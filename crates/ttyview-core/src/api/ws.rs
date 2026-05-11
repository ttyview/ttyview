use crate::api::AppState;
use crate::source::PaneId;
use crate::state::LiveEvent;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{debug, warn};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/ws", get(ws_handler))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(app): State<Arc<AppState>>,
) -> Response {
    // Cross-origin WebSocket hijack defense.
    //
    // Browsers do NOT enforce same-origin on WebSocket handshakes (CORS
    // doesn't apply to WS). Without this check, any page in any tab can
    // open `new WebSocket('ws://<our-daemon>/ws')`, subscribe to panes,
    // and (in non-read-only mode) send keystrokes via `{t:"input"}` —
    // an internet-to-RCE path for the default own-machine deployment.
    //
    // Policy (intentionally permissive for legit non-browser callers):
    //   1. No Origin header → allow. Server-side WS clients (the sandbox
    //      broker's tokio-tungstenite bridge, `wscat`, curl) don't send
    //      Origin, and they aren't the threat model.
    //   2. Origin host:port matches the request's Host header → allow.
    //      Same-origin via the daemon's own page.
    //   3. Origin is in `app.allowed_origins` → allow. The operator opts
    //      extra origins in via `--allow-origin <ORIGIN>` (repeatable).
    //   4. Otherwise → 403.
    if !origin_allowed(&headers, &app.allowed_origins) {
        let origin = headers
            .get(axum::http::header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        warn!(
            target: "ttyview::ws",
            "rejecting WS upgrade: Origin={origin:?} Host={host:?} (not in same-origin and not in --allow-origin allowlist)"
        );
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, app))
        .into_response()
}

/// Decide whether to accept a WS upgrade based on the Origin header.
/// See `ws_handler` for the policy. Exposed `pub(crate)` for unit tests.
pub(crate) fn origin_allowed(headers: &HeaderMap, allowed_origins: &[String]) -> bool {
    let origin = match headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        // Rule 1: no Origin → allow (non-browser caller).
        None => return true,
        Some(s) if s.is_empty() || s == "null" => return true,
        Some(s) => s,
    };

    // Rule 3: explicit allowlist match. Exact string compare (scheme +
    // host + port) is the WHATWG-defined Origin shape.
    if allowed_origins.iter().any(|o| o == origin) {
        return true;
    }

    // Rule 2: same-origin via Host header. Origin includes scheme; Host
    // is just authority. Compare authorities.
    if let Some(host) = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
    {
        if origin_authority(origin) == Some(host) {
            return true;
        }
    }

    false
}

