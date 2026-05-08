use clap::Parser;

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
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .init();
    let cli = Cli::parse();
    ttyview_core::cli::daemon::run(cli.bind, cli.socket.as_deref(), cli.rows, cli.cols).await
}
