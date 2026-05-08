//! The terminal screen: an active grid (primary or alt), scrollback, cursor,
//! and the high-level mutation operations the VT parser dispatches into.
//!
//! `Screen` impls `vte::Perform` (in `crate::parser::vte_handler`) so a
//! `vte::Parser` can drive it byte-by-byte.

use super::{Cell, Cursor, Line};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Screen {
    /// (rows, cols)
    pub size: (u16, u16),
    /// Exactly `rows` lines, always.
    pub primary: Vec<Line>,
    /// `Some` when alt screen (\e[?1049h / \e[?47h) is active; replaces primary
    /// for rendering/mutation, *never* pushes to scrollback.
    pub alt: Option<Vec<Line>>,
    /// Lines that scrolled off the top of primary (most recent at the back).
    pub scrollback: VecDeque<Line>,
    pub max_scrollback: usize,

    pub cursor: Cursor,
    /// Saved by DECSC (\e7); restored by DECRC (\e8). Per-screen save lives
    /// in `saved_cursor_alt` so primary/alt don't clobber each other.
    pub saved_cursor: Option<Cursor>,
    pub saved_cursor_alt: Option<Cursor>,

    /// (top, bottom) inclusive, 0-indexed. Default = full screen.
    pub scroll_region: (u16, u16),
    pub autowrap: bool,

    /// Bumped on every mutation. Lets clients ask "did anything change since gen N?".
    pub generation: u64,
    pub title: Option<String>,

    /// Monotonic count of lines that have ever been pushed from primary
    /// into scrollback. Unaffected by `max_scrollback` eviction (which
    /// only trims the front of `scrollback` after a push). Wpin7's
    /// "freeze on scroll-off" model uses this as a cursor: the
    /// broadcaster emits `ScrollbackAppend` events tagged with
    /// `from_count`/`to_count`, and the client tracks the latest
    /// seen value to skip duplicate rows that may overlap with what
    /// hydrate (`/grid`) already returned.
    #[serde(default)]
    pub scrollback_push_count: u64,

    /// Unix epoch milliseconds stamped onto every cell touched by the
    /// current parser feed. Set by `Term::feed` to `now_ms()` once at the
    /// start of each call; mutators read this when writing/erasing cells.
    /// Skipped from JSON — server-internal scratch field; clients see
    /// per-cell `mtime` instead.
    #[serde(default, skip)]
    pub current_mtime: u64,
}

impl Screen {
    pub fn new(rows: u16, cols: u16) -> Self {
        let rows = rows.max(1);
        let cols = cols.max(1);
        Screen {
            size: (rows, cols),
            primary: vec![Line::blank(cols); rows as usize],
            alt: None,
            scrollback: VecDeque::new(),
            // 2000 lines × ~80 cells = ~160 KB per scrollback in worst-case
            // memory, plus what we actually allocate per Line. A
            // multi-session daemon (60 sessions × N panes) at the previous
            // 10_000 cap could pin ~6 GB if every pane filled, and the
            // /grid endpoint has to clone+serialize this on every request,
            // so even a fraction of full caused multi-MB tick fetches.
            max_scrollback: 2_000,
            cursor: Cursor::default(),
            saved_cursor: None,
            saved_cursor_alt: None,
            scroll_region: (0, rows - 1),
            autowrap: true,
            generation: 0,
            title: None,
            current_mtime: 0,
            scrollback_push_count: 0,
        }
    }

    /// Cell template for blank-erase: `Cell::EMPTY` plus the current
    /// feed's mtime. Use this anywhere we'd otherwise write `Cell::EMPTY`
    /// into the active grid as the result of a parser-driven mutation —
    /// erase_in_display/line, insert/delete_chars, etc. Cells produced
    /// by `Line::blank()` (scrolled-in fresh rows, initial grid) keep
    /// mtime=0; only explicit writes stamp.
    fn stamped_blank(&self) -> Cell {
        Cell {
            mtime: self.current_mtime,
            ..Cell::EMPTY
        }
    }

    pub fn rows(&self) -> u16 {
        self.size.0
    }

    pub fn cols(&self) -> u16 {
        self.size.1
    }

    pub fn alt_active(&self) -> bool {
        self.alt.is_some()
    }

    pub fn active(&self) -> &Vec<Line> {
        self.alt.as_ref().unwrap_or(&self.primary)
    }

    pub fn active_mut(&mut self) -> &mut Vec<Line> {
        if self.alt.is_some() {
            self.alt.as_mut().unwrap()
        } else {
            &mut self.primary
        }
    }

