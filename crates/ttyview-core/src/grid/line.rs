use super::cell::Cell;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
    pub cells: Vec<Cell>,
    /// True if this line was soft-wrapped — the logical line continues on the next row.
    /// Critical for copy/paste reconstruction and for resize/reflow.
    pub wrapped: bool,
}

impl Line {
    pub fn blank(cols: u16) -> Self {
        Line {
            cells: vec![Cell::EMPTY; cols as usize],
            wrapped: false,
        }
    }

    /// Render the line to a String, skipping continuation cells, trimming trailing spaces.
    pub fn render_text(&self) -> String {
        let mut s = String::with_capacity(self.cells.len());
        for cell in &self.cells {
            if cell.is_continuation() {
                continue;
            }
            s.push(cell.ch);
        }
        // Trim trailing spaces (matches `tmux capture-pane -p` default).
        let trimmed = s.trim_end_matches(' ');
        trimmed.to_string()
    }

    /// Render without trimming (for fixed-width grid views).
    pub fn render_text_padded(&self) -> String {
        let mut s = String::with_capacity(self.cells.len());
        for cell in &self.cells {
            if cell.is_continuation() {
                continue;
            }
            s.push(cell.ch);
        }
        s
    }

    pub fn cols(&self) -> u16 {
        self.cells.len() as u16
    }

    /// Resize: if growing, pad with blanks; if shrinking, truncate.
    /// Reflow logic (using `wrapped`) lives at the Screen level, not here.
    pub fn resize(&mut self, cols: u16) {
        let cur = self.cells.len();
        let target = cols as usize;
        if target > cur {
            self.cells.resize(target, Cell::EMPTY);
        } else if target < cur {
            self.cells.truncate(target);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_line_renders_empty() {
        let l = Line::blank(80);
        assert_eq!(l.render_text(), "");
    }

    #[test]
    fn render_trims_trailing_spaces() {
        let mut l = Line::blank(10);
        l.cells[0].ch = 'h';
        l.cells[1].ch = 'i';
        assert_eq!(l.render_text(), "hi");
    }

    #[test]
    fn render_skips_continuation_cells() {
        let mut l = Line::blank(10);
        l.cells[0].ch = '世';
        l.cells[0].width = 2;
        l.cells[1].width = 0;
        l.cells[2].ch = '!';
        assert_eq!(l.render_text(), "世!");
    }

    #[test]
    fn resize_grows_with_blanks() {
        let mut l = Line::blank(5);
        l.cells[0].ch = 'x';
        l.resize(10);
        assert_eq!(l.cells.len(), 10);
        assert_eq!(l.cells[0].ch, 'x');
        assert!(l.cells[9].is_blank());
    }
}
