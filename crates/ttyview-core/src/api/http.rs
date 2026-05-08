use crate::api::AppState;
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::process::Command;

#[derive(Debug, Serialize)]
pub struct PaneSummary {
    pub id: String,
    pub session: Option<String>,
    pub window: Option<String>,
    pub rows: u16,
    pub cols: u16,
    pub generation: u64,
    pub alt_screen: bool,
    pub idle_ms: u64,
    pub cursor: (u16, u16),
    pub title: Option<String>,
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/panes", get(list_panes))
        .route("/panes/:id/grid", get(get_grid))
        .route("/panes/:id/text", get(get_text))
        .route("/panes/:id/baseline", get(get_baseline))
        .route("/panes/:id/scrollback", get(get_scrollback))
        .route("/panes/:id/drift", get(get_drift))
        .route("/panes/:id/reseed", post(post_reseed))
}

async fn list_panes(State(app): State<Arc<AppState>>) -> Json<Vec<PaneSummary>> {
    let mut out = Vec::new();
    for pane_id in app.store.list() {
        if let Some(slot) = app.store.get(&pane_id) {
            let s = slot.state.read().await;
            out.push(PaneSummary {
                id: s.id.0.clone(),
                session: s.session.clone(),
                window: s.window.clone(),
                rows: s.term.screen.rows(),
                cols: s.term.screen.cols(),
                generation: s.term.screen.generation,
                alt_screen: s.term.screen.alt_active(),
                idle_ms: s.idle_ms(),
                cursor: (s.term.screen.cursor.row, s.term.screen.cursor.col),
                title: s.term.screen.title.clone(),
            });
        }
    }
    Json(out)
}

#[derive(Deserialize)]
pub struct GridQuery {
    /// `?skip_scrollback=1` returns the Screen with an empty scrollback
    /// VecDeque. Saves a *lot* of bytes on the wire for tail-only viewers
    /// that don't need any history.
    #[serde(default)]
    pub skip_scrollback: Option<u8>,
    /// `?max_scrollback=N` returns at most the last N scrollback lines
    /// (most-recent kept). Useful for the panel pin which renders a
    /// scrollable overlay but doesn't need the full 2000-line buffer per
    /// tick. Takes precedence over skip_scrollback when both are set.
    #[serde(default)]
    pub max_scrollback: Option<usize>,
}

