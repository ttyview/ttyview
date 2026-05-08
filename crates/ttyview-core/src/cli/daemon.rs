//! `panel daemon` — long-running HTTP+WS server.
//!
//! Attaches to tmux control mode, ingests events into a `PaneStore`, exposes
//! the store over HTTP and WebSocket. Keeps running until Ctrl-C / SIGTERM.

use crate::api::AppState;
use crate::source::{multi_session::MultiSession, PaneId, SourceEvent};
use crate::state::{run_cell_diff_broadcaster, seed_pane, PaneStore};
use anyhow::{Context, Result};
use std::net::SocketAddr;
use std::path::Path;
use tokio::process::Command;
use tokio::signal::unix::{signal, SignalKind};
use tracing::{info, warn};

pub async fn run(addr: SocketAddr, socket: Option<&str>, rows: u16, cols: u16) -> Result<()> {
    run_with_options(addr, socket, rows, cols, None, None, None, None).await
}

pub async fn run_with_tls(
    addr: SocketAddr,
    socket: Option<&str>,
    rows: u16,
    cols: u16,
    tls_cert: Option<&Path>,
    tls_key: Option<&Path>,
) -> Result<()> {
    run_with_options(addr, socket, rows, cols, tls_cert, tls_key, None, None).await
}

pub async fn run_with_options(
    addr: SocketAddr,
    socket: Option<&str>,
    rows: u16,
    cols: u16,
    tls_cert: Option<&Path>,
    tls_key: Option<&Path>,
    diag_log: Option<&Path>,
    registry_url: Option<&str>,
) -> Result<()> {
    // Install rustls crypto provider once. axum-server (TLS) and reqwest
    // (outbound HTTPS for the remote registry) both use rustls 0.23+,
    // which refuses to pick a default provider when more than one is
    // available. Calling install_default() on first run fixes that;
    // .ok() ignores the second-call error when something else (a test
    // harness, a future caller) has already installed one.
    let _ = rustls::crypto::ring::default_provider().install_default();
    info!("panel daemon starting; tmux socket = {:?}; bind = {addr}", socket);
    let mut store = PaneStore::new(rows, cols);
    store.set_tmux_socket(socket.map(String::from));
    store.install_tracer_from_env().await;

    // 0. Pre-populate panes via `list-panes` so /panes is useful immediately,
    // even before any %output arrives. Without this, panes only show up after
    // the first byte of activity.
    if let Err(e) = prepopulate_panes(&store, socket).await {
        warn!("could not prepopulate panes: {e}");
    }

    // 1. Spawn one tmux control client per session and merge their event
    //    streams. A single `tmux -C attach` only emits %output for panes in
    //    the session it landed on, so a single attach left panes in other
    //    sessions stuck at their startup snapshot. MultiSession reconciles
    //    against `list-sessions` every 5 s, so new tmux sessions get picked
    //    up automatically.
    let (_multi, mut rx) = MultiSession::spawn(socket.map(String::from), Some(store.clone()))
        .await
        .context("starting multi-session tmux source")?;

    let store_for_ingest = store.clone();
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            store_for_ingest.apply(ev).await;
        }
        warn!("tmux source closed");
    });

    // Wpin7 cell-diff broadcaster — ticks every 50 ms, fans out per-cell
    // diffs over WS for any pane whose grid mutated since the last tick.
    // Server-side coalesce keeps WS bandwidth bounded under high
    // throughput (a streaming CC response generates hundreds of feeds
    // per second; without this each one would be its own WS frame).
    let store_for_diff = store.clone();
    tokio::spawn(async move {
        run_cell_diff_broadcaster(store_for_diff).await;
    });

    // 2. Build HTTP+WS app and serve.
    let app = crate::api::router(AppState {
        store: store.clone(),
        tmux_socket: socket.map(String::from),
        resized_windows: std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )),
        diag_log_path: diag_log.map(|p| p.to_path_buf()),
        registry_url: registry_url.map(String::from),
    });
    // 3. Wait for a shutdown signal — used by both HTTP and TLS paths.
    let shutdown = async {
        let mut sigterm = signal(SignalKind::terminate()).expect("sigterm handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => info!("ctrl-c"),
            _ = sigterm.recv() => info!("sigterm"),
        }
    };

    if let (Some(cert), Some(key)) = (tls_cert, tls_key) {
        info!("listening on https://{addr} (cert={}, key={})", cert.display(), key.display());
        let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key)
            .await
            .with_context(|| format!("loading TLS cert/key from {}/{}", cert.display(), key.display()))?;
        let handle = axum_server::Handle::new();
        let handle_for_shutdown = handle.clone();
        tokio::spawn(async move {
            shutdown.await;
            handle_for_shutdown.graceful_shutdown(Some(std::time::Duration::from_secs(5)));
        });
        axum_server::bind_rustls(addr, tls_config)
            .handle(handle)
            .serve(app.into_make_service())
            .await
            .context("axum-server (TLS)")?;
    } else {
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("binding {addr}"))?;
        info!("listening on http://{addr}");
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown)
            .await
            .context("axum serve")?;
    }
    Ok(())
}

async fn prepopulate_panes(store: &PaneStore, socket: Option<&str>) -> Result<()> {
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args([
            "list-panes",
            "-aF",
            "#{pane_id}\t#{session_name}\t#{window_index}",
        ])
        .output()
        .await
        .context("tmux list-panes")?;
    if !out.status.success() {
        anyhow::bail!(
            "tmux list-panes failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        let mut parts = line.split('\t');
        let id = match parts.next() {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        let session = parts.next().map(String::from);
        let window = parts.next().map(String::from);
        let pane_id = PaneId(id.to_string());
        store
            .apply(SourceEvent::PaneAdded {
                pane: pane_id.clone(),
                session,
                window,
            })
            .await;
        if let Err(e) = seed_pane(store, socket, &pane_id).await {
            warn!("seed_pane({}) failed: {e}", pane_id.0);
        }
    }
    info!("prepopulated {} panes", store.list().len());
    Ok(())
}
