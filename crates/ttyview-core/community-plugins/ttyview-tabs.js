// ttyview-tabs — pinned-pane tab row above the grid.
//
// Tap a tab to switch panes (uses ttyview.selectPane). '+' pins the
// active pane. Long-press a tab to unpin. State persists via the
// per-plugin storage namespace, keyed by SESSION NAME (with pane id
// kept as a fast-path resolver) — so the tabs survive a tmux server
// restart that mints new pane ids, falling back to session-name match.
//
// Two contributions sharing state via this IIFE's closure:
//   - tabBar       — renders the tab buttons in #tab-bar
//   - settingsTab  — Settings → Pinned Tabs: pin-all-sessions action,
//                    rows count, max tabs per row
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  const STORAGE_KEY = 'pins';
  const SETTINGS_KEY = 'settings';
  const LONG_PRESS_MS = 500;
  const DEFAULTS = { rows: 1, maxPerRow: 0 };  // 0 = unlimited per row

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
  let parentInitialFlexDir = ''; // restore-on-unmount parent flex-direction
  let parentInitialAlignItems = '';
  let parentTouched = false;     // whether we've modified the parent

  function savePins()      { storage.set(STORAGE_KEY,    pins);     }
  function saveSettings()  { storage.set(SETTINGS_KEY,   settings); }

  function resolvePin(pin, panes) {
    if (pin.id) {
      const byId = panes.find(p => p.id === pin.id);
      if (byId) return byId;
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
      .ttvtab-add:active { color: var(--ttv-accent); border-color: var(--ttv-accent); }
      /* Multi-row container — one .ttvtab-row per row, each with its
         own horizontal scroll so a row exceeding maxPerRow can still
         reach the overflow tabs. */
      .ttvtab-row {
        display: flex; gap: 4px; flex-wrap: nowrap;
        overflow-x: auto;
        scrollbar-width: none;
      }
      .ttvtab-row::-webkit-scrollbar { display: none; }
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
  function render() {
    if (!mountedSlot) return;
    mountedSlot.innerHTML = '';
    const panes = tv.listPanes();
    const active = tv.getActivePane();

    // Build the items list (pins + optional pin-current button).
    const items = pins.slice().map(pin => ({ kind: 'pin', pin }));
    if (active && !pins.find(p => p.session === active.session)) {
      items.push({ kind: 'add', active });
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
      mountedSlot.style.cssText = 'display:flex;flex-direction:column;gap:4px;width:100%;flex-basis:100%;';
      // When the host slot is a row-flex container (the default for
      // above-input and above-grid), our column-of-tab-rows would
      // either get pushed off horizontally OR stretch the row's
      // height — visible as "tabs vanished + sibling buttons very
      // tall". Flip the parent to column so siblings (e.g. quickkeys
      // sharing above-input) naturally stack below us instead.
      const parent = mountedSlot.parentNode;
      if (parent && !parentTouched) {
        parentInitialFlexDir = parent.style.flexDirection;
        parentInitialAlignItems = parent.style.alignItems;
        parentTouched = true;
      }
      if (parent) {
        parent.style.flexDirection = 'column';
        parent.style.alignItems = 'stretch';
      }
    } else {
      mountedSlot.style.cssText = mountedSlotInitial;
      const parent = mountedSlot.parentNode;
      if (parent && parentTouched) {
        parent.style.flexDirection = parentInitialFlexDir;
        parent.style.alignItems = parentInitialAlignItems;
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
        if (item.kind === 'pin') {
          const resolved = resolvePin(item.pin, panes);
          const made = makeTabButton(item.pin, resolved, active, fitMode);
          rowEl.appendChild(made.el);
          if (fitMode) placedTabs.push(made);
        } else if (item.kind === 'add') {
          const made = makeAddButton(item.active, fitMode);
          rowEl.appendChild(made.el);
          if (fitMode) placedTabs.push(made);
        }
      }
    }

    if (fitMode && placedTabs.length) {
      // Run after layout settles so each label sees its real width.
      requestAnimationFrame(function() {
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
          mountedSlot.parentNode.style.flexDirection = parentInitialFlexDir;
          mountedSlot.parentNode.style.alignItems = parentInitialAlignItems;
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
      const r2 = makeRow('Number of rows', 'Minimum number of rows to reserve. With Max tabs per row > 0, rows auto-grow to fit every pin; this setting is the floor.');
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
