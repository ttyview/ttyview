// ttyview-pane-picker — Recent + All-alphabetical sections.
//
// Replaces the platform's default arbitrary-order picker (DashMap
// iteration order, effectively random + unstable across requests)
// with: a "Recent" section at top (last-used N panes, default 5)
// and an "All" section below (alphabetical by session name).
//
// Recency is tracked client-side, keyed by SESSION NAME (not pane
// id) so a tmux server restart that re-issues pane ids doesn't
// orphan the recency list. Same persistence trick as the tabs
// plugin's pin storage.
//
// Two contributions:
//   - panePickerList  → owns #pane-picker-list rendering
//   - settingsTab     → user-visible config (toggle / count / sort)
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  const STORAGE = tv.storage('ttyview-pane-picker');
  const KEY_SETTINGS = 'settings';
  const KEY_RECENCY  = 'recency';
  const DEFAULTS = { showRecent: true, recentCount: 5, allSort: 'alpha' };

  function loadSettings() {
    return Object.assign({}, DEFAULTS, STORAGE.get(KEY_SETTINGS) || {});
  }
  function saveSettings(s) { STORAGE.set(KEY_SETTINGS, s); }
  function loadRecency() {
    const v = STORAGE.get(KEY_RECENCY);
    return (v && typeof v === 'object') ? v : {};
  }
  function saveRecency(r) { STORAGE.set(KEY_RECENCY, r); }

  // Plugin closure state, shared between panePickerList + settingsTab
  // contributions so a settings change re-renders the list immediately.
  let settings = loadSettings();
  let recency  = loadRecency();        // { <session-name>: <ts-ms> }
  let pickerSlot = null;               // #pane-picker-list element
  let pickerCtx  = null;

  function recordTouch(sessionName) {
    if (!sessionName) return;
    recency[sessionName] = Date.now();
    saveRecency(recency);
    // No re-render here — the picker isn't visible at the moment of
    // pane-changed (user navigated AWAY from it). Next open shows
    // the updated order.
  }

  // === Renderers ===
  function renderRow(p, panes) {
    // Same disambiguation rule as core's paneLabel: only suffix when
    // multiple panes share a session.
    const same = panes.filter(x => x.session === p.session);
    const idx = same.findIndex(x => x.id === p.id);
    const item = document.createElement('div');
    item.className = 'pp-item';
    item.setAttribute('role', 'option');
    item.setAttribute('data-pane-id', p.id);
    const active = tv.getActivePane();
    if (active && p.id === active.id) item.classList.add('active');
    const sess = document.createElement('span');
    sess.className = 'pp-session';
    sess.textContent = same.length > 1 ? p.session + ' (' + (idx + 1) + ')' : p.session;
    const meta = document.createElement('span');
    meta.className = 'pp-meta';
    const parts = [p.id];
    if (p.window != null) parts.push('w' + p.window);
    parts.push(p.cols + '×' + p.rows);
    meta.textContent = parts.join(' · ');
    item.appendChild(sess);
    item.appendChild(meta);
    item.addEventListener('click', function() {
      tv.closePanePicker();
      // Don't bump recency here — the upcoming pane-changed event
      // will. Avoids double-counting the "I just clicked it" touch.
      tv.selectPane(p.id);
    });
    return item;
  }
  function renderHeader(text) {
    const h = document.createElement('div');
    h.className = 'pp-section';
    h.textContent = text;
    return h;
  }

  function rerender() {
    if (!pickerSlot) return;
    // Re-read settings + recency on every render. Cheap (small JSON
    // blobs) and means any external mutation — DevTools edit, manager
    // touching storage, the settings tab's "Clear" button — is
    // honored without an explicit notification channel.
    settings = loadSettings();
    recency  = loadRecency();
    const panes = tv.listPanes();
    const active = tv.getActivePane();

    // Recent: panes whose session has a timestamp, sorted desc, top N,
    // EXCLUDING the currently-active pane (you're already there).
    const withTs = panes
      .filter(p => recency[p.session] && (!active || p.id !== active.id))
      .map(p => ({ p, ts: recency[p.session] }))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, Math.max(0, settings.recentCount));

    // All: every pane, sorted by chosen rule.
    const all = panes.slice().sort((a, b) => {
      if (settings.allSort === 'id') {
        // Strip leading '%' and compare numerically.
        const na = parseInt(String(a.id).replace(/^%/, ''), 10) || 0;
        const nb = parseInt(String(b.id).replace(/^%/, ''), 10) || 0;
        return na - nb;
      }
      // Alphabetical, ties by pane id (numeric)
      const c = (a.session || '').localeCompare(b.session || '');
      if (c !== 0) return c;
      const na = parseInt(String(a.id).replace(/^%/, ''), 10) || 0;
      const nb = parseInt(String(b.id).replace(/^%/, ''), 10) || 0;
      return na - nb;
    });

    pickerSlot.innerHTML = '';
    if (settings.showRecent && withTs.length > 0) {
      pickerSlot.appendChild(renderHeader('Recent'));
      for (const { p } of withTs) pickerSlot.appendChild(renderRow(p, panes));
    }
    pickerSlot.appendChild(renderHeader('All'));
    for (const p of all) pickerSlot.appendChild(renderRow(p, panes));
  }

  // === Section header CSS — inject once. Picker rows already styled
  // by the daemon; we just need a small "Recent" / "All" subtitle. ===
  const STYLE_ID = 'ttyview-pane-picker-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      #pane-picker-list .pp-section {
        font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
        color: var(--ttv-muted); padding: 10px 16px 6px;
        background: var(--ttv-bg-elev);
      }
    `;
    document.head.appendChild(st);
  }

  // === Contributions ===
  tv.contributes.panePickerList({
    id: 'ttyview-pane-picker',
    name: 'Pane Picker',
    render: function(slot, ctx) {
      ensureStyle();
      pickerSlot = slot;
      pickerCtx = ctx;

      // Bump recency when the user changes panes — fires whether they
      // got there via picker, tab, or programmatic call.
      const offChanged = tv.on('pane-changed', function(d) {
        const p = (tv.listPanes() || []).find(x => x.id === d.to);
        recordTouch(p?.session);
      });
      // Re-render when the pane list refreshes (sessions added/removed).
      const offUpdated = tv.on('panes-updated', rerender);
      // Re-render on picker-open in case panesCache moved between
      // open events (e.g. external `tmux new-session`).
      const offOpened  = tv.on('panePicker-opened', rerender);

      rerender();

      return function unmount() {
        offChanged(); offUpdated(); offOpened();
        const st = document.getElementById(STYLE_ID);
        if (st) st.remove();
        pickerSlot = null; pickerCtx = null;
      };
    },
  });

  tv.contributes.settingsTab({
    id: 'ttyview-pane-picker',
    title: 'Pane Picker',
    render: function(container) {
      container.innerHTML = '';
      const intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
      intro.textContent = 'Reorders the pane picker list. Tracks recency in your browser only — different devices keep separate lists.';
      container.appendChild(intro);

      function makeRow(label) {
        const row = document.createElement('div'); row.style.cssText = 'margin-bottom:14px;';
        const lbl = document.createElement('label');
        lbl.style.cssText = 'display:block;font-size:12px;color:var(--ttv-muted);margin-bottom:6px;';
        lbl.textContent = label;
        row.appendChild(lbl);
        return row;
      }

      // "Show recent" toggle
      const rowToggle = makeRow('Recent section');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!settings.showRecent;
      cb.style.cssText = 'margin-right:8px;';
      cb.addEventListener('change', function() {
        settings.showRecent = cb.checked;
        saveSettings(settings);
        rerender();
      });
      const cbLabel = document.createElement('label');
      cbLabel.style.cssText = 'display:inline-flex;align-items:center;color:var(--ttv-fg);font-size:14px;cursor:pointer;';
      cbLabel.appendChild(cb);
      cbLabel.appendChild(document.createTextNode('Show recent section above the main list'));
      rowToggle.appendChild(cbLabel);
      container.appendChild(rowToggle);

      // "Recent count" number input
      const rowCount = makeRow('Recent count (1–20)');
      const num = document.createElement('input');
      num.type = 'number'; num.min = '1'; num.max = '20';
      num.value = String(settings.recentCount);
      num.style.cssText = 'background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);border-radius:4px;font:inherit;font-size:14px;padding:6px 10px;width:80px;';
      num.addEventListener('change', function() {
        const n = Math.max(1, Math.min(20, parseInt(num.value, 10) || 5));
        settings.recentCount = n;
        num.value = String(n);
        saveSettings(settings);
        rerender();
      });
      rowCount.appendChild(num);
      container.appendChild(rowCount);

      // "All sort" dropdown
      const rowSort = makeRow('All-section sort');
      const sel = document.createElement('select');
      sel.style.cssText = 'background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);border-radius:4px;font:inherit;font-size:14px;padding:6px 10px;';
      [['alpha', 'Alphabetical (default)'], ['id', 'Pane ID']].forEach(function(opt) {
        const o = document.createElement('option');
        o.value = opt[0]; o.textContent = opt[1];
        if (opt[0] === settings.allSort) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function() {
        settings.allSort = sel.value;
        saveSettings(settings);
        rerender();
      });
      rowSort.appendChild(sel);
      container.appendChild(rowSort);

      // Tiny "Clear recency" affordance — useful when you want to wipe
      // the top section without tweaking the toggle / count.
      const rowClear = makeRow('Recency state');
      const clear = document.createElement('button');
      clear.textContent = 'Clear recent history';
      clear.style.cssText = 'background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);border-radius:4px;cursor:pointer;font-size:12px;padding:6px 12px;';
      clear.addEventListener('click', function() {
        recency = {};
        saveRecency(recency);
        rerender();
      });
      rowClear.appendChild(clear);
      container.appendChild(rowClear);
    },
  });
})();
