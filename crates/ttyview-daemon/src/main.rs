use clap::Parser;
use std::path::PathBuf;

/// ttyview-daemon — web terminal viewer for tmux sessions.
///
/// Attaches to a tmux session via `tmux -C` control mode, parses the
/// pane bytes through a vte parser into a structured cell grid, and
/// exposes the grid + live cell-diff events over HTTP/WebSocket.
/// Open the daemon's URL in any browser to view your live tmux
/// session — works on phones, tablets, desktops.
#[derive(Parser, Debug)]
#[command(name = "ttyview-daemon", version, about)]
struct Cli {
    /// Address to bind the HTTP/WS server on.
    #[arg(long, default_value = "127.0.0.1:7681")]
    bind: std::net::SocketAddr,

    /// Tmux socket name (`-L`); omit for the default server.
    #[arg(long)]
    socket: Option<String>,

    /// Default pane size (rows). Tmux panes get resized to match
    /// when a client connects.
    #[arg(long, default_value_t = 50)]
    rows: u16,

    /// Default pane size (columns).
    #[arg(long, default_value_t = 80)]
    cols: u16,

    /// Path to a PEM-encoded TLS certificate. If supplied with --tls-key,
    /// the server speaks HTTPS instead of HTTP. Required for mobile browsers
    /// over Tailscale (the *.ts.net domain is HSTS-preloaded).
    #[arg(long)]
    tls_cert: Option<PathBuf>,

    /// Path to the PEM-encoded TLS key matching --tls-cert.
    #[arg(long)]
    tls_key: Option<PathBuf>,

    /// Path to a JSONL file. When set, client-shipped diagnostic
    /// events (taps, perf timings, errors) are appended here as
    /// JSON Lines. Default = unset = events are dropped on receipt.
    /// Privacy: events contain only metadata (timings, event types,
    /// sizes), NEVER cell content or user input.
    #[arg(long)]
    diag_log: Option<PathBuf>,

    /// URL of a community plugin registry. When set, GET /plugins/registry
    /// fetches from this URL (with the bundled registry as fallback on
    /// any failure). Useful pointers:
    ///   - The official catalog (when it ships): https://raw.githubusercontent.com/ttyview/community-plugins/main/registry.json
    ///   - A private fork
    ///   - A local dev server
    /// Each plugin's `source` field can be either a relative filename
    /// (resolved against the bundle) or an absolute http(s) URL.
    #[arg(long)]
    registry_url: Option<String>,

    /// Demo mode. Skips tmux entirely; serves a single synthetic pane
    /// whose CC transcript is the bundled demo conversation. Useful for
    /// hosting a "try it" link where visitors don't need to install
    /// anything. Implies `--read-only` (no input is forwarded anywhere
    /// because there's no real terminal). Auto-installs the
    /// ttyview-cc + ttyview-terminal-green plugins on first launch
    /// so the page lands in a presentable state.
    #[arg(long)]
    demo: bool,

    /// Read-only mode. WebSocket {t:"input"} messages are dropped;
    /// POST /plugins/install and DELETE /plugins/uninstall return 403.
    /// All read endpoints (panes, grid, scrollback, cc-transcript,
    /// registry, installed) keep working normally. Use this to share
    /// a live tmux session as a read-only spectator URL without giving
    /// visitors keystroke control.
    #[arg(long)]
    read_only: bool,

    /// Per-instance config directory. Default: $HOME/.config/ttyview.
    /// Holds the installed plugins (`<dir>/plugins/`) and the
    /// `installed.json` index. Useful for running multiple daemons
    /// with different plugin sets:
    ///
    ///   ttyview-daemon --bind :7785 --config-dir ~/.config/ttyview-a
    ///   ttyview-daemon --bind :7786 --config-dir ~/.config/ttyview-b
    ///
    /// Browser localStorage is already keyed per-origin (port), so the
    /// active view, theme, layout, and per-plugin storage are also
    /// isolated across instances automatically.
    #[arg(long)]
    config_dir: Option<PathBuf>,

    /// Human-readable instance name. Surfaced via `GET /api/instance`
    /// for plugins (e.g. ttyview-app-name) to render in the header.
    /// Used by ttyview-manager to label each managed app.
    #[arg(long)]
    app_name: Option<String>,
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .init();
    let cli = Cli::parse();
    if cli.tls_cert.is_some() != cli.tls_key.is_some() {
        anyhow::bail!("--tls-cert and --tls-key must be supplied together");
    }
    ttyview_core::cli::daemon::run_with_options_v2(ttyview_core::cli::daemon::RunOptions {
        addr: cli.bind,
        socket: cli.socket.clone(),
        rows: cli.rows,
        cols: cli.cols,
        tls_cert: cli.tls_cert.clone(),
        tls_key: cli.tls_key.clone(),
        diag_log: cli.diag_log.clone(),
        registry_url: cli.registry_url.clone(),
        // demo implies read-only — there's no real PTY for input to land in.
        demo_mode: cli.demo,
        read_only: cli.read_only || cli.demo,
        config_dir: cli.config_dir.clone(),
        app_name: cli.app_name.clone(),
    })
    .await
}
