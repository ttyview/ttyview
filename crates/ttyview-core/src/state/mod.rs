//! Process-wide pane registry and broadcast channels.
//!
//! `PaneStore` is the heart of the daemon: a concurrent map from `PaneId` to
//! `PaneState` (each behind an `RwLock`), plus a per-pane broadcast channel
//! for live events. The `state` module is `Source`-agnostic — anything that
//! produces `SourceEvent`s can drive it via [`PaneStore::apply`].

use crate::detectors::{Bundle, DetectContext, SemanticEvent};
use crate::grid::Cell;
use crate::source::{PaneId, SourceEvent};
use crate::Term;
use bytes::Bytes;
use dashmap::DashMap;
use serde::Serialize;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{broadcast, Mutex, RwLock};

/// Maximum number of buffered events per WS subscriber. If a slow client
/// can't keep up, it'll receive a "lagged" error and should re-snapshot.
const PER_PANE_CHANNEL_CAPACITY: usize = 1024;

/// Live state for a single pane.
pub struct PaneState {
    pub id: PaneId,
    pub term: Term,
    pub last_byte_at: Instant,
    pub session: Option<String>,
    pub window: Option<String>,
    /// True after we've observed Claude Code's startup banner emitted into
    /// this pane. Used by the CC re-emission workaround
    /// (see <https://github.com/anthropics/claude-code/issues/46834>):
    /// CC v2.1.101+ re-emits the entire transcript on every SIGWINCH /
    /// Ctrl+O / Shift+Tab, leaving stale frames in scrollback. After we've
    /// seen the banner once, any subsequent chunk containing the banner
    /// pattern is by definition one of those spurious re-emissions and we
    /// drop it. See `chunk_is_cc_reemission()` below.
    pub cc_banner_seen: bool,
}

impl PaneState {
    pub fn new(id: PaneId, rows: u16, cols: u16) -> Self {
        PaneState {
            id,
            term: Term::new(rows, cols),
            last_byte_at: Instant::now(),
            session: None,
            window: None,
            cc_banner_seen: false,
        }
    }

    pub fn idle_ms(&self) -> u64 {
        self.last_byte_at.elapsed().as_millis() as u64
    }
}

/// Live event published on the broadcast channel for a pane.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t")]
pub enum LiveEvent {
    /// Raw bytes (Protocol A — thin client).
    #[serde(rename = "out")]
    Output {
        #[serde(rename = "p")]
        pane: String,
        /// Base64-encoded for JSON safety.
        #[serde(rename = "b")]
        bytes_b64: String,
    },
    /// New generation reached after a feed (Protocol B — structured).
    #[serde(rename = "tick")]
    Tick {
        #[serde(rename = "p")]
        pane: String,
        #[serde(rename = "gen")]
        generation: u64,
        #[serde(rename = "alt")]
        alt: bool,
        #[serde(rename = "row")]
        cursor_row: u16,
        #[serde(rename = "col")]
        cursor_col: u16,
        /// Number of lines currently in the pane's scrollback. Lets a
        /// client that caches scrollback (because per-tick fetches use
        /// `?skip_scrollback=1`) detect when the daemon has accumulated
        /// new history and refresh its cache. Without this signal,
        /// content that scrolls straight off a tiny primary buffer
        /// stays invisible until the client closes+reopens the view.
        #[serde(rename = "sb_len")]
        scrollback_len: usize,
    },
    #[serde(rename = "title")]
    Title {
        #[serde(rename = "p")]
        pane: String,
        #[serde(rename = "v")]
        value: String,
    },
    #[serde(rename = "closed")]
    Closed {
        #[serde(rename = "p")]
        pane: String,
    },
    /// Semantic event from a detector (Claude permission, shell prompt, etc.).
    #[serde(rename = "semantic")]
    Semantic {
        #[serde(rename = "p")]
        pane: String,
        event: SemanticEvent,
    },
    /// Wpin7: per-pane batch of cells whose mtime advanced since last
    /// diff. Coalesced server-side on a 50ms tick by
    /// `run_cell_diff_broadcaster` so a single byte burst doesn't fan
    /// out to dozens of WS frames. Cells carry full state so the client
    /// applies them idempotently.
    #[serde(rename = "cell-diff")]
    CellDiff {
        #[serde(rename = "p")]
        pane: String,
        /// Server emit time (epoch ms). Helpful for client-side diag.
        ts: u64,
        cells: Vec<CellDiffEntry>,
    },
    /// Wpin7: pane's alt-screen state flipped (CC entering/leaving its
    /// TUI). Client should drop all DOM cells and re-fetch via
    /// `GET /panes/:id/grid` — coordinates from before the flip are
    /// meaningless after.
    #[serde(rename = "grid-reset")]
    GridReset {
        #[serde(rename = "p")]
        pane: String,
        /// New alt-screen state after the flip.
        alt: bool,
    },
    /// Wpin7 "freeze on scroll-off": rows that just left primary
    /// (scrolled into scrollback). The client appends each row's
    /// cells as a new frozen DOM row above the live primary. Past
    /// content never mutates after this — CC physically can't reach
    /// scrollback rows, so they're append-only by terminal semantics.
    /// The client may keep these rows even if panel evicts them from
    /// `screen.scrollback` later (panel's max_scrollback cap doesn't
    /// erase the user's history, just frees server-side memory).
    #[serde(rename = "scrollback-append")]
    ScrollbackAppend {
        #[serde(rename = "p")]
        pane: String,
        /// `screen.scrollback_push_count` BEFORE this batch was
        /// emitted. Lets the client deduplicate against hydrate:
        /// if the client already saw `to_count >= from_count` from a
        /// prior /grid hydrate, skip the rows that fall in the
        /// overlap window.
        from_count: u64,
        /// Cumulative push count after applying this batch. Client
        /// stores this as its new "last seen" cursor.
        to_count: u64,
        /// Newly-appended rows, oldest-first. Each entry is the cell
        /// list for that row (full Cell shape; the client renders one
        /// `<span>` per cell).
        rows: Vec<Vec<Cell>>,
    },
}

