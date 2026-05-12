//! Server-authoritative client state.
//!
//! Layout-level preferences that should be **the same in every browser
//! hitting this daemon** (active terminal view, active theme, plugin-
//! scoped storage like pinned tabs and display toggles) live here.
//! Things that are legitimately per-device (which pane you last viewed,
//! font size, the persisted UI-tab on the project hub) stay in
//! `localStorage` on the client and are *not* synced through here.
//!
//! Wire shape:
//!
//!   GET    /api/state          → { schema:1, keys: { "k": <json>, … } }
//!   PUT    /api/state/:key     ← raw JSON body  → 200 { ok: true }
//!   DELETE /api/state/:key     → 200 { ok: true }
//!
//! Persistence: `<config_dir>/state.json` (JSON object). Writes happen
//! synchronously on each PUT/DELETE — single-user daemon, the cost is
//! a fsync per layout toggle which is fine in practice. If write
//! amplification becomes a real problem we'd debounce; not premature
//! to keep it simple now.
//!
//! Future profiles hook: this module's `StateStore` is per-daemon
//! today. When profiles ship (URL param `?profile=<id>`), the same
//! shape will live under `<config_dir>/profiles/<id>/state.json`
//! and the router will pick which `StateStore` to inject by header
//! or query — no schema change at this layer.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, put},
    Json, Router,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, Mutex};

use super::AppState;

/// In-memory cache backed by a single JSON file on disk. Cheap to
/// snapshot under read lock; writes are persisted before the lock
/// is released so a crash can't lose a successfully-acked PUT.
pub struct StateStore {
    /// Absolute path of `<config_dir>/state.json`.
    file_path: PathBuf,
    /// Key → JSON value cache. `Value::Null` is treated as "set to
    /// null" (distinct from "absent"). Use `unset` to remove a key.
    data: Mutex<HashMap<String, Value>>,
}

impl StateStore {
    /// Open (or create empty) the state file under `config_dir`. The
    /// caller's `config_dir` already exists by the time we're called
    /// (the daemon creates it for the plugins store first).
    pub fn open(config_dir: &StdPath) -> std::io::Result<Arc<Self>> {
        let file_path = config_dir.join("state.json");
        let data: HashMap<String, Value> = match std::fs::read(&file_path) {
            Ok(bytes) => match serde_json::from_slice::<StoreFile>(&bytes) {
                Ok(parsed) => parsed.keys,
                Err(e) => {
                    // Corrupted file: log + start empty. Don't delete —
                    // operator can inspect / move it aside.
                    tracing::warn!(
                        target: "ttyview::state",
                        "state.json parse failed at {}: {e}; starting empty",
                        file_path.display()
                    );
                    HashMap::new()
                }
            },
            // No file yet — first run on this config_dir.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => return Err(e),
        };
        Ok(Arc::new(Self {
            file_path,
            data: Mutex::new(data),
        }))
    }

    /// Snapshot the entire store. Cheap clone of a small map; values
    /// are JSON (typically scalar / short array). Holds the read lock
    /// only long enough to clone.
    pub fn snapshot(&self) -> HashMap<String, Value> {
        let g = self.data.lock().unwrap();
        g.clone()
    }

    /// Set `key` to `value` and persist. Returns `Err` only when the
    /// disk write fails — the in-memory cache is still updated.
    pub fn set(&self, key: String, value: Value) -> std::io::Result<()> {
        let mut g = self.data.lock().unwrap();
        g.insert(key, value);
        let bytes = serialise(&g)?;
        drop(g);
        write_atomic(&self.file_path, &bytes)
    }

    /// Remove `key` and persist. No-op if the key wasn't present
    /// (still rewrites the file).
    pub fn unset(&self, key: &str) -> std::io::Result<()> {
        let mut g = self.data.lock().unwrap();
        g.remove(key);
        let bytes = serialise(&g)?;
        drop(g);
        write_atomic(&self.file_path, &bytes)
    }
}

fn serialise(data: &HashMap<String, Value>) -> std::io::Result<Vec<u8>> {
    serde_json::to_vec_pretty(&StoreFile { schema: 1, keys: data.clone() })
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Write-then-rename so a crash mid-write doesn't leave a half-written
/// state.json. The tmp file lives next to the target on the same FS
/// so `rename` is atomic.
fn write_atomic(path: &StdPath, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| StdPath::new("."));
    let tmp = parent.join(format!(
        ".state.json.tmp.{}",
        std::process::id()
    ));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// === On-disk schema ===

#[derive(Serialize, serde::Deserialize)]
struct StoreFile {
    schema: u8,
    keys: HashMap<String, Value>,
}

// === HTTP API ===

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/state", get(get_state))
        .route("/api/state/:key", put(put_state_key).delete(delete_state_key))
}

