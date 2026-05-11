//! ttyview-sandbox — per-visitor sandbox broker.
//!
//! Spins up a fresh `tmux` server + a `ttyview` per session,
//! reverse-proxies HTTP + WebSocket by session id, garbage-collects
//! idle sessions.
//!
//! Routes:
//!   GET  /                     → landing HTML with "Start a session" link
//!   POST /sessions             → spawn a new sandbox; redirect to /s/<id>/
//!   GET  /s/<id>/              → ttyview UI (served by the per-session daemon)
//!   GET  /s/<id>/<anything>    → reverse-proxied to 127.0.0.1:<port>/<anything>
//!   GET  /s/<id>/ws            → WebSocket reverse-proxy
//!
//! Each session runs:
//!   tmux -L ttv-sb-<id> new-session -d -s box bash
//!   ttyview --bind 127.0.0.1:<port> --socket ttv-sb-<id>
//!
//! Cleanup loop: every 60 s, kills sessions whose last_activity is
//! older than --idle-timeout (default 15 min).

use anyhow::{Context, Result};
use axum::{
    body::Body,
    extract::{Path, State, WebSocketUpgrade},
    http::{header, Method, Request, StatusCode, Uri},
    response::{Html, IntoResponse, Json, Redirect, Response},
    routing::{any, get, post},
    Router,
};
use bytes::Bytes;
use clap::Parser;
use http_body_util::BodyExt;
use rand::Rng;
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tracing::{info, warn};

#[derive(Parser, Debug)]
#[command(name = "ttyview-sandbox", version, about)]
struct Cli {
    /// Address to bind the broker on.
    #[arg(long, default_value = "0.0.0.0:8080")]
    bind: SocketAddr,

    /// Path to the ttyview binary spawned per session.
    #[arg(long, default_value = "/usr/local/bin/ttyview")]
    daemon_bin: PathBuf,

    /// Range of TCP ports allocated to per-session daemons (inclusive).
    /// Sessions reserve a port from this range; capacity = max-min+1.
    #[arg(long, default_value_t = 19000)]
    port_min: u16,
    #[arg(long, default_value_t = 19099)]
    port_max: u16,

    /// Kill a session after this many minutes of no requests.
    #[arg(long, default_value_t = 15)]
    idle_timeout_min: u64,

    /// Maximum number of concurrent sessions.
    #[arg(long, default_value_t = 100)]
    max_sessions: usize,
}

#[derive(Debug)]
struct Session {
    id: String,
    port: u16,
    socket_name: String,
    daemon_pid: u32,
    last_activity: Instant,
}

#[derive(Clone)]
struct AppState {
    cfg: Arc<Cli>,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    used_ports: Arc<Mutex<std::collections::HashSet<u16>>>,
    http_client: Arc<reqwest::Client>,
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .init();
    let cli = Cli::parse();
    info!("ttyview-sandbox starting on {}", cli.bind);
    let state = AppState {
        cfg: Arc::new(cli),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        used_ports: Arc::new(Mutex::new(std::collections::HashSet::new())),
        http_client: Arc::new(
            reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
        ),
    };
    // Spawn cleanup loop
    {
        let state = state.clone();
        tokio::spawn(async move { cleanup_loop(state).await });
    }

    let app = Router::new()
        .route("/", get(landing))
        .route("/healthz", get(|| async { "ok" }))
        .route("/sessions", post(create_session))
        .route("/s/:id/ws", any(ws_proxy))
        .route("/s/:id", get(redirect_with_slash))
        .route("/s/:id/", any(http_proxy))
        .route("/s/:id/*rest", any(http_proxy))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(state.cfg.bind)
        .await
        .with_context(|| format!("binding {}", state.cfg.bind))?;
    axum::serve(listener, app).await?;
    Ok(())
}