/// A single cell touched within a `CellDiff` window. Position + full
/// cell state — flat shape for compact JSON. (r,c) are coordinates in
/// the active grid (primary or alt depending on current state).
#[derive(Debug, Clone, Serialize)]
pub struct CellDiffEntry {
    pub r: u16,
    pub c: u16,
    #[serde(flatten)]
    pub cell: Cell,
}

/// Per-pane bundle: the locked state + a broadcast tx + detectors.
pub struct PaneSlot {
    pub state: Arc<RwLock<PaneState>>,
    pub tx: broadcast::Sender<LiveEvent>,
    pub detectors: Mutex<Bundle>,
    /// Wpin7 cell-diff broadcaster's per-pane bookkeeping. The
    /// broadcaster (see `run_cell_diff_broadcaster`) ticks every 50ms,
    /// reads `screen.generation`, and short-circuits when it hasn't
    /// changed since `last_gen`. When it has, it walks the active grid
    /// for cells where `mtime > last_mtime`, emits a `CellDiff`, and
    /// updates these counters.
    pub diff_state: std::sync::Mutex<DiffState>,
}

#[derive(Debug, Default, Clone)]
pub struct DiffState {
    /// Last screen generation we walked. If unchanged, no mutation
    /// happened — skip the walk entirely (steady-state idle is free).
    pub last_gen: u64,
    /// Last alt-screen state we observed. On flip, broadcast a
    /// `grid-reset` and reset `last_row_hashes` so the post-flip grid
    /// is freshly published.
    pub last_alt: bool,
    /// Content hash per visible-grid row from the last broadcast.
    /// Replaces the previous `last_mtime` scheme: a Line rotation
    /// (e.g. CC TUI scroll on submit) moves cells between rows
    /// without bumping their mtime, so an mtime-floor scan misses
    /// the move and the client renders stale neighbours under fresh
    /// writes (the wpin7 "garbled status line" symptom). Hashing
    /// the row's actual content catches both writes AND moves.
    /// Length matches `screen.active().len()`; rows whose hash
    /// differs from `prev` get all their cells re-broadcast.
    pub last_row_hashes: Vec<u64>,
    /// Cursor into `screen.scrollback_push_count`. The broadcaster
    /// emits `ScrollbackAppend` for the rows pushed since this
    /// counter — i.e., for the freshly-evicted-from-primary lines
    /// the client hasn't seen yet. Bumped to current count after
    /// each emit. On client (re)connect / hydrate, this is treated
    /// as "everything up to current count is already accounted for"
    /// because the hydrate response already includes scrollback.
    pub last_scrollback_count: u64,
}

/// Process-wide pane registry.
#[derive(Clone, Default)]
pub struct PaneStore {
    panes: Arc<DashMap<PaneId, Arc<PaneSlot>>>,
    /// Default size for newly-discovered panes (until an actual size is known).
    default_size: (u16, u16),
    /// Optional `-L <socket>` arg for `tmux` shells. Lets the Resized
    /// handler re-seed its rebuilt Term from the live pane via
    /// `capture-pane -e` so resizes don't leave the panel pin blank
    /// until the next CC interaction.
    tmux_socket: Option<String>,
    /// Bytes-tracer (for parser bug repro): when env var `PANEL_TRACE_PANE`
    /// is set to a pane id at startup, every `%output` event for that pane
    /// gets appended to `PANEL_TRACE_FILE` (default
    /// `~/.local/share/panel/parser-trace.jsonl`). The file is binary-safe:
    /// bytes are hex-encoded so the JSONL stays grep-friendly.
    tracer: Option<Arc<BytesTracer>>,
}

struct BytesTracer {
    pane: String,
    file: tokio::sync::Mutex<tokio::fs::File>,
}

