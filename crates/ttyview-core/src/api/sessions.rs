//! tmux session CRUD — create / rename / kill.
//!
//! Why these endpoints exist: the dropdown picker can only select
//! existing sessions; users on mobile (mobile-cc) need a way to spin
//! up a fresh session for a new CC chat, rename when they
//! repurpose one, and kill when they're done. Pairs with the
//! `ttyview-pane-picker` inline UX (＋ button + ⋮ row menu) and the
//! `ttyview-session-manager` settings tab.
//!
//! Wire surface:
//!
//!   POST   /api/sessions                ← {name, cwd?}  → 200 {ok:true, name}
//!   POST   /api/sessions/:name/rename   ← {to}          → 200 {ok:true, name}
//!   DELETE /api/sessions/:name                          → 200 {ok:true}
//!
//! All three are gated on `!read_only && !demo_mode` (mirrors
//! `/api/uploads`). Session names are validated by regex
//! `^[A-Za-z0-9_.-]{1,64}$` — tmux itself allows more, but we keep
//! the set tight to make argv-injection structurally impossible and
//! to dodge tmux's `:`-as-window-separator surprises.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::AppState;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/sessions", post(create_session))
        .route("/api/sessions/:name/rename", post(rename_session))
        .route("/api/sessions/:name", delete(kill_session))
}

// --- request / response shapes ---------------------------------------------

#[derive(Deserialize)]
struct CreateReq {
    name: String,
    /// Working directory for the initial pane. None = tmux default
    /// (`HOME` for the daemon user, typically). Validated as an
    /// absolute path that exists on disk before invoking tmux —
    /// catches typos before tmux silently falls back to `HOME`.
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct RenameReq {
    to: String,
}

#[derive(Serialize)]
struct OkResp {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize)]
struct ErrResp {
    error: String,
}

fn err(code: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<ErrResp>) {
    (code, Json(ErrResp { error: msg.into() }))
}

// --- handlers --------------------------------------------------------------

