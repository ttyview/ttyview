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
    /// Fires once per successful mutation (set / merge / unset). WS
    /// connections subscribe and push a `{t:"state-changed"}` nudge so
    /// clients refetch `/api/state` on demand instead of polling it. The
    /// payload is intentionally empty — a nudge, not a delta; the client
    /// already diffs the full snapshot. See `ttyview-live-sync`.
    change_tx: tokio::sync::broadcast::Sender<()>,
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
        // Capacity is small on purpose: a subscriber that falls behind gets
        // `Lagged`, which we coalesce into a single nudge (the client refetches
        // the whole snapshot anyway), so we never need to buffer many.
        let (change_tx, _) = tokio::sync::broadcast::channel(16);
        Ok(Arc::new(Self {
            file_path,
            data: Mutex::new(data),
            change_tx,
        }))
    }

    /// Subscribe to mutation nudges. Each successful `set`/`merge`/`unset`
    /// sends one `()`; WS connections relay it as `{t:"state-changed"}`.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<()> {
        self.change_tx.subscribe()
    }

    /// Notify subscribers of a mutation. Send error (no receivers) is ignored.
    fn notify(&self) {
        let _ = self.change_tx.send(());
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
        write_atomic(&self.file_path, &bytes)?;
        self.notify();
        Ok(())
    }

    /// Remove `key` and persist. No-op if the key wasn't present
    /// (still rewrites the file).
    pub fn unset(&self, key: &str) -> std::io::Result<()> {
        let mut g = self.data.lock().unwrap();
        g.remove(key);
        let bytes = serialise(&g)?;
        drop(g);
        write_atomic(&self.file_path, &bytes)?;
        self.notify();
        Ok(())
    }

    /// Deep-merge `patch` into `key`'s current value and persist, under the
    /// same write lock as `set`/`unset`. This is the anti-clobber path: a
    /// client sends only the fields it actually CHANGED (a minimal nested
    /// patch), so concurrent edits another client made to OTHER entries of
    /// the same key survive. `null` patch values delete that entry; arrays
    /// and scalars replace wholesale (arrays-as-leaf). See `deep_merge`.
    pub fn merge(&self, key: String, patch: Value) -> std::io::Result<()> {
        let mut g = self.data.lock().unwrap();
        let entry = g.entry(key).or_insert(Value::Null);
        deep_merge(entry, patch);
        let bytes = serialise(&g)?;
        drop(g);
        write_atomic(&self.file_path, &bytes)?;
        self.notify();
        Ok(())
    }
}