impl BytesTracer {
    async fn from_env() -> Option<Arc<Self>> {
        let pane = std::env::var("PANEL_TRACE_PANE").ok()?;
        if pane.is_empty() {
            return None;
        }
        let path = std::env::var("PANEL_TRACE_FILE").ok().unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
            format!("{home}/.local/share/panel/parser-trace.jsonl")
        });
        if let Some(parent) = std::path::Path::new(&path).parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let file = match tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
        {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("PANEL_TRACE_PANE set but cannot open {path}: {e}");
                return None;
            }
        };
        tracing::info!("parser-trace: pane={pane} → {path}");
        Some(Arc::new(BytesTracer {
            pane,
            file: tokio::sync::Mutex::new(file),
        }))
    }

    async fn record(&self, pane: &PaneId, bytes: &[u8]) {
        if pane.0 != self.pane {
            return;
        }
        // Hex-encode: keeps the line single-line and bytes-safe.
        let hex: String = bytes
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros())
            .unwrap_or(0);
        let line = format!(
            "{{\"ts_us\":{ts},\"kind\":\"out\",\"pane\":\"{}\",\"len\":{},\"hex\":\"{hex}\"}}\n",
            self.pane,
            bytes.len()
        );
        let mut f = self.file.lock().await;
        use tokio::io::AsyncWriteExt;
        let _ = f.write_all(line.as_bytes()).await;
    }
}

impl PaneStore {
    pub fn new(default_rows: u16, default_cols: u16) -> Self {
        PaneStore {
            panes: Arc::new(DashMap::new()),
            default_size: (default_rows, default_cols),
            tmux_socket: None,
            tracer: None,
        }
    }

    /// Wire the tmux socket so internal handlers (e.g. Resized) can shell
    /// out to `tmux` for things like re-seeding from `capture-pane`.
    pub fn set_tmux_socket(&mut self, socket: Option<String>) {
        self.tmux_socket = socket;
    }

    /// Enable the optional bytes tracer (driven by env vars). Idempotent —
    /// safe to call after construction; no-op if env not set or open fails.
    pub async fn install_tracer_from_env(&mut self) {
        self.tracer = BytesTracer::from_env().await;
    }

    pub fn list(&self) -> Vec<PaneId> {
        self.panes.iter().map(|e| e.key().clone()).collect()
    }

    pub fn get(&self, id: &PaneId) -> Option<Arc<PaneSlot>> {
        self.panes.get(id).map(|e| Arc::clone(e.value()))
    }

    /// Drop a stale pane slot and broadcast Closed to subscribers.
    /// Used by /reseed when tmux says the pane no longer exists — without
    /// this the daemon keeps serving cached grid bytes from a long-dead
    /// pane id (common after a tmux server restart that minted fresh
    /// pane ids while the daemon's store still holds the old ones).
    pub fn evict_stale(&self, id: &PaneId) -> bool {
        if let Some((_, slot)) = self.panes.remove(id) {
            let _ = slot.tx.send(LiveEvent::Closed {
                pane: id.0.clone(),
            });
            true
        } else {
            false
        }
    }

    /// Ensure the pane exists; create it (with default size) if not.
    pub fn ensure(&self, id: &PaneId) -> Arc<PaneSlot> {
        if let Some(existing) = self.get(id) {
            return existing;
        }
        let (rows, cols) = self.default_size;
        let state = Arc::new(RwLock::new(PaneState::new(id.clone(), rows, cols)));
        let (tx, _rx) = broadcast::channel(PER_PANE_CHANNEL_CAPACITY);
        let slot = Arc::new(PaneSlot {
            state,
            tx,
            detectors: Mutex::new(Bundle::with_defaults()),
            diff_state: std::sync::Mutex::new(DiffState::default()),
        });
        self.panes.insert(id.clone(), Arc::clone(&slot));
        slot
    }