async fn get_grid(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<GridQuery>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let pane = crate::source::PaneId(id);
    let slot = app.store.get(&pane).ok_or(StatusCode::NOT_FOUND)?;

    // Decide what mode the response will be in. The ETag has to encode
    // mode because two simultaneous clients can hit the same pane with
    // different ?skip_scrollback/?max_scrollback and we must NOT 304 a
    // request whose body would actually differ.
    let want_full = q.max_scrollback.is_none() && q.skip_scrollback.unwrap_or(0) == 0;
    let cap = q.max_scrollback.unwrap_or(0);
    let mode_tag = if want_full {
        "full".to_string()
    } else if cap == 0 {
        "skip".to_string()
    } else {
        format!("max={cap}")
    };

    // Snapshot generation under a short read lock; release before doing
    // the expensive clone or building the response.
    let generation = {
        let s = slot.state.read().await;
        s.term.screen.generation
    };
    // Strong ETag — `Screen::generation` is bumped on every parser
    // mutation, so equal generation + same mode = byte-identical body.
    let etag = format!("\"v1-{generation}-{mode_tag}\"");

    if let Some(if_none) = headers.get(header::IF_NONE_MATCH) {
        if etag_matches(if_none, &etag) {
            // Skip the clone entirely. Reply 304 with the ETag header so
            // the client can keep validating against the same key.
            let mut resp = Response::default();
            *resp.status_mut() = StatusCode::NOT_MODIFIED;
            if let Ok(v) = HeaderValue::from_str(&etag) {
                resp.headers_mut().insert(header::ETAG, v);
            }
            return Ok(resp);
        }
    }

    // Build the body — re-acquire the read lock to clone the screen at
    // (potentially newer) state. The ETag we serve still reflects the
    // generation we just cloned, so a second `If-None-Match` round-trip
    // will see whatever bumped between snapshot and clone.
    let s = slot.state.read().await;
    let screen = if want_full {
        s.term.screen.clone()
    } else {
        // Build a Screen cloning everything *except* the full scrollback
        // VecDeque. Avoids the per-request 100 MB clone on busy CC panes.
        let scrollback = if cap == 0 {
            std::collections::VecDeque::new()
        } else {
            let sb = &s.term.screen.scrollback;
            let start = sb.len().saturating_sub(cap);
            sb.iter().skip(start).cloned().collect()
        };
        crate::Screen {
            size: s.term.screen.size,
            primary: s.term.screen.primary.clone(),
            alt: s.term.screen.alt.clone(),
            scrollback,
            max_scrollback: s.term.screen.max_scrollback,
            cursor: s.term.screen.cursor,
            saved_cursor: s.term.screen.saved_cursor,
            saved_cursor_alt: s.term.screen.saved_cursor_alt,
            scroll_region: s.term.screen.scroll_region,
            autowrap: s.term.screen.autowrap,
            generation: s.term.screen.generation,
            title: s.term.screen.title.clone(),
            current_mtime: 0,
            scrollback_push_count: s.term.screen.scrollback_push_count,
        }
    };
    // Update the ETag in case generation moved between the snapshot and
    // the clone — keeps the header consistent with what we shipped.
    let etag = format!("\"v1-{}-{mode_tag}\"", screen.generation);
    drop(s);

    let mut resp = Json(screen).into_response();
    if let Ok(v) = HeaderValue::from_str(&etag) {
        resp.headers_mut().insert(header::ETAG, v);
    }
    Ok(resp)
}

/// RFC 7232 If-None-Match comparison: a comma-separated list of
/// quoted ETags or the special `*`. We accept `*` (matches any
/// existing resource) and exact matches; weak/strong distinction
/// is collapsed by stripping any leading `W/`.
fn etag_matches(if_none_match: &HeaderValue, our_etag: &str) -> bool {
    let s = match if_none_match.to_str() {
        Ok(s) => s,
        Err(_) => return false,
    };
    if s.trim() == "*" {
        return true;
    }
    let our_normalised = our_etag.trim_start_matches("W/");
    s.split(',').any(|tag| {
        let t = tag.trim();
        let t = t.trim_start_matches("W/");
        t == our_normalised
    })
}

#[derive(Deserialize)]
pub struct TextQuery {
    /// `?ansi=1` to include ANSI escape codes for color/attrs.
    #[serde(default)]
    pub ansi: Option<u8>,
    /// `?scrollback=1` to include scrollback history.
    #[serde(default)]
    pub scrollback: Option<u8>,
}

/// Raw `tmux capture-pane -p -e` bytes for the pane. Suitable for feeding
/// directly to xterm.js (or any terminal emulator) as a one-shot baseline so
/// the client doesn't have to re-render the grid from JSON.
///
/// Note: the baseline body is `\n`-separated, not `\r\n` — same quirk as
/// `lib::feed_baseline`. The client should normalize before writing to a real
/// terminal emulator (e.g., write each line with `\r\n`).
/// `tmux capture-pane -p -e -S -N` — N lines of scrollback ABOVE the current
/// visible grid. Returned as raw bytes (ANSI escapes preserved). The first
/// `lines` rows are scrollback; the next `pane_height` rows are the live
/// grid (the live portion is also what `/baseline` returns).
///
/// Query: `?lines=200` (default 200, capped at 5000).
#[derive(Deserialize)]
pub struct ScrollbackQuery {
    #[serde(default)]
    pub lines: Option<u32>,
}

