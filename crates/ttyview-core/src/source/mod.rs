//! Source — where pane byte streams come from.
//!
//! The `Source` trait is the key seam: anything that produces a stream of
//! `(pane_id, bytes)` events can drive the rest of the system. `tmux_control`
//! is one impl. `replay` (file → events) is another. A future `pty` impl will
//! own its own PTYs.

pub mod multi_session;
pub mod tmux_control;

use bytes::Bytes;

#[derive(Debug, Clone)]
pub enum SourceEvent {
    /// A new pane appeared.
    PaneAdded {
        pane: PaneId,
        session: Option<String>,
        window: Option<String>,
    },
    /// Bytes written to a pane.
    Output { pane: PaneId, bytes: Bytes },
    /// A pane was closed.
    PaneClosed { pane: PaneId },
    /// A pane resized.
    Resized { pane: PaneId, rows: u16, cols: u16 },
    /// Source itself terminated (the underlying tmux process exited, etc.).
    Closed { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PaneId(pub String);

impl PaneId {
    pub fn new(s: impl Into<String>) -> Self {
        PaneId(s.into())
    }
}

impl std::fmt::Display for PaneId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
