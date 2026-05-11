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

/// All daemon-startup knobs in one struct. Lets the binary pass new
/// flags without breaking every existing call site of `run_with_options`.
pub struct RunOptions {
    pub addr: SocketAddr,
    pub socket: Option<String>,
    pub rows: u16,
    pub cols: u16,
    pub tls_cert: Option<std::path::PathBuf>,
    pub tls_key: Option<std::path::PathBuf>,
    pub diag_log: Option<std::path::PathBuf>,
    pub registry_url: Option<String>,
    pub demo_mode: bool,
    pub read_only: bool,
    /// Per-instance config dir. None = default ($HOME/.config/ttyview).
    /// Holds installed plugins + their index. Browsers further isolate
    /// per-origin localStorage automatically.
    pub config_dir: Option<std::path::PathBuf>,
    /// Human-readable name for this daemon instance. Returned by
    /// `GET /api/instance`; null when unset.
    pub app_name: Option<String>,
    /// Where staged + archived image uploads live. None = default
    /// (`~/.cache/ttyview/uploads`). `<dir>/staging/` holds files
    /// awaiting send; the dir itself holds sent pastes (kept until
    /// the user clears them).
    pub uploads_dir: Option<std::path::PathBuf>,
    /// Extra origins allowed to open a WebSocket beyond same-origin.
    /// Plumbed into `AppState.allowed_origins`; see that field for
    /// the policy. Empty by default. Embedders that don't surface a
    /// `--allow-origin` flag (mobile-cc, the sandbox broker's
    /// per-session daemon) pass `Vec::new()`.
    pub allowed_origins: Vec<String>,
}

pub async fn run_with_options_v2(opts: RunOptions) -> Result<()> {
    run_with_options_inner(opts).await
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
    run_with_options_inner(RunOptions {
        addr,
        socket: socket.map(String::from),
        rows,
        cols,
        tls_cert: tls_cert.map(|p| p.to_path_buf()),
        tls_key: tls_key.map(|p| p.to_path_buf()),
        diag_log: diag_log.map(|p| p.to_path_buf()),
        registry_url: registry_url.map(String::from),
        demo_mode: false,
        read_only: false,
        config_dir: None,
        app_name: None,
        uploads_dir: None,
        allowed_origins: Vec::new(),
    }).await
}

async fn run_with_options_inner(opts: RunOptions) -> Result<()> {
    let RunOptions {
        addr, socket, rows, cols,
        tls_cert, tls_key, diag_log, registry_url,
        demo_mode, read_only, config_dir, app_name, uploads_dir,
        allowed_origins,
    } = opts;
    let socket = socket.as_deref();
    let tls_cert = tls_cert.as_deref();
    let tls_key = tls_key.as_deref();
    let diag_log = diag_log.as_deref();
    let registry_url = registry_url.as_deref();
    // Resolve the per-instance config dir.
    //
    // Default policy: each daemon gets its own dir keyed by bind port,
    // at `~/.config/ttyview/<port>/`. Running two daemons on different
    // ports gives independent plugin sets out of the box, with no
    // `--config-dir` flag needed.
    //
    // First-run migration: the legacy single-shared dir was
    // `~/.config/ttyview/{plugins,installed.json}`. If a fresh
    // port-keyed dir doesn't exist yet AND the legacy dir has content,
    // copy it once so existing single-instance users don't lose their
    // installed plugins on upgrade. Subsequent boots see the per-port
    // dir already populated and skip the migration.
    let home_base = {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        std::path::PathBuf::from(home).join(".config/ttyview")
    };
    let resolved_config_dir = config_dir.clone().unwrap_or_else(|| {
        let dir = home_base.join(addr.port().to_string());
        // Migrate if needed (sync, one-shot, before any plugin work).
        let legacy_plugins = home_base.join("plugins");
        let new_plugins = dir.join("plugins");
        if !new_plugins.exists() && legacy_plugins.exists() {
            if let Err(e) = std::fs::create_dir_all(&dir) {
                warn!("config_dir migration: create_dir_all({}): {e}", dir.display());
            } else if let Err(e) = copy_dir_recursive(&legacy_plugins, &new_plugins) {
                warn!("config_dir migration: copy {} → {}: {e}",
                    legacy_plugins.display(), new_plugins.display());
            } else {
                info!("config_dir migration: copied {} → {}",
                    legacy_plugins.display(), new_plugins.display());
            }
        }
        dir
    });
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

    if demo_mode {
        // No tmux. Seed one synthetic pane that the CC view can attach
        // to. The cc-transcript endpoint short-circuits in demo mode
        // and serves the bundled JSONL regardless of pane id.
        info!("demo mode — skipping tmux; seeding synthetic pane %demo");
        store
            .apply(SourceEvent::PaneAdded {
                pane: PaneId("%demo".into()),
                session: Some("demo".into()),
                window: Some("0".into()),
            })
            .await;
        // Auto-install the curated demo plugins so the page lands in a
        // presentable state on first visit. Best-effort — log on
        // failure but don't block startup.
        if let Err(e) = crate::api::plugins::demo_install_curated(&resolved_config_dir).await {
            warn!("demo: auto-install failed: {e}");
        }
    } else {
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
        // _multi must outlive the spawn; leaking it keeps the source alive
        // for the lifetime of the daemon (same as before).
        std::mem::forget(_multi);

        // Wpin7 cell-diff broadcaster — ticks every 50 ms, fans out per-cell
        // diffs over WS for any pane whose grid mutated since the last tick.
        let store_for_diff = store.clone();
        tokio::spawn(async move {
            run_cell_diff_broadcaster(store_for_diff).await;
        });
    }

    if read_only {
        info!("read-only mode — input + plugin install/uninstall disabled");
    }

    info!("config_dir: {}", resolved_config_dir.display());

    // Initialise upload state — creates the staging dir on disk. We
    // build this regardless of demo_mode (handlers gate themselves
    // on read_only); a daemon with no uploads dir at all is currently
    // only used by tests and the sandbox broker.
    let resolved_uploads_dir = uploads_dir
        .clone()
        .unwrap_or_else(crate::api::uploads::default_uploads_dir);
    let uploads_state = match crate::api::uploads::UploadsState::new(resolved_uploads_dir.clone()) {
        Ok(s) => {
            info!("uploads_dir: {}", resolved_uploads_dir.display());
            Some(s)
        }
        Err(e) => {
            warn!(
                "uploads_dir {}: {e} — /api/uploads endpoints will return 503",
                resolved_uploads_dir.display()
            );
            None
        }
    };

    // 2. Build HTTP+WS app and serve.
    let app = crate::api::router(AppState {
        store: store.clone(),
        tmux_socket: socket.map(String::from),
        resized_windows: std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )),
        diag_log_path: diag_log.map(|p| p.to_path_buf()),
        registry_url: registry_url.map(String::from),
        read_only,
        demo_mode,
        config_dir: resolved_config_dir,
        app_name: app_name.clone(),
        uploads: uploads_state,
        allowed_origins,
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

/// One-shot recursive copy used by the legacy → per-port config-dir
/// migration. Sync (we run it at startup before any async work). Best-
/// effort: errors propagate up to the caller which logs and falls
/// through (the per-port dir just stays empty, user can move things
/// over manually or pass --config-dir).
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
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