async fn get_scrollback(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<ScrollbackQuery>,
) -> Result<Response, StatusCode> {
    let lines = q.lines.unwrap_or(200).min(5000) as i64;
    // tmux capture-pane: -S start_line. Negative = N lines into history.
    let start = format!("-{}", lines);
    let mut cmd = Command::new("tmux");
    if let Some(s) = &app.tmux_socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args([
            "capture-pane",
            "-p",
            "-e",
            "-S",
            &start,
            "-t",
            &id,
        ])
        .output()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !out.status.success() {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(axum::body::Body::from(out.stdout))
        .unwrap())
}

async fn get_baseline(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, StatusCode> {
    let mut cmd = Command::new("tmux");
    if let Some(s) = &app.tmux_socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args(["capture-pane", "-p", "-e", "-t", &id])
        .output()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !out.status.success() {
        return Err(StatusCode::NOT_FOUND);
    }
    let body = axum::body::Body::from(out.stdout);
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(body)
        .unwrap())
}

async fn get_text(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<TextQuery>,
) -> impl IntoResponse {
    let pane = crate::source::PaneId(id);
    match app.store.get(&pane) {
        Some(slot) => {
            let s = slot.state.read().await;
            let text = if q.scrollback.unwrap_or(0) != 0 {
                s.term.screen.render_text_with_scrollback()
            } else {
                s.term.screen.render_text()
            };
            // ANSI rendering is not implemented in v1 — text is plain.
            let _ = q.ansi;
            Ok::<_, StatusCode>(text)
        }
        None => Err(StatusCode::NOT_FOUND),
    }
}

#[derive(Debug, Serialize)]
pub struct DriftReport {
    pub pane: String,
    /// Number of rows panel has in primary.
    pub panel_rows: usize,
    /// Number of rows tmux's `capture-pane -p` returned.
    pub tmux_rows: usize,
    /// How many of the trailing rows differ between panel and tmux.
    /// 0 = perfectly in sync. Larger = more drift.
    pub diff_rows: usize,
    /// Indices (0-based, panel side) where the rows differ.
    pub diff_indices: Vec<usize>,
    /// Up to 5 example diffs to make the JSON useful for eyeballing.
    pub samples: Vec<DriftSample>,
}

#[derive(Debug, Serialize)]
pub struct DriftSample {
    pub row: usize,
    pub panel: String,
    pub tmux: String,
}

