// ttyview-tabs — session tab area (pinned tabs / all sessions),
// grouped by project.
//
// Pinned mode renders pins as PROJECT GROUPS: a slim header row
// (collapse caret, color dot, group name, count) above the group's
// tab rows, the whole group bracketed by a colored line on the left.
// Tabs keep their full session name (middle-ellipsis when tight) —
// stripped-to-digit labels were tried and reverted: too cryptic.
// Tapping a header collapses/expands that group. Groups are derived
// from session names (`lingush-claude1` → group "lingush", label
// "1"); a pin may carry an explicit `group` to override. Sessions
// that don't match the pattern flow into a headerless ungrouped row
// at the top. Long-press a header to enter move mode (▲▼ step the
// group up/down; tap elsewhere to dismiss); explicit order persists
// per group.
//
// A vertical utility rail sits on the RIGHT edge of the area (thumb
// side) with four buttons: ▦ = all sessions (every tmux session,
// alphabetical), 🕘 = recent (MRU, most-recent first), a 📌 pushpin
// that toggles PIN MODE (tap tabs to pin/unpin while lit), and a ✎
// pencil that toggles LABEL MODE (tap a tab to inline-edit its custom
// label while lit). Tap a mode to switch into it; tap the lit one to
// return to pinned. In every mode, tap a tab to switch and long-press
// to cycle its todo/done mark.
//
// Custom tab tags (per-session, tmux-web "subtitle" style): the ✎ rail
// toggle enters tag mode; tapping a tab opens an inline input on a
// SECOND LINE under the tab name. A tag is a separate annotation, NOT a
// rename — the name line and the real tmux session are untouched, so
// grouping / pins / marks / recents / dots all keep working off the true
// name. A tagged tab switches to a two-line stack but keeps the SAME
// fixed height (shrunk line-heights, like tmux-web keeps tabs uniform);
// untagged tabs are visually unchanged. Empty clears the tag. Tags live
// in the synced storage namespace (LABELS_KEY), carrying across devices
// like pins/marks.
//
// Above the groups, an always-on RECENT ROW (toggle in Settings)
// shows the most-recently-used sessions across all groups, newest
// first — one tap to jump back to where you just were. Recency is
// fed by the 'pane-changed' event and persisted (server-synced, so
// it carries across devices).
//
// Status dots (tmux-web-style, per session, settings-toggleable):
// amber pulsing = Claude Code permission prompt open (semantic
// events), blue pulsing = recent output (idle_ms poll), orange =
// finished since last viewed. See the "status dots" section below.
//
// Manual todo/done marks (per-session, tmux-web "cycle" gesture): press
// and HOLD a tab — one continuous press advances through stages, one
// `markDelay()` apart (default 500ms, adjustable in Settings):
//   from none  → todo (pink) → done (green)
//   from todo  → none        → done (green)
//   from done  → none        → todo (pink)
// Release at any stage locks that mark; finger drift > 36px cancels
// (generous so a wobbling thumb keeps the hold; only a real scroll aborts).
// Marks show as a left-edge stripe. Pin/unpin lives on the rail's
// pushpin toggle (tap it to enter pin mode, then tap tabs to pin/unpin).
// Both the marks and the pins persist in the synced storage namespace.
//
// Pin state persists via the per-plugin storage namespace, keyed by
// SESSION NAME (with pane id kept as a fast-path resolver) — so the
// tabs survive a tmux server restart that mints new pane ids, falling
// back to session-name match. Legacy `row` fields on pins are ignored
// (groups supersede manual row assignment). Per-group state (collapsed,
// color override) lives under the `groups` storage key.
//
// The `rows` setting is both the reserved minimum height AND the
// visible cap: when groups need more height, the area stays `rows`
// tab-rows tall and scrolls vertically.
//
// Default slot is above-input (bottom of the screen, by the thumb —
// the tmux-web arrangement); movable via Settings → Layout.
//
// Two contributions sharing state via this IIFE's closure:
//   - tabBar       — renders the grouped tabs + rail
//   - settingsTab  — Settings → Pinned Tabs: pin-all-sessions action,
//                    rows count, max tabs per row
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  const STORAGE_KEY = 'pins';
  const SETTINGS_KEY = 'settings';
  const GROUPS_KEY = 'groups';
  const MARKS_KEY = 'marks';
  const LABELS_KEY = 'labels';   // per-session custom display label (cosmetic alias)
  const LONG_PRESS_MS = 500;
  // Finger-drift tolerance for the press-and-hold mark gesture. Generous
  // on purpose: a hold is meant to stay put, but thumbs wobble — a tight
  // threshold made the mark abort whenever the finger shifted slightly
  // mid-press. Still small enough that a deliberate horizontal scroll of
  // a tab row (which travels much further) cancels as before.
  const MARK_DRIFT_PX = 36;
  // A press held at least this long is treated as a DELIBERATE hold, not a
  // quick tap. When the mark gesture was armed but the finger lifts before a
  // mark stage fires (released early), we swallow the tap instead of falling
  // through to onTap() — otherwise an aborted "long-press to change the dot"
  // silently switches to the tab and bumps it to the front of the recent row.
  // Quick taps (< this) still switch as before.
  const HOLD_SUPPRESS_MS = 250;
  const MARK_BUBBLE_LIFT = 72;   // px the state popup floats above the tab top (clear of the fingertip)
  const DEFAULTS = { rows: 1, maxPerRow: 0, mode: 'pinned', dots: true, recentRow: true, recentRows: 1, recentWrap: false, marks: true, markDelay: 500, markPopup: true, tabHeight: 28 };  // maxPerRow 0 = unlimited per row; recentRows = recent-area height in tab-rows (FRACTIONAL, half-row steps); recentWrap = wrap recents into a vertical-scroll grid (default off = single horizontal strip; on = grid even at 1 row tall)
  const RECENTS_KEY = 'recents';
  const RECENT_ROW_MAX = 12;    // tabs shown in the always-on recent row (single-row mode)
  const RECENT_STORE_MAX = 30;  // MRU entries kept in storage
  const RECENT_ROW_MAX_MULTI = RECENT_STORE_MAX;  // multi-row mode: show the full MRU (it scrolls vertically)
  const DOT_ACTIVE_MS = 4000;  // pane output within this window = "active"
  const DOT_POLL_MS = 4000;    // /panes refresh cadence while mounted + visible

  const storage = tv.storage('ttyview-tabs');

  // Hoisted state — shared between contributions.
  let pins = (function() {
    const v = storage.get(STORAGE_KEY);
    return Array.isArray(v) ? v : [];
  })();
  let settings = Object.assign({}, DEFAULTS, storage.get(SETTINGS_KEY) || {});
  // Per-group UI state: { [groupName]: { collapsed?: bool, color?: '#rgb' } }
  let groupsCfg = (function() {
    const v = storage.get(GROUPS_KEY);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  })();
  // ---- manual todo/done marks (per-session, user-set) ----
  // A session-keyed map { session: 'todo'|'done' }; absent = unmarked.
  // Long-press a tab cycles nothing → todo → done → nothing (tmux-web
  // style). Stored in the synced namespace, so marks carry across
  // devices like pins do.
  let marks = (function() {
    const v = storage.get(MARKS_KEY);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  })();
  // ---- custom tab labels (per-session cosmetic alias) ----
  // A session-keyed map { session: 'custom text' }; absent = use the
  // default (group-stripped digit, or full session name). PURELY
  // COSMETIC: the real tmux session keeps its name, so grouping, pins,
  // marks, recents and dots all keep working off the true name — only
  // the tab's visible text changes (its title= always shows the real
  // name). Stored in the synced namespace, so labels carry across
  // devices like pins/marks do.
  let labels = (function() {
    const v = storage.get(LABELS_KEY);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  })();
  // Pin mode: a transient toggle (rail pushpin button) that turns every
  // tab tap into a pin/unpin instead of a pane switch. Not persisted —
  // it's a momentary editing posture, like movingGroup.
  let pinMode = false;
  // Label mode: sibling transient toggle (rail ✎ button) — turns every
  // tab tap into an inline label edit instead of a pane switch. Mutually
  // exclusive with pinMode; not persisted.
  let labelMode = false;
  // True while an inline label editor is open. Background re-renders
  // (status-dot poll, pane-changed / panes-updated / semantic events)
  // call render(), which rebuilds the slot via innerHTML='' — that would
  // destroy the focused <input> mid-edit and slam the on-screen keyboard
  // shut. While this is set, render() no-ops; commit() clears it first.
  let editingActive = false;
  let movingGroup = null;       // group name in ▲▼ move mode (long-press a header)
  let suppressHeadTap = false;  // swallow the pointerup that completes a header
                                // long-press: render() replaces the header mid-
                                // press, so without implicit touch capture
                                // (i.e. with a mouse) the release lands on the
                                // NEW element and would read as a fresh tap
  let mountedSlot = null;       // set by tabBar render(); null when not mounted
  let mountedSlotInitial = '';  // restore-on-unmount cssText
  let parentTouched = false;    // whether we've added .ttv-stacked-slot to parent
  let contentEl = null;         // the vertically-scrolling column left of the rail

  function savePins()      { storage.set(STORAGE_KEY,  pins);      }
  function saveSettings()  { storage.set(SETTINGS_KEY, settings);  }
  function saveGroups()    { storage.set(GROUPS_KEY,   groupsCfg); }
  function saveMarks()     { storage.set(MARKS_KEY,    marks);     }
  function saveLabels()    { storage.set(LABELS_KEY,   labels);    }

  // Custom display label for a session, or null when none is set.
  function labelOf(session) { return (session && labels[session]) || null; }
  // Set / clear a session's custom label. Empty (or whitespace) clears.
  function setLabel(session, text) {
    if (!session) return;
    text = (text || '').trim();
    if (text) labels[session] = text; else delete labels[session];
    saveLabels();
    if (typeof window.ttvDiag === 'function') window.ttvDiag('tab-label', { session: session, label: text || null });
  }

  function marksOn() { return settings.marks !== false; }
  function markOf(session) { return (marksOn() && session && marks[session]) || null; }
  // Hold duration per gesture stage (ms). One value governs both the
  // initial press threshold and the promote-to-next-stage interval —
  // matching tmux-web's single `dotDelay` knob.
  function markDelay() {
    const v = parseInt(settings.markDelay, 10);
    return (v >= 100 && v <= 4000) ? v : 500;
  }
  // Tab/header/rail row height in px (Settings → Tab height). Clamped to
  // a sane touch-target range; 28 is the original fixed value.
  function tabHeight() {
    const v = parseInt(settings.tabHeight, 10);
    return (v >= 20 && v <= 72) ? v : 28;
  }
  // Recent-area visible HEIGHT, in tab-rows. FRACTIONAL allowed (half-row
  // steps from the settings stepper) so the strip can be e.g. 1.5 rows tall —
  // a peek of the next row hints it scrolls. Clamped 1‒6.
  function recentRowsVal() {
    const v = parseFloat(settings.recentRows);
    if (!isFinite(v)) return 1;
    return Math.max(1, Math.min(6, v));
  }
  // Whether the recents wrap into a VERTICAL-scrolling grid (vs the single
  // horizontal-scroll strip). True when the user opted in (the height stepper
  // sets recentWrap) OR the height is more than one row. Default-off keeps the
  // original single strip for embedders that never touch this.
  function recentWrapOn() {
    return !!settings.recentWrap || recentRowsVal() > 1;
  }
  function setMark(session, mark) {
    if (mark) marks[session] = mark; else delete marks[session];
    saveMarks();
    if (typeof window.ttvDiag === 'function') window.ttvDiag('tab-mark', { session: session, mark: mark || null });
  }
  // Reflect a session's mark on a live tab element WITHOUT a full
  // re-render — used for in-hold feedback. Rendering mid-gesture would
  // detach the very button being pressed and kill its pointer stream,
  // so the stripe is toggled in place; a render() on pointerup syncs
  // any duplicate tabs of the same session.
  function applyStripe(btn, mark) {
    btn.classList.remove('mark-todo', 'mark-done');
    if (mark === 'todo' || mark === 'done') btn.classList.add('mark-' + mark);
  }

  // ---- mark popup (floating state indicator above the pressed tab) ----
  // The finger covers the tab (and its stripe) mid-hold, so the current
  // mark is echoed in a bubble ABOVE the tab — above the thumb. One
  // shared element; updates live as the gesture promotes, fades on
  // release. tmux-web's dot-toggle-bubble, made persistent for the hold.
  function markPopupOn() { return settings.markPopup !== false; }
  const MARK_SPEC = { todo: ['#f7768e', 'todo'], done: ['#9ece6a', 'done'] };
  let markBubbleEl = null;
  let markBubbleTimer = null;
  function showMarkBubble(btn, mark) {
    if (!markPopupOn()) return;
    if (markBubbleTimer) { clearTimeout(markBubbleTimer); markBubbleTimer = null; }
    if (!markBubbleEl) {
      markBubbleEl = document.createElement('div');
      markBubbleEl.className = 'ttvtab-markbubble';
      document.body.appendChild(markBubbleEl);
    }
    const spec = MARK_SPEC[mark];
    const dot = spec
      ? '<span class="mb-dot" style="background:' + spec[0] + '"></span>'
      : '<span class="mb-dot mb-none"></span>';
    markBubbleEl.innerHTML = dot + '<span>' + (spec ? spec[1] : 'none') + '</span>';
    // Tint the border (and arrow) to the state colour — pink/green, or
    // a neutral muted edge for "none".
    const edge = spec ? spec[0] : 'var(--ttv-muted)';
    markBubbleEl.style.borderColor = edge;
    markBubbleEl.style.setProperty('--mb-edge', edge);
    const r = btn.getBoundingClientRect();
    // translate(-50%) in CSS means `left` is the bubble's CENTER, so a
    // leftmost/rightmost tab would push the bubble off-screen. Clamp the
    // center using the populated bubble's width so it stays fully visible.
    const mbHalf = markBubbleEl.offsetWidth / 2;
    const MB_MARGIN = 6;
    const mbCenter = Math.max(
      mbHalf + MB_MARGIN,
      Math.min(r.left + r.width / 2, window.innerWidth - mbHalf - MB_MARGIN)
    );
    markBubbleEl.style.left = mbCenter + 'px';
    // Lift it well clear of the fingertip — the bubble's bottom sits
    // MARK_BUBBLE_LIFT px above the tab top (translate(-50%,-100%) in
    // CSS anchors its bottom edge here). 8px was under the finger.
    markBubbleEl.style.top = (r.top - MARK_BUBBLE_LIFT) + 'px';
    markBubbleEl.style.opacity = '1';
  }
  function hideMarkBubble() {
    if (!markBubbleEl) return;
    const el = markBubbleEl;
    el.style.opacity = '0';
    markBubbleTimer = setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (markBubbleEl === el) markBubbleEl = null;
      markBubbleTimer = null;
    }, 240);
  }

  // pin/unpin by session name — used by pin-mode taps (the rail pushpin).
  function togglePin(session, paneId) {
    if (!session) return;
    if (pins.find(p => p.session === session)) {
      pins = pins.filter(p => p.session !== session);
    } else {
      pins.push({ id: paneId, session: session });
    }
    savePins();
    if (typeof window.ttvDiag === 'function') window.ttvDiag('tab-pin', { session: session, pinned: !!pins.find(p => p.session === session) });
    render();
  }

  // ---- recents (MRU across all sessions) ----
  // A plain most-recently-used list of SESSION NAMES, newest first.
  // Fed by the 'pane-changed' event (below); powers both the always-on
  // recent row (A) and the 🕘 rail mode (B). Server-synced storage, so
  // recency carries across the user's devices.
  let recents = (function() {
    const v = storage.get(RECENTS_KEY);
    return Array.isArray(v) ? v.filter(s => typeof s === 'string') : [];
  })();
  function saveRecents() { storage.set(RECENTS_KEY, recents.slice(0, RECENT_STORE_MAX)); }
  // Move `session` to the front. Returns true if order actually changed
  // (so callers can skip a redundant re-render).
  function noteRecent(session) {
    if (!session) return false;
    const i = recents.indexOf(session);
    if (i === 0) return false;
    if (i > 0) recents.splice(i, 1);
    recents.unshift(session);
    if (recents.length > RECENT_STORE_MAX) recents.length = RECENT_STORE_MAX;
    saveRecents();
    return true;
  }
  // MRU-ordered LIVE sessions, one representative pane each. With
  // `recentsOnly` (the always-on row): ONLY sessions you've actually
  // visited, in recency order — short and genuinely recent, no filler.
  // Without it (the 🕘 mode): recents first, then every never-visited
  // live session (alphabetical), so the mode is a full switcher.
  function liveRecents(panes, recentsOnly) {
    const bySession = new Map();
    for (const p of panes) if (!bySession.has(p.session)) bySession.set(p.session, p);
    const out = [];
    const used = new Set();
    for (const s of recents) {
      const p = bySession.get(s);
      if (p && !used.has(s)) { out.push(p); used.add(s); }
    }
    if (recentsOnly) return out;
    const rest = [];
    for (const p of panes) if (!used.has(p.session)) { used.add(p.session); rest.push(p); }
    rest.sort((a, b) => String(a.session).localeCompare(String(b.session)));
    return out.concat(rest);
  }

  // Muted dark-theme palette — pure hues vibrate on dark backgrounds.
  // Deterministic name→color so groups keep their color across
  // devices with zero config; per-group override via groupsCfg.
  const PALETTE = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7',
                   '#7dcfff', '#f7768e', '#ff9e64', '#73daca'];
  function groupColor(name) {
    const cfg = groupsCfg[name];
    if (cfg && cfg.color) return cfg.color;
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  // Derive { group, label } from a session name, or null when the
  // name doesn't look like "<project><n>". Handles the common
  // conventions: mcc1 → mcc/1, lingush-claude2 → lingush/2,
  // tmux-web4 → tmux-web/4, claude3 → claude/3.
  function deriveGroup(session) {
    // The agent-word suffix (claude/cc/agent) only strips when set off
    // by a separator — otherwise "mcc1" would parse as group "m" + "cc".
    const m = /^([a-zA-Z][\w.-]*?)(?:[-_](?:claude|cc|agent))?[-_]?(\d+)$/.exec(session || '');
    if (!m || !m[1]) return null;
    return { group: m[1], label: m[2] };
  }
  function pinGroup(pin) {
    if (pin.group) return { group: pin.group, label: pin.session || pin.id || '?' };
    return deriveGroup(pin.session);
  }

  // ---- status dots (per-session, tmux-web-style) ----
  // Three states, strongest wins:
  //   waiting   (amber, pulsing) — Claude Code permission prompt open
  //               in some pane of the session. Driven by the
  //               claude.permission_prompt / _resolved semantic events
  //               (daemon-side detectors, all panes — needs the core
  //               'semantic' plugin event; no-op on older daemons).
  //   active    (blue, pulsing)  — some pane produced output within
  //               DOT_ACTIVE_MS. Driven by idle_ms from a /panes poll.
  //   attention (orange)         — was active, went idle while you
  //               weren't viewing it; cleared when you switch to it.
  const waitingPanes = new Map();   // paneId -> session (null until resolved)
  let activeSessions = new Set();   // sessions with recent output
  const attention = new Set();      // finished-since-viewed sessions
  const DOT_RANK = { waiting: 3, active: 2, attention: 1 };

  function dotsOn() { return settings.dots !== false; }

  function sessionDot(session) {
    if (!dotsOn() || !session) return null;
    for (const s of waitingPanes.values()) {
      if (s === session) return 'waiting';
    }
    if (activeSessions.has(session)) return 'active';
    if (attention.has(session)) return 'attention';
    return null;
  }

  function groupDotOf(items) {
    let best = null;
    for (const it of items) {
      const d = sessionDot(it.pin.session);
      if (d && (!best || DOT_RANK[d] > DOT_RANK[best])) best = d;
    }
    return best;
  }

  function makeDotEl(state) {
    const el = document.createElement('span');
    el.className = 'ttvtab-dot ' + state;
    return el;
  }

  function updateDotState(panes) {
    const activePane = tv.getActivePane();
    const viewedSession = activePane ? activePane.session : null;
    const live = new Set();
    const nowActive = new Set();
    for (const p of panes) {
      live.add(p.session);
      if (typeof p.idle_ms === 'number' && p.idle_ms < DOT_ACTIVE_MS) {
        nowActive.add(p.session);
      }
    }
    // active → idle transition while not being viewed = attention.
    for (const s of activeSessions) {
      if (!nowActive.has(s) && s !== viewedSession && live.has(s)) {
        attention.add(s);
      }
    }
    if (viewedSession) attention.delete(viewedSession);
    for (const s of [...attention]) if (!live.has(s)) attention.delete(s);
    activeSessions = nowActive;
    // Prune waiting entries whose pane died (prompt can't resolve
    // anymore) and late-resolve sessions for panes we couldn't map
    // when the event arrived.
    const byId = new Map(panes.map(p => [p.id, p.session]));
    for (const [pid, sess] of [...waitingPanes]) {
      if (!byId.has(pid)) waitingPanes.delete(pid);
      else if (!sess) waitingPanes.set(pid, byId.get(pid));
    }
  }

  // Module-scope wiring: these register BEFORE the tabBar contribution
  // subscribes render, so by the time tabBar's own panes-updated /
  // pane-changed handlers repaint, dot state is already fresh.
  tv.on('panes-updated', function(list) {
    if (!dotsOn()) return;
    updateDotState(Array.isArray(list) ? list : tv.listPanes());
  });
  tv.on('pane-changed', function(e) {
    if (!dotsOn() || !e || !e.to) return;
    const p = tv.listPanes().find(x => x.id === e.to);
    if (p) attention.delete(p.session);
  });
  // MRU bookkeeping. Module-scope (like the dot handlers) so it runs
  // BEFORE the tabBar contribution's own pane-changed→render handler —
  // the recent row is fresh by the time render() reads `recents`.
  tv.on('pane-changed', function(e) {
    if (!e || !e.to) return;
    const p = tv.listPanes().find(x => x.id === e.to);
    if (p) noteRecent(p.session);
  });
  tv.on('semantic', function(ev) {
    if (!dotsOn() || !ev || !ev.name) return;
    if (ev.name === 'claude.permission_prompt') {
      const p = tv.listPanes().find(x => x.id === ev.pane);
      waitingPanes.set(ev.pane, p ? p.session : null);
    } else if (ev.name === 'claude.permission_resolved') {
      waitingPanes.delete(ev.pane);
    } else return;
    render();
  });

  // idle_ms only refreshes when /panes is re-fetched — poll while the
  // tab area is mounted and the page is visible. refreshPanes emits
  // panes-updated, which both updates dot state (above) and re-renders
  // (tabBar's subscription).
  let dotPollTimer = null;
  function pollDots() {
    if (!dotsOn() || document.visibilityState === 'hidden') return;
    if (typeof tv.refreshPanes === 'function') tv.refreshPanes();
  }
  function onVisibilityPoll() {
    if (document.visibilityState === 'visible') pollDots();
  }

  // Geometry diagnostics for the "section moves on toggle" report —
  // lands in the daemon's diag.jsonl and the Client Logs tab. One
  // record per render settle + a per-frame burst around toggles.
  function logGeom(tag) {
    try {
      if (typeof window.ttvDiag !== 'function' || !mountedSlot) return;
      const r = mountedSlot.getBoundingClientRect();
      const acc = mountedSlot.closest('[data-slot]');
      const ar = acc ? acc.getBoundingClientRect() : null;
      const inp = document.getElementById('input-row');
      window.ttvDiag('tabs-geom', {
        tag: tag,
        mode: settings.mode || 'pinned',
        slotH: Math.round(r.height * 10) / 10,
        slotTop: Math.round(r.top * 10) / 10,
        accH: ar ? Math.round(ar.height * 10) / 10 : -1,
        accTop: ar ? Math.round(ar.top * 10) / 10 : -1,
        inputTop: inp ? Math.round(inp.getBoundingClientRect().top * 10) / 10 : -1,
        // The pinned stack height now lives on leftCol (content's parent);
        // it's the constant that must NOT vary across modes.
        stackH: (contentEl && contentEl.parentNode) ? contentEl.parentNode.style.height : '',
        kids: contentEl ? contentEl.children.length : 0,
      });
    } catch (_) {}
  }

  function resolvePin(pin, panes) {
    // pin.id is a fast-path *hint* — but tmux recycles pane ids
    // across server restarts. If the cached id now belongs to a
    // different session, IGNORE it and re-resolve by session name
    // (then update the cache). Without this guard, the "active"
    // highlight tracks a stale id and lights up the wrong tab.
    if (pin.id) {
      const byId = panes.find(p => p.id === pin.id);
      if (byId && (!pin.session || byId.session === pin.session)) {
        return byId;
      }
    }
    if (pin.session) {
      const bySess = panes.find(p => p.session === pin.session);
      if (bySess) {
        pin.id = bySess.id;
        savePins();
        return bySess;
      }
    }
    return null;
  }

  // ---- styles (one-time inject) ----
  function ensureStyles() {
    const styleId = 'ttyview-tabs-style';
    if (document.getElementById(styleId)) return;
    const st = document.createElement('style');
    st.id = styleId;
    st.textContent = `
      .ttvtab {
        flex: none;
        position: relative;
        background: var(--ttv-bg-elev2);
        color: var(--ttv-fg);
        border: 1px solid var(--ttv-border);
        border-radius: 4px;
        /* Fixed height — glyph-independent. Emoji/symbol labels (📌, ▦)
           get taller line boxes than Latin text on Android, which made
           the measured row height (and therefore the whole section)
           differ between pinned and all modes: 86px vs 92px, a 6px
           jump on every toggle (caught via tabs-geom diag records).
           Height is a CSS var (Settings → Tab height); 28px fallback. */
        height: var(--ttv-tab-h, 28px);
        box-sizing: border-box;
        padding: 0 10px;
        font-size: 12px;
        line-height: 1;
        font-family: inherit;
        white-space: nowrap;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        user-select: none;
        -webkit-user-select: none;
        touch-action: manipulation;
        min-width: 0;
      }
      .ttvtab:active { filter: brightness(1.15); }
      .ttvtab.active {
        background: var(--ttv-bg);
        border-color: var(--ttv-accent);
        color: var(--ttv-accent);
      }
      .ttvtab.missing { opacity: 0.45; font-style: italic; }
      /* ---- manual todo/done marks (left-edge stripe) ---- */
      /* inset box-shadow, not a border — draws inside the box so it
         never shifts the tab's width or content padding. */
      .ttvtab.mark-todo { box-shadow: inset 3px 0 0 0 #f7768e; }
      .ttvtab.mark-done { box-shadow: inset 3px 0 0 0 #9ece6a; }
      /* Floating state popup above the pressed tab (finger hides the
         stripe). position:fixed so getBoundingClientRect coords map
         straight to viewport; translate lifts it clear above the tab. */
      .ttvtab-markbubble {
        position: fixed;
        transform: translate(-50%, -100%);
        z-index: 99999;
        display: flex; align-items: center; gap: 10px;
        background: var(--ttv-bg-elev2);
        color: var(--ttv-fg);
        border: 2px solid var(--ttv-border);
        border-radius: 10px;
        padding: 11px 18px;
        font-size: 18px; font-weight: 700; line-height: 1;
        box-shadow: 0 6px 22px rgba(0,0,0,0.55);
        pointer-events: none;
        white-space: nowrap;
        opacity: 0;
        transition: opacity 140ms;
      }
      /* Downward arrow pointing at the held tab. */
      .ttvtab-markbubble::after {
        content: '';
        position: absolute; top: 100%; left: 50%;
        transform: translateX(-50%);
        border: 9px solid transparent;
        border-top-color: var(--mb-edge, var(--ttv-border));
      }
      .ttvtab-markbubble .mb-dot {
        width: 15px; height: 15px; border-radius: 50%;
        display: inline-block; flex: none;
      }
      .ttvtab-markbubble .mb-dot.mb-none {
        background: transparent;
        border: 1.5px solid var(--ttv-muted);
      }
      /* Pin mode: every content tab becomes a pin/unpin target — a
         dashed accent outline signals the changed tap meaning. */
      .ttv-pinmode .ttvtab-content .ttvtab,
      .ttv-pinmode .ttvtab-recentrow .ttvtab,
      /* Label mode: tabs become rename targets — same dashed-outline cue. */
      .ttv-labelmode .ttvtab-content .ttvtab,
      .ttv-labelmode .ttvtab-recentrow .ttvtab {
        outline: 1px dashed var(--ttv-rail-accent, var(--ttv-accent));
        outline-offset: -1px;
      }
      /* ---- custom tag (second line under the name, tmux-web style) ---- */
      /* A tagged tab switches to a vertical stack (name over tag). The
         box height stays the FIXED 28px (.ttvtab height) — line-heights
         are shrunk so both rows fit, like tmux-web keeps its tabs uniform
         height. Untagged tabs are untouched (single centered line). */
      .ttvtab.has-tag {
        flex-direction: column;
        align-items: stretch;
        justify-content: center;
        gap: 0;
      }
      .ttvtab.has-tag .ttvtab-label {
        font-size: 11px;
        /* line-height must clear glyph ascent+descent (≈1.2em) or the
           row's overflow clips the bottom — 11px needs ≈13.2, 9px needs
           ≈10.8. 14 + 11 = 25px fits the 26px inner box (28px − 2px
           border) with both lines clearing their glyphs. */
        line-height: 14px;
        text-align: center;
        width: 100%;
      }
      .ttvtab .ttvtab-tag {
        font-size: 9px;
        line-height: 11px;
        color: var(--ttv-muted);
        text-align: center;
        width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .ttvtab.active .ttvtab-tag { color: var(--ttv-accent); opacity: 0.85; }
      .ttvtab.missing .ttvtab-tag { color: var(--ttv-muted); }
      /* Inline tag editor (label mode). The editing tab breaks out of the
         fit-grid to a comfortable width; the name stays on top, the input
         replaces the tag line below it. */
      .ttvtab.tag-editing {
        flex: 0 0 auto;
        min-width: 150px;
        outline: 1px solid var(--ttv-accent);
        outline-offset: -1px;
      }
      .ttvtab .ttvtab-tagedit {
        flex: none;
        width: 100%;
        min-width: 0;
        background: var(--ttv-bg);
        color: var(--ttv-fg);
        border: none;
        border-radius: 3px;
        font: inherit;
        /* match the tag line (9/11) so name + input fit the 26px box */
        font-size: 9px;
        line-height: 11px;
        text-align: center;
        padding: 0;
        margin: 0;
        outline: none;
      }
      .ttvtab .ttvtab-label {
        overflow: hidden;
        min-width: 0;
      }
      .ttvtab .ttvtab-x {
        font-size: 14px; line-height: 1;
        opacity: 0;
        transition: opacity 80ms;
        flex: none;
      }
      .ttvtab.editing .ttvtab-x { opacity: 0.7; }
      .ttvtab.editing { animation: ttvtab-pulse 0.6s infinite alternate; }
      @keyframes ttvtab-pulse { from { background: var(--ttv-bg-elev2); } to { background: var(--ttv-border); } }
      /* ---- Tall two-line tabs (opt-in: body.ttv-tall-tabs) ----------
         When enabled (mobile-cc sets the class), every tab (pinned
         content AND the recent row) grows to a fixed taller height so the
         custom tag (subtitle) is readable on its own line instead of
         being crammed into 28px. The icon rail (.ttvtab-railbtn) is
         excluded — it stays compact. The default (no class) is the
         original 28px cram, so ttyview-demo / panel / other embedders are
         unaffected. */
      body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn) { height: 44px; padding: 0 8px; }
      body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn) .ttvtab-label {
        font-size: 13px; line-height: 16px;
      }
      body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn).has-tag { gap: 2px; }
      body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn).has-tag .ttvtab-label {
        font-size: 13px; line-height: 15px; font-weight: 600;
      }
      body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn) .ttvtab-tag {
        font-size: 11px; line-height: 14px; text-align: left;
      }
      body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn) .ttvtab-tagedit {
        font-size: 12px; line-height: 16px;
      }
      /* ---- Card head row (name + dot + ⋮) ---------------------------
         The name line is wrapped in a STABLE .ttvtab-head so the dot and
         mobile-cc-tab-menu's ⋮ can sit as flex children on one centered
         row, with the subtitle below. DEFAULT = display:contents (a no-op
         wrapper) so non-mobile embedders (ttyview-demo / panel) are
         unchanged — the dot keeps its absolute corner position. Only under
         body.ttv-tall-tabs does it become a real row:
           [ name flex:1 ellipsis ] … [ .ttvtab-dot ] [ .mcc-tabmenu-btn ]
         mobile-cc-tab-menu appends its ⋮ as the LAST child of .ttvtab-head
         (right of the dot) instead of absolute-positioning. */
      .ttvtab-head { display: contents; }
      body.ttv-tall-tabs .ttvtab:not(.ttvtab-railbtn) .ttvtab-head {
        display: flex; align-items: center; gap: 6px;
        width: 100%; flex: 1 1 auto; min-width: 0;
      }
      body.ttv-tall-tabs .ttvtab-head .ttvtab-label {
        flex: 1 1 auto; min-width: 0; width: auto; text-align: left;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      body.ttv-tall-tabs .ttvtab-head .ttvtab-dot {
        position: static; flex: none;
      }
      .ttvtab-add {
        background: transparent;
        border: 1px dashed var(--ttv-border);
        color: var(--ttv-muted);
      }
      .ttvtab .ttvtab-pinmark {
        font-size: 9px; line-height: 1;
        opacity: 0.8;
        flex: none;
      }
      .ttvtab-add:active { color: var(--ttv-accent); border-color: var(--ttv-accent); }
      /* Multi-row container — one .ttvtab-row per row, each with its
         own horizontal scroll so a row exceeding maxPerRow can still
         reach the overflow tabs. */
      .ttvtab-row {
        display: flex; gap: 4px; flex-wrap: nowrap;
        overflow-x: auto;
        scrollbar-width: none;
        /* Keep natural height inside the capped column-flex slot —
           without this, a maxHeight on the slot squishes every row
           (flex-shrink) instead of triggering vertical scroll. */
        flex: none;
      }
      .ttvtab-row::-webkit-scrollbar { display: none; }
      /* When the tabs plugin claims its parent slot for its own
         stacked rows, mark the parent so siblings (other plugin
         spans) get their own horizontal scroll instead of dragging
         everything together via the slot's overflow-x: auto. */
      .ttv-stacked-slot {
        flex-direction: column !important;
        align-items: stretch !important;
        overflow-x: hidden !important;
      }
      .ttv-stacked-slot > * {
        overflow-x: auto;
        max-width: 100%;
        scrollbar-width: none;
      }
      .ttv-stacked-slot > *::-webkit-scrollbar { display: none; }
      /* Fit mode: when maxPerRow is set, every tab is exactly
         1/maxPerRow of the row width — even on rows with fewer
         items, so columns line up across rows. The row container
         carries --ttv-max-per-row (set inline by render()).
         Labels truncate with middle-ellipsis (applied by JS
         after layout). */
      .ttvtab-row.fit { overflow-x: hidden; justify-content: flex-start; }
      .ttvtab-row.fit .ttvtab,
      .ttvtab.fit {
        flex: 0 0 calc((100% - (var(--ttv-max-per-row) - 1) * 4px) / var(--ttv-max-per-row));
        padding-left: 8px;
        padding-right: 8px;
      }
      /* ---- project groups ---- */
      .ttvtab-content {
        display: flex; flex-direction: column; gap: 4px;
        /* flex:1 1 0 + min-height:0 so it fills the height leftCol
           leaves after the (pinned-mode-only) recent row and scrolls,
           instead of dictating its own height. leftCol is pinned to a
           constant total — keeps mode switches from bumping the
           terminal. */
        flex: 1 1 0; min-width: 0; min-height: 0;
        overflow-y: auto;
        scrollbar-width: none;
      }
      .ttvtab-content::-webkit-scrollbar { display: none; }
      .ttvtab-group {
        display: flex; flex-direction: column; gap: 4px;
        border-left: 3px solid var(--ttv-border);
        padding-left: 6px;
        flex: none;
        min-width: 0;
      }
      .ttvtab-ghead {
        display: flex; align-items: center; gap: 6px;
        /* Same height as tabs: a header is a primary tap target
           (collapse/expand + long-press reorder), not a caption. */
        height: var(--ttv-tab-h, 28px);
        box-sizing: border-box;
        /* A filled full-width bar, not a transparent caption — reads
           as a real control on the black slot background. render()
           overlays a per-group color tint inline (color-mix). */
        background: var(--ttv-bg-elev2);
        border: 1px solid var(--ttv-border);
        border-radius: 4px;
        padding: 0 8px;
        font-family: inherit; font-size: 12px; line-height: 1;
        color: var(--ttv-muted);
        cursor: pointer;
        user-select: none; -webkit-user-select: none;
        touch-action: manipulation;
        min-width: 0;
      }
      .ttvtab-ghead:active { filter: brightness(1.15); }
      .ttvtab-ghead.gmoving {
        background: var(--ttv-bg-elev2);
        outline: 1px solid var(--ttv-accent);
      }
      .ttvtab-ghead .ttvtab-garrow {
        flex: none; width: 38px; height: 24px;
        background: var(--ttv-bg-elev2); color: var(--ttv-fg);
        border: 1px solid var(--ttv-border); border-radius: 4px;
        font-size: 12px; line-height: 1; font-family: inherit;
        display: inline-flex; align-items: center; justify-content: center;
        cursor: pointer;
        touch-action: manipulation;
      }
      .ttvtab-ghead .ttvtab-garrow:disabled { opacity: 0.35; }
      .ttvtab-ghead .ttvtab-garrow:first-of-type { margin-left: auto; }
      .ttvtab-ghead .ttvtab-gcaret { flex: none; font-size: 10px; width: 12px; text-align: left; }
      .ttvtab-ghead .ttvtab-gdot {
        flex: none; width: 8px; height: 8px; border-radius: 50%;
      }
      .ttvtab-ghead .ttvtab-gname {
        font-weight: 600; color: var(--ttv-fg);
        overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      }
      .ttvtab-ghead.gactive .ttvtab-gname { color: var(--ttv-accent); }
      .ttvtab-ghead .ttvtab-gcount { flex: none; opacity: 0.7; }
      /* ---- status dots ---- */
      .ttvtab .ttvtab-dot {
        position: absolute; top: 3px; right: 3px;
        width: 7px; height: 7px; border-radius: 50%;
        pointer-events: none;
      }
      /* On a (collapsed) group header the dot flows inline after the
         count instead of overlaying a corner. */
      .ttvtab-ghead .ttvtab-dot {
        position: static; flex: none;
        width: 7px; height: 7px; border-radius: 50%;
        pointer-events: none;
      }
      .ttvtab-dot.waiting   { background: #f0c040; animation: ttvtab-dot-pulse 1.2s ease-in-out infinite; }
      .ttvtab-dot.active    { background: #4a9eff; animation: ttvtab-dot-pulse 1s ease-in-out infinite; }
      .ttvtab-dot.attention { background: #e8a828; }
      @keyframes ttvtab-dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
      /* ---- utility rail (right edge, thumb side) ---- */
      .ttvtab-rail {
        display: flex; flex-direction: column; gap: 4px;
        flex: none;
      }
      .ttvtab-rail .ttvtab {
        width: 32px; padding: 0; justify-content: center;
        /* Icon color = the embedder's rail accent if set (mobile-cc
           paints it brand-coral), else the host theme accent. */
        color: var(--ttv-rail-accent, var(--ttv-accent));
      }
      .ttvtab-rail .ttvtab .ttvtab-label { overflow: visible; display: inline-flex; }
      .ttvtab-rail .ttvtab svg { display: block; opacity: 0.5; transition: opacity 120ms; }
      .ttvtab-rail .ttvtab:active svg { opacity: 0.8; }
      /* Lit = the active mode. Override the generic .active (which uses
         --ttv-accent) so the rail follows its own accent. */
      .ttvtab-rail .ttvtab.active {
        background: var(--ttv-bg);
        border-color: var(--ttv-rail-accent, var(--ttv-accent));
        color: var(--ttv-rail-accent, var(--ttv-accent));
      }
      .ttvtab-rail .ttvtab.active svg { opacity: 1; }
      /* ---- recent row (A) ---- */
      /* The recents are a real group now: a bracketed band (reusing
         .ttvtab-group) with a collapsible header (.ttvtab-rhead) above
         the tab strip. A muted bracket + 🕘 dot mark it as the recent
         band (vs the per-project colored group brackets). */
      .ttvtab-recentgroup { border-left-color: var(--ttv-muted); }
      .ttvtab-rhead .ttvtab-gdot { background: var(--ttv-muted); }
      .ttvtab-rhead .ttvtab-gname { color: var(--ttv-muted); }
      .ttvtab-recentrow {
        display: flex; gap: 4px; align-items: center;
        flex: none;
        overflow-x: auto; scrollbar-width: none;
        /* The group band already supplies the bracket + left inset, so
           the strip itself carries none — its tabs line up on the same
           fit-width grid + left column as the group tabs. No padding so
           the multi-row max-height clamps to EXACTLY N rows. */
        padding: 0;
        box-sizing: content-box;
      }
      .ttvtab-recentrow::-webkit-scrollbar { display: none; }
      /* Multi-row recents (settings.recentRows > 1): wrap into a grid that
         scrolls VERTICALLY instead of one strip scrolling horizontally. The
         max-height (N tab-rows) is set inline by render() once a tab is
         measured, so it works across font-size / tab-height changes. */
      .ttvtab-recentrow.multirow {
        flex-wrap: wrap;
        overflow-x: hidden;
        overflow-y: auto;
        row-gap: 4px;
      }
    `;
    document.head.appendChild(st);
  }

  // ---- core render of the tab area ----
  let renderGen = 0;     // invalidates stale rAF callbacks across re-renders
  let lastHeightPx = ''; // the constant tab-stack (leftCol) height,
                         // carried across renders so a mode switch never
                         // flashes to natural content height during the
                         // re-render → rAF-remeasure gap. Mode-INDEPENDENT
                         // (see the render-settle rAF) so ▦/🕘 don't bump
                         // the terminal above.
  let recentReserve = 0; // measured height (incl. the leftCol gap) of the
                         // always-on recent row; cached from renders where
                         // it's present so the modes where it's absent
                         // (all / recent) can reserve the same space.
  // Public API for mobile-cc's ⋮ tab menu: get/set a tab's subtitle (the
  // per-session custom tag) and re-render so it shows immediately. Generic
  // — callers feature-detect window.ttvTabsSetLabel; default builds without
  // this consumer are unaffected. setLabel/labelOf/render are hoisted.
  try {
    window.ttvTabsGetLabel = function (session) { return labelOf(session); };
    window.ttvTabsSetLabel = function (session, text) { setLabel(session, text); render(); };
    // Remove a session from the MRU recents in-memory + persist + re-render.
    // A reload-based remove (storage write + location.reload) can't work: on
    // reload the last-viewed pane re-opens → pane-changed → noteRecent re-adds
    // it, and hydrateServerState can race the fire-and-forget PUT. Mutating the
    // live `recents` array here sidesteps both. Returns true if it was present.
    window.ttvTabsRemoveRecent = function (session) {
      const i = recents.indexOf(session);
      if (i < 0) return false;
      recents.splice(i, 1);
      saveRecents();
      render();
      return true;
    };
  } catch (_) {}

  function render() {
    if (!mountedSlot) return;
    if (editingActive) return;   // don't blow away an open inline label editor
    const gen = ++renderGen;
    // Re-renders happen mid-interaction (pin/unpin, collapse,
    // panes-updated) — keep the user's scroll position instead of
    // jumping to the top. contentEl carries the groups' VERTICAL scroll;
    // the recent row carries its own HORIZONTAL scroll (it's a fresh
    // element each render, so without this it snaps back to the start on
    // every dot-poll / output event — see buildRecentRow).
    const prevScroll = contentEl ? contentEl.scrollTop : 0;
    const prevRecentScroll = (function() {
      const rr = mountedSlot.querySelector('.ttvtab-recentrow');
      if (!rr) return 0;
      return rr.classList.contains('multirow') ? rr.scrollTop : rr.scrollLeft;
    })();
    mountedSlot.innerHTML = '';
    const panes = tv.listPanes();
    const active = tv.getActivePane();
    const mode = (settings.mode === 'all' || settings.mode === 'recent')
      ? settings.mode : 'pinned';
    const rows = Math.max(1, settings.rows | 0);
    const max  = Math.max(0, settings.maxPerRow | 0);
    const fitMode = max > 0;
    // Whether the always-on recent row is in play at all (enabled AND
    // there's something recent to show). Computed mode-independently:
    // the row only RENDERS in pinned mode, but its height is reserved in
    // every mode so switching modes can't change the stack height.
    const recentsActive = settings.recentRow !== false
      && liveRecents(panes, true).length > 0;

    // Layout: [ leftCol (recent row + groups) | rail ]. mountedSlot is
    // a row; the left column stacks the optional recent row above the
    // groups content. Keeping the recent row INSIDE the left column
    // (not full-width above everything) makes its width equal the
    // groups' width, so recent tabs and group tabs share the same
    // fit-width grid. The rail spans the full height on the thumb side.
    // The parent slot is row-flex by default — claim it as a column
    // context (see .ttv-stacked-slot) so width:100% works and the
    // quickkeys sibling keeps its own horizontal scroll.
    mountedSlot.style.cssText = 'display:flex;flex-direction:row;gap:4px;width:100%;align-items:stretch;';
    mountedSlot.style.setProperty('--ttv-tab-h', tabHeight() + 'px');   // user-set tab height (cascades to tabs + headers + rail)
    mountedSlot.classList.toggle('ttv-pinmode', pinMode);
    mountedSlot.classList.toggle('ttv-labelmode', labelMode);
    const parent = mountedSlot.parentNode;
    if (parent) {
      parent.classList.add('ttv-stacked-slot');
      parentTouched = true;
    }

    const leftCol = document.createElement('div');
    leftCol.style.cssText = 'display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-width:0;';
    // Re-apply the last known stack height synchronously — the rAF at
    // the end of render() re-measures and refines, but without this the
    // frame(s) in between render at natural content height and the area
    // jumps. lastHeightPx is mode-independent, so this is correct even
    // across a mode switch (the whole point: no terminal bump).
    if (lastHeightPx) leftCol.style.height = lastHeightPx;
    mountedSlot.appendChild(leftCol);

    // A — always-on recent row: most-recently-used sessions, across
    // groups, one tap to jump back. Pinned mode only (the 🕘 rail mode
    // is the full recent view); opt out via Settings → Recent tabs.
    // Built after placedTabs is declared (below) so its fit tabs join
    // the same middle-ellipsis pass; deferred via a thunk here.
    let buildRecentInto = null;
    if (mode === 'pinned' && settings.recentRow !== false) {
      buildRecentInto = leftCol;
    }

    const content = document.createElement('div');
    content.className = 'ttvtab-content';
    // Height is governed by leftCol (fixed) + this element's flex:1 1 0
    // / min-height:0 / overflow-y:auto (see CSS): it fills whatever
    // leftCol leaves after the recent row and scrolls. No explicit cap
    // here — that lived on content before groups + the recent row made
    // the stack height mode-dependent.
    leftCol.appendChild(content);
    contentEl = content;

    const placedTabs = []; // { el, label, fullText } — for ellipsis pass

    // Now that placedTabs exists, build the recent row (prepended above
    // the groups in the left column) and feed its fit tabs into the
    // same ellipsis pass.
    if (buildRecentInto) {
      const rr = buildRecentRow(panes, active, fitMode, max, placedTabs);
      if (rr) buildRecentInto.insertBefore(rr, content);
    }

    // Chunk `entries` into .ttvtab-row children of parentEl —
    // maxPerRow per row in fit mode, one scrolling row otherwise.
    function placeRows(parentEl, entries, make) {
      if (!entries.length) return;
      const chunk = fitMode ? max : entries.length;
      for (let i = 0; i < entries.length; i += chunk) {
        const rowEl = document.createElement('div');
        rowEl.className = 'ttvtab-row' + (fitMode ? ' fit' : '');
        if (fitMode) rowEl.style.setProperty('--ttv-max-per-row', String(max));
        for (const entry of entries.slice(i, i + chunk)) {
          const made = make(entry);
          if (!made) continue;
          rowEl.appendChild(made.el);
          if (fitMode) placedTabs.push(made);
        }
        parentEl.appendChild(rowEl);
      }
    }

    if (mode === 'pinned') {
      // Partition pins into ungrouped + named groups (first-appearance
      // order — pin order is user-controlled, groups inherit it).
      const order = [];
      const byGroup = {};
      const ungrouped = [];
      for (const pin of pins) {
        const d = pinGroup(pin);
        if (d && d.group) {
          if (!byGroup[d.group]) { byGroup[d.group] = []; order.push(d.group); }
          byGroup[d.group].push({ pin, label: d.label });
        } else {
          ungrouped.push({ pin, label: pin.session || pin.id || '?' });
        }
      }

      // Explicit per-group order (written by ▲▼ move mode) wins over
      // first-appearance order; ties keep appearance order so groups
      // without a stored order slot in stably.
      const appear = {};
      order.forEach(function(n, i) { appear[n] = i; });
      order.sort(function(a, b) {
        const oa = (groupsCfg[a] && groupsCfg[a].order != null) ? groupsCfg[a].order : appear[a];
        const ob = (groupsCfg[b] && groupsCfg[b].order != null) ? groupsCfg[b].order : appear[b];
        return (oa - ob) || (appear[a] - appear[b]);
      });
      // Re-number the whole list and persist on every move so orders
      // stay dense and unambiguous.
      function commitOrder(list) {
        list.forEach(function(n, i) {
          groupsCfg[n] = Object.assign({}, groupsCfg[n], { order: i });
        });
        saveGroups();
        render();
      }

      // Headerless ungrouped row first; the "+ pin current" chip lives
      // here too (it applies to whatever session is active).
      const ungroupedEntries = ungrouped.map(u => ({ kind: 'pin', pin: u.pin, label: u.label }));
      if (active && !pins.find(p => p.session === active.session)) {
        ungroupedEntries.push({ kind: 'add', active });
      }
      placeRows(content, ungroupedEntries, function(entry) {
        if (entry.kind === 'add') return makeAddButton(entry.active, fitMode);
        return makeTabButton(entry.pin, resolvePin(entry.pin, panes), active, fitMode);
      });

      for (const name of order) {
        const items = byGroup[name];
        const color = groupColor(name);
        const collapsed = !!(groupsCfg[name] && groupsCfg[name].collapsed);
        const hasActive = !!(active && items.some(it => it.pin.session === active.session));

        const g = document.createElement('div');
        g.className = 'ttvtab-group';
        g.style.borderLeftColor = color;

        // A div, not a button — move mode nests real <button> arrows
        // inside, and buttons can't legally contain buttons.
        const head = document.createElement('div');
        head.setAttribute('role', 'button');
        head.className = 'ttvtab-ghead' + (hasActive ? ' gactive' : '')
          + (movingGroup === name ? ' gmoving' : '');
        // Tint the bar toward the group color (subtle — 14% keeps text
        // contrast). Falls back to the stock elev2 fill from the CSS
        // class on browsers without color-mix.
        if (window.CSS && CSS.supports && CSS.supports('background', 'color-mix(in srgb, red 10%, black)')) {
          head.style.background = 'color-mix(in srgb, ' + color + ' 14%, var(--ttv-bg-elev2))';
        }
        const caret = document.createElement('span');
        caret.className = 'ttvtab-gcaret';
        caret.textContent = collapsed ? '▸' : '▾';
        const dot = document.createElement('span');
        dot.className = 'ttvtab-gdot';
        dot.style.background = color;
        const nm = document.createElement('span');
        nm.className = 'ttvtab-gname';
        nm.textContent = name;
        const cnt = document.createElement('span');
        cnt.className = 'ttvtab-gcount';
        cnt.textContent = String(items.length);
        head.appendChild(caret);
        head.appendChild(dot);
        head.appendChild(nm);
        head.appendChild(cnt);
        // Collapsed groups surface their members' strongest status —
        // a hidden waiting prompt must not be silenced by collapsing.
        if (collapsed) {
          const gd = groupDotOf(items);
          if (gd) head.appendChild(makeDotEl(gd));
        }
        head.title = (collapsed ? 'Expand ' : 'Collapse ') + name +
          ' (' + items.length + ' session' + (items.length === 1 ? '' : 's') +
          ') — long-press to reorder';
        head.tabIndex = -1;

        // Move mode: ▲▼ on the right edge of this header.
        if (movingGroup === name) {
          const idx = order.indexOf(name);
          function arrow(glyph, delta, disabled) {
            const a = document.createElement('button');
            a.type = 'button';
            a.className = 'ttvtab-garrow';
            a.textContent = glyph;
            a.disabled = disabled;
            a.title = delta < 0 ? 'Move group up' : 'Move group down';
            a.addEventListener('pointerdown', function(e) { e.stopPropagation(); });
            a.addEventListener('pointerup', function(e) {
              e.stopPropagation();
              const list = order.slice();
              list.splice(idx, 1);
              list.splice(idx + delta, 0, name);
              commitOrder(list);  // saves + re-renders; move mode stays on
            });
            a.addEventListener('mousedown', function(e) { e.preventDefault(); });
            return a;
          }
          head.appendChild(arrow('▲', -1, idx === 0));
          head.appendChild(arrow('▼', +1, idx === order.length - 1));
        }

        // Tap = collapse/expand; long-press = enter/leave move mode;
        // tap while moving = leave move mode (don't also collapse).
        let headTimer = null;
        let headLong = false;
        function clearHeadTimer() {
          if (headTimer) { clearTimeout(headTimer); headTimer = null; }
        }
        head.addEventListener('pointerdown', function() {
          headLong = false;
          suppressHeadTap = false;  // a new gesture invalidates any stale swallow
          clearHeadTimer();
          headTimer = setTimeout(function() {
            headLong = true;
            suppressHeadTap = true;
            movingGroup = movingGroup === name ? null : name;
            render();
          }, LONG_PRESS_MS);
        });
        head.addEventListener('pointerup', function(e) {
          clearHeadTimer();
          if (headLong) { headLong = false; suppressHeadTap = false; return; }
          if (suppressHeadTap) { suppressHeadTap = false; return; }
          if (e.button !== undefined && e.button !== 0) return;
          if (movingGroup !== null) { movingGroup = null; render(); return; }
          groupsCfg[name] = Object.assign({}, groupsCfg[name],
            { collapsed: !collapsed });
          saveGroups();
          render();
        });
        head.addEventListener('pointerleave',  function() { clearHeadTimer(); headLong = false; });
        head.addEventListener('pointercancel', function() { clearHeadTimer(); headLong = false; });
        head.addEventListener('mousedown', function(e) { e.preventDefault(); });
        g.appendChild(head);

        if (!collapsed) {
          placeRows(g, items, function(it) {
            return makeTabButton(it.pin, resolvePin(it.pin, panes), active, fitMode);
          });
        }
        content.appendChild(g);
      }
    } else if (mode === 'recent') {
      // B — flat MRU list, most-recent first (live sessions). Same
      // tap-to-switch / long-press-to-pin behavior as all-sessions.
      placeRows(content, liveRecents(panes), function(p) {
        return makeSessionButton(p, active, fitMode);
      });
    } else {
      // Every session, one tab each, alphabetical.
      const seen = new Set();
      const sessions = [];
      for (const p of panes) {
        if (!seen.has(p.session)) { seen.add(p.session); sessions.push(p); }
      }
      sessions.sort((a, b) => String(a.session).localeCompare(String(b.session)));
      placeRows(content, sessions, function(p) {
        return makeSessionButton(p, active, fitMode);
      });
    }

    // Utility rail — right edge (thumb side). Hard cap by design: if
    // this ever wants more buttons than fit the area height, those
    // belong in an overlay, not a scrolling rail.
    const rail = document.createElement('div');
    rail.className = 'ttvtab-rail';
    makeRail(rail, mode);
    mountedSlot.appendChild(rail);

    // Constant stack height: the whole left column (the always-on
    // recent row + the scrolling content) is pinned to ONE height in
    // every mode, so switching pinned / ▦ all / 🕘 recent never changes
    // the tab area's size and bumps the terminal above. The content is
    // ALWAYS exactly `rows` tab-rows tall; the recent row is pinned-mode
    // only, so its measured height is RESERVED in the other modes (the
    // content grows to fill that space rather than leaving a gap).
    // Everything is measured (not hardcoded) so font-size / padding
    // changes don't desync — and the recent row's own height is cached
    // (recentReserve) from the renders where it's present, for use in
    // the modes where it's absent.
    requestAnimationFrame(function() {
      if (gen !== renderGen || !mountedSlot) return;
      const tab = mountedSlot.querySelector('.ttvtab');
      const h = (tab && tab.offsetHeight) ? tab.offsetHeight : 28;
      const contentBase = rows * h + (rows - 1) * 4;
      const rr = leftCol.querySelector('.ttvtab-recentrow');
      // Multi-row recents: cap the wrapped strip at N tab-rows tall so it
      // scrolls vertically. Set BEFORE measuring offsetHeight so the
      // reserved height below reflects the capped (visible) height.
      if (rr && rr.classList.contains('multirow')) {
        const rRows = recentRowsVal();   // FRACTIONAL (half-row steps)
        // N tab-rows + (N-1) row-gaps, +2px so a whole bottom row's border
        // isn't sub-pixel-clipped. For a half-row value (e.g. 1.5) this
        // deliberately leaves a PEEK of the next row as a scroll hint.
        rr.style.maxHeight = (rRows * h + (Math.ceil(rRows) - 1) * 4 + 2) + 'px';
      }
      // Reserve the whole recent GROUP (header bar + tab strip), not just
      // the strip — the header is always shown even when collapsed.
      const rg = leftCol.querySelector('.ttvtab-recentgroup');
      if (rg) recentReserve = rg.offsetHeight + 4 /* leftCol row gap */;
      // Restore the recent row's scroll (it's rebuilt every render) so a
      // poll/output-driven re-render doesn't snap it back. Single-row mode
      // scrolls horizontally; multi-row scrolls vertically.
      if (rr && prevRecentScroll) {
        if (rr.classList.contains('multirow')) rr.scrollTop = prevRecentScroll;
        else rr.scrollLeft = prevRecentScroll;
      }
      const reserve = recentsActive ? (recentReserve || (h + 10)) : 0;
      const px = (contentBase + reserve) + 'px';
      lastHeightPx = px;
      leftCol.style.height = px;
      // Restore scroll only after the height re-creates the overflow —
      // setting scrollTop on an uncapped element clamps it to 0.
      if (prevScroll) content.scrollTop = prevScroll;
      logGeom('render-settle');
    });

    if (fitMode && placedTabs.length) {
      // Run after layout settles so each label sees its real width.
      requestAnimationFrame(function() {
        if (gen !== renderGen) return;
        for (const t of placedTabs) middleEllipsisFit(t.label, t.fullText);
      });
    }
  }

  // Fit `fullText` into `el` with middle-ellipsis (start … end) when it
  // overflows. Binary-searches the kept-char count; O(log n) layout
  // reads per element. Caller must give the element its final layout
  // before calling (inside requestAnimationFrame).
  function middleEllipsisFit(el, fullText) {
    el.textContent = fullText;
    if (el.scrollWidth <= el.clientWidth) return;
    const n = fullText.length;
    let lo = 1, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const first = Math.ceil(mid / 2);
      const last = mid - first;
      el.textContent = fullText.slice(0, first) + '…' + fullText.slice(n - last);
      if (el.scrollWidth <= el.clientWidth) lo = mid;
      else hi = mid - 1;
    }
    const first = Math.ceil(lo / 2);
    const last = lo - first;
    el.textContent = fullText.slice(0, first) + '…' + fullText.slice(n - last);
  }

  // Append the custom TAG line (a smaller second row under the name,
  // tmux-web "subtitle" style) when this session has one set. The tab's
  // height is unchanged — `.has-tag` switches the box to a column layout
  // with shrunk line-heights so name + tag both fit the fixed 28px. The
  // tag is purely cosmetic; the name line (and grouping/pins/dots) are
  // untouched. Call BEFORE appending the status dot so the dot overlays
  // the corner rather than flowing into the stack.
  function addTagLine(btn, session) {
    const tag = labelOf(session);
    if (!tag) return;
    btn.classList.add('has-tag');
    const el = document.createElement('span');
    el.className = 'ttvtab-tag';
    el.textContent = tag;
    btn.appendChild(el);
  }

  // labelText: display label (group-stripped, e.g. "1"); the tab's
  // title always carries the full session name so identity is never
  // ambiguous.
  function makeTabButton(pin, resolved, active, fitMode, labelText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ttvtab';
    if (fitMode) btn.classList.add('fit');
    if (!resolved) btn.classList.add('missing');
    else if (active && resolved.id === active.id) btn.classList.add('active');
    const session = pin.session || (resolved && resolved.session);
    const mk = markOf(session);
    if (mk) btn.classList.add('mark-' + mk);
    const label = document.createElement('span');
    label.className = 'ttvtab-label';
    // The name line is the group-stripped labelText (e.g. "16"), or the
    // full session name when ungrouped. The custom TAG is a separate
    // second line (addTagLine), never a replacement. title= always
    // carries the real session name.
    const fullText = labelText || pin.session || pin.id || '?';
    label.textContent = fullText;
    btn.title = pin.session || pin.id || '?';
    // Name + dot share one row (.ttvtab-head); mobile-cc-tab-menu appends its
    // ⋮ here too. The subtitle (addTagLine) goes BELOW the head.
    const head = document.createElement('div');
    head.className = 'ttvtab-head';
    head.appendChild(label);
    const dot = sessionDot(session);
    if (dot) head.appendChild(makeDotEl(dot));
    btn.appendChild(head);
    addTagLine(btn, session);
    attachTabGesture(btn, session, resolved && resolved.id, function() {
      if (resolved) tv.selectPane(resolved.id);
    });
    return { el: btn, label, fullText };
  }

  function makeAddButton(active, fitMode) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ttvtab ttvtab-add';
    if (fitMode) add.classList.add('fit');
    const label = document.createElement('span');
    label.className = 'ttvtab-label';
    const fullText = '+ ' + (active.session || active.id);
    label.textContent = fullText;
    add.appendChild(label);
    add.title = 'Pin current pane';
    add.tabIndex = -1;
    add.addEventListener('pointerup', function(e) {
      if (e.button !== undefined && e.button !== 0) return;
      pins.push({ id: active.id, session: active.session });
      savePins();
      render();
    });
    add.addEventListener('mousedown', function(e) { e.preventDefault(); });
    return { el: add, label, fullText };
  }

  // Rail icons — inline SVG, not emoji: identical on every device and
  // themeable via currentColor (the host accent, or --ttv-rail-accent if
  // an embedder sets one). Round caps/joins keep them friendly.
  //   all    — a 2×2 grid of sessions
  //   recent — a clock (MRU / most-recent-first)
  const RAIL_ICONS = {
    all: '<svg viewBox="0 0 18 18" width="18" height="18" fill="currentColor" aria-hidden="true">'
      + '<rect x="2" y="2" width="6" height="6" rx="1.6"/><rect x="10" y="2" width="6" height="6" rx="1.6"/>'
      + '<rect x="2" y="10" width="6" height="6" rx="1.6"/><rect x="10" y="10" width="6" height="6" rx="1.6"/></svg>',
    recent: '<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<circle cx="9" cy="9" r="6.5"/><path d="M9 5.2V9l2.6 1.7"/></svg>',
    pin: '<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M6.3 2.5h5.4M10.4 2.5l-.7 5 2.2 2.4H6.1l2.2-2.4-.7-5"/><path d="M9 9.9V15.5"/></svg>',
    label: '<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M11.4 3.1l3.5 3.5M12.6 1.9a1.65 1.65 0 0 1 2.3 2.3L5.5 13.6l-3.2.9.9-3.2z"/></svg>',
  };

  // Utility rail — mode buttons on the thumb-side edge. Each button
  // selects its mode (all / recent) and lights up while active; tapping
  // the lit one returns to pinned. The rail thus doubles as the mode
  // indicator. Pinned is "home" (both unlit).
  function makeRail(railEl, mode) {
    railEl.appendChild(makeRailButton('all', 'all', mode,
      mode === 'all' ? 'Back to pinned tabs' : 'Show all sessions'));
    railEl.appendChild(makeRailButton('recent', 'recent', mode,
      mode === 'recent' ? 'Back to pinned tabs' : 'Show recent sessions (most recent first)'));
    railEl.appendChild(makePinModeButton());
    railEl.appendChild(makeLabelModeButton());
  }

  // Pin-mode toggle — orthogonal to the all/recent view modes: it
  // overlays whatever view is active, turning every tab tap into a
  // pin/unpin. Lit while on; tap again (or tap empty slot area) to exit.
  function makePinModeButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ttvtab ttvtab-railbtn';
    if (pinMode) btn.classList.add('active');
    const label = document.createElement('span');
    label.className = 'ttvtab-label';
    label.innerHTML = RAIL_ICONS.pin || '';
    btn.appendChild(label);
    btn.title = pinMode ? 'Done pinning (tap tabs to pin/unpin)' : 'Pin / unpin tabs';
    btn.setAttribute('aria-label', btn.title);
    btn.tabIndex = -1;
    btn.addEventListener('pointerup', function(e) {
      if (e.button !== undefined && e.button !== 0) return;
      pinMode = !pinMode;
      if (pinMode) labelMode = false;   // one editing posture at a time
      render();
    });
    btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
    return btn;
  }

  // Label-mode toggle — sibling of pin mode: overlays whatever view is
  // active, turning every tab tap into an inline label edit. Lit while
  // on; tap again (or tap empty slot area) to exit. Mutually exclusive
  // with pin mode.
  function makeLabelModeButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ttvtab ttvtab-railbtn';
    if (labelMode) btn.classList.add('active');
    const label = document.createElement('span');
    label.className = 'ttvtab-label';
    label.innerHTML = RAIL_ICONS.label || '';
    btn.appendChild(label);
    btn.title = labelMode ? 'Done tagging (tap a tab to edit its tag)' : 'Edit tab tags';
    btn.setAttribute('aria-label', btn.title);
    btn.tabIndex = -1;
    btn.addEventListener('pointerup', function(e) {
      if (e.button !== undefined && e.button !== 0) return;
      labelMode = !labelMode;
      if (labelMode) pinMode = false;   // one editing posture at a time
      render();
    });
    btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
    return btn;
  }
  function makeRailButton(icon, targetMode, mode, title) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ttvtab ttvtab-railbtn';
    if (mode === targetMode) btn.classList.add('active');
    const label = document.createElement('span');
    label.className = 'ttvtab-label';
    label.innerHTML = RAIL_ICONS[icon] || '';
    btn.appendChild(label);
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.tabIndex = -1;
    btn.addEventListener('pointerup', function(e) {
      if (e.button !== undefined && e.button !== 0) return;
      logGeom('pre-toggle');
      settings.mode = (mode === targetMode) ? 'pinned' : targetMode;
      saveSettings();
      render();
      // Per-frame burst: catches transients the after-the-settle
      // measurements keep missing.
      let f = 0;
      (function burst() {
        logGeom('toggle+f' + f);
        if (++f < 8) requestAnimationFrame(burst);
      })();
    });
    btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
    return btn;
  }

  // The always-on recent row (A): a horizontally-scrollable strip of
  // the most-recently-used live sessions, newest first, with a leading
  // 🕘 marker. Returns null when there's nothing to show. Full session
  // names (not group-stripped) since recents cross groups; the pin
  // mark is suppressed (most recents are pinned — it'd be noise).
  // fitMode/max mirror the groups so recent tabs share the SAME
  // fit-width grid; placedTabs (optional) collects fit tabs for the
  // caller's middle-ellipsis pass. The row keeps a single horizontal
  // scroll (more recents than fit just scroll), so tab WIDTH matches a
  // group tab while still showing the full MRU list.
  function buildRecentRow(panes, active, fitMode, max, placedTabs) {
    const recentRows = recentRowsVal();
    const multiRow = recentWrapOn();
    const cap = multiRow ? RECENT_ROW_MAX_MULTI : RECENT_ROW_MAX;
    const live = liveRecents(panes, true).slice(0, cap);
    if (!live.length) return null;
    const collapsed = !!settings.recentCollapsed;

    // The recents now read as a real group: a collapsible header bar
    // (.ttvtab-ghead, same control as the project groups) above the tab
    // strip, both inside a bracketed band (.ttvtab-recentgroup). The
    // muted bracket + 🕘 dot mark it as the recent band vs the
    // per-project colored group brackets.
    const group = document.createElement('div');
    group.className = 'ttvtab-group ttvtab-recentgroup';

    const head = document.createElement('div');
    head.setAttribute('role', 'button');
    head.className = 'ttvtab-ghead ttvtab-rhead';
    const caret = document.createElement('span');
    caret.className = 'ttvtab-gcaret';
    caret.textContent = collapsed ? '▸' : '▾';
    const dot = document.createElement('span');
    dot.className = 'ttvtab-gdot';
    const nm = document.createElement('span');
    nm.className = 'ttvtab-gname';
    nm.textContent = 'Recent';
    const cnt = document.createElement('span');
    cnt.className = 'ttvtab-gcount';
    cnt.textContent = String(live.length);
    head.appendChild(caret);
    head.appendChild(dot);
    head.appendChild(nm);
    head.appendChild(cnt);
    head.title = (collapsed ? 'Expand' : 'Collapse') + ' recent sessions ('
      + live.length + ')';
    head.tabIndex = -1;
    // Tap = collapse/expand (recents isn't reorderable, so no move mode).
    head.addEventListener('pointerup', function(e) {
      if (e.button !== undefined && e.button !== 0) return;
      settings.recentCollapsed = !collapsed;
      saveSettings();
      render();
    });
    head.addEventListener('mousedown', function(e) { e.preventDefault(); });
    group.appendChild(head);

    if (collapsed) return group;

    const row = document.createElement('div');
    row.className = 'ttvtab-recentrow' + (multiRow ? ' multirow' : '');
    row.title = 'Recently used sessions';
    if (fitMode) row.style.setProperty('--ttv-max-per-row', String(max));
    for (const p of live) {
      const made = makeSessionButton(p, active, fitMode, { noPinMark: true });
      row.appendChild(made.el);
      if (fitMode && placedTabs && made.label) placedTabs.push(made);
    }
    group.appendChild(row);
    return group;
  }

  // All-sessions / recent-mode / recent-row tab. Tap switches;
  // long-press toggles the pin. opts.noPinMark suppresses the 📌
  // indicator (used in the recent row, where it's just noise).
  function makeSessionButton(pane, active, fitMode, opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ttvtab';
    if (fitMode) btn.classList.add('fit');
    if (active && active.session === pane.session) btn.classList.add('active');
    const label = document.createElement('span');
    label.className = 'ttvtab-label';
    // Name line is the real session name; the custom TAG (if any) is a
    // separate second line (addTagLine), never a replacement.
    const fullText = pane.session || pane.id || '?';
    label.textContent = fullText;
    // Name + (pin mark) + dot share one row (.ttvtab-head); mobile-cc-tab-menu
    // appends its ⋮ here too. The subtitle (addTagLine) goes BELOW the head.
    const head = document.createElement('div');
    head.className = 'ttvtab-head';
    head.appendChild(label);
    const isPinned = !!pins.find(p => p.session === pane.session);
    // Suppress the 📌 pin mark when a tag is shown — in the two-line
    // column layout it would land on its own row between name and tag.
    if (isPinned && !(opts && opts.noPinMark) && !labelOf(pane.session)) {
      const mark = document.createElement('span');
      mark.className = 'ttvtab-pinmark';
      mark.textContent = '📌';
      head.appendChild(mark);
    }
    btn.title = fullText + (pinMode
      ? (isPinned ? ' (tap to unpin)' : ' (tap to pin)')
      : ' (press & hold to mark todo/done)');
    const mk = markOf(pane.session);
    if (mk) btn.classList.add('mark-' + mk);
    const dot = sessionDot(pane.session);
    if (dot) head.appendChild(makeDotEl(dot));
    btn.appendChild(head);
    addTagLine(btn, pane.session);

    attachTabGesture(btn, pane.session, pane.id, function() {
      // Keep the user's actual pane when it's already in this session.
      tv.selectPane(active && active.session === pane.session ? active.id : pane.id);
    });
    return { el: btn, label, fullText };
  }

  // Inline TAG editor (label mode). Keeps the name line on top and puts
  // a text input where the tag (second line) goes, prefilled with the
  // current tag. Enter / blur commits; Escape cancels; an empty value
  // CLEARS the tag. Stays in label mode so several tabs can be tagged in
  // a row. The input stops its own pointer/click events from bubbling so
  // the tab gesture and slot scroll don't hijack typing.
  function startInlineEdit(btn, session) {
    if (btn.querySelector('.ttvtab-tagedit')) return;   // already editing this tab
    const labelEl = btn.querySelector('.ttvtab-label');
    if (!labelEl) return;
    editingActive = true;   // freeze background re-renders until commit/cancel
    // Switch to the two-line stack (name on top, input below) and drop
    // any existing static tag span so the input takes its place.
    btn.classList.add('has-tag', 'tag-editing');
    const oldTag = btn.querySelector('.ttvtab-tag');
    if (oldTag) oldTag.remove();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ttvtab-tagedit';
    input.value = labelOf(session) || '';
    input.placeholder = 'tag…';
    input.setAttribute('aria-label', 'Tag for ' + session);
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;
    // Tag line sits after the name; the status dot is corner-absolute so
    // appending at the end keeps name → input order.
    const dotEl = btn.querySelector('.ttvtab-dot');
    if (dotEl) btn.insertBefore(input, dotEl); else btn.appendChild(input);
    ['pointerdown', 'pointerup', 'click', 'mousedown'].forEach(function(t) {
      input.addEventListener(t, function(e) { e.stopPropagation(); });
    });
    let done = false;
    function commit(save) {
      if (done) return;
      done = true;
      editingActive = false;   // unfreeze BEFORE render() so it actually repaints
      if (save) setLabel(session, input.value.trim());   // empty → clears the tag
      render();   // rebuilds the slot; the (possibly stale) input is discarded
    }
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', function() { commit(true); });
    // Focus + select once it's in the DOM (mobile keyboards need this
    // after attach, not synchronously).
    requestAnimationFrame(function() { input.focus(); input.select(); });
  }

  // Tap + staged todo/done hold gesture (tmux-web "cycle" model). A
  // short tap switches pane (or pins, in pin mode). Holding past
  // markDelay() runs stage 1; keep holding another markDelay() to
  // promote to stage 2 — one continuous press:
  //   from none → todo (pink) → done (green)
  //   from todo → none        → done (green)
  //   from done → none        → todo (pink)
  // Captured `before` (mark at press start) drives both stages so the
  // sequence is deterministic regardless of timing jitter.
  function attachTabGesture(btn, session, paneId, onTap) {
    if (session) btn.dataset.session = session;
    let t1 = null, t2 = null, acted = false, startX = 0, startY = 0;
    let armed = false;   // true once the mark-hold timer is armed on this press
    let startedOnPassthrough = false;   // press began on a [data-tab-passthrough]
                                        // child (e.g. the ⋮ menu button): hold-to-
                                        // mark still works (events bubble here), but
                                        // a quick TAP must not switch panes — that
                                        // child owns the tap (opens its own menu).
    let tDown = 0;   // performance.now() at pointerdown — timing baseline
    function now() { try { return performance.now(); } catch (_) { return 0; } }
    // Gesture telemetry → diag.jsonl (cat 'mark-gesture'). Each record
    // carries `sinceDown` so we can see whether a stage fired late: if a
    // stage's sinceDown ≫ its scheduled delay, the setTimeout was
    // throttled (main thread busy rendering CC output) — that's the
    // "sometimes a delay" smell, distinct from a drift-cancel.
    function gd(phase, extra) {
      if (typeof window.ttvDiag !== 'function') return;
      window.ttvDiag('mark-gesture', Object.assign(
        { phase: phase, session: session, sinceDown: Math.round(now() - tDown) }, extra || {}));
    }
    function clearTimers() {
      if (t1) { clearTimeout(t1); t1 = null; }
      if (t2) { clearTimeout(t2); t2 = null; }
    }
    function haptic() { try { if (navigator.vibrate) navigator.vibrate(35); } catch (_) {} }
    function endQuiet() {
      clearTimers(); hideMarkBubble();
      if (acted) { acted = false; const r0 = now(); render(); gd('end-render', { renderMs: Math.round(now() - r0) }); }
    }
    btn.addEventListener('pointerdown', function(e) {
      acted = false;
      armed = false;
      startX = e.clientX; startY = e.clientY;
      startedOnPassthrough = !!(e.target && e.target.closest && e.target.closest('[data-tab-passthrough]'));
      tDown = now();
      clearTimers();
      // Pin mode owns the tap (pin/unpin); don't also arm marking.
      if (!marksOn() || !session || pinMode || labelMode) return;
      armed = true;   // marking is in play — a deliberate hold must not select
      const delay = markDelay();
      const before = marks[session] || '';
      gd('down', { delay: delay, before: before || null });
      t1 = setTimeout(function() {
        t1 = null;
        acted = true;
        const s1 = before ? '' : 'todo';   // had a color → clear; else pink
        const w0 = now();
        setMark(session, s1);
        applyStripe(btn, s1);
        showMarkBubble(btn, s1);
        haptic();
        gd('stage1', { mark: s1 || null, delay: delay, lateMs: Math.round((now() - tDown) - delay), workMs: Math.round(now() - w0) });
        t2 = setTimeout(function() {
          t2 = null;
          const s2 = (before === 'done') ? 'todo' : 'done';   // promote
          const w1 = now();
          setMark(session, s2);
          applyStripe(btn, s2);
          showMarkBubble(btn, s2);
          haptic();
          gd('stage2', { mark: s2 || null, delay: delay, lateMs: Math.round((now() - tDown) - 2 * delay), workMs: Math.round(now() - w1) });
        }, delay);
      }, delay);
    });
    btn.addEventListener('pointermove', function(e) {
      if (!(t1 || t2)) return;
      // Cancel only when the finger LEAVES the tab (+ a margin), not on
      // in-tab jitter. Distance-from-origin drift was too twitchy: a small
      // move at the start of a hold on a wide tab exceeded MARK_DRIFT_PX
      // while still on the tab, killing the gesture. pointerleave is
      // unreliable for touch (implicit pointer capture keeps the target),
      // so we test the pointer against the tab's own rect here. A real
      // scroll moves the finger off the tab and still cancels.
      const r = btn.getBoundingClientRect();
      const m = MARK_DRIFT_PX;
      const inside = e.clientX >= r.left - m && e.clientX <= r.right + m &&
                     e.clientY >= r.top - m && e.clientY <= r.bottom + m;
      if (!inside) {
        gd('drift-cancel', { dx: Math.round(e.clientX - startX), dy: Math.round(e.clientY - startY) });
        endQuiet();   // left the tab → scroll/drift cancels (keeps any applied stage)
      }
    });
    btn.addEventListener('pointerup', function(e) {
      clearTimers();
      hideMarkBubble();
      if (acted) { acted = false; const r0 = now(); render(); gd('up-render', { renderMs: Math.round(now() - r0) }); return; }   // a mark fired → sync duplicates, not a tap
      if (e.button !== undefined && e.button !== 0) return;
      // Deliberate hold released early (mark armed but no stage fired): the
      // user was trying to change the dot, not switch tabs. Swallow it so it
      // doesn't select the pane and bump it to the front of the recent row.
      const heldMs = Math.round(now() - tDown);
      if (armed && heldMs >= HOLD_SUPPRESS_MS) { gd('hold-cancel', { heldMs: heldMs }); return; }
      // Quick tap that began on a pass-through child (the ⋮ menu button):
      // that child's own click opens its menu — don't ALSO switch panes. A
      // hold over the ⋮ still cycled the mark above (acted), so only the
      // quick-tap select is suppressed here. This is what lets the dot/mark
      // press-and-hold work across the WHOLE tab incl. the ⋮ area.
      if (startedOnPassthrough) { gd('passthrough-tap', {}); return; }
      gd('tap', {});
      if (labelMode) { if (session) startInlineEdit(btn, session); return; }
      if (pinMode) { togglePin(session, paneId); return; }
      if (onTap) onTap();
    });
    btn.addEventListener('pointerleave',  endQuiet);
    btn.addEventListener('pointercancel', endQuiet);
    btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
    btn.tabIndex = -1;
  }

  // ---- contributions ----
  tv.contributes.tabBar({
    id: 'ttyview-tabs',
    name: 'Pinned Tabs',
    // Bottom of the screen by the thumb (the tmux-web arrangement);
    // the user can move it via Settings → Layout.
    preferredSlot: 'above-input',
    render: function(slot) {
      ensureStyles();
      mountedSlot = slot;
      mountedSlotInitial = slot.style.cssText;

      const off1 = tv.on('pane-changed',  render);
      const off2 = tv.on('panes-updated', render);

      // Tapping empty area of the tab slot (not a tab, not the rail)
      // exits pin / label mode — the natural "I'm done editing" gesture.
      slot.addEventListener('click', function(e) {
        if ((pinMode || labelMode) && !e.target.closest('.ttvtab')) {
          pinMode = false;
          labelMode = false;
          render();
        }
      });

      // Move mode dismisses on a tap ANYWHERE outside a group header —
      // document-level because the natural "put it away" tap is on the
      // terminal, not inside the tab slot.
      function onDocClick(e) {
        if (movingGroup !== null && !e.target.closest('.ttvtab-ghead')) {
          movingGroup = null;
          render();
        }
      }
      document.addEventListener('click', onDocClick);

      // Status-dot freshness: poll /panes while mounted + visible,
      // and immediately on returning to the foreground (the phone
      // resume path — intervals were clamped/frozen while hidden).
      dotPollTimer = setInterval(pollDots, DOT_POLL_MS);
      document.addEventListener('visibilitychange', onVisibilityPoll);

      // Seed the MRU with the session you're currently in, so the
      // recent row isn't empty before your first pane switch.
      const seed = tv.getActivePane();
      if (seed) noteRecent(seed.session);

      render();
      return function unmount() {
        off1(); off2();
        editingActive = false;   // never carry a frozen-render flag across mounts
        clearInterval(dotPollTimer);
        dotPollTimer = null;
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('visibilitychange', onVisibilityPoll);
        if (mountedSlot && parentTouched && mountedSlot.parentNode) {
          mountedSlot.parentNode.classList.remove('ttv-stacked-slot');
        }
        parentTouched = false;
        mountedSlot = null;
        contentEl = null;
      };
    },
  });

  tv.contributes.settingsTab({
    id: 'ttyview-tabs',
    title: 'Pinned Tabs',
    render: function(container) {
      // Always re-read state on settings-open (cheap; aligns with how
      // the Pane Picker plugin treats its settings tab).
      settings = Object.assign({}, DEFAULTS, storage.get(SETTINGS_KEY) || {});

      container.innerHTML = '';
      const intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
      intro.textContent = 'Customize the pinned tabs area. Tabs are grouped by project (derived from session names). State is per-browser (localStorage). Changes apply immediately.';
      container.appendChild(intro);

      function makeRow(label, hint) {
        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom:14px;';
        const lbl = document.createElement('label');
        lbl.style.cssText = 'display:block;font-size:12px;color:var(--ttv-muted);margin-bottom:6px;';
        lbl.textContent = label;
        row.appendChild(lbl);
        if (hint) {
          const h = document.createElement('div');
          h.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-bottom:6px;';
          h.textContent = hint;
          row.appendChild(h);
        }
        return row;
      }
      function btn(text) {
        const b = document.createElement('button');
        b.textContent = text;
        b.style.cssText = 'background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);border-radius:4px;cursor:pointer;font-size:12px;padding:6px 12px;margin-right:6px;';
        return b;
      }

      // Pin all current sessions (+ clear)
      const r1 = makeRow('Bulk actions', null);
      const pinAll = btn('Pin all current sessions');
      pinAll.addEventListener('click', function() {
        const panes = tv.listPanes();
        // Dedupe by session name; one pin per unique session.
        const seen = new Set(pins.map(p => p.session));
        const uniqueSessions = new Set();
        for (const p of panes) {
          if (!seen.has(p.session) && !uniqueSessions.has(p.session)) {
            uniqueSessions.add(p.session);
            pins.push({ id: p.id, session: p.session });
          }
        }
        savePins();
        render();
        statusEl.textContent = 'Pinned ' + uniqueSessions.size + ' new session' + (uniqueSessions.size === 1 ? '' : 's') + '. Total: ' + pins.length;
      });
      const clear = btn('Clear all pins');
      clear.addEventListener('click', function() {
        if (!confirm('Remove all ' + pins.length + ' pinned tabs?')) return;
        pins = [];
        savePins();
        render();
        statusEl.textContent = 'Cleared.';
      });
      r1.appendChild(pinAll);
      r1.appendChild(clear);
      const statusEl = document.createElement('div');
      statusEl.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:6px;';
      statusEl.textContent = pins.length + ' pin' + (pins.length === 1 ? '' : 's') + ' currently.';
      r1.appendChild(statusEl);
      container.appendChild(r1);

      // Expand all groups (recovery action; group state is otherwise
      // managed from the headers themselves).
      const rG = makeRow('Groups', 'Groups derive from session names (mcc1 → "mcc"). Tap a group header to collapse/expand it; long-press a header to reorder groups with ▲▼.');
      const expandAll = btn('Expand all groups');
      expandAll.addEventListener('click', function() {
        for (const k of Object.keys(groupsCfg)) {
          if (groupsCfg[k]) delete groupsCfg[k].collapsed;
        }
        saveGroups();
        render();
      });
      rG.appendChild(expandAll);
      container.appendChild(rG);

      // Recent tabs row (A) + the 🕘 rail mode (B)
      const rR = makeRow('Recent tabs', 'A strip of your most recently used sessions (newest first) sits above the groups — one tap to jump back, across projects. The 🕘 button on the rail opens a full recent-only view. Recency is tracked across your devices.');
      const recLbl = document.createElement('label');
      recLbl.style.cssText = 'display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ttv-fg);cursor:pointer;';
      const recChk = document.createElement('input');
      recChk.type = 'checkbox';
      recChk.checked = settings.recentRow !== false;
      recChk.addEventListener('change', function() {
        settings.recentRow = recChk.checked;
        saveSettings();
        render();
      });
      recLbl.appendChild(recChk);
      recLbl.appendChild(document.createTextNode('Show recent tabs row'));
      rR.appendChild(recLbl);
      // Recent-area HEIGHT, in tab-rows — a − / + stepper with HALF-row
      // resolution. Using it turns on recentWrap, so the recents wrap into a
      // vertical-scrolling grid: even at 1 row tall you scroll DOWN for older
      // sessions, and a half-row (1.5 / 2.5 …) leaves a peek of the next row
      // as a scroll hint. (Replaces the old integer "rows" field.)
      const recHWrap = document.createElement('div');
      recHWrap.style.cssText = 'margin-top:12px;';
      const recHLbl = document.createElement('div');
      recHLbl.style.cssText = 'font-size:13px;color:var(--ttv-fg);margin-bottom:6px;';
      recHLbl.textContent = 'Recent area height (scrolls vertically)';
      recHWrap.appendChild(recHLbl);
      const recHCtl = document.createElement('div');
      recHCtl.style.cssText = 'display:flex;align-items:center;gap:8px;';
      function recStepBtn(txt) {
        const b = document.createElement('button');
        b.type = 'button'; b.tabIndex = -1; b.textContent = txt;
        b.style.cssText = 'width:42px;height:42px;font-size:22px;line-height:1;background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);border-radius:8px;cursor:pointer;';
        b.addEventListener('mousedown', function(e) { e.preventDefault(); });
        return b;
      }
      const recMinus = recStepBtn('−');
      const recReadout = document.createElement('div');
      recReadout.style.cssText = 'min-width:64px;text-align:center;font-size:15px;color:var(--ttv-fg);';
      const recPlus = recStepBtn('+');
      function recPaint() {
        const n = recentRowsVal();
        recReadout.textContent = (Math.round(n * 2) / 2) + (n === 1 ? ' row' : ' rows');
      }
      function recCommit(n) {
        n = Math.max(1, Math.min(6, Math.round(n * 2) / 2));
        settings.recentRows = n;
        settings.recentWrap = true;   // the height stepper implies the vertical-scroll grid
        saveSettings(); recPaint(); render();
      }
      recMinus.addEventListener('click', function() { recCommit(recentRowsVal() - 0.5); });
      recPlus.addEventListener('click', function() { recCommit(recentRowsVal() + 0.5); });
      recHCtl.appendChild(recMinus); recHCtl.appendChild(recReadout); recHCtl.appendChild(recPlus);
      recHWrap.appendChild(recHCtl);
      const recHint = document.createElement('div');
      recHint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:6px;';
      recHint.textContent = 'Half-row steps. Recents wrap and scroll vertically; a half row leaves a peek of the next as a scroll hint.';
      recHWrap.appendChild(recHint);
      recPaint();
      rR.appendChild(recHWrap);
      container.appendChild(rR);

      // Rows
      const r2 = makeRow('Number of rows', 'Visible height of the tab area, in tab-rows (needs Tabs per row > 0). Fewer tabs still reserve this height; more tabs scroll vertically within it.');
      const rowsInp = document.createElement('input');
      rowsInp.type = 'number'; rowsInp.min = '1'; rowsInp.max = '5';
      rowsInp.value = String(settings.rows);
      rowsInp.style.cssText = 'background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);border-radius:4px;font:inherit;font-size:14px;padding:6px 10px;width:80px;';
      rowsInp.addEventListener('change', function() {
        const n = Math.max(1, Math.min(5, parseInt(rowsInp.value, 10) || 1));
        settings.rows = n; rowsInp.value = String(n);
        saveSettings(); render();
      });
      r2.appendChild(rowsInp);
      container.appendChild(r2);

      // Status dots
      const rD = makeRow('Status dots', 'Per-session dot on each tab: amber pulsing = Claude Code waiting on a permission prompt, blue pulsing = producing output, orange = finished since you last viewed it. Collapsed groups show their strongest member dot.');
      const dotsLbl = document.createElement('label');
      dotsLbl.style.cssText = 'display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ttv-fg);cursor:pointer;';
      const dotsChk = document.createElement('input');
      dotsChk.type = 'checkbox';
      dotsChk.checked = settings.dots !== false;
      dotsChk.addEventListener('change', function() {
        settings.dots = dotsChk.checked;
        saveSettings();
        if (settings.dots) pollDots();
        render();
      });
      dotsLbl.appendChild(dotsChk);
      dotsLbl.appendChild(document.createTextNode('Show status dots'));
      rD.appendChild(dotsLbl);
      container.appendChild(rD);

      // Manual todo/done marks
      const rM = makeRow('Todo / done marks', 'Press and hold any tab to mark it (tmux-web style): hold one step to set/clear, keep holding to advance — none → todo (pink) → done (green). Release to lock. Shown as a stripe on the tab’s left edge, synced across your devices. (Pin / unpin now lives on the pushpin button on the rail.)');
      const mkLbl = document.createElement('label');
      mkLbl.style.cssText = 'display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ttv-fg);cursor:pointer;';
      const mkChk = document.createElement('input');
      mkChk.type = 'checkbox';
      mkChk.checked = settings.marks !== false;
      mkChk.addEventListener('change', function() {
        settings.marks = mkChk.checked;
        saveSettings();
        render();
      });
      mkLbl.appendChild(mkChk);
      mkLbl.appendChild(document.createTextNode('Enable todo / done marks'));
      rM.appendChild(mkLbl);
      const clearMarks = btn('Clear all marks');
      clearMarks.style.marginLeft = '10px';
      clearMarks.addEventListener('click', function() {
        const n = Object.keys(marks).length;
        if (!n) return;
        if (!confirm('Clear all ' + n + ' mark' + (n === 1 ? '' : 's') + '?')) return;
        marks = {};
        saveMarks();
        render();
      });
      rM.appendChild(clearMarks);
      // Hold time per stage (governs both the initial press and the
      // promote-to-next interval), mirroring tmux-web's single knob.
      const delayWrap = document.createElement('div');
      delayWrap.style.cssText = 'margin-top:10px;display:flex;align-items:center;gap:8px;';
      const delayLbl = document.createElement('span');
      delayLbl.style.cssText = 'font-size:12px;color:var(--ttv-muted);';
      delayLbl.textContent = 'Hold time per step (ms)';
      const delayInp = document.createElement('input');
      delayInp.type = 'number'; delayInp.min = '150'; delayInp.max = '2000'; delayInp.step = '50';
      delayInp.value = String(markDelay());
      delayInp.style.cssText = 'background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);border-radius:4px;font:inherit;font-size:14px;padding:6px 10px;width:90px;';
      delayInp.addEventListener('change', function() {
        const n = Math.max(150, Math.min(2000, parseInt(delayInp.value, 10) || 500));
        settings.markDelay = n; delayInp.value = String(n);
        saveSettings();
      });
      delayWrap.appendChild(delayLbl);
      delayWrap.appendChild(delayInp);
      rM.appendChild(delayWrap);
      // Mark popup — a floating state indicator above the tab while you
      // hold (your finger covers the stripe). On by default.
      const popWrap = document.createElement('div');
      popWrap.style.cssText = 'margin-top:10px;';
      const popLbl = document.createElement('label');
      popLbl.style.cssText = 'display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ttv-fg);cursor:pointer;';
      const popChk = document.createElement('input');
      popChk.type = 'checkbox';
      popChk.checked = settings.markPopup !== false;
      popChk.addEventListener('change', function() {
        settings.markPopup = popChk.checked;
        saveSettings();
      });
      popLbl.appendChild(popChk);
      popLbl.appendChild(document.createTextNode('Show state popup above tab while holding'));
      popWrap.appendChild(popLbl);
      rM.appendChild(popWrap);
      container.appendChild(rM);

      // Custom tab labels (cosmetic alias)
      const rL = makeRow('Tab tags', 'Tap the ✎ button on the rail to enter tag mode, then tap a tab to add a small note shown on a second line under the tab name (tmux-web style). Tags are cosmetic — the real tmux session keeps its name, so grouping and pins are unaffected. Clear a tag by emptying the field. Synced across your devices.');
      const labelCount = btn('Clear all tags');
      labelCount.addEventListener('click', function() {
        const n = Object.keys(labels).length;
        if (!n) return;
        if (!confirm('Clear all ' + n + ' tag' + (n === 1 ? '' : 's') + '?')) return;
        labels = {};
        saveLabels();
        render();
        labelStatus.textContent = 'Cleared.';
      });
      rL.appendChild(labelCount);
      const labelStatus = document.createElement('div');
      labelStatus.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:6px;';
      const ln = Object.keys(labels).length;
      labelStatus.textContent = ln + ' tag' + (ln === 1 ? '' : 's') + ' set.';
      rL.appendChild(labelStatus);
      container.appendChild(rL);

      // Max per row
      const r3 = makeRow('Tabs per row', 'How many tabs each row holds, distributed equally with no horizontal overflow; long names truncate with middle-ellipsis (start…end). 0 = unlimited (single horizontal scroll per row).');
      const maxInp = document.createElement('input');
      maxInp.type = 'number'; maxInp.min = '0'; maxInp.max = '50';
      maxInp.value = String(settings.maxPerRow);
      maxInp.style.cssText = rowsInp.style.cssText;
      maxInp.addEventListener('change', function() {
        const n = Math.max(0, Math.min(50, parseInt(maxInp.value, 10) || 0));
        settings.maxPerRow = n; maxInp.value = String(n);
        saveSettings(); render();
      });
      r3.appendChild(maxInp);
      container.appendChild(r3);

      // Tab height
      const r4 = makeRow('Tab height (px)', 'Height of each tab, group header, and rail button. 28 is the default; 20–72 allowed. Bigger = easier touch targets (more vertical space used); smaller = more tabs visible at once.');
      const hInp = document.createElement('input');
      hInp.type = 'number'; hInp.min = '20'; hInp.max = '72'; hInp.step = '2';
      hInp.value = String(tabHeight());
      hInp.style.cssText = rowsInp.style.cssText;
      hInp.addEventListener('change', function() {
        const n = Math.max(20, Math.min(72, parseInt(hInp.value, 10) || 28));
        settings.tabHeight = n; hInp.value = String(n);
        saveSettings(); render();
      });
      r4.appendChild(hInp);
      container.appendChild(r4);
    },
  });
})();
