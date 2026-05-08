//! `panel replay <input>` — replay recorded bytes through panel's parser.
//!
//! Two input forms:
//!   * a single file: raw byte stream, panel renders & prints.
//!   * a directory (recorded by `panel record`): baseline.bytes + live.bytes,
//!     replays both and (if `expected.txt` is present) compares.
//!
//! Used as the foundation for golden tests.

use crate::feed_baseline;
use crate::Term;
use anyhow::{Context, Result};
use similar::{ChangeTag, TextDiff};
use std::path::Path;

pub fn run(input: &Path, rows: u16, cols: u16, json: bool) -> Result<()> {
    let meta = input.join("meta.json");
    if input.is_dir() && meta.exists() {
        replay_session(input, json)
    } else {
        replay_file(input, rows, cols, json)
    }
}

fn replay_file(input: &Path, rows: u16, cols: u16, json: bool) -> Result<()> {
    let bytes = std::fs::read(input).with_context(|| format!("reading {}", input.display()))?;
    let mut term = Term::new(rows, cols);
    term.feed(&bytes);
    if json {
        println!("{}", serde_json::to_string_pretty(&term.screen)?);
    } else {
        println!("{}", term.screen.render_text());
    }
    Ok(())
}

fn replay_session(dir: &Path, json: bool) -> Result<()> {
    let meta_bytes = std::fs::read(dir.join("meta.json"))?;
    let meta: crate::cli::record::Meta = serde_json::from_slice(&meta_bytes)?;
    let baseline = std::fs::read(dir.join("baseline.bytes"))?;
    let live = std::fs::read(dir.join("live.bytes"))?;

    let mut term = Term::new(meta.rows, meta.cols);
    feed_baseline(&mut term, &baseline);
    // Restore baseline cursor by issuing a CSI CUP — feed it through the
    // parser so all the same code paths run.
    let (cy, cx) = meta.baseline_cursor;
    let cup = format!("\x1b[{};{}H", cy + 1, cx + 1);
    term.feed(cup.as_bytes());
    term.feed(&live);

    if json {
        println!("{}", serde_json::to_string_pretty(&term.screen)?);
        return Ok(());
    }

    let panel_text = term.screen.render_text();
    println!(
        "# pane:        {}\n# rows×cols:   {}×{}\n# baseline:    {} bytes\n# live:        {} bytes\n# generation:  {}",
        meta.pane,
        meta.rows,
        meta.cols,
        baseline.len(),
        live.len(),
        term.screen.generation,
    );
    println!();

    let expected_path = dir.join("expected.txt");
    if expected_path.exists() {
        let expected = std::fs::read_to_string(&expected_path)?;
        if normalize(&panel_text) == normalize(&expected) {
            println!("OK match (panel == expected.txt)");
            println!();
            println!("{panel_text}");
            return Ok(());
        }
        println!("DIVERGE (- expected  + panel):");
        let diff = TextDiff::from_lines(&expected, &panel_text);
        for change in diff.iter_all_changes() {
            let sign = match change.tag() {
                ChangeTag::Delete => "-",
                ChangeTag::Insert => "+",
                ChangeTag::Equal => " ",
            };
            print!("{sign} {}", change.value());
        }
        std::process::exit(1);
    } else {
        println!("{panel_text}");
    }
    Ok(())
}

fn normalize(s: &str) -> String {
    s.trim_end_matches('\n')
        .lines()
        .map(|l| l.trim_end_matches(' ').to_string())
        .collect::<Vec<_>>()
        .join("\n")
}