    /// Render visible grid (no scrollback) as text. Trailing-space-trimmed per line,
    /// matching `tmux capture-pane -p` default.
    pub fn render_text(&self) -> String {
        let mut s = String::with_capacity((self.cols() as usize + 1) * self.rows() as usize);
        let lines = self.active();
        for (i, line) in lines.iter().enumerate() {
            s.push_str(&line.render_text());
            if i + 1 < lines.len() {
                s.push('\n');
            }
        }
        s
    }

    /// Render with scrollback prepended (only if alt screen not active).
    pub fn render_text_with_scrollback(&self) -> String {
        let mut s = String::new();
        if !self.alt_active() {
            for line in &self.scrollback {
                s.push_str(&line.render_text());
                s.push('\n');
            }
        }
        s.push_str(&self.render_text());
        s
    }

    fn bump(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }

    // ---------- low-level mutators (called from vte handler) ----------

    /// Print a printable character at the cursor, advance cursor with wrap handling.
    pub fn put_char(&mut self, ch: char) {
        use unicode_width::UnicodeWidthChar;
        let w = ch.width().unwrap_or(1) as u8;
        if w == 0 {
            // Zero-width (combining marks) — for v1, append to previous cell's char.
            // Skip if there's no previous cell.
            let (row, col) = (self.cursor.row, self.cursor.col);
            if col > 0 {
                let prev = (col - 1) as usize;
                let lines = self.active_mut();
                if let Some(line) = lines.get_mut(row as usize) {
                    if let Some(cell) = line.cells.get_mut(prev) {
                        // Naive: replace. Proper combining-char handling is post-v1.
                        let _ = cell.ch;
                    }
                }
            }
            return;
        }

        let cols = self.cols();
        let attrs = self.cursor.attrs;
        let fg = self.cursor.fg;
        let bg = self.cursor.bg;

        // Pending wrap: the prior print landed at col=cols-1 with autowrap on.
        // We deferred the wrap until *now* (xterm quirk).
        if self.cursor.pending_wrap && self.autowrap {
            self.linefeed_with_wrap_flag(true);
            self.cursor.col = 0;
            self.cursor.pending_wrap = false;
        }

        // If we don't fit in the current line, wrap immediately (only if autowrap).
        if self.cursor.col + w as u16 > cols {
            if self.autowrap {
                self.linefeed_with_wrap_flag(true);
                self.cursor.col = 0;
            } else {
                // Clamp cursor to last column without wrapping.
                self.cursor.col = cols.saturating_sub(w as u16);
            }
        }

        let mtime = self.current_mtime;
        let (row, col) = (self.cursor.row, self.cursor.col);
        let lines = self.active_mut();
        if let Some(line) = lines.get_mut(row as usize) {
            // Mark wrapping flag false on a fresh insertion (will be re-set on overflow).
            // Don't reset wrapped here — only the wrap path sets it to true.
            if let Some(cell) = line.cells.get_mut(col as usize) {
                *cell = Cell {
                    ch,
                    fg,
                    bg,
                    attrs,
                    width: w,
                    mtime,
                };
            }
            if w == 2 {
                if let Some(cont) = line.cells.get_mut(col as usize + 1) {
                    *cont = Cell {
                        ch: ' ',
                        fg,
                        bg,
                        attrs,
                        width: 0,
                        mtime,
                    };
                }
            }
        }

        let advance = w as u16;
        let new_col = self.cursor.col + advance;
        if new_col >= cols {
            // Pin at last column; defer wrap until next print (xterm quirk).
            self.cursor.col = cols - 1;
            self.cursor.pending_wrap = true;
        } else {
            self.cursor.col = new_col;
            self.cursor.pending_wrap = false;
        }
        self.bump();
    }

    pub fn carriage_return(&mut self) {
        self.cursor.col = 0;
        self.cursor.pending_wrap = false;
        self.bump();
    }

    pub fn backspace(&mut self) {
        if self.cursor.col > 0 {
            self.cursor.col -= 1;
            self.cursor.pending_wrap = false;
            self.bump();
        }
    }

    pub fn tab(&mut self) {
        // Tabs every 8 columns.
        let cols = self.cols();
        let next = ((self.cursor.col / 8) + 1) * 8;
        self.cursor.col = next.min(cols.saturating_sub(1));
        self.cursor.pending_wrap = false;
        self.bump();
    }

    /// LF — move cursor down one row, scrolling within scroll region if needed.
    pub fn linefeed(&mut self) {
        self.linefeed_with_wrap_flag(false);
    }

