//! HTTP + WebSocket API surface.
//!
//! Endpoints:
//!   GET  /panes                     → list of pane summaries
//!   GET  /panes/:id/grid            → full grid as JSON
//!   GET  /panes/:id/text            → rendered text (trailing-trimmed)
//!   GET  /panes/:id/text?ansi=1     → rendered text WITH ANSI color codes
//!   GET  /ws                        → WebSocket: subscribe / snapshot / send-input
//!   GET  /healthz                   → "ok"
//!
//! WebSocket messages (server → client) are LiveEvents from `state::LiveEvent`.
//!
//! WebSocket commands (client → server):
//!   {"t":"sub","p":"<pane>","kinds":["out","tick","title"]}
//!   {"t":"snapshot","p":"<pane>","req":"<id>"}    → server replies with a Snapshot frame
//!   {"t":"input","p":"<pane>","keys":"..."}        → forward keys to tmux send-keys

pub mod http;
pub mod plugins;
pub mod sessions;
pub mod state;
pub mod uploads;
pub mod ws;

use crate::state::PaneStore;
use axum::Router;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct AppState {
    pub store: PaneStore,
    /// tmux socket name (`-L`) for `send-keys` / `capture-pane` calls.
    pub tmux_socket: Option<String>,
    /// Refcount of WS connections that have switched a window to
    /// `window-size manual` (via the `resize` client message). When the
    /// count for a window drops to 0 — last interested WS disconnected or
    /// explicitly released — the window-size option is restored to
    /// `latest` so client-driven sizing resumes. Without this, every
    /// "Fit pane to viewport" toggle leaves the window pinned forever,
    /// which silently breaks any other tmux client (xterm.js in tmux-web,
    /// a real terminal, etc.) that expects to drive its own size.
    pub resized_windows: Arc<Mutex<HashMap<String, usize>>>,
    /// If set, client diagnostic events received via WS are appended
    /// to this file as JSONL. None = drop silently (default — no
    /// client telemetry is persisted unless the operator opts in via
    /// the `--diag-log` flag). Events contain only metadata
    /// (timings, event types, sizes) — never cell content or input
    /// text — so logging is safe by construction.
    pub diag_log_path: Option<std::path::PathBuf>,
    /// If set, GET /plugins/registry fetches from this URL instead of
    /// (or with fallback to) the bundled registry. Lets users point
    /// the daemon at any catalog — the official ttyview/community-
    /// plugins repo, a private fork, a local development server. Empty
    /// = bundled-only (the v1 default).
    pub registry_url: Option<String>,
    /// Read-only mode. Set by --read-only or --demo. WebSocket
    /// {t:"input"} messages are dropped; POST /plugins/install and
    /// DELETE /plugins/uninstall return 403. Reads keep working.
    pub read_only: bool,
    /// Demo mode. Set by --demo. Implies read_only. Skips tmux entirely;
    /// the synthetic pane "%demo" is the only thing in /panes, and its
    /// CC transcript is the bundled demo conversation. Used for hosting
    /// a public "try it" link where visitors need zero setup.
    pub demo_mode: bool,
    /// Per-instance config directory. Holds the installed-plugins dir
    /// (`<config_dir>/plugins/`) and `installed.json`. Two daemons
    /// with different config_dir values share zero state.
    pub config_dir: std::path::PathBuf,
    /// Human-readable name for this daemon instance. Returned by
    /// `GET /api/instance`; plugins (e.g. ttyview-app-name) render
    /// it in the header.
    pub app_name: Option<String>,
    /// Image-paste / upload state. `None` disables the
    /// `/api/uploads*` endpoints entirely (they 503). The daemon
    /// binary always populates this; embedders (tests, sandbox
    /// broker) can opt out by passing None.
    pub uploads: Option<Arc<uploads::UploadsState>>,
    /// Extra origins allowed to open a WebSocket beyond same-origin.
    /// Same-origin (Origin's authority matches the request's Host
    /// header) is always permitted; non-browser clients with no
    /// Origin header are also permitted. Anything else must appear
    /// in this list — see `ws::origin_allowed` for the policy.
    /// Empty by default (the safe v1 default). Operator opts in via
    /// `--allow-origin <ORIGIN>` (repeatable).
    pub allowed_origins: Vec<String>,
    /// Server-authoritative client state (active terminal view, theme,
    /// pinned tabs, display toggles, generic per-plugin storage). See
    /// `state.rs` for the wire surface. Every browser hitting this
    /// daemon hydrates from here on boot, so the layout is uniform
    /// regardless of localStorage contents.
    pub state: Arc<state::StateStore>,
}

pub fn router(state: AppState) -> Router {
    // Janitor for the uploads staging dir runs as a tokio task; only
    // spawn it when uploads are actually enabled for this daemon.
    if let Some(u) = state.uploads.clone() {
        uploads::spawn_janitor(u);
    }
    Router::new()
        .merge(http::routes())
        .merge(ws::routes())
        .merge(plugins::routes())
        .merge(uploads::routes())
        .merge(sessions::routes())
        .merge(state::routes())
        .merge(static_routes())
        .with_state(Arc::new(state))
}

/// Static file serving for the embedded UI bundle (`ui/` dir, embedded at
/// compile time via rust-embed). Mounted at `/ui/*` plus a top-level
/// `/tuiv2` and `/` redirect for convenience.
fn static_routes() -> Router<Arc<AppState>> {
    use axum::{
        http::{header, StatusCode, Uri},
        response::{IntoResponse, Redirect, Response},
        routing::get,
    };
    use rust_embed::RustEmbed;

    #[derive(RustEmbed)]
    #[folder = "ui/"]
    struct Assets;

    async fn serve(uri: Uri) -> Response {
        let path = uri.path().trim_start_matches('/').to_string();
        let path = path.strip_prefix("ui/").unwrap_or(&path);
        let path = if path.is_empty() || path == "ui" {
            "index.html"
        } else {
            path
        };
        match Assets::get(path) {
            Some(content) => {
                let mime = mime_guess::from_path(path).first_or_octet_stream();
                (
                    [
                        (header::CONTENT_TYPE, mime.as_ref()),
                        // Dev-friendly: never let the browser hold onto an
                        // old build. Embedded assets are tiny and re-fetching
                        // them on each load is fine. Removes the "I changed
                        // the CSS but the page looks the same" footgun.
                        (header::CACHE_CONTROL, "no-store, must-revalidate"),
                    ],
                    content.data.into_owned(),
                )
                    .into_response()
            }
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn root_redirect() -> Redirect {
        Redirect::temporary("/ui/index.html")
    }

    Router::new()
        .route("/", get(root_redirect))
        .route("/ui", get(serve))
        .route("/ui/", get(serve))
        .route("/ui/*path", get(serve))
}