    /// Apply a SourceEvent: update the pane's grid, broadcast what changed.
    pub async fn apply(&self, ev: SourceEvent) {
        match ev {
            SourceEvent::PaneAdded {
                pane,
                session,
                window,
            } => {
                let slot = self.ensure(&pane);
                let mut s = slot.state.write().await;
                s.session = session;
                s.window = window;
            }
            SourceEvent::Output { pane, bytes } => {
                if let Some(tr) = &self.tracer {
                    tr.record(&pane, &bytes).await;
                }
                let slot = self.ensure(&pane);
                // CC re-emission workaround:
                // upstream bug #46834 — claude-code v2.1.101+ re-emits the
                // entire transcript on every SIGWINCH/Ctrl+O/Shift+Tab. We
                // detect those chunks (by their distinctive
                // \x1b[2J\x1b[H + "Claude Code v" signature) and drop them
                // *after* the first one we see per pane. Self-disabling
                // when CC fixes it upstream: a fix means the trigger
                // doesn't fire, our detector sees no second-or-later
                // banner, nothing gets dropped.
                if cc_reemission_drop_enabled() && chunk_is_cc_reemission(&bytes) {
                    let mut s = slot.state.write().await;
                    if s.cc_banner_seen {
                        let dropped_bytes = bytes.len();
                        let pane_id = pane.0.clone();
                        drop(s);
                        // Use both tracing (structured) and eprintln
                        // (unconditional stderr → journalctl). The
                        // tracing-subscriber filter has surprised us
                        // before; stderr always lands.
                        tracing::info!("cc-reemit-drop: pane={pane_id} bytes={dropped_bytes}");
                        eprintln!("cc-reemit-drop: pane={pane_id} bytes={dropped_bytes}");
                        // Do NOT feed the parser, do NOT push to scrollback,
                        // do NOT broadcast. Subscribers see nothing — same
                        // as if CC hadn't emitted at all (which is the bug's
                        // intended pre-2.1.101 behaviour).
                        return;
                    } else {
                        s.cc_banner_seen = true;
                        // Fall through to normal handling — first banner
                        // is the legitimate session-start render.
                    }
                }
                let (gen, alt, row, col, sb_len, semantic_events) = {
                    let mut s = slot.state.write().await;
                    s.term.feed(&bytes);
                    s.last_byte_at = Instant::now();
                    let gen = s.term.screen.generation;
                    let alt = s.term.screen.alt_active();
                    let row = s.term.screen.cursor.row;
                    let col = s.term.screen.cursor.col;
                    let sb_len = s.term.screen.scrollback.len();
                    let mut det = slot.detectors.lock().await;
                    let semantic = det.observe(&DetectContext {
                        pane_id: &pane.0,
                        screen: &s.term.screen,
                        recent_bytes: &bytes,
                    });
                    (gen, alt, row, col, sb_len, semantic)
                };
                broadcast_output(&slot.tx, &pane, &bytes);
                let _ = slot.tx.send(LiveEvent::Tick {
                    pane: pane.0.clone(),
                    generation: gen,
                    alt,
                    cursor_row: row,
                    cursor_col: col,
                    scrollback_len: sb_len,
                });
                for ev in semantic_events {
                    let _ = slot.tx.send(LiveEvent::Semantic {
                        pane: pane.0.clone(),
                        event: ev,
                    });
                }
            }
            SourceEvent::PaneClosed { pane } => {
                if let Some((_, slot)) = self.panes.remove(&pane) {
                    let _ = slot.tx.send(LiveEvent::Closed {
                        pane: pane.0.clone(),
                    });
                }
            }
            SourceEvent::Resized { pane, rows, cols } => {
                let slot = self.ensure(&pane);
                let mut s = slot.state.write().await;
                let cur_rows = s.term.screen.rows();
                let cur_cols = s.term.screen.cols();
                if cur_rows == rows && cur_cols == cols {
                    // No-op: layout-change can fire when only X/Y shifts.
                } else {
                    // Rebuild the Term at the new dimensions while keeping
                    // scrollback + title across the size change.
                    let preserved_scrollback = std::mem::take(&mut s.term.screen.scrollback);
                    let preserved_max = s.term.screen.max_scrollback;
                    let preserved_title = s.term.screen.title.clone();
                    s.term = Term::new(rows, cols);
                    s.term.screen.scrollback = preserved_scrollback;
                    s.term.screen.max_scrollback = preserved_max;
                    s.term.screen.title = preserved_title;
                    drop(s);
                    // Re-seed primary from the live pane. CC redraws on
                    // SIGWINCH but only when it has reason to (animation
                    // tick, user input). Without this, the panel pin would
                    // sit blank between resize and the next interaction.
                    if let Some(reseed) = capture_pane_baseline(self.tmux_socket.clone(), pane.0.clone()).await {
                        // Fingerprint the capture *before* feeding so a
                        // stale-state-baked-in repro can be diagnosed
                        // from journalctl alone. Hash + the visible
                        // last-row snippet (after we feed it) tells us
                        // exactly what the re-seed froze into primary.
                        let cap_hash = fnv1a_32(&reseed);
                        let cap_len = reseed.len();
                        let mut s = slot.state.write().await;
                        crate::feed_baseline(&mut s.term, &reseed);
                        let gen = s.term.screen.generation;
                        let alt = s.term.screen.alt_active();
                        let row = s.term.screen.cursor.row;
                        let col = s.term.screen.cursor.col;
                        let sb_len = s.term.screen.scrollback.len();
                        // Last 3 non-empty rows of the rebuilt primary —
                        // this is what's actually visible at the bottom
                        // of the pane, where transient states (Ctrl+C
                        // exit warning, modal prompts, etc.) tend to
                        // live.
                        let tail_snippet = primary_tail_snippet(&s.term.screen, 3);
                        let pane_id = pane.0.clone();
                        drop(s);
                        tracing::info!(
                            "reseed: pane={pane_id} new={rows}x{cols} cap_len={cap_len} cap_hash={cap_hash:08x} tail={tail_snippet:?}"
                        );
                        let _ = slot.tx.send(LiveEvent::Tick {
                            pane: pane_id,
                            generation: gen,
                            alt,
                            cursor_row: row,
                            cursor_col: col,
                            scrollback_len: sb_len,
                        });
                    } else {
                        // Fallback: still emit a tick so subscribers
                        // re-render their (now-empty) view.
                        let s = slot.state.read().await;
                        let _ = slot.tx.send(LiveEvent::Tick {
                            pane: pane.0.clone(),
                            generation: s.term.screen.generation,
                            alt: s.term.screen.alt_active(),
                            cursor_row: s.term.screen.cursor.row,
                            cursor_col: s.term.screen.cursor.col,
                            scrollback_len: s.term.screen.scrollback.len(),
                        });
                    }
                }
            }
            SourceEvent::Closed { reason: _ } => {
                // Source-level close: clear all panes? Or leave them so
                // clients can read final state. Leave for now.
            }
        }
    }
}

