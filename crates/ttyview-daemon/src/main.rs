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
    ttyview_core::cli::daemon::run_with_options(
        cli.bind,
        cli.socket.as_deref(),
        cli.rows,
        cli.cols,
        cli.tls_cert.as_deref(),
        cli.tls_key.as_deref(),
        cli.diag_log.as_deref(),
        cli.registry_url.as_deref(),
    )
    .await
}
