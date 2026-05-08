use anyhow::{Context, Result};
use tokio::process::Command;

pub async fn run(socket: Option<&str>) -> Result<()> {
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args([
            "list-panes",
            "-aF",
            "#{session_name}\t#{window_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_width}x#{pane_height}",
        ])
        .output()
        .await
        .context("running tmux list-panes")?;
    if !out.status.success() {
        anyhow::bail!(
            "tmux list-panes failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    println!("{:<20} {:>3}  {:<6} {:<20} {}", "session", "win", "pane", "cmd", "size");
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.splitn(5, '\t');
        let s = parts.next().unwrap_or("");
        let w = parts.next().unwrap_or("");
        let p = parts.next().unwrap_or("");
        let c = parts.next().unwrap_or("");
        let sz = parts.next().unwrap_or("");
        println!("{:<20} {:>3}  {:<6} {:<20} {}", s, w, p, c, sz);
    }
    Ok(())
}
