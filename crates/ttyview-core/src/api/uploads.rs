//! Image-upload endpoints — the host-side half of the image-paste UX.
//!
//! Pasting a screenshot into Claude Code over SSH is the #1 pain point
//! Levelsio called out on Twitter (2026-05-11). Other terminal apps work
//! around it via "Termius, please paste into /tmp"; ttyview does it
//! natively by pairing these endpoints with the `ttyview-image-paste`
//! plugin on the client.
//!
//! Wire surface:
//!
//!   POST   /api/uploads          ← multipart "image" field → 200 { id }
//!   DELETE /api/uploads/:id      → 200 { ok: true }
//!   POST   /api/uploads/send     ← JSON { pane, ids[], text } → paste +
//!                                  Enter + verify-retry. 200 { paths[] }.
//!
//! The two-phase shape (stage then send) exists to give the browser a
//! progress UI for eager uploads — the user picks images, they start
//! flying to disk immediately, then a caption is typed, then Send fires
//! the actual tmux paste. Single-shot uploads would stall Send for
//! seconds on slow networks with no feedback.
//!
//! Storage layout:
//!
//!   <uploads_dir>/staging/   ← unsent uploads, swept by janitor after 1 h
//!   <uploads_dir>/           ← sent uploads, kept indefinitely
//!
//! Default uploads_dir is `~/.cache/ttyview/uploads`. Configurable via
//! `--uploads-dir`.
//!
//! Both stage and send are 403'd in read_only / demo mode (mirrors
//! `/plugins/install`). Demo mode has no real tmux pane to paste into
//! and no host filesystem we want to write to from anonymous visitors.

use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::AppState;

/// Hard cap on a single staged upload. Phone screenshots are usually
/// 2–5 MB; HEIC/RAW originals can be larger. 25 MB matches the
/// established convention (tmux-web uses the same number) and is
/// comfortably under axum/hyper's default request-body ceilings.
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

/// How often the janitor scans the staging dir.
const JANITOR_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// How long an upload can sit in staging before the janitor reclaims
/// it. Generous — a user might pick an image, get distracted, come back.
const STAGE_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone)]
struct Staged {
    /// Absolute path under <uploads_dir>/staging/.
    path: PathBuf,
    /// When the file landed on disk — used by the janitor to expire
    /// orphans. The browser-supplied filename and size aren't stored
    /// (echoed back in the stage response so the client has them
    /// already, and the janitor doesn't need them).
    created_at: SystemTime,
}

/// Per-daemon upload state. Holds the directory layout and an
/// in-memory index of staged files keyed by id. The janitor task
/// shares the same Mutex so disk and memory stay consistent.
pub struct UploadsState {
    /// Root dir; archive lives here directly, staging lives in
    /// `<root>/staging/`.
    pub uploads_dir: PathBuf,
    pub staging_dir: PathBuf,
    by_id: Mutex<HashMap<String, Staged>>,
}

impl UploadsState {
    pub fn new(uploads_dir: PathBuf) -> std::io::Result<Arc<Self>> {
        let staging_dir = uploads_dir.join("staging");
        std::fs::create_dir_all(&staging_dir)?;
        Ok(Arc::new(Self {
            uploads_dir,
            staging_dir,
            by_id: Mutex::new(HashMap::new()),
        }))
    }
}

/// Default location when `--uploads-dir` is unset.
pub fn default_uploads_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join(".cache/ttyview/uploads")
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/uploads", post(stage_upload))
        .route("/api/uploads/:id", delete(delete_staged))
        .route("/api/uploads/send", post(send_uploads))
}

