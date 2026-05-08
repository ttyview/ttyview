//! Shell-prompt-ready detector.
//!
//! Heuristic: a "prompt ready" event fires when the cursor lands on a line
//! whose visible text ends in `$ `, `# `, `> `, or `% ` (with arbitrary leading
//! prompt content), AND the cursor is near the end of that text. We dedupe
//! consecutive fires at the same `(row, col, generation_class)`.
//!
//! Better-but-future: OSC 133 semantic prompts. If your shell emits them, the
//! prompt is unambiguous. This regex-ish heuristic is the fallback.

use super::{DetectContext, Detector, SemanticEvent};
use serde_json::json;

#[derive(Default)]
pub struct BashPromptDetector {
    last_fire_gen: u64,
}

impl Detector for BashPromptDetector {
    fn name(&self) -> &str {
        "shell.prompt_ready"
    }

    fn observe(&mut self, ctx: &DetectContext<'_>) -> Vec<SemanticEvent> {
        let screen = ctx.screen;
        // Idempotency: don't refire on the same generation.
        if screen.generation == self.last_fire_gen {
            return Vec::new();
        }
        let cur_row = screen.cursor.row as usize;
        let cur_col = screen.cursor.col as usize;
        let row = match screen.active().get(cur_row) {
            Some(r) => r,
            None => return Vec::new(),
        };
        let text = row.render_text();
        // Strip trailing spaces (already done by render_text), but be safe.
        let trimmed = text.trim_end();
        if trimmed.is_empty() {
            return Vec::new();
        }
        let last = trimmed.chars().last().unwrap();
        let is_prompt_terminator = matches!(last, '$' | '#' | '>' | '%');
        if !is_prompt_terminator {
            return Vec::new();
        }
        // Cursor should be at or just past the prompt sigil + a space.
        // Tolerate up to 2 cols of slack (sigil, space, possibly another char).
        let prompt_len = trimmed.chars().count();
        if cur_col < prompt_len || cur_col > prompt_len + 2 {
            return Vec::new();
        }
        self.last_fire_gen = screen.generation;
        vec![SemanticEvent {
            name: self.name().to_string(),
            at_gen: screen.generation,
            data: json!({
                "pane": ctx.pane_id,
                "prompt_text": trimmed,
                "cursor": [screen.cursor.row, screen.cursor.col],
            }),
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Term;

    #[test]
    fn fires_on_basic_dollar_prompt() {
        let mut term = Term::new(5, 80);
        term.feed(b"bash-5.2$ ");
        let mut det = BashPromptDetector::default();
        let evts = det.observe(&DetectContext {
            pane_id: "%1",
            screen: &term.screen,
            recent_bytes: b"",
        });
        assert_eq!(evts.len(), 1);
        assert_eq!(evts[0].name, "shell.prompt_ready");
    }

    #[test]
    fn doesnt_fire_in_middle_of_typing() {
        let mut term = Term::new(5, 80);
        term.feed(b"bash-5.2$ echo hi");
        let mut det = BashPromptDetector::default();
        let evts = det.observe(&DetectContext {
            pane_id: "%1",
            screen: &term.screen,
            recent_bytes: b"",
        });
        // Cursor is far past the `$` — no fire.
        assert!(evts.is_empty());
    }

    #[test]
    fn doesnt_refire_same_generation() {
        let mut term = Term::new(5, 80);
        term.feed(b"bash-5.2$ ");
        let mut det = BashPromptDetector::default();
        let _ = det.observe(&DetectContext {
            pane_id: "%1",
            screen: &term.screen,
            recent_bytes: b"",
        });
        let evts = det.observe(&DetectContext {
            pane_id: "%1",
            screen: &term.screen,
            recent_bytes: b"",
        });
        assert!(evts.is_empty());
    }

    #[test]
    fn fires_on_root_hash_prompt() {
        let mut term = Term::new(5, 80);
        term.feed(b"root@host:/# ");
        let mut det = BashPromptDetector::default();
        let evts = det.observe(&DetectContext {
            pane_id: "%1",
            screen: &term.screen,
            recent_bytes: b"",
        });
        assert_eq!(evts.len(), 1);
    }
}