/// FNV-1a 64-bit hash of a Line's CONTENT (ch + fg + bg + attrs +
/// width). Excludes mtime deliberately: a reseed or resize re-stamps
/// every cell's mtime even though the rendered content is identical,
/// and we don't want those to trigger spurious full-grid broadcasts.
fn line_content_hash(line: &crate::grid::Line) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    for cell in &line.cells {
        // ch as u32, then mix.
        h ^= cell.ch as u64;
        h = h.wrapping_mul(PRIME);
        // Color encoded as a single u64: variant tag in high byte +
        // payload in the low bytes. Cheap, deterministic.
        h ^= color_id(cell.fg);
        h = h.wrapping_mul(PRIME);
        h ^= color_id(cell.bg);
        h = h.wrapping_mul(PRIME);
        h ^= attrs_id(cell.attrs);
        h = h.wrapping_mul(PRIME);
        h ^= cell.width as u64;
        h = h.wrapping_mul(PRIME);
    }
    h
}

fn color_id(c: crate::grid::Color) -> u64 {
    use crate::grid::Color;
    match c {
        Color::Default => 0,
        Color::Indexed(i) => 0x100 | (i as u64),
        Color::Rgb(r, g, b) => 0x200 | ((r as u64) << 16) | ((g as u64) << 8) | (b as u64),
    }
}

fn attrs_id(a: crate::grid::Attrs) -> u64 {
    let mut v: u64 = 0;
    if a.bold      { v |= 1 << 0; }
    if a.dim       { v |= 1 << 1; }
    if a.italic    { v |= 1 << 2; }
    if a.underline { v |= 1 << 3; }
    if a.blink     { v |= 1 << 4; }
    if a.inverse   { v |= 1 << 5; }
    if a.hidden    { v |= 1 << 6; }
    if a.strike    { v |= 1 << 7; }
    v
}

/// Wpin7 cell-diff broadcaster. Ticks every 50 ms, walks every pane,
/// emits `CellDiff` for cells in rows whose CONTENT hash advanced
/// since the last tick (catching writes AND Line rotations) and
/// `GridReset` on alt-screen flip. Spawn one of these per daemon in
/// `cli/daemon.rs`.
///
/// Three properties to keep in mind when modifying:
///
/// 1. **Row-hash dirty detection** (not mtime-floor). The earlier
///    mtime-based scheme missed CC TUI scrolls — `scroll_up_in_region`
///    rotates `Line` objects so cell content shifts between rows but
///    `cell.mtime` stays at the original write time. Client kept stale
///    neighbours under fresh writes ("garbled status line" bug).
///    Hashing each row's content (ch+fg+bg+attrs+width) catches that:
///    a row that changed content for ANY reason — write, rotation,
///    blank insert — has a different hash, so we re-emit ALL its cells.
///    Bandwidth on a typical scroll: ~28 rows × 60 cells × ~50 B = 80 KB
///    per scroll burst, well-bounded.
/// 2. **Generation short-circuit.** Most ticks don't see any mutation
///    (no `%output` arrived in the 50 ms window). We compare
///    `screen.generation` against `diff_state.last_gen` and skip the
///    walk entirely if equal AND no alt-flip. Steady-state idle pane =
///    constant cost per tick (one comparison).
/// 3. **Lock order.** We snapshot `slot.diff_state` (sync Mutex)
///    BEFORE acquiring `slot.state` (async RwLock). Holding the sync
///    mutex across an `.await` would block the runtime. We release
///    diff_state after cloning, take the read lock on state, then
///    re-acquire diff_state to update counters.
pub async fn run_cell_diff_broadcaster(store: PaneStore) {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(50));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let panes = store.list();
        for pane_id in panes {
            let slot = match store.get(&pane_id) {
                Some(s) => s,
                None => continue,
            };
            // Snapshot current diff_state under the sync mutex.
            let prev: DiffState = match slot.diff_state.lock() {
                Ok(g) => g.clone(),
                Err(p) => p.into_inner().clone(),
            };

            let s = slot.state.read().await;
            let cur_gen = s.term.screen.generation;
            let cur_alt = s.term.screen.alt_active();
            let alt_flipped = cur_alt != prev.last_alt;

            // Generation short-circuit: nothing mutated, no walk needed.
            // (Alt flips bump generation too, so this branch only runs
            // when there's truly nothing to publish.)
            if cur_gen == prev.last_gen && !alt_flipped {
                drop(s);
                continue;
            }

            let lines = s.term.screen.active();
            let mut new_hashes: Vec<u64> = Vec::with_capacity(lines.len());
            let mut diff_cells: Vec<CellDiffEntry> = Vec::new();
            for (r, line) in lines.iter().enumerate() {
                let h = line_content_hash(line);
                new_hashes.push(h);
                // After alt-flip, treat every row as changed.
                let prev_h = if alt_flipped {
                    None
                } else {
                    prev.last_row_hashes.get(r).copied()
                };
                if Some(h) != prev_h {
                    for (c, cell) in line.cells.iter().enumerate() {
                        diff_cells.push(CellDiffEntry {
                            r: r as u16,
                            c: c as u16,
                            cell: *cell,
                        });
                    }
                }
            }

            // Scrollback-append: figure out which rows have left primary
            // since last tick. push_count is monotonic across the
            // pane's lifetime; the actual `screen.scrollback` deque is
            // bounded by max_scrollback. If the client's last_count is
            // way behind (e.g., long-running pane, eviction overflowed),
            // we can only ship what's still in the deque tail — older
            // pushes are lost. That's acceptable: the client's hydrate
            // brought in scrollback up to the deque cap anyway, and
            // freeze semantics mean its existing DOM still has those
            // rows from hydrate-time.
            let cur_sb_count = s.term.screen.scrollback_push_count;
            let new_pushes = cur_sb_count.saturating_sub(prev.last_scrollback_count);
            let sb_rows: Vec<Vec<Cell>> = if new_pushes > 0 {
                let sb = &s.term.screen.scrollback;
                let take = (new_pushes as usize).min(sb.len());
                let start = sb.len() - take;
                sb.iter().skip(start).map(|line| line.cells.clone()).collect()
            } else {
                Vec::new()
            };

            drop(s);

            if alt_flipped {
                let _ = slot.tx.send(LiveEvent::GridReset {
                    pane: pane_id.0.clone(),
                    alt: cur_alt,
                });
            }
            if !diff_cells.is_empty() {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let _ = slot.tx.send(LiveEvent::CellDiff {
                    pane: pane_id.0.clone(),
                    ts,
                    cells: diff_cells,
                });
            }
            if !sb_rows.is_empty() {
                let _ = slot.tx.send(LiveEvent::ScrollbackAppend {
                    pane: pane_id.0.clone(),
                    from_count: prev.last_scrollback_count,
                    to_count: cur_sb_count,
                    rows: sb_rows,
                });
            }

            if let Ok(mut g) = slot.diff_state.lock() {
                g.last_gen = cur_gen;
                g.last_alt = cur_alt;
                g.last_row_hashes = new_hashes;
                g.last_scrollback_count = cur_sb_count;
            };
        }
    }
}