const LANDING_HTML: &str = r##"<!doctype html>
<html><head><meta charset="utf-8"><title>ttyview sandbox</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; background: #1e1e1e; color: #d4d4d4; padding: 30px; line-height: 1.5; max-width: 640px; margin: auto; }
  h1 { color: #6ed29a; }
  .btn { display: inline-block; padding: 12px 24px; background: #6ed29a; color: #1e1e1e; text-decoration: none; font-weight: 600; border-radius: 6px; margin-top: 12px; border: none; font-size: 16px; cursor: pointer; }
  .btn:hover { filter: brightness(1.1); }
  code { background: #2a2a2a; padding: 2px 6px; border-radius: 3px; }
  .meta { color: #888; font-size: 13px; margin-top: 24px; }
</style></head>
<body>
  <h1>ttyview sandbox</h1>
  <p>Click the button below to spin up a fresh, ephemeral tmux + ttyview for you to play with. The session is private to your URL and self-destructs after <span id="idle"></span> minutes of inactivity.</p>
  <p>What you can do inside:</p>
  <ul>
    <li>Type into the bash prompt — keystrokes go to a real shell.</li>
    <li>Open Settings (⚙) → Discover and install plugins.</li>
    <li>Try the Cmd-K command palette.</li>
    <li>Switch terminal views (cell-grid, plain text, Claude Code).</li>
  </ul>
  <p><a href="#" class="btn" id="start">Start a session →</a></p>
  <p class="meta">Source: <a href="https://github.com/ttyview/ttyview" style="color: #6ed29a">github.com/ttyview/ttyview</a></p>
<script>
  const btn = document.getElementById('start');
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    btn.textContent = 'Starting…';
    try {
      const r = await fetch('/sessions', { method: 'POST' });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'failed');
      window.location.href = '/s/' + data.id + '/';
    } catch (err) {
      btn.textContent = 'Failed: ' + err.message;
    }
  });
</script>
</body></html>"##;

async fn landing(State(state): State<AppState>) -> Html<String> {
    Html(LANDING_HTML.replace(
        r#"<span id="idle"></span>"#,
        &format!("<span id=\"idle\">{}</span>", state.cfg.idle_timeout_min),
    ))
}

#[derive(Serialize)]
struct CreateSessionResp {
    ok: bool,
    id: Option<String>,
    error: Option<String>,
}

async fn create_session(State(state): State<AppState>) -> impl IntoResponse {
    match spawn_session(&state).await {
        Ok(id) => (
            StatusCode::OK,
            Json(CreateSessionResp { ok: true, id: Some(id), error: None }),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(CreateSessionResp { ok: false, id: None, error: Some(e.to_string()) }),
        ),
    }
}

async fn spawn_session(state: &AppState) -> Result<String> {
    {
        let sessions = state.sessions.lock().await;
        if sessions.len() >= state.cfg.max_sessions {
            anyhow::bail!("server is full ({} sessions)", sessions.len());
        }
    }
    let id = random_id(8);
    let socket_name = format!("ttv-sb-{id}");
    let port = pick_port(state).await?;

    // 1. Start a fresh tmux server with one session running bash.
    let tmux_status = tokio::process::Command::new("tmux")
        .args(["-L", &socket_name, "new-session", "-d", "-s", "box", "bash"])
        .status()
        .await
        .with_context(|| "spawning tmux")?;
    if !tmux_status.success() {
        release_port(state, port).await;
        anyhow::bail!("tmux new-session failed");
    }

    // 2. Spawn ttyview attached to that tmux server.
    let daemon = tokio::process::Command::new(&state.cfg.daemon_bin)
        .args([
            "--bind",
            &format!("127.0.0.1:{port}"),
            "--socket",
            &socket_name,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .kill_on_drop(false)
        .spawn()
        .with_context(|| "spawning ttyview")?;
    let daemon_pid = daemon.id().unwrap_or(0);
    // Detach — we track by pid below.
    std::mem::forget(daemon);

    // 3. Wait for the daemon to bind. Up to 5s; bail otherwise so the
    //    visitor doesn't get a 502 on the first proxy request.
    let mut waited = 0;
    loop {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            break;
        }
        if waited >= 50 {
            kill_session_processes(daemon_pid, &socket_name).await;
            release_port(state, port).await;
            anyhow::bail!("daemon never bound to port {port}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        waited += 1;
    }

    let session = Session {
        id: id.clone(),
        port,
        socket_name,
        daemon_pid,
        last_activity: Instant::now(),
    };
    info!(
        "session {id}: spawned daemon pid={} on port={} socket={}",
        session.daemon_pid, session.port, session.socket_name
    );
    state.sessions.lock().await.insert(id.clone(), session);
    Ok(id)
}

fn random_id(n: usize) -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..n).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

async fn pick_port(state: &AppState) -> Result<u16> {
    let mut used = state.used_ports.lock().await;
    for p in state.cfg.port_min..=state.cfg.port_max {
        if !used.contains(&p) {
            used.insert(p);
            return Ok(p);
        }
    }
    anyhow::bail!("no free ports in range")
}

async fn release_port(state: &AppState, port: u16) {
    state.used_ports.lock().await.remove(&port);
}

async fn kill_session_processes(daemon_pid: u32, socket_name: &str) {
    if daemon_pid != 0 {
        // SIGTERM the daemon — it has a graceful_shutdown handler.
        unsafe { libc_kill(daemon_pid as i32, 15) };
    }
    let _ = tokio::process::Command::new("tmux")
        .args(["-L", socket_name, "kill-server"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

async fn redirect_with_slash(Path(id): Path<String>) -> Redirect {
    Redirect::temporary(&format!("/s/{id}/"))
}

// === HTTP reverse-proxy ===

async fn http_proxy(
    State(state): State<AppState>,
    Path(params): Path<HashMap<String, String>>,
    req: Request<Body>,
) -> Response {
    let id = match params.get("id") {
        Some(id) => id.clone(),
        None => return (StatusCode::BAD_REQUEST, "missing id").into_response(),
    };
    let port = {
        let mut sessions = state.sessions.lock().await;
        match sessions.get_mut(&id) {
            Some(s) => {
                s.last_activity = Instant::now();
                s.port
            }
            None => return (StatusCode::NOT_FOUND, "session not found").into_response(),
        }
    };
    proxy_http_to(state.http_client.clone(), port, &id, req).await
}

async fn proxy_http_to(
    client: Arc<reqwest::Client>,
    port: u16,
    id: &str,
    req: Request<Body>,
) -> Response {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_string();
    // Strip the /s/<id> prefix; the daemon expects root paths.
    let prefix = format!("/s/{id}");
    let stripped = path.strip_prefix(&prefix).unwrap_or(&path);
    let stripped = if stripped.is_empty() { "/" } else { stripped };
    let query = parts.uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let upstream = format!("http://127.0.0.1:{port}{stripped}{query}");

    let body_bytes = match body.collect().await {
        Ok(b) => b.to_bytes(),
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("body read: {e}")).into_response(),
    };

    let method = match reqwest::Method::from_bytes(parts.method.as_str().as_bytes()) {
        Ok(m) => m,
        Err(_) => return (StatusCode::BAD_GATEWAY, "bad method").into_response(),
    };
    let mut builder = client.request(method, &upstream);
    for (k, v) in parts.headers.iter() {
        let name = k.as_str();
        // hop-by-hop headers don't pass through proxies
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "host" | "connection" | "transfer-encoding" | "upgrade" | "te" | "trailers" | "proxy-authorization" | "proxy-authenticate"
        ) {
            continue;
        }
        builder = builder.header(name, v.as_bytes());
    }
    if !body_bytes.is_empty() {
        builder = builder.body(body_bytes.to_vec());
    }
    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("upstream: {e}")).into_response(),
    };
    let status = StatusCode::from_u16(resp.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut out = Response::builder().status(status);
    for (k, v) in resp.headers().iter() {
        let name = k.as_str();
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "content-length" | "transfer-encoding" | "connection"
        ) {
            continue;
        }
        out = out.header(name, v.as_bytes());
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("read body: {e}")).into_response(),
    };
    out.body(Body::from(bytes)).unwrap()
}

// === WebSocket reverse-proxy ===

async fn ws_proxy(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
    req: Request<Body>,
) -> Response {
    let port = {
        let mut sessions = state.sessions.lock().await;
        match sessions.get_mut(&id) {
            Some(s) => {
                s.last_activity = Instant::now();
                s.port
            }
            None => return (StatusCode::NOT_FOUND, "session not found").into_response(),
        }
    };
    // Reconstruct the upstream URL — same path the visitor hit minus
    // the /s/<id> prefix. Daemon listens at /ws.
    let path = req.uri().path();
    let stripped = path.strip_prefix(&format!("/s/{id}")).unwrap_or(path);
    let upstream_url = format!("ws://127.0.0.1:{port}{stripped}");
    ws.on_upgrade(move |client_ws| async move {
        if let Err(e) = bridge_ws(client_ws, &upstream_url).await {
            warn!("ws bridge {upstream_url}: {e}");
        }
    })
}

async fn bridge_ws(client_ws: axum::extract::ws::WebSocket, upstream_url: &str) -> Result<()> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as TMsg;
    let (upstream_ws, _resp) = tokio_tungstenite::connect_async(upstream_url)
        .await
        .with_context(|| format!("connect {upstream_url}"))?;
    let (mut client_tx, mut client_rx) = client_ws.split();
    let (mut up_tx, mut up_rx) = upstream_ws.split();
    let c2u = async {
        while let Some(msg) = client_rx.next().await {
            let m = match msg {
                Ok(axum::extract::ws::Message::Text(t)) => TMsg::Text(t),
                Ok(axum::extract::ws::Message::Binary(b)) => TMsg::Binary(b),
                Ok(axum::extract::ws::Message::Ping(p)) => TMsg::Ping(p),
                Ok(axum::extract::ws::Message::Pong(p)) => TMsg::Pong(p),
                Ok(axum::extract::ws::Message::Close(_)) | Err(_) => break,
            };
            if up_tx.send(m).await.is_err() { break; }
        }
        let _ = up_tx.send(TMsg::Close(None)).await;
    };
    let u2c = async {
        while let Some(msg) = up_rx.next().await {
            let m = match msg {
                Ok(TMsg::Text(t)) => axum::extract::ws::Message::Text(t),
                Ok(TMsg::Binary(b)) => axum::extract::ws::Message::Binary(b),
                Ok(TMsg::Ping(p)) => axum::extract::ws::Message::Ping(p),
                Ok(TMsg::Pong(p)) => axum::extract::ws::Message::Pong(p),
                Ok(TMsg::Close(_)) | Ok(TMsg::Frame(_)) | Err(_) => break,
            };
            if client_tx.send(m).await.is_err() { break; }
        }
        let _ = client_tx.send(axum::extract::ws::Message::Close(None)).await;
    };
    tokio::select! {
        _ = c2u => {},
        _ = u2c => {},
    }
    Ok(())
}

// === Cleanup loop ===

async fn cleanup_loop(state: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    let idle = Duration::from_secs(state.cfg.idle_timeout_min * 60);
    loop {
        tick.tick().await;
        let now = Instant::now();
        let mut to_kill: Vec<Session> = Vec::new();
        {
            let mut sessions = state.sessions.lock().await;
            sessions.retain(|id, s| {
                if now.duration_since(s.last_activity) > idle {
                    info!("session {id}: idle timeout, killing");
                    to_kill.push(Session {
                        id: s.id.clone(),
                        port: s.port,
                        socket_name: s.socket_name.clone(),
                        daemon_pid: s.daemon_pid,
                        last_activity: s.last_activity,
                    });
                    false
                } else {
                    true
                }
            });
        }
        for s in to_kill {
            kill_session_processes(s.daemon_pid, &s.socket_name).await;
            release_port(&state, s.port).await;
        }
    }
}

// silence unused-import warnings on `Method`, `Uri`, `Bytes`, `header` in
// future refactors — kept here so the `use` block stays organised.
#[allow(dead_code)]
fn _suppress_unused() {
    let _: Method;
    let _: Uri;
    let _: Bytes;
    let _ = header::CONTENT_TYPE;
}
