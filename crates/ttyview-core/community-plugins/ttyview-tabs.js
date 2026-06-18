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
// side) with two mode buttons: ▦ = all sessions (every tmux session,
// alphabetical), 🕘 = recent (MRU, most-recent first). Tap to switch
// into the mode; tap the lit one to return to pinned. In both modes,
// tap a tab to switch, long-press to pin/unpin.
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
  const LONG_PRESS_MS = 500;
  const DEFAULTS = { rows: 1, maxPerRow: 0, mode: 'pinned', dots: true, recentRow: true };  // maxPerRow 0 = unlimited per row
  const RECENTS_KEY = 'recents';
  const RECENT_ROW_MAX = 12;    // tabs shown in the always-on recent row
  const RECENT_STORE_MAX = 30;  // MRU entries kept in storage
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
  let editingId = null;
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
           jump on every toggle (caught via tabs-geom diag records). */
        height: 28px;
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
        height: 28px;
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
      }
      /* ---- recent row (A) ---- */
      .ttvtab-recentrow {
        display: flex; gap: 4px; align-items: center;
        flex: none;
        overflow-x: auto; scrollbar-width: none;
        /* A tray, visually distinct from the groups: darker, with a
           hairline separating it from the area below. */
        background: var(--ttv-bg-elev);
        border-bottom: 1px solid var(--ttv-border);
        /* Match a group's left inset (3px bracket + 6px) EXACTLY so
           recent tabs share the groups' fit-width grid AND align to
           the same left column. A muted bracket marks the recent band
           (vs the per-project colored group brackets). */
        border-left: 3px solid var(--ttv-muted);
        padding: 0 0 5px 6px;
      }
      .ttvtab-recentrow::-webkit-scrollbar { display: none; }
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
  function render() {
    if (!mountedSlot) return;
    const gen = ++renderGen;
    // Re-renders happen mid-interaction (pin/unpin, collapse,
    // panes-updated) — keep the user's scroll position instead of
    // jumping to the top.
    const prevScroll = contentEl ? contentEl.scrollTop : 0;
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
      if (rr) recentReserve = rr.offsetHeight + 4 /* leftCol row gap */;
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

  // labelText: display label (group-stripped, e.g. "1"); the tab's
  // title always carries the full session name so identity is never
  // ambiguous.
  function makeTabButton(pin, resolved, active, fitMode, labelText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ttvtab';
    if (fitMode) btn.classList.add('fit');
    if (editingId === pin.id) btn.classList.add('editing');
    if (!resolved) btn.classList.add('missing');
    else if (active && resolved.id === active.id) btn.classList.add('active');
    const label = document.createElement('span');
    label.className = 'ttvtab-label';
    const fullText = labelText || pin.session || pin.id || '?';
    label.textContent = fullText;
    btn.title = pin.session || pin.id || '?';
    btn.appendChild(label);
    const xs = document.createElement('span');
    xs.className = 'ttvtab-x';
    xs.textContent = '×';
    btn.appendChild(xs);
    const dot = sessionDot(pin.session || (resolved && resolved.session));
    if (dot) btn.appendChild(makeDotEl(dot));
    attachTapHandlers(btn, pin, resolved);
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

  // Utility rail — mode buttons on the thumb-side edge. Each button
  // selects its mode (▦ all, 🕘 recent) and lights up while active;
  // tapping the lit one returns to pinned. The rail thus doubles as
  // the mode indicator. Pinned is "home" (both unlit).
  function makeRail(railEl, mode) {
    railEl.appendChild(makeRailButton('▦', 'all', mode,
      mode === 'all' ? 'Back to pinned tabs' : 'Show all sessions'));
    railEl.appendChild(makeRailButton('🕘', 'recent', mode,
      mode === 'recent' ? 'Back to pinned tabs' : 'Show recent sessions (most recent first)'));
  }
  function makeRailButton(glyph, targetMode, mode, title) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ttvtab';
    if (mode === targetMode) btn.classList.add('active');
    const label = document.createElement('span');
    label.className = 'ttvtab-label';
    label.textContent = glyph;
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
    const live = liveRecents(panes, true).slice(0, RECENT_ROW_MAX);
    if (!live.length) return null;
    const row = document.createElement('div');
    row.className = 'ttvtab-recentrow';
    row.title = 'Recently used sessions';
    if (fitMode) row.style.setProperty('--ttv-max-per-row', String(max));
    for (const p of live) {
      const made = makeSessionButton(p, active, fitMode, { noPinMark: true });
      row.appendChild(made.el);
      if (fitMode && placedTabs && made.label) placedTabs.push(made);
    }
    return row;
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
    const fullText = pane.session || pane.id || '?';
    label.textContent = fullText;
    btn.appendChild(label);
    const isPinned = !!pins.find(p => p.session === pane.session);
    if (isPinned && !(opts && opts.noPinMark)) {
      const mark = document.createElement('span');
      mark.className = 'ttvtab-pinmark';
      mark.textContent = '📌';
      btn.appendChild(mark);
    }
    btn.title = fullText + (isPinned ? ' (pinned — long-press to unpin)' : ' (long-press to pin)');
    const dot = sessionDot(pane.session);
    if (dot) btn.appendChild(makeDotEl(dot));
    btn.tabIndex = -1;

    let pressTimer = null;
    let longPressed = false;
    function clearTimer() {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }
    btn.addEventListener('pointerdown', function() {
      longPressed = false;
      clearTimer();
      pressTimer = setTimeout(function() {
        longPressed = true;
        if (isPinned) {
          pins = pins.filter(p => p.session !== pane.session);
        } else {
          pins.push({ id: pane.id, session: pane.session });
        }
        savePins();
        render();
      }, LONG_PRESS_MS);
    });
    btn.addEventListener('pointerup', function(e) {
      clearTimer();
      if (longPressed) { longPressed = false; return; }
      if (e.button !== undefined && e.button !== 0) return;
      // Keep the user's actual pane when it's already in this session.
      tv.selectPane(active && active.session === pane.session ? active.id : pane.id);
    });
    btn.addEventListener('pointerleave',  function() { clearTimer(); longPressed = false; });
    btn.addEventListener('pointercancel', function() { clearTimer(); longPressed = false; });
    btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
    return { el: btn, label, fullText };
  }

  function attachTapHandlers(btn, pin, resolved) {
    let pressTimer = null;
    let longPressed = false;
    const pinKey = pin.id || pin.session;
    function diag(ev, extra) {
      if (typeof window.ttvDiag !== 'function') return;
      window.ttvDiag('tab-tap', Object.assign({ ev: ev, pin: pinKey, resolved: !!resolved }, extra || {}));
    }
    function clearTimer() {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }
    function startPress(e) {
      longPressed = false;
      clearTimer();
      diag('start', { ptr: e.pointerType });
      pressTimer = setTimeout(function() {
        longPressed = true;
        editingId = pinKey;
        diag('long-press');
        render();
      }, LONG_PRESS_MS);
    }
    function endPress(e) {
      clearTimer();
      if (longPressed) { longPressed = false; return; }
      if (editingId === pinKey) {
        pins = pins.filter(p => (p.id || p.session) !== pinKey);
        editingId = null;
        savePins();
        render();
        return;
      }
      if (editingId) { editingId = null; render(); return; }
      if (resolved) tv.selectPane(resolved.id);
    }
    btn.addEventListener('pointerdown',  function(e) { startPress(e); });
    btn.addEventListener('pointerup',    function(e) { endPress(e); });
    btn.addEventListener('pointerleave', function() { clearTimer(); longPressed = false; });
    btn.addEventListener('pointercancel', function() { clearTimer(); longPressed = false; });
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

      slot.addEventListener('click', function(e) {
        if (!e.target.closest('.ttvtab') && editingId !== null) {
          editingId = null;
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
      container.appendChild(rR);

      // Rows
      const r2 = makeRow('Number of rows', 'Visible height of the tab area, in tab-rows (needs Max tabs per row > 0). Fewer tabs still reserve this height; more tabs scroll vertically within it.');
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

      // Max per row
      const r3 = makeRow('Max tabs per row', 'When > 0, each row holds exactly this many tabs distributed equally with no horizontal overflow; long names truncate with middle-ellipsis (start…end). 0 = unlimited, single horizontal scroll.');
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
    },
  });
})();