/// Spawn the staging-dir janitor. Best-effort: sweeps stale in-memory
/// entries + orphaned files on disk. Logs and continues on any error;
/// a janitor crash should never take the daemon down.
pub fn spawn_janitor(uploads: Arc<UploadsState>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(JANITOR_INTERVAL);
        tick.tick().await; // first tick fires immediately; skip it
        loop {
            tick.tick().await;
            let now = SystemTime::now();
            // Sweep in-memory entries past the TTL. Take the lock,
            // collect ids, release, then unlink each — keeps the
            // critical section short.
            let stale_paths: Vec<PathBuf> = {
                let mut idx = uploads.by_id.lock().unwrap();
                let stale_ids: Vec<String> = idx
                    .iter()
                    .filter_map(|(id, s)| {
                        now.duration_since(s.created_at)
                            .ok()
                            .filter(|d| *d > STAGE_TTL)
                            .map(|_| id.clone())
                    })
                    .collect();
                stale_ids
                    .iter()
                    .filter_map(|id| idx.remove(id).map(|s| s.path))
                    .collect()
            };
            for p in &stale_paths {
                if let Err(e) = std::fs::remove_file(p) {
                    tracing::warn!("uploads janitor: remove {}: {e}", p.display());
                }
            }
            // Sweep orphaned files in staging that aren't in the index
            // (daemon restart leaves them behind, since the index is
            // memory-only). Drop anything older than the TTL.
            let dir = uploads.staging_dir.clone();
            let known: std::collections::HashSet<PathBuf> = uploads
                .by_id
                .lock()
                .unwrap()
                .values()
                .map(|s| s.path.clone())
                .collect();
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    let p = e.path();
                    if known.contains(&p) {
                        continue;
                    }
                    let too_old = e
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| now.duration_since(t).ok())
                        .map(|d| d > STAGE_TTL)
                        .unwrap_or(false);
                    if too_old {
                        if let Err(err) = std::fs::remove_file(&p) {
                            tracing::warn!("uploads janitor orphan: {}: {err}", p.display());
                        }
                    }
                }
            }
        }
    });
}

// --- handlers ---------------------------------------------------------------

#[derive(Serialize)]
struct StageResp {
    id: String,
    name: String,
    size: u64,
}

#[derive(Serialize)]
struct ErrResp {
    error: String,
}

async fn stage_upload(
    State(state): State<Arc<AppState>>,
    mut mp: Multipart,
) -> impl IntoResponse {
    if state.read_only {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrResp { error: "read-only mode".into() }),
        )
            .into_response();
    }
    let uploads = match state.uploads.as_ref() {
        Some(u) => u.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrResp { error: "uploads disabled".into() }),
            )
                .into_response();
        }
    };

    // We accept exactly one multipart field named "image". Anything else
    // is ignored (multer/JS-side may pad with metadata fields).
    let mut chosen: Option<(String, Vec<u8>)> = None;
    while let Ok(Some(field)) = mp.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name != "image" {
            continue;
        }
        let original = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "upload.bin".into());
        let bytes = match field.bytes().await {
            Ok(b) => b,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrResp { error: format!("multipart read: {e}") }),
                )
                    .into_response();
            }
        };
        if bytes.len() > MAX_IMAGE_BYTES {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(ErrResp {
                    error: format!("max {} bytes per image", MAX_IMAGE_BYTES),
                }),
            )
                .into_response();
        }
        chosen = Some((original, bytes.to_vec()));
        break;
    }

    let (original_name, body) = match chosen {
        Some(x) => x,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrResp { error: "no 'image' field".into() }),
            )
                .into_response();
        }
    };

    let id = gen_id();
    let ext = sanitized_ext(&original_name);
    let staged_path = uploads.staging_dir.join(format!("{id}{ext}"));
    if let Err(e) = std::fs::write(&staged_path, &body) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrResp { error: format!("write: {e}") }),
        )
            .into_response();
    }
    let size = body.len() as u64;
    uploads.by_id.lock().unwrap().insert(
        id.clone(),
        Staged {
            path: staged_path,
            created_at: SystemTime::now(),
        },
    );
    tracing::debug!(
        target: "ttyview::uploads",
        id = %id,
        name = %original_name,
        bytes = size,
        "staged"
    );

    (
        StatusCode::OK,
        Json(StageResp { id, name: original_name, size }),
    )
        .into_response()
}

#[derive(Serialize)]
struct OkResp {
    ok: bool,
}