/// Extract the authority (host[:port]) from an Origin header value.
/// Returns None for malformed origins. We only care about http/https.
fn origin_authority(origin: &str) -> Option<&str> {
    for scheme in ["http://", "https://"] {
        if let Some(rest) = origin.strip_prefix(scheme) {
            // Origin must not have a path; if it does, ignore everything
            // after the authority. Browsers send `scheme://host[:port]`.
            let auth = rest.split('/').next().unwrap_or(rest);
            return Some(auth);
        }
    }
    None
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
enum ClientMsg {
    /// Subscribe to a pane's events.
    #[serde(rename = "sub")]
    Subscribe {
        #[serde(rename = "p")]
        pane: String,
        /// Filter event kinds (defaults to all).
        #[serde(default)]
        kinds: Option<Vec<String>>,
    },
    /// Unsubscribe.
    #[serde(rename = "unsub")]
    Unsubscribe {
        #[serde(rename = "p")]
        pane: String,
    },
    /// Request a one-shot snapshot of a pane's grid.
    #[serde(rename = "snapshot")]
    Snapshot {
        #[serde(rename = "p")]
        pane: String,
        #[serde(default)]
        req: Option<String>,
    },
    /// Send keys to a pane via tmux send-keys (no-op until input module wired).
    #[serde(rename = "input")]
    Input {
        #[serde(rename = "p")]
        pane: String,
        keys: String,
    },
    /// Resize a pane via `tmux resize-pane -x cols -y rows`. Used by tuiv3
    /// to fit the pane to the client viewport when the user picks a font
    /// size that wouldn't fit the default 80×30 grid.
    #[serde(rename = "resize")]
    Resize {
        #[serde(rename = "p")]
        pane: String,
        cols: u16,
        rows: u16,
    },
    /// Release a pane's manual window-size lock acquired by a previous
    /// `resize` from this same WS. Lets a client cleanly turn off
    /// "fit pane to viewport" without disconnecting. The lock is also
    /// released automatically on WS disconnect, so callers don't have to
    /// send this — it's just an explicit cleanup hook.
    #[serde(rename = "restore-size")]
    RestoreSize {
        #[serde(rename = "p")]
        pane: String,
    },
    /// Client-side diagnostic events. The client buffers events
    /// (taps, perf timings, errors) and ships them as a batch.
    /// The daemon writes them to its diag-log file IFF
    /// AppState.diag_log_path is Some — otherwise it silently
    /// drops them (default privacy-preserving behavior).
    #[serde(rename = "diag")]
    Diag {
        #[serde(default)]
        events: Vec<serde_json::Value>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "t")]
enum ServerReply {
    #[serde(rename = "snapshot")]
    Snapshot {
        #[serde(rename = "p")]
        pane: String,
        #[serde(default)]
        req: Option<String>,
        screen: crate::Screen,
    },
    #[serde(rename = "ack")]
    Ack {
        #[serde(rename = "for")]
        for_kind: String,
        ok: bool,
        message: Option<String>,
    },
    #[serde(rename = "err")]
    Err { message: String },
}

async fn handle_socket(socket: WebSocket, app: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();

    // Subscriber state: which panes is this client subscribed to, and what
    // event kinds.
    let mut subs: Vec<(PaneId, broadcast::Receiver<LiveEvent>, HashSet<String>)> = Vec::new();

    // Per-connection set of window IDs this client has switched to
    // `window-size manual` via the `resize` command. Used to refcount the
    // lock in AppState.resized_windows so window-size is restored to
    // `latest` once the last interested client disconnects (or sends
    // `restore-size`). Without this, "Fit pane to viewport" in tuiv3 or
    // the tmux-web panel pin pins the window forever, breaking xterm
    // clients that expect their own size to drive the pane.
    let mut held_windows: HashSet<String> = HashSet::new();

    // Two select branches: client commands AND fan-in of pane broadcasts.
    // To select over a dynamic set of receivers we do a small poll-based merge.
    // Labeled `'conn` so the inner branches can break-out-with-cleanup.
    'conn: loop {
        // Build a set of live event futures from current subs.
        // tokio::select! over a Vec of futures isn't direct — we use a small
        // helper: poll each receiver in turn with try_recv() each tick.
        tokio::select! {
            biased;
            client_msg = receiver.next() => {
                match client_msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ClientMsg>(&text) {
                            Ok(cmd) => {
                                if let Err(e) = handle_client_msg(&app, cmd, &mut subs, &mut held_windows, &mut sender).await {
                                    warn!("ws client msg handling failed: {e}");
                                }
                            }
                            Err(e) => {
                                let reply = ServerReply::Err {
                                    message: format!("bad json: {e}"),
                                };
                                let _ = sender.send(Message::Text(serde_json::to_string(&reply).unwrap())).await;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        debug!("ws client closed");
                        break;
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = sender.send(Message::Pong(p)).await;
                    }
                    Some(Ok(_)) => { /* binary, pong: ignore */ }
                    Some(Err(e)) => {
                        warn!("ws receive error: {e}");
                        break;
                    }
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)), if !subs.is_empty() => {
                // Drain any pending broadcast events without blocking.
                let mut to_remove = Vec::new();
                for (i, (_pane, rx, kinds)) in subs.iter_mut().enumerate() {
                    loop {
                        match rx.try_recv() {
                            Ok(ev) => {
                                if event_matches_kinds(&ev, kinds) {
                                    let json = serde_json::to_string(&ev).unwrap_or_default();
                                    if sender.send(Message::Text(json)).await.is_err() {
                                        break 'conn;
                                    }
                                }
                            }
                            Err(broadcast::error::TryRecvError::Empty) => break,
                            Err(broadcast::error::TryRecvError::Lagged(n)) => {
                                warn!("ws subscriber lagged by {n}; consider re-snapshotting");
                            }
                            Err(broadcast::error::TryRecvError::Closed) => {
                                to_remove.push(i);
                                break;
                            }
                        }
                    }
                }
                for i in to_remove.into_iter().rev() {
                    subs.swap_remove(i);
                }
            }
        }
    }

    // Release any window-size locks this connection was holding. When the
    // refcount for a window drops to 0, restore window-size to `latest`
    // so client-driven sizing resumes for everyone else attached to it.
    for window_id in held_windows.drain() {
        release_window_lock(&app, &window_id).await;
    }
}

