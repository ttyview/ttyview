use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Color {
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

impl Default for Color {
    fn default() -> Self {
        Color::Default
    }
}

impl Color {
    pub fn is_default(&self) -> bool {
        matches!(self, Color::Default)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Attrs {
    #[serde(default, skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub dim: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub blink: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub inverse: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub strike: bool,
}

impl Attrs {
    pub fn is_all_false(&self) -> bool {
        !self.bold
            && !self.dim
            && !self.italic
            && !self.underline
            && !self.blink
            && !self.inverse
            && !self.hidden
            && !self.strike
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cell {
    pub ch: char,
    /// Foreground color. Skipped from JSON when Default — the most
    /// common case (every blank padding cell). Combined with `bg` /
    /// `attrs` / `width` skip-defaults this typically shrinks blank
    /// cells from ~190 B to ~12 B, ~16× the wire-size reduction. The
    /// 7 MB scrollback fetches that timed out wpin7 over Tailscale on
    /// mobile drop to ~500 KB.
    #[serde(default, skip_serializing_if = "Color::is_default")]
    pub fg: Color,
    #[serde(default, skip_serializing_if = "Color::is_default")]
    pub bg: Color,
    #[serde(default, skip_serializing_if = "Attrs::is_all_false")]
    pub attrs: Attrs,
    /// 0 = continuation cell of a wide char (do not render).
    /// 1 = single-width (default — skipped from JSON).
    /// 2 = wide (CJK / emoji); the next cell is its continuation.
    #[serde(default = "default_width", skip_serializing_if = "is_one_u8")]
    pub width: u8,
    /// Unix epoch milliseconds at which this cell was last written.
    /// 0 = never touched. Stamped by `Screen::current_mtime` at every
    /// byte-driven mutation. Wpin7 uses this to compute a per-row
    /// "settled" timestamp without keeping a separate change log.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub mtime: u64,
}

fn is_zero_u64(v: &u64) -> bool {
    *v == 0
}

fn is_false(v: &bool) -> bool {
    !*v
}

fn default_width() -> u8 {
    1
}

fn is_one_u8(v: &u8) -> bool {
    *v == 1
}

impl Default for Cell {
    fn default() -> Self {
        Cell::EMPTY
    }
}

impl Cell {
    pub const EMPTY: Cell = Cell {
        ch: ' ',
        fg: Color::Default,
        bg: Color::Default,
        attrs: Attrs {
            bold: false,
            dim: false,
            italic: false,
            underline: false,
            blink: false,
            inverse: false,
            hidden: false,
            strike: false,
        },
        width: 1,
        mtime: 0,
    };

    pub fn is_continuation(&self) -> bool {
        self.width == 0
    }

    pub fn is_blank(&self) -> bool {
        self.ch == ' ' && self.fg == Color::Default && self.bg == Color::Default
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_cell_is_blank_space() {
        let c = Cell::EMPTY;
        assert_eq!(c.ch, ' ');
        assert_eq!(c.width, 1);
        assert!(c.is_blank());
        assert!(!c.is_continuation());
    }

    #[test]
    fn continuation_cell_detected() {
        let mut c = Cell::EMPTY;
        c.width = 0;
        assert!(c.is_continuation());
    }
}