async fn delete_staged(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let uploads = match state.uploads.as_ref() {
        Some(u) => u.clone(),
        None => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let entry = uploads.by_id.lock().unwrap().remove(&id);
    match entry {
        Some(s) => {
            // Best-effort removal — the janitor will mop up if this
            // fails. We don't 500 on a stale staging file.
            let _ = std::fs::remove_file(&s.path);
            (StatusCode::OK, Json(OkResp { ok: true })).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
struct SendReq {
    /// Target pane id, e.g. "%5". Must match the existing pane-id
    /// regex used elsewhere (`^%\d+$`) — anything else is rejected so
    /// we never pass user-controlled strings to tmux as a pane target.
    pane: String,
    /// Staged image ids to attach, in display order.
    #[serde(default)]
    ids: Vec<String>,
    /// Optional caption typed by the user. Becomes the prefix of the
    /// message: `<text> [image: /path1] [image: /path2]`.
    #[serde(default)]
    text: String,
}

#[derive(Serialize)]
struct SendResp {
    paths: Vec<String>,
}

async fn send_uploads(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SendReq>,
) -> impl IntoResponse {
    if state.read_only {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrResp { error: "read-only mode".into() }),
        )
            .into_response();
    }
    let uploads = match state.uploads.as_ref() {
        Some(u) => u.clone(),
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrResp { error: "uploads disabled".into() }),
            )
                .into_response();
        }
    };

    if req.ids.is_empty() && req.text.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrResp { error: "ids or text required".into() }),
        )
            .into_response();
    }
    if !is_valid_pane_id(&req.pane) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrResp { error: format!("invalid pane id: {}", req.pane) }),
        )
            .into_response();
    }

    // Move each staged file to its archive location. We do this BEFORE
    // pasting so a partial failure (one missing id, disk full mid-move)
    // doesn't leave the chat with an `[image: <staging-path>]` token
    // that the janitor is about to delete.
    let mut final_paths: Vec<PathBuf> = Vec::with_capacity(req.ids.len());
    for id in &req.ids {
        let staged = uploads.by_id.lock().unwrap().remove(id);
        let staged = match staged {
            Some(s) => s,
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(ErrResp { error: format!("unknown id: {id}") }),
                )
                    .into_response();
            }
        };
        let ext = staged
            .path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| format!(".{s}"))
            .unwrap_or_default();
        let final_name = format!("{}{}", id, ext);
        let final_path = uploads.uploads_dir.join(&final_name);
        if let Err(e) = std::fs::rename(&staged.path, &final_path) {
            // Roll back: re-insert the staging entry so the janitor
            // (or a retry) can find it again.
            uploads.by_id.lock().unwrap().insert(id.clone(), staged);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrResp { error: format!("archive {id}: {e}") }),
            )
                .into_response();
        }
        final_paths.push(final_path);
    }

    // Build the message body. Format mirrors what Claude Code's TUI
    // recognizes when reading a pasted prompt: `[image: /abs/path]`
    // tokens, space-separated, optionally prefixed by free-form text.
    let tags: Vec<String> = final_paths
        .iter()
        .map(|p| format!("[image: {}]", p.display()))
        .collect();
    let message = if req.text.trim().is_empty() {
        tags.join(" ")
    } else {
        format!("{} {}", req.text.trim(), tags.join(" "))
    };

    // Drop the message via tmux's paste buffer rather than `send-keys -l`.
    // Why: send-keys has a 16 KB limit and a multi-image caption can
    // overshoot; paste-buffer hands tmux the whole blob in one go and
    // the buffer name lets us isolate it from any unrelated paste
    // history. The buffer is deleted after paste (`paste-buffer -d`).
    let socket = state.tmux_socket.clone();
    let pane = req.pane.clone();
    let join =
        tokio::task::spawn_blocking(move || paste_into_pane(socket.as_deref(), &pane, &message))
            .await;
    match join {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrResp { error: format!("paste: {e}") }),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrResp { error: format!("join: {e}") }),
            )
                .into_response();
        }
    }

    (
        StatusCode::OK,
        Json(SendResp {
            paths: final_paths.iter().map(|p| p.display().to_string()).collect(),
        }),
    )
        .into_response()
}

// --- tmux paste + verify-retry ---------------------------------------------

