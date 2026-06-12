// ttyview-tabs — session tab area (pinned tabs / all sessions).
//
// Two view modes, switched by the leading 📌/▦ toggle button and
// persisted in settings:
//   - pinned: the curated pin list. Tap to switch panes, '+' pins the
//     active pane, long-press a tab then tap × to unpin.
//   - all: every tmux session, alphabetical. Tap to switch; long-press
//     toggles that session's pin (pinned sessions show a 📌 mark).
// Pin state persists via the per-plugin storage namespace, keyed by
// SESSION NAME (with pane id kept as a fast-path resolver) — so the
// tabs survive a tmux server restart that mints new pane ids, falling
// back to session-name match.
//
// The `rows` setting is both the reserved minimum height AND the
// visible cap: when tabs need more rows, the area stays `rows` tall
// and scrolls vertically.
//
// Default slot is above-input (bottom of the screen, by the thumb —
// the tmux-web arrangement); movable via Settings → Layout.
//
// Two contributions sharing state via this IIFE's closure:
//   - tabBar       — renders the tab buttons
//   - settingsTab  — Settings → Pinned Tabs: pin-all-sessions action,
//                    rows count, max tabs per row
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  const STORAGE_KEY = 'pins';
  const SETTINGS_KEY = 'settings';
  const LONG_PRESS_MS = 500;
  const DEFAULTS = { rows: 1, maxPerRow: 0, mode: 'pinned' };  // maxPerRow 0 = unlimited per row

  const storage = tv.storage('ttyview-tabs');

  // Hoisted state — shared between contributions.
  let pins = (function() {
    const v = storage.get(STORAGE_KEY);
    return Array.isArray(v) ? v : [];
  })();
  let settings = Object.assign({}, DEFAULTS, storage.get(SETTINGS_KEY) || {});
  let editingId = null;
  let mountedSlot = null;       // set by tabBar render(); null when not mounted
  let mountedSlotInitial = '';  // restore-on-unmount cssText
  let parentTouched = false;    // whether we've added .ttv-stacked-slot to parent

  function savePins()      { storage.set(STORAGE_KEY,    pins);     }
  function saveSettings()  { storage.set(SETTINGS_KEY,   settings); }

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
        background: var(--ttv-bg-elev2);
        color: var(--ttv-fg);
        border: 1px solid var(--ttv-border);
        border-radius: 4px;
        padding: 5px 10px;
        font-size: 12px;
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
    `;
    document.head.appendChild(st);
  }

  // ---- core render of the tab area ----
  let renderGen = 0;     // invalidates stale rAF callbacks across re-renders
  let lastHeightPx = ''; // carried across renders so the area never
                         // flashes to natural content height during the
                         // cssText-reset → rAF-remeasure gap (visible as
                         // a jump when toggling pinned ↔ all)
  function render() {
    if (!mountedSlot) return;
    const gen = ++renderGen;
    // Re-renders happen mid-interaction (pin/unpin, panes-updated) —
    // keep the user's scroll position instead of jumping to the top.
    const prevScroll = mountedSlot.scrollTop;
    mountedSlot.innerHTML = '';
    const panes = tv.listPanes();
    const active = tv.getActivePane();
    const mode = settings.mode === 'all' ? 'all' : 'pinned';

    // Build the items list. The mode toggle leads in both modes.
    const items = [{ kind: 'toggle', mode }];
    if (mode === 'pinned') {
      // Pins + optional pin-current button.
      for (const pin of pins) items.push({ kind: 'pin', pin });
      if (active && !pins.find(p => p.session === active.session)) {
        items.push({ kind: 'add', active });
      }
    } else {
      // Every session, one tab each, alphabetical.
      const seen = new Set();
      const sessions = [];
      for (const p of panes) {
        if (!seen.has(p.session)) { seen.add(p.session); sessions.push(p); }
      }
      sessions.sort((a, b) => String(a.session).localeCompare(String(b.session)));
      for (const p of sessions) items.push({ kind: 'sess', pane: p });
    }

    // Distribute into rows. In fit mode (max > 0) we chunk strictly
    // by maxPerRow and let rows auto-grow to hold every item; the
    // `rows` setting becomes a minimum (handy for reserving vertical
    // space when there are few pins). Without max, the `rows`
    // setting is irrelevant — a single horizontally-scrolling row.
    const rows = Math.max(1, settings.rows | 0);
    const max  = Math.max(0, settings.maxPerRow | 0);
    let groups;
    if (max === 0) {
      groups = [items];
    } else {
      groups = [];
      for (let i = 0; i < items.length; i += max) {
        groups.push(items.slice(i, i + max));
      }
      while (groups.length < rows) groups.push([]);
      if (groups.length === 0) groups = [items];
    }

    // Container layout. Fit mode (maxPerRow > 0) always stacks rows
    // vertically so each row independently fits its slice to row
    // width. Without fit mode, single-row uses the original inline
    // flex on the slot; multi-row stacks.
    const fitMode = max > 0;
    const needsOwnRow = groups.length > 1 || fitMode;
    if (needsOwnRow) {
      // Width:100% claims the row in the (now-column-flex) parent.
      // Do NOT set flex-basis:100% — in a column-flex parent that
      // applies to height and makes us claim the entire slot, which
      // visibly inflates row heights / inter-row gaps.
      mountedSlot.style.cssText = 'display:flex;flex-direction:column;gap:4px;width:100%;';
      // Re-apply the last known height synchronously — the rAF below
      // re-measures and refines, but without this the frame(s) in
      // between render at content height and the section jumps.
      if (lastHeightPx) {
        mountedSlot.style.minHeight = lastHeightPx;
        mountedSlot.style.maxHeight = lastHeightPx;
        mountedSlot.style.overflowY = 'auto';
      }
      // When the host slot is a row-flex container (the default for
      // above-input and above-grid), our column-of-tab-rows would
      // either get pushed off horizontally OR stretch the row's
      // height — visible as "tabs vanished + sibling buttons very
      // tall". Apply .ttv-stacked-slot to the parent: flips it to
      // column, kills its own overflow-x so the keys-row scroll
      // doesn't drag the tabs along, and gives each child its own
      // independent horizontal scroll.
      const parent = mountedSlot.parentNode;
      if (parent) {
        parent.classList.add('ttv-stacked-slot');
        parentTouched = true;
      }
    } else {
      mountedSlot.style.cssText = mountedSlotInitial;
      const parent = mountedSlot.parentNode;
      if (parent && parentTouched) {
        parent.classList.remove('ttv-stacked-slot');
        parentTouched = false;
      }
    }

    const placedTabs = []; // { el, label, fullText } — for ellipsis pass
    for (const group of groups) {
      const rowEl = (groups.length > 1 || fitMode)
        ? Object.assign(document.createElement('div'), { className: 'ttvtab-row' + (fitMode ? ' fit' : '') })
        : mountedSlot;
      if (rowEl !== mountedSlot) mountedSlot.appendChild(rowEl);
      if (fitMode) rowEl.style.setProperty('--ttv-max-per-row', String(max));
      for (const item of group) {
        let made = null;
        if (item.kind === 'pin') {
          const resolved = resolvePin(item.pin, panes);
          made = makeTabButton(item.pin, resolved, active, fitMode);
        } else if (item.kind === 'add') {
          made = makeAddButton(item.active, fitMode);
        } else if (item.kind === 'toggle') {
          made = makeToggleButton(item.mode, fitMode);
        } else if (item.kind === 'sess') {
          made = makeSessionButton(item.pane, active, fitMode);
        }
        if (!made) continue;
        rowEl.appendChild(made.el);
        if (fitMode) placedTabs.push(made);
      }
    }

    // Constant visible height: the area is ALWAYS exactly `rows` rows
    // tall — fewer tabs leave empty space, more tabs scroll vertically.
    // min-height == max-height so toggling pinned ↔ all (or pinning /
    // unpinning) never shifts the layout around it. Measured (not
    // hardcoded) row height so font-size / padding changes don't
    // desync; the first row always has content (the mode toggle).
    if (needsOwnRow) {
      requestAnimationFrame(function() {
        if (gen !== renderGen || !mountedSlot) return;
        const first = mountedSlot.firstElementChild;
        if (!first || !first.offsetHeight) return;
        const px = (rows * first.offsetHeight + (rows - 1) * 4) + 'px';
        lastHeightPx = px;
        mountedSlot.style.minHeight = px;
        mountedSlot.style.maxHeight = px;
        mountedSlot.style.overflowY = 'auto';
        // Restore scroll only after the cap re-creates the overflow —
        // setting scrollTop on an uncapped element clamps it to 0.
        if (prevScroll) mountedSlot.scrollTop = prevScroll;
      });
    }

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

  function makeTabButton(pin, resolved, active, fitMode) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ttvtab';
    if (fitMode) btn.classList.add('fit');
    if (editingId === pin.id) btn.classList.add('editing');
    if (!resolved) btn.classList.add('missing');
    else if (active && resolved.id === active.id) btn.classList.add('active');
    const label = document.createElement('span');
    label.className = 'ttvtab-label';
    const fullText = pin.session || pin.id || '?';
    label.textContent = fullText;
    btn.title = fullText;
    btn.appendChild(label);
    const xs = document.createElement('span');
    xs.className = 'ttvtab-x';
    xs.textContent = '×';
    btn.appendChild(xs);
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

  // Leading mode toggle — shows the CURRENT mode, tap to switch.
  function makeToggleButton(mode, fitMode) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ttvtab ttvtab-add';
    if (fitMode) btn.classList.add('fit');
    const label = document.createElement('span');
    label.className = 'ttvtab-label';
    const fullText = mode === 'pinned' ? '📌' : '▦ all';
    label.textContent = fullText;
    btn.appendChild(label);
    btn.title = mode === 'pinned'
      ? 'Showing pinned tabs — tap to show all sessions'
      : 'Showing all sessions — tap to show pinned tabs';
    btn.setAttribute('aria-label', btn.title);
    btn.tabIndex = -1;
    btn.addEventListener('pointerup', function(e) {
      if (e.button !== undefined && e.button !== 0) return;
      settings.mode = mode === 'pinned' ? 'all' : 'pinned';
      saveSettings();
      render();
    });
    btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
    return { el: btn, label, fullText };
  }

  // All-sessions mode tab. Tap switches; long-press toggles the pin.
  function makeSessionButton(pane, active, fitMode) {
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
    if (isPinned) {
      const mark = document.createElement('span');
      mark.className = 'ttvtab-pinmark';
      mark.textContent = '📌';
      btn.appendChild(mark);
    }
    btn.title = fullText + (isPinned ? ' (pinned — long-press to unpin)' : ' (long-press to pin)');
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

      // Re-read settings on each render so settings-tab edits take
      // effect even though they live in a different DOM tree.
      const off1 = tv.on('pane-changed',  render);
      const off2 = tv.on('panes-updated', render);

      slot.addEventListener('click', function(e) {
        if (!e.target.closest('.ttvtab') && editingId !== null) {
          editingId = null;
          render();
        }
      });

      render();
      return function unmount() {
        off1(); off2();
        if (mountedSlot && parentTouched && mountedSlot.parentNode) {
          mountedSlot.parentNode.classList.remove('ttv-stacked-slot');
        }
        parentTouched = false;
        mountedSlot = null;
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
      intro.textContent = 'Customize the pinned tabs row. State is per-browser (localStorage). Changes apply immediately.';
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

      // Rows
      const r2 = makeRow('Number of rows', 'Visible height of the tab area, in rows (needs Max tabs per row > 0). Fewer tabs still reserve this height; more tabs scroll vertically within it.');
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
