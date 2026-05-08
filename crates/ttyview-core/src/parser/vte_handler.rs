//! `vte::Perform` impl — translates parsed escape sequence actions into
//! mutations on `Screen`. The Screen impls Perform; we wrap it in `Term` so
//! callers can `term.feed(bytes)` without juggling a separate parser.

use crate::grid::{Color, Screen};
use vte::{Params, Parser, Perform};

pub struct Term {
    pub screen: Screen,
    parser: Parser,
}

impl Term {
    pub fn new(rows: u16, cols: u16) -> Self {
        Term {
            screen: Screen::new(rows, cols),
            parser: Parser::new(),
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        // Stamp every cell touched by this feed with the current wall-clock
        // ms. Wpin7's per-row "settled" timestamp reads max(cell.mtime) per
        // row, debounced 1.5s after the last byte arrives. One mtime per
        // feed (rather than per-byte) is a deliberate coarsening — bursts
        // that span <1ms shouldn't make the row look like it's still
        // streaming after the burst settles.
        self.screen.current_mtime = unix_ms_now();
        for &b in bytes {
            self.parser.advance(&mut self.screen, b);
        }
    }
}

fn unix_ms_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Perform for Screen {
    fn print(&mut self, c: char) {
        self.put_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            0x07 => { /* BEL — TODO: emit bell event */ }
            0x08 => self.backspace(),
            0x09 => self.tab(),
            0x0a | 0x0b | 0x0c => self.linefeed(), // LF, VT, FF
            0x0d => self.carriage_return(),
            _ => {}
        }
    }

    fn hook(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _action: char) {
        // DCS — sixel, etc. Ignored for v1.
    }

    fn put(&mut self, _byte: u8) {}