    fn linefeed_with_wrap_flag(&mut self, was_wrap: bool) {
        let bot = self.scroll_region.1;
        if self.cursor.row == bot {
            // Mark current line as wrapped (if this LF was caused by autowrap).
            if was_wrap {
                let row = self.cursor.row as usize;
                let lines = self.active_mut();
                if let Some(line) = lines.get_mut(row) {
                    line.wrapped = true;
                }
            }
            self.scroll_up_in_region(1);
        } else if self.cursor.row < self.rows() {
            if was_wrap {
                let row = self.cursor.row as usize;
                let lines = self.active_mut();
                if let Some(line) = lines.get_mut(row) {
                    line.wrapped = true;
                }
            }
            self.cursor.row = (self.cursor.row + 1).min(self.rows() - 1);
        }
        self.cursor.pending_wrap = false;
        self.bump();
    }

    /// Reverse line feed — move up, scroll down if at top.
    pub fn reverse_linefeed(&mut self) {
        let top = self.scroll_region.0;
        if self.cursor.row == top {
            self.scroll_down_in_region(1);
        } else if self.cursor.row > 0 {
            self.cursor.row -= 1;
        }
        self.cursor.pending_wrap = false;
        self.bump();
    }

    /// Scroll the scroll region up by N lines: top N lines are removed,
    /// N blank lines pushed at the bottom. If primary screen and region
    /// covers full screen, the removed lines go to scrollback.
    pub fn scroll_up_in_region(&mut self, n: u16) {
        let (top, bot) = self.scroll_region;
        let n = n.min(bot - top + 1);
        let cols = self.cols();
        let region_full_screen = top == 0 && bot == self.rows() - 1;
        let to_scrollback = !self.alt_active() && region_full_screen;

        for _ in 0..n {
            let lines = self.active_mut();
            let removed = lines.remove(top as usize);
            lines.insert(bot as usize, Line::blank(cols));
            if to_scrollback {
                self.scrollback.push_back(removed);
                self.scrollback_push_count = self.scrollback_push_count.wrapping_add(1);
                while self.scrollback.len() > self.max_scrollback {
                    self.scrollback.pop_front();
                }
            }
        }
        self.bump();
    }

    pub fn scroll_down_in_region(&mut self, n: u16) {
        let (top, bot) = self.scroll_region;
        let n = n.min(bot - top + 1);
        let cols = self.cols();
        for _ in 0..n {
            let lines = self.active_mut();
            lines.remove(bot as usize);
            lines.insert(top as usize, Line::blank(cols));
        }
        self.bump();
    }

    pub fn move_cursor_abs(&mut self, row: u16, col: u16) {
        let r = row.min(self.rows().saturating_sub(1));
        let c = col.min(self.cols().saturating_sub(1));
        self.cursor.row = r;
        self.cursor.col = c;
        self.cursor.pending_wrap = false;
        self.bump();
    }

    pub fn move_cursor_rel(&mut self, drow: i32, dcol: i32) {
        let r = (self.cursor.row as i32 + drow).clamp(0, self.rows() as i32 - 1) as u16;
        let c = (self.cursor.col as i32 + dcol).clamp(0, self.cols() as i32 - 1) as u16;
        self.cursor.row = r;
        self.cursor.col = c;
        self.cursor.pending_wrap = false;
        self.bump();
    }

    /// Erase in display: 0=cursor→end, 1=start→cursor, 2=all, 3=scrollback.
    pub fn erase_in_display(&mut self, mode: u16) {
        let cols = self.cols();
        let rows = self.rows();
        let (cr, cc) = (self.cursor.row, self.cursor.col);
        let blank = self.stamped_blank();
        let lines = self.active_mut();
        match mode {
            0 => {
                // Cursor to end.
                if let Some(line) = lines.get_mut(cr as usize) {
                    for c in (cc as usize)..(cols as usize) {
                        if let Some(cell) = line.cells.get_mut(c) {
                            *cell = blank;
                        }
                    }
                }
                for r in (cr as usize + 1)..(rows as usize) {
                    if let Some(line) = lines.get_mut(r) {
                        for cell in line.cells.iter_mut() {
                            *cell = blank;
                        }
                        line.wrapped = false;
                    }
                }
            }
            1 => {
                // Start to cursor.
                for r in 0..(cr as usize) {
                    if let Some(line) = lines.get_mut(r) {
                        for cell in line.cells.iter_mut() {
                            *cell = blank;
                        }
                        line.wrapped = false;
                    }
                }
                if let Some(line) = lines.get_mut(cr as usize) {
                    for c in 0..=(cc as usize) {
                        if let Some(cell) = line.cells.get_mut(c) {
                            *cell = blank;
                        }
                    }
                }
            }
            2 => {
                for line in lines.iter_mut() {
                    for cell in line.cells.iter_mut() {
                        *cell = blank;
                    }
                    line.wrapped = false;
                }
            }
            3 => {
                self.scrollback.clear();
            }
            _ => {}
        }
        self.bump();
    }