/// Decrement the refcount for a window and, if it drops to 0, restore
/// `window-size` to `latest`. Called from both the WS-disconnect cleanup
/// and the explicit `restore-size` client message. Safe to call with a
/// window that isn't currently locked (no-op).
async fn release_window_lock(app: &Arc<crate::api::AppState>, window_id: &str) {
    let should_restore = {
        let mut map = match app.resized_windows.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(), // recover from a poisoned mutex
        };
        match map.get_mut(window_id) {
            Some(n) if *n > 1 => {
                *n -= 1;
                false
            }
            Some(_) => {
                map.remove(window_id);
                true
            }
            None => false,
        }
    };
    if !should_restore {
        return;
    }
    let socket = app.tmux_socket.clone();
    let win = window_id.to_string();
    let _ = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("tmux");
        if let Some(s) = &socket {
            cmd.arg("-L").arg(s);
        }
        // `latest` = pane sizes follow the most-recently-attached client.
        // This is the tmux default and what xterm-driven setups expect.
        let _ = cmd
            .args(["set", "-w", "-t", &win, "window-size", "latest"])
            .output();
    })
    .await;
}

fn event_matches_kinds(ev: &LiveEvent, kinds: &HashSet<String>) -> bool {
    if kinds.is_empty() {
        return true;
    }
    let kind = match ev {
        LiveEvent::Output { .. } => "out",
        LiveEvent::Tick { .. } => "tick",
        LiveEvent::Title { .. } => "title",
        LiveEvent::Closed { .. } => "closed",
        LiveEvent::Semantic { .. } => "semantic",
        LiveEvent::CellDiff { .. } => "cell-diff",
        LiveEvent::GridReset { .. } => "grid-reset",
        LiveEvent::ScrollbackAppend { .. } => "scrollback-append",
    };
    kinds.contains(kind)
}

