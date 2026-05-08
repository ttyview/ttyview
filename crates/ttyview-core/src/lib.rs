//! `ttyview-core` — structured terminal pane state library.
//!
//! Top-level layout:
//!   * `grid`   — Cell, Line, Cursor, Screen (the data model + mutations)
//!   * `parser` — vte::Perform impls that drive Screen from byte streams
//!   * `source` — where bytes come from (`tmux -C` today; PTYs later)
//!   * `state`  — process-wide pane registry + broadcast channels
//!   * `api`    — HTTP+WS surface (axum)
//!   * `detectors` — semantic event detectors
//!   * `cli`    — daemon entry-point logic

pub mod api;
pub mod cli;
pub mod detectors;
pub mod grid;
pub mod parser;
pub mod source;
pub mod state;

pub use grid::Screen;
pub use parser::Term;

/// Feed `tmux capture-pane -e` output into a Term.
///
/// `capture-pane -e` emits one trailing `\n` per row (no `\r`); it's a rendered
/// text view, not a raw byte stream. We replay it line-by-line so each line
/// starts at column 0, and strip exactly one trailing newline so feeding a
/// 24-row capture into a 24-row screen doesn't scroll.
///
/// Live `%output` bytes are different — programs there emit `\r\n` via the
/// PTY's ONLCR translation, so they don't need this normalization.
pub fn feed_baseline(term: &mut Term, bytes: &[u8]) {
    let trimmed: &[u8] = match bytes.last() {
        Some(&b'\n') => &bytes[..bytes.len() - 1],
        _ => bytes,
    };
    let mut iter = trimmed.split(|&b| b == b'\n');
    let first = iter.next().unwrap_or(&[]);
    term.feed(first);
    for line in iter {
        term.feed(b"\r\n");
        term.feed(line);
    }
}