    /// Erase in line: 0=cursor→end, 1=start→cursor, 2=all.
    pub fn erase_in_line(&mut self, mode: u16) {
        let cols = self.cols();
        let (cr, cc) = (self.cursor.row, self.cursor.col);
        let blank = self.stamped_blank();
        let lines = self.active_mut();
        let line = match lines.get_mut(cr as usize) {
            Some(l) => l,
            None => return,
        };
        match mode {
            0 => {
                for c in (cc as usize)..(cols as usize) {
                    if let Some(cell) = line.cells.get_mut(c) {
                        *cell = blank;
                    }
                }
            }
            1 => {
                for c in 0..=(cc as usize) {
                    if let Some(cell) = line.cells.get_mut(c) {
                        *cell = blank;
                    }
                }
            }
            2 => {
                for cell in line.cells.iter_mut() {
                    *cell = blank;
                }
            }
            _ => {}
        }
        self.bump();
    }

    pub fn insert_lines(&mut self, n: u16) {
        let (top, bot) = self.scroll_region;
        if self.cursor.row < top || self.cursor.row > bot {
            return;
        }
        let n = n.min(bot - self.cursor.row + 1);
        let cols = self.cols();
        let cur = self.cursor.row;
        for _ in 0..n {
            let lines = self.active_mut();
            lines.remove(bot as usize);
            lines.insert(cur as usize, Line::blank(cols));
        }
        self.bump();
    }

    pub fn delete_lines(&mut self, n: u16) {
        let (top, bot) = self.scroll_region;
        if self.cursor.row < top || self.cursor.row > bot {
            return;
        }
        let n = n.min(bot - self.cursor.row + 1);
        let cols = self.cols();
        let cur = self.cursor.row;
        for _ in 0..n {
            let lines = self.active_mut();
            lines.remove(cur as usize);
            lines.insert(bot as usize, Line::blank(cols));
        }
        self.bump();
    }

    pub fn insert_chars(&mut self, n: u16) {
        let cols = self.cols();
        let (cr, cc) = (self.cursor.row, self.cursor.col);
        let blank = self.stamped_blank();
        let lines = self.active_mut();
        if let Some(line) = lines.get_mut(cr as usize) {
            let n = n.min(cols - cc) as usize;
            for _ in 0..n {
                line.cells.insert(cc as usize, blank);
                line.cells.truncate(cols as usize);
            }
        }
        self.bump();
    }

    pub fn delete_chars(&mut self, n: u16) {
        let cols = self.cols();
        let (cr, cc) = (self.cursor.row, self.cursor.col);
        let blank = self.stamped_blank();
        let lines = self.active_mut();
        if let Some(line) = lines.get_mut(cr as usize) {
            let n = n.min(cols - cc) as usize;
            for _ in 0..n {
                if (cc as usize) < line.cells.len() {
                    line.cells.remove(cc as usize);
                    line.cells.push(blank);
                }
            }
        }
        self.bump();
    }

    pub fn save_cursor(&mut self) {
        if self.alt_active() {
            self.saved_cursor_alt = Some(self.cursor);
        } else {
            self.saved_cursor = Some(self.cursor);
        }
    }

    pub fn restore_cursor(&mut self) {
        let src = if self.alt_active() {
            self.saved_cursor_alt
        } else {
            self.saved_cursor
        };
        if let Some(c) = src {
            self.cursor = c;
            self.bump();
        }
    }

    pub fn enter_alt_screen(&mut self, save_cursor: bool) {
        if self.alt.is_none() {
            if save_cursor {
                self.saved_cursor = Some(self.cursor);
            }
            let blank = vec![Line::blank(self.cols()); self.rows() as usize];
            self.alt = Some(blank);
            self.cursor = Cursor::default();
            self.bump();
        }
    }

    pub fn exit_alt_screen(&mut self, restore_cursor: bool) {
        if self.alt.is_some() {
            self.alt = None;
            if restore_cursor {
                if let Some(c) = self.saved_cursor.take() {
                    self.cursor = c;
                }
            }
            self.bump();
        }
    }

    pub fn set_scroll_region(&mut self, top: u16, bot: u16) {
        let rows = self.rows();
        let top = top.min(rows - 1);
        let bot = bot.min(rows - 1).max(top);
        self.scroll_region = (top, bot);
        // Cursor goes to home.
        self.cursor.row = 0;
        self.cursor.col = 0;
        self.cursor.pending_wrap = false;
        self.bump();
    }

