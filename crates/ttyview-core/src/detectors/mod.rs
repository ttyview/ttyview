//! Semantic detectors — pluggable observers that turn rendered grid state +
//! recent output bytes into higher-level events ("shell prompt ready", "Claude
//! is asking for permission", "tool call started", etc.).
//!
//! Detectors run after every `apply()` of an Output event. They're cheap
//! state machines, not regexes against the whole grid each tick — keep them
//! small and stateful where useful.

use crate::Screen;
use serde::{Deserialize, Serialize};

pub mod claude;
pub mod shell;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticEvent {
    pub name: String,
    pub at_gen: u64,
    pub data: serde_json::Value,
}

pub struct DetectContext<'a> {
    pub pane_id: &'a str,
    pub screen: &'a Screen,
    /// Bytes the screen received since the last detector call. May be empty.
    pub recent_bytes: &'a [u8],
}

pub trait Detector: Send + Sync {
    fn name(&self) -> &str;
    fn observe(&mut self, ctx: &DetectContext<'_>) -> Vec<SemanticEvent>;
}

/// Bundle of detectors that run together. Each detector keeps its own state
/// across calls, so create one Bundle per pane.
pub struct Bundle {
    detectors: Vec<Box<dyn Detector>>,
}

impl Default for Bundle {
    fn default() -> Self {
        Bundle::new()
    }
}

impl Bundle {
    pub fn new() -> Self {
        Bundle {
            detectors: Vec::new(),
        }
    }

    pub fn with_defaults() -> Self {
        let mut b = Bundle::new();
        b.add(Box::new(shell::BashPromptDetector::default()));
        b.add(Box::new(claude::ClaudePermissionDetector::default()));
        b
    }

    pub fn add(&mut self, d: Box<dyn Detector>) {
        self.detectors.push(d);
    }

    pub fn observe(&mut self, ctx: &DetectContext<'_>) -> Vec<SemanticEvent> {
        let mut events = Vec::new();
        for d in &mut self.detectors {
            events.extend(d.observe(ctx));
        }
        events
    }

    pub fn names(&self) -> Vec<&str> {
        self.detectors.iter().map(|d| d.name()).collect()
    }
}
