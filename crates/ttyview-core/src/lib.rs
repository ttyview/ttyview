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

/// True if `s` is a raw tmux pane id: `%` followed by one or more digits.
pub fn is_raw_tmux_pane_id(s: &str) -> bool {
    s.strip_prefix('%')
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

/// Reduce a client-supplied pane id to something tmux will accept as a
/// `-t` target.
///
/// Clients that talked to a daemon affected by the tmux <= 3.3
/// tab→underscore format mangling (released mobile-cc v0.1.x/v0.2.0) hold
/// composite ids like `%0_work_0`. tmux rejects those outright
/// ("can't find pane: %0_0"), so we strip everything after the leading
/// `%<digits>` run. Ids that don't start with `%<digit>` (e.g. the demo
/// pane `%demo`) pass through unchanged.
pub fn tmux_pane_target(pane: &str) -> &str {
    let Some(rest) = pane.strip_prefix('%') else {
        return pane;
    };
    let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 {
        return pane;
    }
    &pane[..1 + digits]
}

#[cfg(test)]
mod pane_id_tests {
    use super::{is_raw_tmux_pane_id, tmux_pane_target};

    #[test]
    fn raw_id_detection() {
        assert!(is_raw_tmux_pane_id("%0"));
        assert!(is_raw_tmux_pane_id("%12345"));
        assert!(!is_raw_tmux_pane_id("%"));
        assert!(!is_raw_tmux_pane_id("%demo"));
        assert!(!is_raw_tmux_pane_id("%0_work_0"));
        assert!(!is_raw_tmux_pane_id("0"));
    }

    #[test]
    fn composite_ids_reduce_to_raw() {
        assert_eq!(tmux_pane_target("%0_work_0"), "%0");
        assert_eq!(tmux_pane_target("%12_0"), "%12");
        assert_eq!(tmux_pane_target("%7"), "%7");
    }

    #[test]
    fn non_numeric_ids_pass_through() {
        assert_eq!(tmux_pane_target("%demo"), "%demo");
        assert_eq!(tmux_pane_target("demo"), "demo");
        assert_eq!(tmux_pane_target("%"), "%");
    }
}