    pub fn set_title(&mut self, title: String) {
        self.title = Some(title);
        self.bump();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(rows: u16, cols: u16) -> Screen {
        Screen::new(rows, cols)
    }

    #[test]
    fn put_char_basic() {
        let mut sc = s(3, 10);
        sc.put_char('h');
        sc.put_char('i');
        assert_eq!(sc.cursor.col, 2);
        assert_eq!(sc.render_text(), "hi\n\n");
    }

    #[test]
    fn carriage_return_resets_col() {
        let mut sc = s(3, 10);
        sc.put_char('a');
        sc.put_char('b');
        sc.carriage_return();
        assert_eq!(sc.cursor.col, 0);
        sc.put_char('X');
        assert_eq!(sc.render_text(), "Xb\n\n");
    }

    #[test]
    fn linefeed_advances_row() {
        let mut sc = s(3, 10);
        sc.put_char('a');
        sc.linefeed();
        assert_eq!(sc.cursor.row, 1);
    }

    #[test]
    fn linefeed_at_bottom_scrolls() {
        let mut sc = s(3, 10);
        sc.put_char('a');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('b');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('c');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('d');
        // After scrolling: a went to scrollback, visible is b/c/d.
        assert_eq!(sc.render_text(), "b\nc\nd");
        assert_eq!(sc.scrollback.len(), 1);
    }

    #[test]
    fn alt_screen_does_not_scrollback() {
        let mut sc = s(3, 10);
        sc.put_char('a');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('b');
        sc.enter_alt_screen(true);
        assert_eq!(sc.render_text(), "\n\n");
        sc.put_char('X');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('Y');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('Z');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('W'); // forces scroll in alt
        // Alt screen scrolled but scrollback untouched.
        assert!(sc.scrollback.is_empty());
        sc.exit_alt_screen(true);
        // Primary content preserved + cursor restored.
        assert_eq!(sc.render_text(), "a\nb\n");
    }

    #[test]
    fn erase_in_display_2_clears_all() {
        let mut sc = s(3, 5);
        sc.put_char('a');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('b');
        sc.erase_in_display(2);
        assert_eq!(sc.render_text(), "\n\n");
    }

    #[test]
    fn move_cursor_abs_clamps() {
        let mut sc = s(3, 10);
        sc.move_cursor_abs(99, 99);
        assert_eq!(sc.cursor.row, 2);
        assert_eq!(sc.cursor.col, 9);
    }

    #[test]
    fn wide_char_takes_two_cells() {
        let mut sc = s(2, 10);
        sc.put_char('世');
        sc.put_char('界');
        assert_eq!(sc.cursor.col, 4);
        assert_eq!(sc.render_text(), "世界\n");
        let line = &sc.primary[0];
        assert_eq!(line.cells[0].width, 2);
        assert_eq!(line.cells[1].width, 0);
        assert_eq!(line.cells[2].width, 2);
        assert_eq!(line.cells[3].width, 0);
    }

    #[test]
    fn pending_wrap_at_eol_defers_wrap() {
        let mut sc = s(3, 3);
        sc.put_char('a');
        sc.put_char('b');
        sc.put_char('c');
        // cursor pinned at col=2 with pending_wrap.
        assert_eq!(sc.cursor.col, 2);
        assert!(sc.cursor.pending_wrap);
        sc.put_char('d');
        // Now wrap happened: 'd' on row 1 col 0.
        assert_eq!(sc.cursor.row, 1);
        assert_eq!(sc.cursor.col, 1);
        assert_eq!(sc.render_text(), "abc\nd\n");
    }

    #[test]
    fn save_and_restore_cursor() {
        let mut sc = s(5, 10);
        sc.move_cursor_abs(2, 3);
        sc.save_cursor();
        sc.move_cursor_abs(4, 5);
        sc.restore_cursor();
        assert_eq!(sc.cursor.row, 2);
        assert_eq!(sc.cursor.col, 3);
    }

    #[test]
    fn insert_lines_pushes_below() {
        let mut sc = s(4, 5);
        sc.put_char('a');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('b');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('c');
        // cursor at row 2 col 1 (after 'c')
        sc.move_cursor_abs(1, 0);
        sc.insert_lines(1);
        assert_eq!(sc.render_text(), "a\n\nb\nc");
    }

    #[test]
    fn delete_lines_pulls_up() {
        let mut sc = s(4, 5);
        sc.put_char('a');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('b');
        sc.linefeed();
        sc.carriage_return();
        sc.put_char('c');
        sc.move_cursor_abs(0, 0);
        sc.delete_lines(1);
        assert_eq!(sc.render_text(), "b\nc\n\n");
    }
}
