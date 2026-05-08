//! `panel record <pane> <dir> [--socket S]`
//!
//! Captures a full session for golden tests: writes a directory with
//!   * `baseline.bytes`  — `capture-pane -p -e` at attach time
//!   * `live.bytes`      — raw `%output` stream during recording
//!   * `meta.json`       — pane id, dimensions, timestamp
//!   * `expected.txt`    — `capture-pane -p` at end of recording (ground truth)
//!
//! `panel replay <dir>` consumes the same layout.

use crate::source::{
    tmux_control::{SpawnOpts, TmuxControl},
    SourceEvent,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Serialize, Deserialize)]
pub struct Meta {
    pub pane: String,
    pub rows: u16,
    pub cols: u16,
    pub recorded_at: String,
    pub socket: Option<String>,
    /// Cursor position at attach time (before live bytes apply).
    /// `capture-pane -e` gives grid content but not cursor.
    pub baseline_cursor: (u16, u16), // (row, col)
}

pub async fn run(
    target_pane: &str,
    output_dir: &Path,
    seconds: u64,
    socket: Option<&str>,
) -> Result<()> {
    fs::create_dir_all(output_dir)
        .await
        .with_context(|| format!("creating {}", output_dir.display()))?;

    // 1. Read pane size + cursor + capture baseline.
    let (rows, cols) = pane_size(target_pane, socket).await?;
    let baseline_cursor = pane_cursor(target_pane, socket).await?;
    let baseline = capture_pane_ansi(target_pane, socket).await?;
    fs::write(output_dir.join("baseline.bytes"), &baseline).await?;

    // 2. Attach and stream live bytes for `seconds`.
    let (_tmux, mut rx) = TmuxControl::spawn_with(SpawnOpts {
        socket_name: socket.map(String::from),
        target_session: None,
    })
    .context("spawning tmux -C")?;

    let mut live = fs::File::create(output_dir.join("live.bytes")).await?;
    let deadline = Duration::from_secs(seconds);
    let started = tokio::time::Instant::now();
    let mut total: u64 = 0;
    eprintln!(
        "panel record: {} ({}×{}) for {}s → {}",
        target_pane,
        rows,
        cols,
        seconds,
        output_dir.display()
    );
    loop {
        let remaining = deadline.checked_sub(started.elapsed()).unwrap_or_default();
        if remaining.is_zero() {
            break;
        }
        let ev = match timeout(remaining, rx.recv()).await {
            Ok(Some(ev)) => ev,
            Ok(None) | Err(_) => break,
        };
        match ev {
            SourceEvent::Output { pane, bytes } if pane.0 == target_pane => {
                live.write_all(&bytes).await?;
                total += bytes.len() as u64;
            }
            SourceEvent::Closed { reason } => {
                eprintln!("tmux closed: {reason}");
                break;
            }
            _ => {}
        }
    }
    live.flush().await?;

    // 3. Capture expected.txt (ground truth at end of recording).
    let expected = capture_pane_text(target_pane, socket).await?;
    fs::write(output_dir.join("expected.txt"), &expected).await?;

    // 4. Write meta.
    let meta = Meta {
        pane: target_pane.to_string(),
        rows,
        cols,
        recorded_at: chrono_like_now(),
        socket: socket.map(String::from),
        baseline_cursor,
    };
    fs::write(output_dir.join("meta.json"), serde_json::to_vec_pretty(&meta)?).await?;

    eprintln!(
        "ok: baseline={} bytes, live={} bytes, expected={} bytes",
        baseline.len(),
        total,
        expected.len()
    );
    Ok(())
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{secs}")
}

async fn pane_cursor(pane: &str, socket: Option<&str>) -> Result<(u16, u16)> {
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args([
            "display",
            "-p",
            "-t",
            pane,
            "#{cursor_y}\t#{cursor_x}",
        ])
        .output()
        .await
        .context("tmux display cursor")?;
    if !out.status.success() {
        anyhow::bail!(
            "tmux display failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let s = s.trim();
    let (y, x) = s.split_once('\t').context("parsing cursor")?;
    Ok((y.parse()?, x.parse()?))
}

async fn pane_size(pane: &str, socket: Option<&str>) -> Result<(u16, u16)> {
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args(["display", "-p", "-t", pane, "#{pane_height}\t#{pane_width}"])
        .output()
        .await
        .context("tmux display")?;
    if !out.status.success() {
        anyhow::bail!(
            "tmux display failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let s = s.trim();
    let (h, w) = s.split_once('\t').context("parsing pane size")?;
    Ok((h.parse()?, w.parse()?))
}

async fn capture_pane_ansi(pane: &str, socket: Option<&str>) -> Result<Vec<u8>> {
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args(["capture-pane", "-p", "-e", "-t", pane])
        .output()
        .await
        .context("tmux capture-pane -e")?;
    if !out.status.success() {
        anyhow::bail!(
            "tmux capture-pane -e failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(out.stdout)
}

async fn capture_pane_text(pane: &str, socket: Option<&str>) -> Result<String> {
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args(["capture-pane", "-p", "-t", pane])
        .output()
        .await
        .context("tmux capture-pane")?;
    if !out.status.success() {
        anyhow::bail!(
            "tmux capture-pane failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
