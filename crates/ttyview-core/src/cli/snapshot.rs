//! `panel snapshot <pane>` — one-shot comparison.
//!
//! Attaches to tmux control mode, captures bytes for the pane for
//! `--collect-ms` milliseconds (or until idle for `--idle-ms`), feeds them
//! through panel's parser, and prints both panel-rendered text and
//! `tmux capture-pane -p` text plus a diff. Exits 0 on match, 1 on diverge.
//!
//! IMPORTANT: tmux control mode only emits `%output` for *new* bytes after
//! attach. To establish a starting point that matches tmux's view, we capture
//! an initial pane snapshot via `capture-pane -p -e -J` and feed those bytes
//! through panel as a baseline, then accumulate live diffs.

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

pub async fn run(
    target_pane: &str,
    rows: u16,
    cols: u16,
    collect_ms: u64,
    idle_ms: u64,
    socket: Option<&str>,
) -> Result<()> {
    let mut term = Term::new(rows, cols);
    let mut live_bytes: Vec<u8> = Vec::new();

    // Baseline: the existing pane content. capture-pane -e gives us the grid
    // as ANSI escape sequences, but with `\n` between lines (no `\r`) — it's a
    // rendered text view, not a raw byte stream. Replay it line-by-line so each
    // line starts at col 0.
    let baseline = capture_pane_ansi(target_pane, socket).await?;
    let cursor = capture_pane_cursor(target_pane, socket).await?;
    if let Ok(p) = std::env::var("PANEL_DUMP_BASELINE") {
        std::fs::write(p, &baseline).ok();
    }
    crate::feed_baseline(&mut term, &baseline);
    let cup = format!("\x1b[{};{}H", cursor.0 + 1, cursor.1 + 1);
    term.feed(cup.as_bytes());

    let (_tmux, mut rx) = TmuxControl::spawn_with(SpawnOpts {
        socket_name: socket.map(String::from),
        target_session: None,
    })
    .context("spawning tmux -C")?;

    // Drain output for collect_ms or until no event for idle_ms.
    let collect = Duration::from_millis(collect_ms);
    let idle = Duration::from_millis(idle_ms);
    let started = time::Instant::now();
    let mut last_event = time::Instant::now();
    loop {
        if started.elapsed() >= collect {
            break;
        }
        let wait = collect.saturating_sub(started.elapsed()).min(idle);
        match time::timeout(wait, rx.recv()).await {
            Ok(Some(SourceEvent::Output { pane, bytes })) => {
                if pane.0 == target_pane {
                    live_bytes.extend_from_slice(&bytes);
                    term.feed(&bytes);
                    last_event = time::Instant::now();
                }
            }
            Ok(Some(SourceEvent::Closed { reason })) => {
                eprintln!("# tmux closed: {reason}");
                break;
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {
                if last_event.elapsed() >= idle {
                    break;
                }
            }
        }
    }

    if let Ok(p) = std::env::var("PANEL_DUMP_LIVE") {
        std::fs::write(p, &live_bytes).ok();
    }
    let panel_text = term.screen.render_text();
    let tmux_text = capture_pane_text(target_pane, socket).await?;

    println!("# pane:        {target_pane}");
    println!("# rows×cols:   {}×{}", rows, cols);
    println!("# generation:  {}", term.screen.generation);
    println!("# alt screen:  {}", term.screen.alt_active());
    println!(
        "# cursor:      ({},{})",
        term.screen.cursor.row, term.screen.cursor.col
    );
    println!();

    if panel_text.trim_end() == tmux_text.trim_end() {
        println!("OK match");
        return Ok(());
    }

    println!("DIVERGE (- tmux  + panel):");
    let diff = TextDiff::from_lines(&tmux_text, &panel_text);
    for change in diff.iter_all_changes() {
        let sign = match change.tag() {
            ChangeTag::Delete => "-",
            ChangeTag::Insert => "+",
            ChangeTag::Equal => " ",
        };
        print!("{sign} {}", change.value());
    }
    std::process::exit(1);
}

fn tmux_cmd(socket: Option<&str>) -> Command {
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    cmd
}

/// `tmux capture-pane -p -t <pane>` — rendered text only.
async fn capture_pane_text(pane: &str, socket: Option<&str>) -> Result<String> {
    let out = tmux_cmd(socket)
        .args(["capture-pane", "-p", "-t", pane])
        .output()
        .await
        .context("running tmux capture-pane -p")?;
    if !out.status.success() {
        anyhow::bail!(
            "tmux capture-pane failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// `tmux capture-pane -p -e -t <pane>` — bytes with ANSI escapes preserved (-e),
/// suitable for replaying through a terminal emulator.
async fn capture_pane_cursor(pane: &str, socket: Option<&str>) -> Result<(u16, u16)> {
    let out = tmux_cmd(socket)
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

async fn capture_pane_ansi(pane: &str, socket: Option<&str>) -> Result<Vec<u8>> {
    let out = tmux_cmd(socket)
        .args(["capture-pane", "-p", "-e", "-t", pane])
        .output()
        .await
        .context("running tmux capture-pane -p -e")?;
    if !out.status.success() {
        anyhow::bail!(
            "tmux capture-pane -e failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(out.stdout)
}