/// Returns true if the env var `PANEL_DROP_CC_REEMISSIONS` is unset or
/// anything other than `"0"` / `"false"`. Default-on; flip to `0` to
/// disable the workaround (e.g. while validating CC's upstream fix).
fn cc_reemission_drop_enabled() -> bool {
    match std::env::var("PANEL_DROP_CC_REEMISSIONS") {
        Ok(v) => v != "0" && v.to_lowercase() != "false",
        Err(_) => true,
    }
}

/// Detect the byte signature of a Claude Code TUI re-emission triggered by
/// a layout-change event (SIGWINCH, Ctrl+O transcript toggle, Shift+Tab
/// permission cycle). See upstream issue
/// <https://github.com/anthropics/claude-code/issues/46834>.
///
/// Two-factor signal:
///   1. The chunk contains `\x1b[2J\x1b[H` near the start (clear-screen
///      followed by cursor-home — CC's "redraw from scratch" prelude).
///   2. The chunk contains CC's box-drawing logo bytes `▛███▜`
///      (`\xe2\x96\x9b\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x9c`)
///      — uniquely identifies CC's banner. We don't search for the
///      literal "Claude Code v" string because CC interleaves SGR
///      escapes between words (`\x1b[1mClaude\x1b[1CCode\x1b[1C…`),
///      making the contiguous literal absent on the wire.
///
/// Both must be present. Token-streaming output from CC has neither;
/// other TUIs that clear-and-redraw (vim, less, htop) lack the logo
/// bytes. Verified against captured bytes from CC v2.1.119 on
/// 2026-04-27 — every observed re-emission matched both predicates.
fn chunk_is_cc_reemission(bytes: &[u8]) -> bool {
    // `\x1b[2J` then optional CSI noise then `\x1b[H` is the canonical
    // start. Allow a small window between them for any cursor moves CC
    // emits in between (`\x1b[2D\x1b[4B\x1b[2J\x1b[H` is what we've
    // captured in practice).
    let head = &bytes[..bytes.len().min(64)];
    let has_clear_home = bytes_contains(head, b"\x1b[2J\x1b[H")
        || (bytes_contains(head, b"\x1b[2J")
            && bytes_contains(&bytes[..bytes.len().min(128)], b"\x1b[H"));
    if !has_clear_home {
        return false;
    }
    // CC's logo: `▛███▜` (the wide-block-bar in `▐▛███▜▌`). Always
    // present in a re-emission, never elsewhere.
    const CC_LOGO: &[u8] = b"\xe2\x96\x9b\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x9c";
    let scan_len = bytes.len().min(4096);
    bytes_contains(&bytes[..scan_len], CC_LOGO)
}