/// Compare panel's rendered primary against `tmux capture-pane -p` for the
/// given pane and return a row-level diff. Useful when "panel is showing
/// stale content" complaints come in — one curl tells you whether panel
/// has actually drifted from tmux's view, and which rows.
async fn get_drift(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<DriftReport>, StatusCode> {
    let pane = crate::source::PaneId(id.clone());
    let slot = app.store.get(&pane).ok_or(StatusCode::NOT_FOUND)?;
    let panel_text = {
        let s = slot.state.read().await;
        crate::state::render_primary_text(&s.term.screen)
    };
    let tmux_text =
        crate::state::capture_pane_text(app.tmux_socket.as_deref(), &id).await;
    let tmux_text = match tmux_text {
        Some(t) => t,
        None => {
            // tmux can't see this pane — treat as a complete drift,
            // record what panel has anyway.
            let panel_rows = panel_text.lines().count();
            return Ok(Json(DriftReport {
                pane: id,
                panel_rows,
                tmux_rows: 0,
                diff_rows: panel_rows,
                diff_indices: (0..panel_rows).collect(),
                samples: panel_text
                    .lines()
                    .take(5)
                    .enumerate()
                    .map(|(i, l)| DriftSample {
                        row: i,
                        panel: l.to_string(),
                        tmux: String::new(),
                    })
                    .collect(),
            }));
        }
    };
    // Right-align comparison at the bottom of both renders. Trailing
    // blank rows on one side shouldn't count as drift, so we trim them.
    let panel_lines: Vec<&str> = panel_text.lines().collect();
    let tmux_lines: Vec<&str> = tmux_text
        .lines()
        .rev()
        .skip_while(|l| l.is_empty())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let n = panel_lines.len().min(tmux_lines.len());
    // Walk the last `n` rows of each, indexing panel-side.
    let panel_start = panel_lines.len().saturating_sub(n);
    let tmux_start = tmux_lines.len().saturating_sub(n);
    let mut diff_indices = Vec::new();
    let mut samples = Vec::new();
    for i in 0..n {
        let p = panel_lines[panel_start + i];
        let t = tmux_lines[tmux_start + i];
        if p.trim_end() != t.trim_end() {
            diff_indices.push(panel_start + i);
            if samples.len() < 5 {
                samples.push(DriftSample {
                    row: panel_start + i,
                    panel: p.to_string(),
                    tmux: t.to_string(),
                });
            }
        }
    }
    Ok(Json(DriftReport {
        pane: id,
        panel_rows: panel_lines.len(),
        tmux_rows: tmux_lines.len(),
        diff_rows: diff_indices.len(),
        diff_indices,
        samples,
    }))
}

#[derive(Debug, Serialize)]
pub struct ReseedReport {
    pub pane: String,
    pub ok: bool,
    /// Reason — populated when `ok=false` (e.g. pane vanished, capture
    /// failed). Omitted on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Force-reseed a pane's primary buffer + scrollback by replaying
/// `tmux capture-pane -p -e -S -1000` through a fresh `Term`.
///
/// Why this exists: panel's grid is normally maintained by streaming
/// every `%output` event from tmux's control-mode connection through a
/// `vte` parser. If the daemon misses output (control-mode subscription
/// dropped, multi-session reconciler skipped a session, tmux server
/// restart producing fresh pane ids the daemon hadn't reattached to),
/// the grid silently goes stale and stays stale until the next resize.
///
/// Symptom from the field: a pane running CC for hours showed only the
/// shell-startup banner from when the user first opened the terminal,
/// because panel attached when it was a shell and then missed every
/// byte CC wrote. Drift endpoint reported 100% drift; this endpoint
/// is the recovery path.
///
/// tmux-web's panel pin calls this on overlay open as a belt-and-
/// braces measure (cheap — capture-pane is <50ms — and always
/// produces a correct grid).
async fn post_reseed(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ReseedReport>, StatusCode> {
    let pane = crate::source::PaneId(id.clone());
    match crate::state::seed_pane(&app.store, app.tmux_socket.as_deref(), &pane).await {
        Ok(true) => {
            // Broadcast a fresh grid event so any subscribed clients
            // re-render without waiting for the next %output. Mirrors
            // the pattern used by the Resized branch of `apply()`.
            if let Some(slot) = app.store.get(&pane) {
                let s = slot.state.read().await;
                let _ = slot.tx.send(crate::state::LiveEvent::Tick {
                    pane: pane.0.clone(),
                    generation: s.term.screen.generation,
                    alt: s.term.screen.alt_active(),
                    cursor_row: s.term.screen.cursor.row,
                    cursor_col: s.term.screen.cursor.col,
                    scrollback_len: s.term.screen.scrollback.len(),
                });
            }
            Ok(Json(ReseedReport { pane: id, ok: true, reason: None }))
        }
        Ok(false) => {
            // tmux reports the pane gone (capture-pane non-zero exit).
            // Most common cause: tmux server restarted, fresh pane ids
            // minted, but the panel store still holds the old ones —
            // /grid happily serves stale bytes from those ghosts. Evict
            // the slot so subsequent /grid for this id returns 404 and
            // the client (tmux-web) re-resolves via session→pane lookup.
            let evicted = app.store.evict_stale(&pane);
            tracing::info!(
                target: "panel::reseed",
                "reseed: pane {} not in tmux; evicted_from_store={}",
                pane.0,
                evicted
            );
            Ok(Json(ReseedReport {
                pane: id,
                ok: false,
                reason: Some(if evicted {
                    "pane not found in tmux; evicted stale slot".into()
                } else {
                    "pane not found in tmux".into()
                }),
            }))
        }
        Err(e) => Ok(Json(ReseedReport {
            pane: id,
            ok: false,
            reason: Some(format!("seed_pane error: {}", e)),
        })),
    }
}
