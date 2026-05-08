//! Multi-session tmux control source.
//!
//! tmux's `-C attach` only emits `%output` for panes in the session it
//! attached to. To observe every pane on the server, we need one control
//! client per session. This module spawns one `tmux -C attach -r -t <S>`
//! per session, merges their event streams into a shared mpsc, and
//! reconciles against `list-sessions` every few seconds so newly-created
//! sessions get attached and removed sessions get cleaned up.
//!
//! Pane ids are server-global in tmux, so the merged stream has no
//! collisions: each pane only emits from the one session that owns it.

use super::{tmux_control::SpawnOpts, tmux_control::TmuxControl, PaneId, SourceEvent};
use crate::state::{seed_pane, PaneStore};
use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

const RECONCILE_INTERVAL: Duration = Duration::from_secs(5);
const EVENT_CHANNEL_CAPACITY: usize = 4096;
// If a session's tmux -C client has produced no events for this long AND the
// session still exists, treat the client as silently broken and respawn it.
// Long-lived `tmux -C attach -r` clients have been observed (tmux quirk?) to
// silently stop emitting %output after several hours while the process stays
// alive — symptom: idle_ms grows to 4h+ across every session at the same time
// the daemon was started, while the underlying tmux panes are very much
// active. This watchdog kills the stuck client; the next reconcile re-attaches.
const CLIENT_SILENCE_RESPAWN_AFTER: Duration = Duration::from_secs(180);

/// Owns one `tmux -C attach -r -t <S>` per active session and forwards all
/// their `SourceEvent`s into a single channel. Reconciles automatically.
pub struct MultiSession {
    socket: Option<String>,
    sessions: Arc<Mutex<HashMap<String, ChildHandle>>>,
    tx: mpsc::Sender<SourceEvent>,
    _reconciler: JoinHandle<()>,
    /// Optional handle to the PaneStore. When present, mid-life session
    /// attaches (e.g. after a tmux server restart introduces a fresh
    /// pane-id sequence) seed each pane's dimensions + scrollback the
    /// same way startup `prepopulate_panes` does. Without this, panes
    /// that appear after the daemon started would stay at the daemon's
    /// default Term size with no history — visible in panel as "stuck
    /// at bash launch moment, never updates" until the daemon is
    /// restarted.
    _store: Option<PaneStore>,
}

struct ChildHandle {
    // _ctrl is held only for its Drop side-effect (kill_on_drop fires SIGKILL
    // on the tmux child). The underlying stdout reader runs in _forwarder.
    _ctrl: TmuxControl,
    _forwarder: JoinHandle<()>,
    // Liveness watchdog. The forwarder bumps this on every event received
    // from this session's tmux client (any event — Output, PaneAdded, etc.).
    // If the gap between Now and last_event_at exceeds
    // CLIENT_SILENCE_RESPAWN_AFTER, the reconciler kills the handle and
    // re-attaches.
    last_event_at: Arc<Mutex<Instant>>,
}