    fn unhook(&mut self) {}

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.is_empty() {
            return;
        }
        let kind = std::str::from_utf8(params[0]).unwrap_or("");
        match kind {
            "0" | "2" => {
                if let Some(value) = params.get(1) {
                    if let Ok(s) = std::str::from_utf8(value) {
                        self.set_title(s.to_string());
                    }
                }
            }
            // OSC 8 (hyperlinks), OSC 52 (clipboard), OSC 133 (semantic prompts)
            // intentionally skipped for v1. Add later — they're cheap wins.
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        let p1 = first_param(params, 1);

        // DEC private (`?`) modes get their own dispatcher.
        if intermediates.first() == Some(&b'?') {
            handle_dec_private(self, params, action);
            return;
        }
        // Other private/extension prefixes (`>`, `<`, `=`, `!`, `$` etc.) are
        // for terminal extensions like XTMODKEYS (`\x1b[>4m`,
        // `\x1b[>4;2m`) — keyboard mode negotiation, NOT SGR. Forwarding
        // those to handle_sgr() turned underline on every time CC
        // negotiated its keymap, which left every subsequently-written cell
        // underlined. Drop them; we don't reply to them either.
        if let Some(&b) = intermediates.first() {
            if b == b'>' || b == b'<' || b == b'=' || b == b'!' || b == b'$' {
                return;
            }
        }

        match action {
            'A' => self.move_cursor_rel(-(p1 as i32), 0),                // CUU
            'B' => self.move_cursor_rel(p1 as i32, 0),                   // CUD
            'C' => self.move_cursor_rel(0, p1 as i32),                   // CUF
            'D' => self.move_cursor_rel(0, -(p1 as i32)),                // CUB
            'E' => {
                self.move_cursor_rel(p1 as i32, 0);
                self.carriage_return();
            }
            'F' => {
                self.move_cursor_rel(-(p1 as i32), 0);
                self.carriage_return();
            }
            'G' | '`' => {
                let col = p1.saturating_sub(1) as u16;
                let row = self.cursor.row;
                self.move_cursor_abs(row, col);
            }
            'H' | 'f' => {
                let row = first_param(params, 1).saturating_sub(1) as u16;
                let col = nth_param(params, 1, 1).saturating_sub(1) as u16;
                self.move_cursor_abs(row, col);
            }
            'J' => self.erase_in_display(first_param(params, 0) as u16),
            'K' => self.erase_in_line(first_param(params, 0) as u16),
            'L' => self.insert_lines(p1 as u16),
            'M' => self.delete_lines(p1 as u16),
            'P' => self.delete_chars(p1 as u16),
            '@' => self.insert_chars(p1 as u16),
            'S' => self.scroll_up_in_region(p1 as u16),
            'T' => self.scroll_down_in_region(p1 as u16),
            'd' => {
                let row = p1.saturating_sub(1) as u16;
                let col = self.cursor.col;
                self.move_cursor_abs(row, col);
            }
            'm' => handle_sgr(self, params),
            'r' => {
                let top = first_param(params, 1).saturating_sub(1) as u16;
                let bot = nth_param(params, 1, self.rows() as usize).saturating_sub(1) as u16;
                self.set_scroll_region(top, bot);
            }
            's' => self.save_cursor(),
            'u' => self.restore_cursor(),
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, byte: u8) {
        match byte {
            b'7' => self.save_cursor(),
            b'8' => self.restore_cursor(),
            b'D' => self.linefeed(),         // IND — index
            b'E' => {
                self.linefeed();
                self.carriage_return();
            }
            b'M' => self.reverse_linefeed(), // RI — reverse index
            b'c' => {
                // RIS — full reset.
                let (rows, cols) = self.size;
                *self = Screen::new(rows, cols);
            }
            _ => {}
        }
    }
}

fn first_param(params: &Params, default: usize) -> usize {
    params
        .iter()
        .next()
        .and_then(|p| p.first().copied())
        .map(|v| if v == 0 { default } else { v as usize })
        .unwrap_or(default)
}

fn nth_param(params: &Params, n: usize, default: usize) -> usize {
    params
        .iter()
        .nth(n)
        .and_then(|p| p.first().copied())
        .map(|v| if v == 0 { default } else { v as usize })
        .unwrap_or(default)
}

fn handle_dec_private(screen: &mut Screen, params: &Params, action: char) {
    let set = action == 'h';
    let reset = action == 'l';
    if !(set || reset) {
        return;
    }
    for p in params.iter() {
        let code = p.first().copied().unwrap_or(0);
        match code {
            7 => screen.autowrap = set,
            25 => screen.cursor.visible = set,
            47 | 1047 => {
                if set {
                    screen.enter_alt_screen(false);
                } else {
                    screen.exit_alt_screen(false);
                }
            }
            1048 => {
                if set {
                    screen.save_cursor();
                } else {
                    screen.restore_cursor();
                }
            }
            1049 => {
                if set {
                    screen.enter_alt_screen(true);
                } else {
                    screen.exit_alt_screen(true);
                }
            }
            _ => {}
        }
    }
}

fn handle_sgr(screen: &mut Screen, params: &Params) {
    let mut iter = params.iter();
    let mut peek: Option<&[u16]> = None;
    loop {
        let p = match peek.take().or_else(|| iter.next()) {
            Some(v) => v,
            None => return,
        };
        let code = p.first().copied().unwrap_or(0);
        match code {
            0 => screen.cursor.reset_sgr(),
            1 => screen.cursor.attrs.bold = true,
            2 => screen.cursor.attrs.dim = true,
            3 => screen.cursor.attrs.italic = true,
            4 => {
                // Extended underline subparam form: `\x1b[4:N m`.
                //   4:0 → no underline   (this is the one that bit us — terminals
                //         like Claude Code use 4:N for curly/dotted/etc. and emit
                //         4:0 to turn it off; treating that as plain `4` left
                //         underline=true permanently.)
                //   4:1..=5 → on (single, double, curly, dotted, dashed)
                //   bare 4  → on (single)
                let style = p.get(1).copied().unwrap_or(1);
                screen.cursor.attrs.underline = style != 0;
            }
            5 | 6 => screen.cursor.attrs.blink = true,
            7 => screen.cursor.attrs.inverse = true,
            8 => screen.cursor.attrs.hidden = true,
            9 => screen.cursor.attrs.strike = true,
            22 => {
                screen.cursor.attrs.bold = false;
                screen.cursor.attrs.dim = false;
            }
            23 => screen.cursor.attrs.italic = false,
            24 => screen.cursor.attrs.underline = false,
            25 => screen.cursor.attrs.blink = false,
            27 => screen.cursor.attrs.inverse = false,
            28 => screen.cursor.attrs.hidden = false,
            29 => screen.cursor.attrs.strike = false,
            30..=37 => screen.cursor.fg = Color::Indexed((code - 30) as u8),
            38 => {
                let (color, _consumed) = parse_extended_color(&mut iter);
                if let Some(c) = color {
                    screen.cursor.fg = c;
                }
            }
            39 => screen.cursor.fg = Color::Default,
            40..=47 => screen.cursor.bg = Color::Indexed((code - 40) as u8),
            48 => {
                let (color, _consumed) = parse_extended_color(&mut iter);
                if let Some(c) = color {
                    screen.cursor.bg = c;
                }
            }
            49 => screen.cursor.bg = Color::Default,
            90..=97 => screen.cursor.fg = Color::Indexed((code - 90 + 8) as u8),
            100..=107 => screen.cursor.bg = Color::Indexed((code - 100 + 8) as u8),
            _ => {}
        }
    }
}

/// Consume the parameters following `38` or `48`. Two forms:
///   `38;5;N`         — palette index N (256-color)
///   `38;2;R;G;B`     — RGB (truecolor)
/// vte may deliver these as either separate params (`;`) or a single sub-param
/// list (`:`); we handle both by peeking into the param iterator.
fn parse_extended_color<'a, I>(iter: &mut I) -> (Option<Color>, usize)
where
    I: Iterator<Item = &'a [u16]>,
{
    let p = match iter.next() {
        Some(p) => p,
        None => return (None, 0),
    };
    // Sub-param form: 38:5:N or 38:2::R:G:B (sub-params come together in p[1..]).
    if p.len() >= 2 {
        match p[0] {
            5 => return (Some(Color::Indexed(p[1] as u8)), 1),
            2 => {
                if p.len() >= 4 {
                    return (
                        Some(Color::Rgb(p[1] as u8, p[2] as u8, p[3] as u8)),
                        1,
                    );
                }
                if p.len() >= 5 {
                    // 38:2::R:G:B (color space id at p[1])
                    return (
                        Some(Color::Rgb(p[2] as u8, p[3] as u8, p[4] as u8)),
                        1,
                    );
                }
            }
            _ => {}
        }
    }
    // Separated-param form: 38;5;N or 38;2;R;G;B.
    let mode = p.first().copied().unwrap_or(0);
    match mode {
        5 => {
            let n = iter.next().and_then(|p| p.first().copied()).unwrap_or(0);
            (Some(Color::Indexed(n as u8)), 2)
        }
        2 => {
            let r = iter.next().and_then(|p| p.first().copied()).unwrap_or(0);
            let g = iter.next().and_then(|p| p.first().copied()).unwrap_or(0);
            let b = iter.next().and_then(|p| p.first().copied()).unwrap_or(0);
            (Some(Color::Rgb(r as u8, g as u8, b as u8)), 4)
        }
        _ => (None, 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(rows: u16, cols: u16) -> Term {
        Term::new(rows, cols)
    }

    #[test]
    fn print_basic() {
        let mut t = term(3, 10);
        t.feed(b"hello");
        assert_eq!(t.screen.render_text(), "hello\n\n");
    }

    #[test]
    fn newline_carriage_return() {
        let mut t = term(3, 10);
        t.feed(b"a\r\nb\r\nc");
        assert_eq!(t.screen.render_text(), "a\nb\nc");
    }

    #[test]
    fn cursor_position_csi_h() {
        let mut t = term(5, 10);
        t.feed(b"\x1b[3;5H");
        assert_eq!(t.screen.cursor.row, 2);
        assert_eq!(t.screen.cursor.col, 4);
    }

    #[test]
    fn cursor_position_default_is_origin() {
        let mut t = term(5, 10);
        t.feed(b"\x1b[H");
        assert_eq!(t.screen.cursor.row, 0);
        assert_eq!(t.screen.cursor.col, 0);
    }

    #[test]
    fn cursor_up_clamps_at_top() {
        let mut t = term(5, 10);
        t.feed(b"\x1b[3;3H\x1b[100A");
        assert_eq!(t.screen.cursor.row, 0);
        assert_eq!(t.screen.cursor.col, 2);
    }

    #[test]
    fn erase_in_display_2() {
        let mut t = term(3, 5);
        t.feed(b"hello\r\nworld\x1b[2J");
        assert_eq!(t.screen.render_text(), "\n\n");
    }

    #[test]
    fn erase_in_line_to_end() {
        let mut t = term(2, 10);
        t.feed(b"hello\x1b[3G\x1b[K");
        assert_eq!(t.screen.render_text(), "he\n");
    }

    #[test]
    fn sgr_bold_red() {
        let mut t = term(2, 10);
        t.feed(b"\x1b[1;31mX\x1b[m");
        assert!(t.screen.primary[0].cells[0].attrs.bold);
        assert_eq!(t.screen.primary[0].cells[0].fg, Color::Indexed(1));
        // After reset, cursor SGR back to default.
        assert!(!t.screen.cursor.attrs.bold);
    }

    #[test]
    fn sgr_256color() {
        let mut t = term(2, 10);
        t.feed(b"\x1b[38;5;208mX");
        assert_eq!(t.screen.primary[0].cells[0].fg, Color::Indexed(208));
    }

    #[test]
    fn sgr_rgb() {
        let mut t = term(2, 10);
        t.feed(b"\x1b[38;2;10;20;30mX");
        assert_eq!(t.screen.primary[0].cells[0].fg, Color::Rgb(10, 20, 30));
    }

    #[test]
    fn xtmodkeys_does_not_set_underline() {
        // CC sends `\x1b[>4m` and `\x1b[>4;2m` (XTMODKEYS — keyboard mode
        // negotiation). vte exposes the `>` as an intermediate; the
        // numeric param is [4] / [4, 2]. If our `m` handler doesn't check
        // intermediates first, it sees a 4 and turns underline on, which
        // then leaks onto every subsequent character. Regression test for
        // the bug reported via PANEL_TRACE_PANE on 2026-04-27.
        let mut t = term(2, 10);
        t.feed(b"\x1b[>4mX");
        assert!(
            !t.screen.primary[0].cells[0].attrs.underline,
            "XTMODKEYS \x1b[>4m must not turn underline on"
        );
        t.feed(b"\x1b[>4;2mY");
        assert!(
            !t.screen.primary[0].cells[1].attrs.underline,
            "XTMODKEYS \x1b[>4;2m must not turn underline on"
        );
        // Plain CSI 4 m must still work.
        t.feed(b"\x1b[4mZ");
        assert!(t.screen.primary[0].cells[2].attrs.underline);
    }

    #[test]
    fn alt_screen_via_csi_1049() {
        let mut t = term(3, 10);
        t.feed(b"primary\x1b[?1049halt");
        // primary content kept in primary buffer; alt has "alt".
        assert_eq!(t.screen.render_text(), "alt\n\n");
        t.feed(b"\x1b[?1049l");
        assert_eq!(t.screen.render_text(), "primary\n\n");
    }

    #[test]
    fn osc_set_title() {
        let mut t = term(2, 10);
        t.feed(b"\x1b]0;hello world\x07");
        assert_eq!(t.screen.title.as_deref(), Some("hello world"));
    }

    #[test]
    fn save_restore_cursor_via_esc() {
        let mut t = term(5, 10);
        t.feed(b"\x1b[3;5H\x1b7\x1b[1;1H\x1b8");
        assert_eq!(t.screen.cursor.row, 2);
        assert_eq!(t.screen.cursor.col, 4);
    }

    #[test]
    fn reverse_index_at_top_scrolls_down() {
        let mut t = term(3, 5);
        t.feed(b"a\r\nb\r\nc");
        t.feed(b"\x1b[Ha"); // back to top, write 'a' (overwrites 'a')
        t.feed(b"\x1bM");   // reverse index — should scroll down
        // Row 0 now blank, row 1 has 'a' (which was at row 0), row 2 has 'b'.
        // (c was pushed off bottom)
        let text = t.screen.render_text();
        assert!(text.starts_with("\na"), "got: {:?}", text);
    }

    #[test]
    fn scrolling_region_basic() {
        let mut t = term(5, 5);
        t.feed(b"a\r\nb\r\nc\r\nd\r\ne");
        // Set region to lines 2..4 (1-indexed), then go bottom of region and LF.
        t.feed(b"\x1b[2;4r\x1b[4;1H\n");
        // Cursor was at row 3 (0-indexed), region (1,3). LF should scroll region.
        // Row 1 ('b') should be gone; row 2,3 shift up; row 3 blank.
        let text = t.screen.render_text();
        assert_eq!(text.lines().count(), 5);
    }

    #[test]
    fn does_not_panic_on_random_bytes() {
        let mut t = term(24, 80);
        t.feed(b"\x1b[\xff\xff\xff\x07\x08\x09");
        t.feed(&[0u8; 32]);
        t.feed(&[0xffu8; 32]);
        // Just shouldn't panic / hang.
    }
}
