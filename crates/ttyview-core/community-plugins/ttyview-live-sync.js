// ttyview-live-sync — applies server-side /api/state changes to this
// browser live, without a reload.
//
// Why: /api/state is server-authoritative, but until this plugin the
// server's view only reached a browser at page load (hydrateServerState).
// This plugin refetches /api/state on a server WS nudge ('state-changed')
// and on each (re)connect, diffs against the last-seen snapshot, and
// re-applies whatever changed (it used to poll on a 1.5s timer — now
// event-driven, see the wiring at the bottom). Two things fall out of that:
//
//   1. An agent on the host (the `ttyview-ui` CLI in scripts/, or any
//      curl) can drive the UI — switch theme/view, rewrite the pinned
//      tabs, push a toast — and the phone updates within ~1.5 s.
//   2. Two browsers on the same daemon converge live: change the theme
//      on the phone, the laptop tab follows.
//
// Apply paths:
//   ttv-active-theme / ttv-active-view → _internal setters with
//     {persist:false} (restore semantics — never echo back a PUT).
//   ttv-plugin:<id>:<key>              → write the localStorage cache,
//     then emit 'storage-changed' {pluginId, key, value, source} so the
//     owning plugin reconciles (ttyview-tabs subscribes).
//   ttv-agent-cmd-queue                → one-shot commands (toasts).
//     Each entry is {seq, ts, action, ...}; a per-device cursor in
//     localStorage makes every command apply exactly once per device.
//     Transient commands older than 60 s are skipped (a phone that was
//     asleep shouldn't replay an hour of "build done"s); sticky ones
//     always show — "need your input" must survive the pocket.
//
// Loop safety: a change made IN this browser PUTs to the server and
// then comes back on the next poll. Every apply path first compares
// against the current localStorage value and no-ops when equal, so
// echoes never re-render.
(function () {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  const QUEUE_KEY = 'ttv-agent-cmd-queue';
  const CURSOR_KEY = 'ttv-live-sync-cursor'; // per-device, NOT synced
  const STALE_TRANSIENT_MS = 60 * 1000;
  const PLUGIN_PREFIX = 'ttv-plugin:';
  // Keys stored RAW in localStorage (registry ids, not JSON) — must
  // match __serverState.rawKeys in the core bundle.
  const RAW_KEYS = new Set(['ttv-active-theme', 'ttv-active-view']);

  function diag(cat, data) {
    try { if (typeof window.ttvDiag === 'function') window.ttvDiag(cat, data); } catch (_) {}
  }
  function log(msg) {
    try { if (typeof window.ttyviewLog === 'function') window.ttyviewLog('live-sync', msg); } catch (_) {}
  }

  // ---- localStorage helpers ------------------------------------------
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }

  function getCursor() {
    const raw = lsGet(CURSOR_KEY);
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  function setCursor(n) { lsSet(CURSOR_KEY, String(n)); }

  // ---- toast overlay ---------------------------------------------------
  let toastWrap = null;
  function ensureToastWrap() {
    if (toastWrap && toastWrap.isConnected) return toastWrap;
    toastWrap = document.createElement('div');
    toastWrap.id = 'ttv-live-sync-toasts';
    toastWrap.style.cssText =
      'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);' +
      'z-index:9000;display:flex;flex-direction:column;gap:8px;' +
      'align-items:center;pointer-events:none;max-width:92vw;';
    document.body.appendChild(toastWrap);
    return toastWrap;
  }
  function showToast(message, sticky) {
    const wrap = ensureToastWrap();
    const el = document.createElement('div');
    el.className = 'ttv-toast' + (sticky ? ' ttv-toast-sticky' : '');
    el.style.cssText =
      'pointer-events:auto;cursor:pointer;font:13px system-ui,sans-serif;' +
      'background:var(--ttv-bg-elev2, #2a2a2e);color:var(--ttv-fg, #e6e6e6);' +
      'border:1px solid ' + (sticky ? 'var(--ttv-accent, #4a9eff)' : 'var(--ttv-border, #3a3a3e)') + ';' +
      'border-radius:8px;padding:10px 14px;max-width:92vw;overflow-wrap:break-word;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.45);transition:opacity .3s;';
    el.textContent = sticky ? message + '  ✕' : message;
    el.addEventListener('click', function () { el.remove(); });
    wrap.appendChild(el);
    if (!sticky) {
      setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 350);
      }, 4000);
    }
    diag('live-sync-toast', { sticky: !!sticky, len: (message || '').length });
  }

  // ---- queue drain -----------------------------------------------------
  function drainQueue(queue) {
    if (!Array.isArray(queue) || queue.length === 0) {
      // Seeing an empty/absent queue still initializes the cursor —
      // otherwise the first real command later looks like "history
      // from before this device existed" and gets skipped.
      if (getCursor() === null) setCursor(0);
      return;
    }
    const sorted = queue.slice().sort(function (a, b) { return (a.seq | 0) - (b.seq | 0); });
    const maxSeq = sorted[sorted.length - 1].seq | 0;
    let cursor = getCursor();
    if (cursor === null) {
      // First time this device sees the queue — don't replay history.
      setCursor(maxSeq);
      return;
    }
    const now = Date.now();
    for (const cmd of sorted) {
      if (!cmd || (cmd.seq | 0) <= cursor) continue;
      cursor = cmd.seq | 0;
      const stale = cmd.ts && now - cmd.ts > STALE_TRANSIENT_MS;
      if (cmd.action === 'toast') {
        if (stale && !cmd.sticky) continue;
        showToast(String(cmd.message || ''), !!cmd.sticky);
        log('toast: ' + cmd.message);
      }
      // Unknown actions skip silently but still advance the cursor —
      // a newer CLI must not wedge an older client.
    }
    setCursor(cursor);
  }

  // ---- apply paths -----------------------------------------------------
  function applyRawKey(key, value) {
    // value: string | undefined (undefined = deleted server-side)
    const want = typeof value === 'string' ? value : null;
    if (lsGet(key) === want || (want === null && lsGet(key) === null)) return;
    if (want === null) lsDel(key); else lsSet(key, want);
    const internal = tv._internal;
    if (key === 'ttv-active-theme') {
      // Unregistered theme id: localStorage is set, the core's
      // theme-registered hook applies it when the plugin lands.
      if (want === null || internal.registries.theme.has(want)) {
        internal.setActiveThemeId(want, { persist: false });
      }
      log('theme → ' + (want || 'default'));
    } else if (key === 'ttv-active-view') {
      // Guard: mounting an unregistered view would blank the host.
      if (want === null || internal.registries.terminalView.has(want)) {
        internal.setActiveTerminalViewId(want, { persist: false });
      }
      log('view → ' + (want || 'default'));
    }
    diag('live-sync-apply', { key: key, value: want });
  }

  function applyPluginKey(key, value) {
    // key = ttv-plugin:<pluginId>:<subkey>; value undefined = deleted.
    const rest = key.slice(PLUGIN_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep < 1) return;
    const pluginId = rest.slice(0, sep);
    const subkey = rest.slice(sep + 1);
    const wantStr = value === undefined ? null : JSON.stringify(value);
    if (lsGet(key) === wantStr) return; // echo of our own write
    if (wantStr === null) lsDel(key); else lsSet(key, wantStr);
    tv._internal.emit('storage-changed', {
      pluginId: pluginId,
      key: subkey,
      value: value === undefined ? null : value,
      source: 'live-sync',
    });
    diag('live-sync-apply', { key: key });
    log('storage ' + pluginId + ':' + subkey + ' updated');
  }

  function applyDiff(prev, next) {
    const all = new Set(Object.keys(prev).concat(Object.keys(next)));
    for (const k of all) {
      if (k === QUEUE_KEY) continue; // queue is cursor-driven, not diffed
      const a = prev[k];
      const b = next[k];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      if (RAW_KEYS.has(k)) applyRawKey(k, b);
      else if (k.indexOf(PLUGIN_PREFIX) === 0) applyPluginKey(k, b);
    }
  }

  // ---- poll loop -------------------------------------------------------
  let last = null;       // last-seen keys snapshot; null until first fetch
  let inFlight = false;

  async function syncNow() {
    if (inFlight) return false;
    inFlight = true;
    try {
      let resp;
      try { resp = await fetch('/api/state', { cache: 'no-store' }); }
      catch (_) { return false; }
      if (!resp.ok) return false;
      let body;
      try { body = await resp.json(); } catch (_) { return false; }
      const keys = (body && body.keys) || {};
      // First fetch is the baseline: boot hydration already applied
      // server state, so applying here would replay it. The queue
      // still drains (sticky "need your input" must show even if it
      // was posted while this page was closed).
      if (last !== null) applyDiff(last, keys);
      drainQueue(keys[QUEUE_KEY]);
      last = keys;
      return true;
    } finally {
      inFlight = false;
    }
  }

  // Event-driven (battery-trio item 3, 2026-06-23): NO periodic poll. The
  // daemon pushes a {t:"state-changed"} WS nudge on every /api/state mutation
  // (StateStore set/merge/unset), which the core relays as the 'state-changed'
  // plugin event — we refetch on that. We also refetch once per (re)connect via
  // 'connection-open' (the core emits it from ws.onopen on every reopen,
  // including heartbeat/online reconnects), so a change made while we were
  // disconnected is still caught. This replaces the old 1.5s GET /api/state
  // poll, taking the steady-state HTTP cadence to zero (radio can sleep).
  if (typeof tv.on === 'function') {
    tv.on('state-changed', function () { syncNow(); });
    tv.on('connection-open', function () { syncNow(); });
  }
  // Belt-and-suspenders: if the page was backgrounded with the socket open and
  // somehow missed a nudge, catch up on return. Fires only on the visible
  // transition and no-ops when nothing changed.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) syncNow();
  });
  // Initial baseline fetch (boot hydrate already applied server state, so the
  // first syncNow only seeds `last`; later nudges apply diffs).
  syncNow();

  tv.contributes.command({
    id: 'live-sync-now',
    name: 'Live Sync: sync now',
    handler: function () { syncNow(); },
  });

  // Test/automation hook (used by tests/client/live-sync.test.ts).
  window.__ttvLiveSync = { syncNow: syncNow, showToast: showToast };
})();