#[inline]
fn bytes_contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// FNV-1a 32-bit. Used to fingerprint capture-pane bytes for diag logs.
fn fnv1a_32(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Return the last `n` non-empty rendered rows of `screen.primary`,
/// joined by `␤` (visible newline marker). Useful for "what was on
/// screen when this re-seed happened" diag logs without flooding the
/// log line with the full grid.
fn primary_tail_snippet(screen: &crate::Screen, n: usize) -> String {
    let mut tail: Vec<String> = Vec::with_capacity(n);
    for line in screen.primary.iter().rev() {
        if tail.len() >= n {
            break;
        }
        let text: String = line.cells.iter().map(|c| c.ch).collect();
        let trimmed = text.trim_end();
        if !trimmed.is_empty() {
            tail.push(trimmed.to_string());
        }
    }
    tail.reverse();
    let joined = tail.join("␤");
    // Cap to keep a single log line manageable. truncate() panics on
    // UTF-8 boundaries — CC's output is full of emojis and box-draw
    // chars that span multiple bytes. Walk back to the nearest char
    // boundary at or before 200 to avoid killing the tokio worker
    // (a previous panic here orphaned claude5's tmux -C attach for
    // 6+ hours, leaving panel's grid stale).
    if joined.len() > 200 {
        let mut cut = 200;
        while cut > 0 && !joined.is_char_boundary(cut) {
            cut -= 1;
        }
        let mut s = joined;
        s.truncate(cut);
        s.push('…');
        s
    } else {
        joined
    }
}

/// Pull a pane's geometry, scrollback (up to 1000 lines) and live grid
/// from tmux and replay them through a fresh Term so the pane has rich
/// history available immediately. Sized to the actual pane dimensions
/// reported by tmux, then cursor restored via CSI CUP. Live `%output`
/// picks up after this with the cursor in the right place.
///
/// Used both at daemon startup (`prepopulate_panes`) and on every
/// mid-life session attach in `MultiSession::attach_session`. Without
/// the latter, panes that appear after panel started (e.g. tmux server
/// restart producing fresh pane ids) stay stuck at the daemon's
/// default Term dimensions and panel's primary diverges from tmux.
pub async fn seed_pane(
    store: &PaneStore,
    socket: Option<&str>,
    id: &PaneId,
) -> anyhow::Result<bool> {
    use anyhow::Context;
    use tokio::process::Command;
    // 1. Pane geometry + cursor (tab-separated for simple parsing).
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let geom_out = cmd
        .args([
            "display",
            "-p",
            "-t",
            &id.0,
            "#{pane_height}\t#{pane_width}\t#{cursor_y}\t#{cursor_x}",
        ])
        .output()
        .await
        .context("tmux display geometry")?;
    if !geom_out.status.success() {
        return Ok(false); // pane vanished; non-fatal
    }
    let geom = String::from_utf8_lossy(&geom_out.stdout);
    let mut g = geom.trim().split('\t');
    let rows: u16 = g.next().and_then(|x| x.parse().ok()).unwrap_or(24);
    let cols: u16 = g.next().and_then(|x| x.parse().ok()).unwrap_or(80);
    let cy: u16 = g.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let cx: u16 = g.next().and_then(|x| x.parse().ok()).unwrap_or(0);

    // 2. Scrollback + visible content. -S -1000 = up to 1000 lines back.
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let cap_out = cmd
        .args(["capture-pane", "-p", "-e", "-S", "-1000", "-t", &id.0])
        .output()
        .await
        .context("tmux capture-pane")?;
    if !cap_out.status.success() {
        return Ok(false);
    }

    // 3. Replace term with one sized to the pane and replay bytes.
    let slot = store.ensure(id);
    let mut s = slot.state.write().await;
    s.term = Term::new(rows, cols);
    crate::feed_baseline(&mut s.term, &cap_out.stdout);
    // Restore cursor (1-based for CSI CUP).
    let cup = format!("\x1b[{};{}H", cy + 1, cx + 1);
    s.term.feed(cup.as_bytes());
    Ok(true)
}

/// Run `tmux capture-pane -p` (no `-e`, plain text) and return the
/// rendered text. Used by the drift-check endpoint to compare panel's
/// internal primary state against tmux's view.
pub async fn capture_pane_text(socket: Option<&str>, pane: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args(["capture-pane", "-p", "-t", pane])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Render `screen.primary` as plain text — same shape as
/// `tmux capture-pane -p` (one line per row, trailing whitespace
/// trimmed, lines joined by `\n`, no trailing newline).
pub fn render_primary_text(screen: &crate::Screen) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(screen.primary.len());
    for line in &screen.primary {
        let text: String = line.cells.iter().map(|c| c.ch).collect();
        lines.push(text.trim_end().to_string());
    }
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines.join("\n")
}

async fn capture_pane_baseline(socket: Option<String>, pane: String) -> Option<Vec<u8>> {
    let mut cmd = tokio::process::Command::new("tmux");
    if let Some(s) = &socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args(["capture-pane", "-p", "-e", "-t", &pane])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(out.stdout)
}

fn broadcast_output(
    tx: &broadcast::Sender<LiveEvent>,
    pane: &PaneId,
    bytes: &Bytes,
) {
    use base64_encode_b64 as b64;
    let _ = tx.send(LiveEvent::Output {
        pane: pane.0.clone(),
        bytes_b64: b64(bytes),
    });
}

/// Minimal base64 encoder — avoids pulling in another crate just for this.
fn base64_encode_b64(bytes: &[u8]) -> String {
    const ALPH: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(ALPH[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPH[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPH[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPH[(n & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(ALPH[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPH[((n >> 12) & 0x3f) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(ALPH[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPH[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPH[((n >> 6) & 0x3f) as usize] as char);
        out.push('=');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cc_reemission_signature_detection() {
        // Canonical start of every captured CC re-emission (from a real
        // 2.1.119 SIGWINCH on 2026-04-27): `\x1b[2D\x1b[4B\x1b[2J\x1b[H`
        // followed by the banner ASCII art including `▛███▜`.
        let mut real = Vec::new();
        real.extend_from_slice(b"\x1b[2D\x1b[4B\x1b[2J\x1b[H\x1b[38;5;174m \xe2\x96\x90");
        real.extend_from_slice(b"\x1b[48;5;16m\xe2\x96\x9b\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x9c");
        real.extend_from_slice(b"\x1b[49m\xe2\x96\x8c\x1b[3C\x1b[39m\x1b[1mClaude\x1b[1CCode\x1b[1Cv2.1.119");
        assert!(chunk_is_cc_reemission(&real));

        // Token streaming — no clear-screen.
        let tok = b"AARO is the U.S. agency that\x1b[2C tasked with investigating UAP";
        assert!(!chunk_is_cc_reemission(tok));

        // Vim or less doing a redraw — has clear-screen but no logo.
        let vim = b"\x1b[2J\x1b[H~\r\n~\r\n~\r\n\"foo.rs\" [New File]";
        assert!(!chunk_is_cc_reemission(vim));

        // CC banner string in plain text (e.g. user typing about CC into
        // chat) — no clear-screen prefix, so doesn't trip.
        let chat = "❯ what is Claude Code v2.1.119 missing?".as_bytes();
        assert!(!chunk_is_cc_reemission(chat));

        // Has clear-screen + logo bytes mid-chunk (theoretical edge case
        // — a full chunk containing the CC banner). Should trip.
        let mut framed = Vec::new();
        framed.extend_from_slice(b"\x1b[2J\x1b[H\x1b[10;5H");
        framed.extend_from_slice(b"\xe2\x96\x9b\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x9c");
        assert!(chunk_is_cc_reemission(&framed));
    }

    #[tokio::test]
    async fn cc_reemission_lets_first_banner_through_drops_subsequent() {
        // Disable the gating env var — make sure the test runs the
        // workaround unconditionally regardless of host env.
        std::env::remove_var("PANEL_DROP_CC_REEMISSIONS");
        let store = PaneStore::new(40, 120);
        let pane = PaneId("%99".into());
        store
            .apply(SourceEvent::PaneAdded {
                pane: pane.clone(),
                session: None,
                window: None,
            })
            .await;
        // Signature: clear+home + the `▛███▜` logo bytes.
        let mut banner = Vec::new();
        banner.extend_from_slice(b"\x1b[2J\x1b[H");
        banner.extend_from_slice(b"\xe2\x96\x9b\xe2\x96\x88\xe2\x96\x88\xe2\x96\x88\xe2\x96\x9c");
        banner.extend_from_slice(b" Claude Code v2.1.119\r\n");

        // First banner: must reach the parser → primary contains banner text.
        store
            .apply(SourceEvent::Output {
                pane: pane.clone(),
                bytes: bytes::Bytes::from(banner.clone()),
            })
            .await;
        let slot = store.get(&pane).unwrap();
        {
            let s = slot.state.read().await;
            assert!(s.term.screen.render_text().contains("Claude Code v2.1.119"));
            assert!(s.cc_banner_seen);
        }

        // Second banner: dropped. We confirm by snapshotting generation
        // before/after — apply must be a no-op.
        let gen_before = slot.state.read().await.term.screen.generation;
        store
            .apply(SourceEvent::Output {
                pane: pane.clone(),
                bytes: bytes::Bytes::from(banner.clone()),
            })
            .await;
        let gen_after = slot.state.read().await.term.screen.generation;
        assert_eq!(gen_before, gen_after, "second banner must be dropped");
    }

    #[test]
    fn b64_round_trip() {
        // Test against a few known cases.
        assert_eq!(base64_encode_b64(b""), "");
        assert_eq!(base64_encode_b64(b"f"), "Zg==");
        assert_eq!(base64_encode_b64(b"fo"), "Zm8=");
        assert_eq!(base64_encode_b64(b"foo"), "Zm9v");
        assert_eq!(base64_encode_b64(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode_b64(b"hello"), "aGVsbG8=");
    }

    #[tokio::test]
    async fn apply_output_broadcasts_and_updates_grid() {
        let store = PaneStore::new(24, 80);
        let pane = PaneId("%1".into());
        store
            .apply(SourceEvent::PaneAdded {
                pane: pane.clone(),
                session: None,
                window: None,
            })
            .await;
        let slot = store.get(&pane).unwrap();
        let mut sub = slot.tx.subscribe();
        store
            .apply(SourceEvent::Output {
                pane: pane.clone(),
                bytes: bytes::Bytes::from_static(b"hello"),
            })
            .await;
        let s = slot.state.read().await;
        assert_eq!(s.term.screen.render_text().split('\n').next().unwrap(), "hello");
        // We expect both an Output and a Tick event.
        let ev1 = sub.try_recv().unwrap();
        let ev2 = sub.try_recv().unwrap();
        match (&ev1, &ev2) {
            (LiveEvent::Output { .. }, LiveEvent::Tick { .. }) => {}
            other => panic!("expected (Output, Tick), got {other:?}"),
        }
    }
}
