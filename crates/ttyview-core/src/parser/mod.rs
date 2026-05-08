//! VT/xterm escape parser glue. The actual escape *parser* (state machine over bytes
//! → semantic actions) lives in the `vte` crate; this module wraps it with
//! `vte::Perform` impls that translate actions into `Screen` mutations.

pub mod vte_handler;

pub use vte_handler::Term;