async fn handle_client_msg(
    app: &Arc<AppState>,
    cmd: ClientMsg,
    subs: &mut Vec<(PaneId, broadcast::Receiver<LiveEvent>, HashSet<String>)>,
    held_windows: &mut HashSet<String>,
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
) -> anyhow::Result<()> {
    match cmd {
        ClientMsg::Subscribe { pane, kinds } => {
            let pid = PaneId(pane.clone());
            // Allow subscribing to a pane that hasn't been seen yet — events
            // will start flowing once tmux emits %output for it. This avoids
            // a startup race between the daemon's source and an early client.
            let slot = app.store.ensure(&pid);
            let kinds_set: HashSet<String> = kinds.unwrap_or_default().into_iter().collect();
            subs.push((pid, slot.tx.subscribe(), kinds_set));
            let reply = ServerReply::Ack {
                for_kind: "sub".into(),
                ok: true,
                message: None,
            };
            sender
                .send(Message::Text(serde_json::to_string(&reply)?))
                .await?;
        }
        ClientMsg::Unsubscribe { pane } => {
            subs.retain(|(p, _, _)| p.0 != pane);
            let reply = ServerReply::Ack {
                for_kind: "unsub".into(),
                ok: true,
                message: None,
            };
            sender
                .send(Message::Text(serde_json::to_string(&reply)?))
                .await?;
        }
        ClientMsg::Snapshot { pane, req } => {
            let pid = PaneId(pane.clone());
            match app.store.get(&pid) {
                Some(slot) => {
                    let s = slot.state.read().await;
                    let reply = ServerReply::Snapshot {
                        pane,
                        req,
                        screen: s.term.screen.clone(),
                    };
                    sender
                        .send(Message::Text(serde_json::to_string(&reply)?))
                        .await?;
                }
                None => {
                    let reply = ServerReply::Err {
                        message: format!("unknown pane {pane}"),
                    };
                    sender
                        .send(Message::Text(serde_json::to_string(&reply)?))
                        .await?;
                }
            }
        }
        ClientMsg::Resize { pane, cols, rows } => {
            // `resize-pane` is silently a no-op when there's only one pane in
            // a window (the pane fills the window already). To actually change
            // the drawable area we resize the WINDOW that owns this pane —
            // window-size must be `manual` for this to stick.
            //
            // Side effect to be aware of: `manual` mode is sticky across
            // tmux clients. We refcount per WS connection (held_windows +
            // AppState.resized_windows) so it gets restored to `latest` on
            // the last interested disconnect / explicit `restore-size`.
            let socket = app.tmux_socket.clone();
            let pane_arg = pane.clone();
            let result = tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
                let run = |args: &[&str]| -> anyhow::Result<std::process::Output> {
                    let mut cmd = std::process::Command::new("tmux");
                    if let Some(s) = &socket {
                        cmd.arg("-L").arg(s);
                    }
                    Ok(cmd.args(args).output()?)
                };
                // Look up which window owns this pane.
                let win_out = run(&["display", "-p", "-t", &pane_arg, "#{window_id}"])?;
                if !win_out.status.success() {
                    anyhow::bail!(
                        "tmux display window_id failed: {}",
                        String::from_utf8_lossy(&win_out.stderr)
                    );
                }
                let win = String::from_utf8_lossy(&win_out.stdout).trim().to_string();
                // Switch this window to manual sizing so client size doesn't
                // override; ignore errors (the option may already be set).
                let _ = run(&["set", "-w", "-t", &win, "window-size", "manual"]);
                let out = run(&[
                    "resize-window",
                    "-t",
                    &win,
                    "-x",
                    &cols.to_string(),
                    "-y",
                    &rows.to_string(),
                ])?;
                if !out.status.success() {
                    anyhow::bail!(
                        "tmux resize-window failed: {}",
                        String::from_utf8_lossy(&out.stderr)
                    );
                }
                Ok(win)
            })
            .await
            .map_err(|e| anyhow::anyhow!("join error: {e}"))?;
            let reply = match &result {
                Ok(win) => {
                    // Acquire the lock for this connection iff we don't
                    // already hold it. Refcount must match held_windows
                    // exactly — one increment per (connection, window).
                    if held_windows.insert(win.clone()) {
                        let mut map = match app.resized_windows.lock() {
                            Ok(g) => g,
                            Err(p) => p.into_inner(),
                        };
                        *map.entry(win.clone()).or_insert(0) += 1;
                    }
                    ServerReply::Ack {
                        for_kind: "resize".into(),
                        ok: true,
                        message: None,
                    }
                }
                Err(e) => ServerReply::Ack {
                    for_kind: "resize".into(),
                    ok: false,
                    message: Some(e.to_string()),
                },
            };
            sender
                .send(Message::Text(serde_json::to_string(&reply)?))
                .await?;
        }
        ClientMsg::RestoreSize { pane } => {
            // Look up the window for this pane; if we hold a lock on it,
            // release it. No-op if we don't (e.g. a client sending
            // restore-size without a prior resize).
            let socket = app.tmux_socket.clone();
            let pane_arg = pane.clone();
            let win_result = tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
                let mut cmd = std::process::Command::new("tmux");
                if let Some(s) = &socket {
                    cmd.arg("-L").arg(s);
                }
                let out = cmd
                    .args(["display", "-p", "-t", &pane_arg, "#{window_id}"])
                    .output()?;
                if !out.status.success() {
                    anyhow::bail!(
                        "tmux display window_id failed: {}",
                        String::from_utf8_lossy(&out.stderr)
                    );
                }
                Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
            })
            .await
            .map_err(|e| anyhow::anyhow!("join error: {e}"))?;
            let reply = match win_result {
                Ok(win) => {
                    let was_held = held_windows.remove(&win);
                    if was_held {
                        release_window_lock(app, &win).await;
                    }
                    ServerReply::Ack {
                        for_kind: "restore-size".into(),
                        ok: true,
                        message: if was_held { None } else { Some("not held".into()) },
                    }
                }
                Err(e) => ServerReply::Ack {
                    for_kind: "restore-size".into(),
                    ok: false,
                    message: Some(e.to_string()),
                },
            };
            sender
                .send(Message::Text(serde_json::to_string(&reply)?))
                .await?;
        }
        ClientMsg::Input { pane, keys } => {
            // read-only mode: silently ack with ok=false. Visitors of
            // the demo / spectator endpoint shouldn't be able to type
            // into the host's tmux. Silent rather than disconnecting
            // because some plugins (e.g. ttyview-quickkeys) fire input
            // events on every button tap.
            if app.read_only {
                let reply = ServerReply::Ack {
                    for_kind: "input".into(),
                    ok: false,
                    message: Some("read-only mode".into()),
                };
                sender
                    .send(Message::Text(serde_json::to_string(&reply)?))
                    .await?;
                let _ = (pane, keys);
                return Ok(());
            }
            // Forward to tmux send-keys. Splits at 16KB to dodge the
            // documented send-keys size limit.
            let socket = app.tmux_socket.clone();
            let result = tokio::task::spawn_blocking(move || {
                send_keys_chunked(socket.as_deref(), &pane, &keys)
            })
            .await
            .map_err(|e| anyhow::anyhow!("join error: {e}"))?;
            let reply = match result {
                Ok(()) => ServerReply::Ack {
                    for_kind: "input".into(),
                    ok: true,
                    message: None,
                },
                Err(e) => ServerReply::Ack {
                    for_kind: "input".into(),
                    ok: false,
                    message: Some(e.to_string()),
                },
            };
            sender
                .send(Message::Text(serde_json::to_string(&reply)?))
                .await?;
        }
        ClientMsg::Diag { events } => {
            // Privacy-preserving by default: events are dropped unless
            // the operator opted in via `--diag-log <path>`.
            if let Some(path) = &app.diag_log_path {
                if let Err(e) = append_diag_events(path, &events).await {
                    tracing::warn!("diag-log write failed: {e}");
                }
            }
            // No ack — diag is fire-and-forget to keep client overhead
            // minimal. If the operator needs reliability, the events
            // are also retained in the client's ring buffer between
            // flushes.
        }
    }
    Ok(())
}

