//! Claude Code permission-prompt detector.
//!
//! Heuristic for Claude Code's permission UI: the rendered grid contains a
//! line that says (case-insensitive) "Do you want to..." or "Do you want
//! Claude...", and the box has selectable options ("1.", "2.", or "y/n").
//!
//! Real Claude prompts look like:
//!   ╭───────────────────────────────────────╮
//!   │ Tool use                              │
//!   │                                       │
//!   │ Bash(rm -rf /tmp/test)                │
//!   │                                       │
//!   │ Do you want to proceed?               │
//!   │ ❯ 1. Yes                              │
//!   │   2. Yes, and don't ask again         │
//!   │   3. No, and tell Claude what to do   │
//!   ╰───────────────────────────────────────╯
//!
//! This detector is intentionally a heuristic — fixture tests in
//! tests/fixtures/claude/ exercise it against real recordings. The signal is
//! stable enough for tmux-web to surface a "permission pending" indicator.

use super::{DetectContext, Detector, SemanticEvent};
use serde_json::json;

#[derive(Default)]
pub struct ClaudePermissionDetector {
    last_state: bool,
}

impl Detector for ClaudePermissionDetector {
    fn name(&self) -> &str {
        "claude.permission_prompt"
    }

    fn observe(&mut self, ctx: &DetectContext<'_>) -> Vec<SemanticEvent> {
        let text = ctx.screen.render_text();
        let lower = text.to_ascii_lowercase();
        let is_prompt = lower.contains("do you want to proceed")
            || lower.contains("do you want to make this edit")
            || lower.contains("do you want claude")
            || (lower.contains("do you want to") && has_numbered_options(&text));
        let mut events = Vec::new();
        if is_prompt && !self.last_state {
            events.push(SemanticEvent {
                name: self.name().to_string(),
                at_gen: ctx.screen.generation,
                data: json!({
                    "pane": ctx.pane_id,
                    "context": context_snippet(&text),
                }),
            });
        }
        if !is_prompt && self.last_state {
            events.push(SemanticEvent {
                name: "claude.permission_resolved".to_string(),
                at_gen: ctx.screen.generation,
                data: json!({"pane": ctx.pane_id}),
            });
        }
        self.last_state = is_prompt;
        events
    }
}

fn has_numbered_options(text: &str) -> bool {
    // Look for "1." and "2." as standalone tokens at line start (allowing
    // leading whitespace and arrow markers like ❯).
    let mut has1 = false;
    let mut has2 = false;
    for line in text.lines() {
        let trimmed = line.trim_start_matches(|c: char| c.is_whitespace() || c == '❯' || c == '>');
        if trimmed.starts_with("1.") {
            has1 = true;
        } else if trimmed.starts_with("2.") {
            has2 = true;
        }
    }
    has1 && has2
}

fn context_snippet(text: &str) -> String {
    // Return up to 3 lines around the "Do you want" line for context.
    let lines: Vec<&str> = text.lines().collect();
    let idx = lines
        .iter()
        .position(|l| l.to_ascii_lowercase().contains("do you want"));
    let i = match idx {
        Some(i) => i,
        None => return String::new(),
    };
    let start = i.saturating_sub(3);
    let end = (i + 4).min(lines.len());
    lines[start..end].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Term;

    #[test]
    fn fires_on_do_you_want_with_numbered_options() {
        let mut term = Term::new(20, 80);
        let prompt = "Tool use\nBash(rm -rf /tmp/test)\n\nDo you want to proceed?\n  1. Yes\n  2. No";
        for line in prompt.lines() {
            term.feed(line.as_bytes());
            term.feed(b"\r\n");
        }
        let mut det = ClaudePermissionDetector::default();
        let evts = det.observe(&DetectContext {
            pane_id: "%1",
            screen: &term.screen,
            recent_bytes: b"",
        });
        assert_eq!(evts.len(), 1);
        assert_eq!(evts[0].name, "claude.permission_prompt");
        let ctx = evts[0].data["context"].as_str().unwrap();
        assert!(ctx.contains("Do you want to proceed?"), "context: {ctx}");
    }

    #[test]
    fn fires_resolved_after_disappearance() {
        let mut term = Term::new(20, 80);
        term.feed(b"Do you want to proceed?\r\n  1. Yes\r\n  2. No\r\n");
        let mut det = ClaudePermissionDetector::default();
        let _ = det.observe(&DetectContext {
            pane_id: "%1",
            screen: &term.screen,
            recent_bytes: b"",
        });
        // Replace the screen with new content (simulate user picking 1).
        term.feed(b"\x1b[2J\x1b[1;1H");
        term.feed(b"some other output");
        let evts = det.observe(&DetectContext {
            pane_id: "%1",
            screen: &term.screen,
            recent_bytes: b"",
        });
        assert_eq!(evts.len(), 1);
        assert_eq!(evts[0].name, "claude.permission_resolved");
    }

    #[test]
    fn doesnt_fire_on_unrelated_text() {
        let mut term = Term::new(5, 80);
        term.feed(b"echo hello\r\nhello\r\nbash-5.2$ ");
        let mut det = ClaudePermissionDetector::default();
        let evts = det.observe(&DetectContext {
            pane_id: "%1",
            screen: &term.screen,
            recent_bytes: b"",
        });
        assert!(evts.is_empty());
    }
}