async fn create_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateReq>,
) -> impl IntoResponse {
    if state.read_only || state.demo_mode {
        return err(StatusCode::FORBIDDEN, "read-only mode").into_response();
    }
    if !is_valid_session_name(&req.name) {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid name (allowed: [A-Za-z0-9_.-], 1–64 chars)",
        )
        .into_response();
    }
    if session_exists(state.tmux_socket.as_deref(), &req.name) {
        return err(StatusCode::CONFLICT, "session already exists").into_response();
    }
    if let Some(cwd) = req.cwd.as_deref() {
        if !is_valid_cwd(cwd) {
            return err(
                StatusCode::BAD_REQUEST,
                "cwd must be an absolute path to an existing directory",
            )
            .into_response();
        }
    }

    let mut cmd = std::process::Command::new("tmux");
    if let Some(s) = state.tmux_socket.as_deref() {
        cmd.arg("-L").arg(s);
    }
    cmd.args(["new-session", "-d", "-s", &req.name]);
    if let Some(cwd) = req.cwd.as_deref() {
        cmd.arg("-c").arg(cwd);
    }
    match cmd.output() {
        Ok(out) if out.status.success() => Json(OkResp {
            ok: true,
            name: Some(req.name),
        })
        .into_response(),
        Ok(out) => {
            tracing::warn!(
                "tmux new-session failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            err(StatusCode::INTERNAL_SERVER_ERROR, "tmux new-session failed").into_response()
        }
        Err(e) => {
            tracing::warn!("tmux new-session spawn error: {e}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "tmux not available").into_response()
        }
    }
}

async fn rename_session(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(req): Json<RenameReq>,
) -> impl IntoResponse {
    if state.read_only || state.demo_mode {
        return err(StatusCode::FORBIDDEN, "read-only mode").into_response();
    }
    if !is_valid_session_name(&name) {
        return err(StatusCode::BAD_REQUEST, "invalid source name").into_response();
    }
    if !is_valid_session_name(&req.to) {
        return err(StatusCode::BAD_REQUEST, "invalid target name").into_response();
    }
    if name == req.to {
        // No-op; succeed quietly so clients don't have to special-case.
        return Json(OkResp {
            ok: true,
            name: Some(req.to),
        })
        .into_response();
    }
    if !session_exists(state.tmux_socket.as_deref(), &name) {
        return err(StatusCode::NOT_FOUND, "session does not exist").into_response();
    }
    if session_exists(state.tmux_socket.as_deref(), &req.to) {
        return err(StatusCode::CONFLICT, "target name already exists").into_response();
    }

    let mut cmd = std::process::Command::new("tmux");
    if let Some(s) = state.tmux_socket.as_deref() {
        cmd.arg("-L").arg(s);
    }
    cmd.args(["rename-session", "-t", &name, &req.to]);
    match cmd.output() {
        Ok(out) if out.status.success() => Json(OkResp {
            ok: true,
            name: Some(req.to),
        })
        .into_response(),
        Ok(out) => {
            tracing::warn!(
                "tmux rename-session failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "tmux rename-session failed",
            )
            .into_response()
        }
        Err(e) => {
            tracing::warn!("tmux rename-session spawn error: {e}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "tmux not available").into_response()
        }
    }
}

async fn kill_session(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    if state.read_only || state.demo_mode {
        return err(StatusCode::FORBIDDEN, "read-only mode").into_response();
    }
    if !is_valid_session_name(&name) {
        return err(StatusCode::BAD_REQUEST, "invalid name").into_response();
    }
    if !session_exists(state.tmux_socket.as_deref(), &name) {
        // Idempotent delete: already gone is the desired state. Return
        // 404 so the client can distinguish a no-op from a real success
        // if it cares, but the operation isn't strictly an error.
        return err(StatusCode::NOT_FOUND, "session does not exist").into_response();
    }

    let mut cmd = std::process::Command::new("tmux");
    if let Some(s) = state.tmux_socket.as_deref() {
        cmd.arg("-L").arg(s);
    }
    cmd.args(["kill-session", "-t", &name]);
    match cmd.output() {
        Ok(out) if out.status.success() => Json(OkResp {
            ok: true,
            name: None,
        })
        .into_response(),
        Ok(out) => {
            tracing::warn!(
                "tmux kill-session failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            err(StatusCode::INTERNAL_SERVER_ERROR, "tmux kill-session failed").into_response()
        }
        Err(e) => {
            tracing::warn!("tmux kill-session spawn error: {e}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "tmux not available").into_response()
        }
    }
}

// --- helpers ---------------------------------------------------------------

/// Session names: alphanumeric + `_.-`, 1–64 chars. Excludes `:`
/// (tmux's window separator), whitespace, and shell metacharacters
/// so that the name can be passed as an `-s NAME` / `-t NAME` argv
/// element without quoting concerns. The 64-char cap matches tmux's
/// own conventional limit and prevents pathologically long display.
fn is_valid_session_name(s: &str) -> bool {
    let n = s.len();
    if n == 0 || n > 64 {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// cwd validation: must be an absolute path that exists and is a
/// directory. tmux silently falls back to `HOME` for bad paths,
/// which would be confusing UX.
fn is_valid_cwd(s: &str) -> bool {
    if !s.starts_with('/') {
        return false;
    }
    std::fs::metadata(s).map(|m| m.is_dir()).unwrap_or(false)
}

/// Cheap existence check via `tmux has-session -t NAME`. Returns
/// true on exit code 0, false otherwise (including tmux-not-running).
fn session_exists(socket: Option<&str>, name: &str) -> bool {
    let mut cmd = std::process::Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    cmd.args(["has-session", "-t", name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_validation_accepts_common_shapes() {
        assert!(is_valid_session_name("claude1"));
        assert!(is_valid_session_name("ttyview-core"));
        assert!(is_valid_session_name("my_session_42"));
        assert!(is_valid_session_name("v0.1.2"));
        assert!(is_valid_session_name("a"));
        assert!(is_valid_session_name(&"x".repeat(64)));
    }

    #[test]
    fn name_validation_rejects_unsafe_chars() {
        assert!(!is_valid_session_name(""));
        assert!(!is_valid_session_name(&"x".repeat(65)));
        assert!(!is_valid_session_name("with space"));
        assert!(!is_valid_session_name("with:colon"));
        assert!(!is_valid_session_name("with/slash"));
        assert!(!is_valid_session_name("with;semi"));
        assert!(!is_valid_session_name("with$dollar"));
        assert!(!is_valid_session_name("with`backtick"));
        assert!(!is_valid_session_name("with'quote"));
        assert!(!is_valid_session_name("with\"dquote"));
        assert!(!is_valid_session_name("with\\backslash"));
        assert!(!is_valid_session_name("with\nnewline"));
        assert!(!is_valid_session_name("foo; rm -rf /"));
    }

    #[test]
    fn cwd_validation_requires_absolute_existing_dir() {
        assert!(!is_valid_cwd(""));
        assert!(!is_valid_cwd("relative/path"));
        assert!(!is_valid_cwd("/nonexistent/path/that/should/never/exist"));
        // /tmp should reliably exist on Linux test runners.
        assert!(is_valid_cwd("/tmp"));
    }
}