async fn append_diag_events(
    path: &std::path::Path,
    events: &[serde_json::Value],
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    if events.is_empty() {
        return Ok(());
    }
    let mut buf = String::new();
    for ev in events {
        // Each line is one JSONL record. Stamp with server-receive time
        // so log readers don't need to trust client clocks.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut line = serde_json::Map::new();
        line.insert("server_ts".into(), serde_json::json!(now));
        if let Some(obj) = ev.as_object() {
            for (k, v) in obj {
                line.insert(k.clone(), v.clone());
            }
        } else {
            line.insert("payload".into(), ev.clone());
        }
        buf.push_str(&serde_json::to_string(&line)?);
        buf.push('\n');
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    file.write_all(buf.as_bytes()).await?;
    Ok(())
}

fn send_keys_chunked(socket: Option<&str>, pane: &str, keys: &str) -> anyhow::Result<()> {
    // Strategy: split off the trailing CR (if any) and send it as a
    // separate `tmux send-keys Enter` call AFTER a short delay. This is
    // the "paste-then-delayed-Enter" pattern that Claude Code's TUI
    // requires — a single `send-keys -l <message>\r` lands as a paste
    // burst where the trailing CR is treated as a soft newline and
    // submit never fires. The user's "submit didn't work" report on
    // 2026-05-09 was this: the message reached CC's input box but the
    // Enter was eaten by paste handling. Symptom in the diag log was
    // exactly one `inp` event followed by no CC progress.
    //
    // Other terminal apps (bash, vim) accept literal CR as Enter, so
    // we keep that path for non-trailing CR — only the LAST one is
    // promoted to a real Enter key event.
    let send_text = |chunk: &str| -> anyhow::Result<()> {
        if chunk.is_empty() { return Ok(()); }
        const CHUNK: usize = 8 * 1024;
        let mut i = 0;
        let bytes = chunk.as_bytes();
        while i < bytes.len() {
            let end = (i + CHUNK).min(bytes.len());
            let mut split = end;
            while split > i && (bytes[split - 1] & 0xc0) == 0x80 {
                split -= 1;
            }
            if split == i { split = end; }
            let part = std::str::from_utf8(&bytes[i..split]).map_err(|e| anyhow::anyhow!("{e}"))?;
            let mut cmd = std::process::Command::new("tmux");
            if let Some(s) = socket { cmd.arg("-L").arg(s); }
            let output = cmd.args(["send-keys", "-l", "-t", pane, part]).output()?;
            if !output.status.success() {
                anyhow::bail!("tmux send-keys -l failed: {}",
                    String::from_utf8_lossy(&output.stderr));
            }
            i = split;
        }
        Ok(())
    };
    let send_enter = || -> anyhow::Result<()> {
        let mut cmd = std::process::Command::new("tmux");
        if let Some(s) = socket { cmd.arg("-L").arg(s); }
        let output = cmd.args(["send-keys", "-t", pane, "Enter"]).output()?;
        if !output.status.success() {
            anyhow::bail!("tmux send-keys Enter failed: {}",
                String::from_utf8_lossy(&output.stderr));
        }
        Ok(())
    };

    if keys.ends_with('\r') {
        let body = &keys[..keys.len() - 1];
        send_text(body)?;
        // 50 ms is empirically enough to make CC's paste-detection close
        // its current paste burst before the Enter arrives. Shorter
        // delays sometimes still get folded; longer than ~150ms shows
        // up as visible lag on submit.
        std::thread::sleep(std::time::Duration::from_millis(50));
        send_enter()?;
    } else {
        send_text(keys)?;
    }
    Ok(())
}

#[cfg(test)]
mod origin_tests {
    use super::*;
    use axum::http::HeaderValue;

    fn hdrs(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn no_origin_allowed() {
        // Server-side WS clients (broker bridge, wscat) send no Origin.
        let h = hdrs(&[("host", "localhost:7681")]);
        assert!(origin_allowed(&h, &[]));
    }

    #[test]
    fn empty_or_null_origin_allowed() {
        // file:// pages send `Origin: null`. Don't break local docs.
        let h = hdrs(&[("origin", "null"), ("host", "localhost:7681")]);
        assert!(origin_allowed(&h, &[]));
    }

    #[test]
    fn same_origin_allowed() {
        let h = hdrs(&[
            ("origin", "http://localhost:7681"),
            ("host", "localhost:7681"),
        ]);
        assert!(origin_allowed(&h, &[]));
    }

    #[test]
    fn same_origin_https_allowed() {
        let h = hdrs(&[
            ("origin", "https://eyalev-thinkpad.taild2ae6a.ts.net:7785"),
            ("host", "eyalev-thinkpad.taild2ae6a.ts.net:7785"),
        ]);
        assert!(origin_allowed(&h, &[]));
    }

    #[test]
    fn cross_origin_blocked() {
        // The core finding: evil.com tab tries to WS to localhost daemon.
        let h = hdrs(&[
            ("origin", "https://evil.com"),
            ("host", "127.0.0.1:7681"),
        ]);
        assert!(!origin_allowed(&h, &[]));
    }

    #[test]
    fn allowlist_exact_match() {
        let h = hdrs(&[
            ("origin", "https://my-frontend.example.com"),
            ("host", "ttyview-daemon.local:7681"),
        ]);
        let allow = vec!["https://my-frontend.example.com".to_string()];
        assert!(origin_allowed(&h, &allow));
    }

    #[test]
    fn allowlist_does_not_match_substring() {
        // Defense against `https://evil.com.example.com` aliasing past
        // `https://example.com` if we'd used a startsWith check.
        let h = hdrs(&[
            ("origin", "https://evil.com.example.com"),
            ("host", "ttyview-daemon.local:7681"),
        ]);
        let allow = vec!["https://example.com".to_string()];
        assert!(!origin_allowed(&h, &allow));
    }

    #[test]
    fn origin_with_path_normalised_to_authority_for_host_match() {
        // Some clients (or proxies) might tack on a trailing slash —
        // we ignore everything after the authority. WHATWG says Origin
        // shouldn't carry a path but be lenient.
        let h = hdrs(&[
            ("origin", "http://localhost:7681/"),
            ("host", "localhost:7681"),
        ]);
        assert!(origin_allowed(&h, &[]));
    }
}