impl MultiSession {
    /// Spawn a control client per existing session, plus a background
    /// reconciler. Returns the merged event receiver. Pass `Some(store)`
    /// to enable mid-life pane seeding (recommended) — the daemon
    /// always does this; tests can pass `None` to skip the tmux-side
    /// shell-outs.
    pub async fn spawn(
        socket: Option<String>,
        store: Option<PaneStore>,
    ) -> Result<(Self, mpsc::Receiver<SourceEvent>)> {
        let (tx, rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let sessions = Arc::new(Mutex::new(HashMap::<String, ChildHandle>::new()));

        // Initial attach — if this fails (e.g. tmux server not running), we
        // still return successfully; the reconciler will retry every 5s.
        if let Err(e) = reconcile_once(
            socket.as_deref(),
            sessions.clone(),
            tx.clone(),
            store.clone(),
        )
        .await
        {
            warn!("multi-session: initial reconcile failed: {e}");
        }

        // Background reconciler.
        let reconciler_socket = socket.clone();
        let reconciler_sessions = sessions.clone();
        let reconciler_tx = tx.clone();
        let reconciler_store = store.clone();
        let reconciler = tokio::spawn(async move {
            loop {
                tokio::time::sleep(RECONCILE_INTERVAL).await;
                if reconciler_tx.is_closed() {
                    break;
                }
                if let Err(e) = reconcile_once(
                    reconciler_socket.as_deref(),
                    reconciler_sessions.clone(),
                    reconciler_tx.clone(),
                    reconciler_store.clone(),
                )
                .await
                {
                    debug!("multi-session: reconcile failed: {e}");
                }
            }
        });

        Ok((
            MultiSession {
                socket,
                sessions,
                tx,
                _reconciler: reconciler,
                _store: store,
            },
            rx,
        ))
    }

    /// Names of sessions we currently observe. Useful for tests + diagnostics.
    pub async fn attached_sessions(&self) -> Vec<String> {
        let _ = (&self.socket, &self.tx); // silence "field is never read" if it ever drifts
        self.sessions.lock().await.keys().cloned().collect()
    }
}

async fn reconcile_once(
    socket: Option<&str>,
    sessions: Arc<Mutex<HashMap<String, ChildHandle>>>,
    tx: mpsc::Sender<SourceEvent>,
    store: Option<PaneStore>,
) -> Result<()> {
    let want = list_sessions(socket).await?;
    let want_set: HashSet<&str> = want.iter().map(String::as_str).collect();

    let mut have = sessions.lock().await;

    // Detach gone sessions. Dropping ChildHandle kills the tmux client
    // (kill_on_drop=true), the forwarder task sees stdout EOF and exits.
    let gone: Vec<String> = have
        .keys()
        .filter(|s| !want_set.contains(s.as_str()))
        .cloned()
        .collect();
    for s in gone {
        info!("multi-session: detaching from session {s}");
        have.remove(&s);
    }

    // Liveness watchdog: kill any client that's been silent longer than
    // CLIENT_SILENCE_RESPAWN_AFTER (and the session still exists). The
    // re-attach happens in the next loop below in this same reconcile pass.
    let now = Instant::now();
    let mut stuck: Vec<String> = Vec::new();
    for (s, handle) in have.iter() {
        if !want_set.contains(s.as_str()) {
            continue;
        }
        let last = *handle.last_event_at.lock().await;
        if now.duration_since(last) > CLIENT_SILENCE_RESPAWN_AFTER {
            stuck.push(s.clone());
        }
    }
    for s in stuck {
        let secs = have
            .get(&s)
            .map(|h| now.duration_since(*h.last_event_at.try_lock().unwrap()).as_secs())
            .unwrap_or(0);
        warn!(
            "multi-session: client for {s} silent for {secs}s, killing for respawn"
        );
        // Drop the handle → kill_on_drop fires SIGKILL on the tmux client →
        // forwarder sees EOF and exits. The next attach below replaces it.
        have.remove(&s);
    }

    // Attach new sessions.
    for s in &want {
        if have.contains_key(s) {
            continue;
        }
        match attach_session(socket, s, tx.clone(), sessions.clone(), store.as_ref()).await {
            Ok(handle) => {
                have.insert(s.clone(), handle);
            }
            Err(e) => warn!("multi-session: attach {s} failed: {e}"),
        }
    }
    Ok(())
}

/// Run `tmux list-panes -s -t <session>` and return `(pane_id, window_index)`
/// pairs for every pane in that session. Caller decides what to do with them
/// (announce + seed in `attach_session`).
async fn list_session_panes(
    socket: Option<&str>,
    session: &str,
) -> Result<Vec<(PaneId, String)>> {
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args([
            "list-panes",
            "-s",
            "-t",
            session,
            "-F",
            "#{pane_id}\t#{window_index}",
        ])
        .output()
        .await?;
    if !out.status.success() {
        anyhow::bail!(
            "list-panes -s -t {session}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let mut out_panes = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.split('\t');
        let id = match parts.next() {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        let window = parts.next().unwrap_or("0").to_string();
        out_panes.push((PaneId(id.to_string()), window));
    }
    Ok(out_panes)
}

async fn list_sessions(socket: Option<&str>) -> Result<Vec<String>> {
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    let out = cmd
        .args(["list-sessions", "-F", "#{session_name}"])
        .output()
        .await?;
    if !out.status.success() {
        // No sessions or no server is not an error — return empty.
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("no server running") || stderr.contains("no sessions") {
            return Ok(Vec::new());
        }
        anyhow::bail!("list-sessions failed: {}", stderr);
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .collect())
}

/// Spawn one control client for `session`, plus a forwarder task that pumps
/// its events into the shared `tx`. Removes the entry from `sessions` when
/// the client exits, so the next reconcile will re-attach if appropriate.
async fn attach_session(
    socket: Option<&str>,
    session: &str,
    tx: mpsc::Sender<SourceEvent>,
    sessions: Arc<Mutex<HashMap<String, ChildHandle>>>,
    store: Option<&PaneStore>,
) -> Result<ChildHandle> {
    // Discover the session's panes up front. Without this, new panes
    // only appear after their first byte of activity.
    let panes = list_session_panes(socket, session).await.unwrap_or_default();
    let pane_count = panes.len();
    let mut seeded = 0usize;
    for (pane_id, window) in &panes {
        // Always announce the pane via the event channel so PaneStore
        // gets the session/window metadata.
        let _ = tx
            .send(SourceEvent::PaneAdded {
                pane: pane_id.clone(),
                session: Some(session.to_string()),
                window: Some(window.clone()),
            })
            .await;
        // If we have a store handle, also seed dimensions + scrollback
        // for this pane the same way startup prepopulate does. This is
        // load-bearing for tmux-server-restart scenarios: pane ids get
        // re-issued from 0, panel attaches mid-life, and without this
        // panel's Term stays at daemon defaults (e.g. 30x80) while
        // tmux's actual pane is a different size — primary diverges
        // immediately and never recovers.
        if let Some(store) = store {
            match seed_pane(store, socket, pane_id).await {
                Ok(true) => seeded += 1,
                Ok(false) => {} // pane vanished or capture failed; non-fatal
                Err(e) => debug!(
                    "multi-session: seed_pane({}) for {session} failed: {e}",
                    pane_id.0
                ),
            }
        }
    }
    info!(
        "multi-session: attaching to session {session} panes={pane_count} seeded_via_store={seeded}"
    );
    let (ctrl, mut rx) = TmuxControl::spawn_with(SpawnOpts {
        socket_name: socket.map(String::from),
        target_session: Some(session.to_string()),
    })?;
    let session_name = session.to_string();
    let last_event_at = Arc::new(Mutex::new(Instant::now()));
    let last_event_at_fwd = last_event_at.clone();
    let sessions_for_fwd = sessions.clone();
    let forwarder = tokio::spawn(async move {
        // Helper: clean up our entry on every exit path so the reconciler
        // doesn't think we're still attached when we're not. Using a closure
        // keeps the map-locking centralized.
        let cleanup = || {
            let sessions = sessions_for_fwd.clone();
            let session_name = session_name.clone();
            async move {
                let mut have = sessions.lock().await;
                have.remove(&session_name);
            }
        };
        loop {
            match rx.recv().await {
                Some(SourceEvent::Closed { reason }) => {
                    debug!("multi-session: client for {session_name} closed: {reason}");
                    cleanup().await;
                    return;
                }
                Some(ev) => {
                    *last_event_at_fwd.lock().await = Instant::now();
                    if tx.send(ev).await.is_err() {
                        // Main bus dropped — daemon is shutting down. Still
                        // remove from map for symmetry.
                        cleanup().await;
                        return;
                    }
                }
                None => {
                    // Per-session rx closed without ever sending a Closed
                    // event (TmuxControl stdout reader bailed weirdly).
                    // Surfaces as warn! because pre-fix this could leave the
                    // session in `have` with no live client → reconciler
                    // would skip re-attaching → dead pane forever.
                    warn!(
                        "multi-session: rx None for {session_name} (tmux client died silently)"
                    );
                    cleanup().await;
                    return;
                }
            }
        }
    });
    Ok(ChildHandle {
        _ctrl: ctrl,
        _forwarder: forwarder,
        last_event_at,
    })
}
