//! `panel diff <pane>` — the dev verify loop.
//!
//! Attaches to tmux via control mode, feeds bytes for `<pane>` through our
//! parser, every `interval_ms` runs `tmux capture-pane -p` and prints a unified
//! diff between tmux's text and ours. Lets you watch any divergence in real
//! time while exercising programs in the pane.

use crate::source::{
    tmux_control::{SpawnOpts, TmuxControl},
    SourceEvent,
};
use crate::Term;
use anyhow::{Context, Result};
use similar::{ChangeTag, TextDiff};
use std::time::Duration;
use tokio::process::Command;
use tokio::time;

const ANSI_RED: &str = "\x1b[31m";
const ANSI_GREEN: &str = "\x1b[32m";
const ANSI_DIM: &str = "\x1b[2m";
const ANSI_BOLD: &str = "\x1b[1m";
const ANSI_RESET: &str = "\x1b[0m";

pub async fn run(
    target_pane: &str,
    interval_ms: u64,
    rows: u16,
    cols: u16,
    socket: Option<&str>,
) -> Result<()> {
    let (_tmux, mut rx) = TmuxControl::spawn_with(SpawnOpts {
        socket_name: socket.map(String::from),
        target_session: None,
    })
    .context("spawning tmux -C")?;
    let mut term = Term::new(rows, cols);
    let mut last_print = time::Instant::now();
    let interval = Duration::from_millis(interval_ms);
    let mut last_status = String::new();

    eprintln!(
        "panel diff: tracking {target_pane} ({rows}x{cols}). Side-by-side every {interval_ms}ms.\n"
    );

    loop {
        // Drain pane output until interval elapses.
        let elapsed = last_print.elapsed();
        let wait = interval.saturating_sub(elapsed);
        let result = time::timeout(wait, rx.recv()).await;
        match result {
            Ok(Some(SourceEvent::Output { pane, bytes })) => {
                if pane.0 == target_pane {
                    term.feed(&bytes);
                }
            }
            Ok(Some(SourceEvent::Closed { reason })) => {
                eprintln!("tmux source closed: {reason}");
                break;
            }
            Ok(Some(_)) => {}
            Ok(None) => {
                eprintln!("event stream ended");
                break;
            }
            Err(_) => {
                // Timeout — render and compare.
                let panel_text = term.screen.render_text();
                let tmux_text = capture_pane_text(target_pane, socket)
                    .await
                    .unwrap_or_default();
                let status = render_diff(&panel_text, &tmux_text);
                if status != last_status {
                    print!("\x1b[2J\x1b[H"); // clear screen, cursor home
                    println!(
                        "{ANSI_BOLD}panel diff [{target_pane}] gen={} alt={} cursor=({},{}){ANSI_RESET}",
                        term.screen.generation,
                        term.screen.alt_active(),
                        term.screen.cursor.row,
                        term.screen.cursor.col,
                    );
                    println!();
                    println!("{status}");
                    last_status = status;
                }
                last_print = time::Instant::now();
            }
        }
    }
    Ok(())
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
        .context("running tmux capture-pane")?;
    if !out.status.success() {
        anyhow::bail!(
            "tmux capture-pane failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

fn render_diff(panel: &str, tmux: &str) -> String {
    if panel == tmux {
        return format!(
            "{ANSI_GREEN}✓ MATCH{ANSI_RESET} ({} lines)\n\n{ANSI_DIM}{}{ANSI_RESET}",
            panel.lines().count(),
            tmux,
        );
    }
    let diff = TextDiff::from_lines(tmux, panel);
    let mut out = String::new();
    out.push_str(&format!(
        "{ANSI_RED}✗ DIVERGE{ANSI_RESET}  {ANSI_DIM}(- tmux  + panel){ANSI_RESET}\n\n"
    ));
    for change in diff.iter_all_changes() {
        let (sign, color) = match change.tag() {
            ChangeTag::Delete => ("-", ANSI_RED),
            ChangeTag::Insert => ("+", ANSI_GREEN),
            ChangeTag::Equal => (" ", ANSI_DIM),
        };
        out.push_str(&format!(
            "{color}{sign} {}{ANSI_RESET}",
            change.value().trim_end_matches('\n')
        ));
        out.push('\n');
    }
    out
}