/// Recursively merge `patch` into `target`.
/// - both objects → per-key: `null` deletes; nested objects recurse;
///   everything else (scalars, ARRAYS) replaces that key wholesale.
/// - patch is a scalar/array → replaces `target` wholesale (arrays-as-leaf).
/// - target is absent/non-object but patch is an object → target becomes a
///   fresh object and the patch is applied (so `null` fields are skipped, not
///   stored as nulls).
fn deep_merge(target: &mut Value, patch: Value) {
    if let Value::Object(p) = patch {
        if !target.is_object() {
            *target = Value::Object(serde_json::Map::new());
        }
        let t = target.as_object_mut().unwrap();
        for (k, v) in p {
            if v.is_null() {
                t.remove(&k);
            } else if t.get(&k).map(Value::is_object).unwrap_or(false) && v.is_object() {
                deep_merge(t.get_mut(&k).unwrap(), v);
            } else {
                t.insert(k, v);
            }
        }
    } else {
        *target = patch;
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
        .route(
            "/api/state/:key",
            put(put_state_key)
                .patch(patch_state_key)
                .delete(delete_state_key),
        )
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
    // Cap the value size: state.json is rewritten in full on every PUT and the
    // in-memory map lives for the process lifetime, so an unbounded value is a
    // trivial disk/RAM DoS. 1 MiB is generous for UI state (pins, labels,
    // cached search results).
    const MAX_VALUE_BYTES: usize = 1024 * 1024;
    let approx_len = serde_json::to_vec(&value).map(|v| v.len()).unwrap_or(0);
    if approx_len > MAX_VALUE_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("value exceeds {MAX_VALUE_BYTES} bytes"),
        )
            .into_response();
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

async fn patch_state_key(
    State(app): State<Arc<AppState>>,
    Path(key): Path<String>,
    Json(patch): Json<Value>,
) -> impl IntoResponse {
    if !is_safe_key(&key) {
        return (StatusCode::BAD_REQUEST, "invalid key").into_response();
    }
    // Same DoS guard as PUT — the merge rewrites state.json in full and the
    // result lives in the in-memory map for the process lifetime.
    const MAX_VALUE_BYTES: usize = 1024 * 1024;
    let approx_len = serde_json::to_vec(&patch).map(|v| v.len()).unwrap_or(0);
    if approx_len > MAX_VALUE_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("patch exceeds {MAX_VALUE_BYTES} bytes"),
        )
            .into_response();
    }
    match app.state.merge(key.clone(), patch) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => {
            tracing::warn!(target: "ttyview::state", key = %key, "state merge failed: {e}");
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

    // ---- deep_merge (anti-clobber) ----
    use serde_json::json;
    fn merged(mut target: Value, patch: Value) -> Value {
        deep_merge(&mut target, patch);
        target
    }

    #[test]
    fn merge_changes_only_patched_entries() {
        // The core anti-clobber property: a patch touching s1 must NOT drop
        // s2 that another client set on the server meanwhile.
        let server = json!({ "s1": "todo", "s2": "done" });
        let patch = json!({ "s1": "done" });            // our only change
        assert_eq!(merged(server, patch), json!({ "s1": "done", "s2": "done" }));
    }

    #[test]
    fn merge_null_deletes_entry() {
        let target = json!({ "a": 1, "b": 2 });
        assert_eq!(merged(target, json!({ "b": null })), json!({ "a": 1 }));
    }

    #[test]
    fn merge_recurses_into_nested_objects() {
        // groups[g] = {collapsed,color,order}: changing `color` must keep
        // a concurrently-set `collapsed`/`order`.
        let target = json!({ "g": { "collapsed": true, "color": "#aaa", "order": 0 } });
        let patch = json!({ "g": { "color": "#0f0" } });
        assert_eq!(
            merged(target, patch),
            json!({ "g": { "collapsed": true, "color": "#0f0", "order": 0 } })
        );
    }

    #[test]
    fn merge_arrays_are_atomic_leaves() {
        // Arrays replace wholesale (no element merge) — pins-style values.
        let target = json!({ "p": [1, 2, 3] });
        assert_eq!(merged(target, json!({ "p": [9] })), json!({ "p": [9] }));
    }

    #[test]
    fn merge_scalar_patch_replaces_wholesale() {
        assert_eq!(merged(json!({ "a": 1 }), json!("x")), json!("x"));
        assert_eq!(merged(json!([1, 2]), json!({ "a": 1 })), json!({ "a": 1 }));
    }

    #[test]
    fn merge_into_absent_skips_null_fields() {
        // Fresh key (Null): nulls in the patch are skips, not stored nulls.
        let target = Value::Null;
        assert_eq!(merged(target, json!({ "a": 1, "gone": null })), json!({ "a": 1 }));
    }

    #[test]
    fn store_merge_persists_and_survives_reopen() {
        let dir = tmp_dir();
        let key = "ttv-plugin:ttyview-tabs:marks";
        {
            let s = StateStore::open(dir.path()).unwrap();
            s.set(key.into(), json!({ "s1": "todo", "s2": "done" })).unwrap();
            // Simulate a stale client that only changed s1 — must keep s2.
            s.merge(key.into(), json!({ "s1": "done" })).unwrap();
        }
        let s2 = StateStore::open(dir.path()).unwrap();
        assert_eq!(
            s2.snapshot().get(key).unwrap(),
            &json!({ "s1": "done", "s2": "done" })
        );
    }
}