#[derive(Serialize)]
struct GetResp {
    schema: u8,
    keys: HashMap<String, Value>,
}

async fn get_state(State(app): State<Arc<AppState>>) -> Json<GetResp> {
    Json(GetResp {
        schema: 1,
        keys: app.state.snapshot(),
    })
}

async fn put_state_key(
    State(app): State<Arc<AppState>>,
    Path(key): Path<String>,
    Json(value): Json<Value>,
) -> impl IntoResponse {
    if !is_safe_key(&key) {
        return (StatusCode::BAD_REQUEST, "invalid key").into_response();
    }
    match app.state.set(key.clone(), value) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => {
            tracing::warn!(target: "ttyview::state", key = %key, "state set failed: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"ok": false, "error": e.to_string()})),
            )
                .into_response()
        }
    }
}

async fn delete_state_key(
    State(app): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    if !is_safe_key(&key) {
        return (StatusCode::BAD_REQUEST, "invalid key").into_response();
    }
    match app.state.unset(&key) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"ok": false, "error": e.to_string()})),
        )
            .into_response(),
    }
}

/// Keep keys printable + reasonably short; rejects anything that
/// could be a path-traversal smell or wreck the JSON shape. The
/// real persistence layer doesn't use the key as a path, but cheap
/// defense-in-depth.
fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 256
        && !key.contains("..")
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tmpdir")
    }

    #[test]
    fn set_and_snapshot_round_trip() {
        let dir = tmp_dir();
        let s = StateStore::open(dir.path()).unwrap();
        s.set("ttv-active-view".into(), Value::String("cell-grid".into()))
            .unwrap();
        s.set("ttv-active-theme".into(), Value::String("ttyview-nord".into()))
            .unwrap();
        let snap = s.snapshot();
        assert_eq!(snap.get("ttv-active-view").unwrap(), &Value::String("cell-grid".into()));
        assert_eq!(snap.get("ttv-active-theme").unwrap(), &Value::String("ttyview-nord".into()));
    }

    #[test]
    fn persists_across_reopen() {
        let dir = tmp_dir();
        {
            let s = StateStore::open(dir.path()).unwrap();
            s.set("ttv-plugin:ttyview-tabs:pins".into(), serde_json::json!([
                {"session": "s1", "pane": "%1"}
            ])).unwrap();
        }
        let s2 = StateStore::open(dir.path()).unwrap();
        let pins = s2.snapshot();
        let v = pins.get("ttv-plugin:ttyview-tabs:pins").unwrap();
        assert!(v.is_array());
        assert_eq!(v[0]["session"], "s1");
    }

    #[test]
    fn unset_removes_key() {
        let dir = tmp_dir();
        let s = StateStore::open(dir.path()).unwrap();
        s.set("k".into(), Value::Bool(true)).unwrap();
        assert!(s.snapshot().contains_key("k"));
        s.unset("k").unwrap();
        assert!(!s.snapshot().contains_key("k"));
    }

    #[test]
    fn missing_file_is_empty_not_error() {
        let dir = tmp_dir();
        // Don't create state.json.
        let s = StateStore::open(dir.path()).unwrap();
        assert!(s.snapshot().is_empty());
    }

    #[test]
    fn corrupted_file_recovers_empty() {
        let dir = tmp_dir();
        std::fs::write(dir.path().join("state.json"), b"this is not json").unwrap();
        let s = StateStore::open(dir.path()).unwrap();
        // Logs a warn; in-memory store is empty (not erroring).
        assert!(s.snapshot().is_empty());
        // And we can still write to it; new content overwrites garbage.
        s.set("k".into(), Value::Bool(true)).unwrap();
        let s2 = StateStore::open(dir.path()).unwrap();
        assert_eq!(s2.snapshot().get("k").unwrap(), &Value::Bool(true));
    }

    #[test]
    fn safe_key_validation() {
        assert!(is_safe_key("ttv-active-view"));
        assert!(is_safe_key("ttv-plugin:ttyview-tabs:pins"));
        assert!(!is_safe_key(""));
        assert!(!is_safe_key("../etc/passwd"));    // .. sequence
        assert!(!is_safe_key("hi there"));         // space
        assert!(!is_safe_key("a/b/c"));            // slash
        assert!(!is_safe_key("k\0null"));           // NUL
        assert!(!is_safe_key(&"x".repeat(257)));    // too long
    }
}