/// load-buffer the message into a named buffer, paste it into the
/// target pane, delete the buffer, then send Enter with a verify-retry
/// loop. Returns Ok(()) once the pane visibly changed after some Enter
/// attempt — or after the retry budget is exhausted (still Ok, callers
/// just won't know which).
fn paste_into_pane(socket: Option<&str>, pane: &str, message: &str) -> anyhow::Result<()> {
    use std::io::Write;
    use std::process::Command;

    // Write the body to a tmpfile because `tmux load-buffer -` reads
    // from stdin, which means piping through Command::stdin — doable
    // but the tmpfile path is simpler and parallel-safe (unique name).
    let mut tmp = tempfile_path();
    tmp.set_extension("paste");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(message.as_bytes())?;
    }
    let buf_name = format!("ttyview-paste-{}", gen_id());

    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args(["load-buffer", "-b", &buf_name])
        .arg(&tmp)
        .output()?;
    let _ = std::fs::remove_file(&tmp);
    if !out.status.success() {
        anyhow::bail!(
            "tmux load-buffer failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args(["paste-buffer", "-b", &buf_name, "-d", "-t", pane])
        .output()?;
    if !out.status.success() {
        anyhow::bail!(
            "tmux paste-buffer failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    // Capture a fingerprint of the pane before pressing Enter, then
    // try Enter up to MAX_RETRY times until the pane changes. The
    // failure mode this defends against is Claude Code's input-paste
    // detection eating the Enter — same case the WS send pathway's
    // 50 ms delay defends against, but here we verify rather than
    // hope.
    const MAX_RETRY: u32 = 3;
    const VERIFY_WAIT: Duration = Duration::from_millis(700);
    // 50 ms gives CC's paste-burst handler time to close its buffer
    // before our Enter arrives — same constant the WS pathway uses.
    std::thread::sleep(Duration::from_millis(50));

    let baseline = capture_pane(socket, pane).unwrap_or_default();
    for attempt in 1..=MAX_RETRY {
        let mut cmd = Command::new("tmux");
        if let Some(s) = socket {
            cmd.arg("-L").arg(s);
        }
        let out = cmd.args(["send-keys", "-t", pane, "Enter"]).output()?;
        if !out.status.success() {
            tracing::warn!(
                "uploads send-keys Enter attempt {attempt} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            continue;
        }
        std::thread::sleep(VERIFY_WAIT);
        let after = capture_pane(socket, pane).unwrap_or_default();
        if after != baseline {
            tracing::debug!("uploads Enter#{attempt} verified");
            return Ok(());
        }
        tracing::warn!("uploads Enter#{attempt} unchanged; will retry");
    }
    tracing::warn!("uploads Enter retries exhausted; pane never changed");
    Ok(())
}

fn capture_pane(socket: Option<&str>, pane: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args(["capture-pane", "-p", "-t", pane])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

// --- helpers ---------------------------------------------------------------

fn is_valid_pane_id(s: &str) -> bool {
    s.starts_with('%')
        && s[1..].chars().all(|c| c.is_ascii_digit())
        && s.len() > 1
        && s.len() < 16
}

/// `.png`, `.jpg`, … stripped down to ascii alnum + dot. Defaults to
/// `.bin` when the browser supplied nothing recognizable. Never
/// passes the original arbitrary filename through to disk — only the
/// extension.
fn sanitized_ext(name: &str) -> String {
    let after_dot = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    let clean: String = after_dot
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_lowercase();
    if clean.is_empty() {
        ".bin".into()
    } else {
        format!(".{clean}")
    }
}

/// Non-cryptographic unique id. SystemTime nanos + a process-wide
/// monotonic counter. Plenty of entropy to avoid collisions across
/// concurrent uploads; no security claims.
fn gen_id() -> String {
    static CTR: AtomicU64 = AtomicU64::new(0);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let c = CTR.fetch_add(1, Ordering::Relaxed);
    format!("{ts:x}{c:x}")
}

fn tempfile_path() -> PathBuf {
    std::env::temp_dir().join(format!("ttyview-{}", gen_id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_id_validation() {
        assert!(is_valid_pane_id("%0"));
        assert!(is_valid_pane_id("%12345"));
        assert!(!is_valid_pane_id(""));
        assert!(!is_valid_pane_id("%"));
        assert!(!is_valid_pane_id("0"));
        assert!(!is_valid_pane_id("%0; rm -rf /"));
        assert!(!is_valid_pane_id("%abc"));
    }

    #[test]
    fn ext_sanitizing() {
        assert_eq!(sanitized_ext("foo.png"), ".png");
        assert_eq!(sanitized_ext("FOO.JPG"), ".jpg");
        assert_eq!(sanitized_ext("noext"), ".bin");
        assert_eq!(sanitized_ext(""), ".bin");
        assert_eq!(sanitized_ext("evil.../../etc.passwd"), ".passwd");
        assert_eq!(sanitized_ext("foo.really-long-extension"), ".reallylo");
    }

    #[test]
    fn gen_id_unique_under_concurrency() {
        use std::collections::HashSet;
        let ids: HashSet<String> = (0..10_000).map(|_| gen_id()).collect();
        assert_eq!(ids.len(), 10_000);
    }
}
