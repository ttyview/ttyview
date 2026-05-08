use super::cell::{Attrs, Color};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub row: u16,
    pub col: u16,
    /// Cursor visibility (DECTCEM, `\e[?25h` / `\e[?25l`).
    pub visible: bool,
    /// "Pending wrap" — when the cursor is at col=cols and a printable arrived,
    /// we leave it pinned and wrap on the *next* print. xterm/vt100 quirk.
    pub pending_wrap: bool,
    pub fg: Color,
    pub bg: Color,
    pub attrs: Attrs,
}

impl Default for Cursor {
    fn default() -> Self {
        Cursor {
            row: 0,
            col: 0,
            visible: true,
            pending_wrap: false,
            fg: Color::Default,
            bg: Color::Default,
            attrs: Attrs::default(),
        }
    }
}

impl Cursor {
    /// Reset SGR state (after `\e[m` / `\e[0m`) but keep position.
    pub fn reset_sgr(&mut self) {
        self.fg = Color::Default;
        self.bg = Color::Default;
        self.attrs = Attrs::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_cursor_at_origin() {
        let c = Cursor::default();
        assert_eq!(c.row, 0);
        assert_eq!(c.col, 0);
        assert!(c.visible);
        assert!(!c.pending_wrap);
    }

    #[test]
    fn reset_sgr_preserves_position() {
        let mut c = Cursor::default();
        c.row = 5;
        c.col = 10;
        c.attrs.bold = true;
        c.fg = Color::Indexed(2);
        c.reset_sgr();
        assert_eq!(c.row, 5);
        assert_eq!(c.col, 10);
        assert!(!c.attrs.bold);
        assert_eq!(c.fg, Color::Default);
    }
}
