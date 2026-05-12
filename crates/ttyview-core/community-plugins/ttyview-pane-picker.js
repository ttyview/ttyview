// ttyview-pane-picker — Recent + All-alphabetical sections + inline
// session CRUD (＋ create, ⋮ rename / kill).
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
// Session CRUD calls /api/sessions endpoints (added 2026-05-12).
// The ⋮ per-row menu has Rename / Kill — Kill is gated on a confirm
// dialog because mobile users fat-finger. ＋ at top of "All" opens a
// dialog with name + optional cwd. After a successful op the natural
// panes-updated event from tmux control-mode refreshes the list; we
// also poll once after 800 ms in case the event lagged.
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
  // alwaysShowMeta = true forces the per-row meta (id · window · dims)
  // to render even when every session has a single pane in w0 — i.e.
  // when the column is redundant noise across all rows. Default false
  // means we auto-hide it under that condition; user can flip it on
  // for the verbose view.
  const DEFAULTS = { showRecent: true, recentCount: 5, allSort: 'alpha', alwaysShowMeta: false };

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

  // === Session CRUD over /api/sessions (added 2026-05-12) ===
  async function apiCreateSession(name, cwd) {
    const body = cwd ? { name, cwd } : { name };
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + res.status));
    }
    return res.json();
  }
  async function apiRenameSession(from, to) {
    const res = await fetch('/api/sessions/' + encodeURIComponent(from) + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + res.status));
    }
    return res.json();
  }
  async function apiKillSession(name) {
    const res = await fetch('/api/sessions/' + encodeURIComponent(name), {
      method: 'DELETE',
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + res.status));
    }
    return res.json();
  }

  // After a successful CRUD op, tmux control-mode emits panes-updated
  // on its own — but there's a small lag. Trigger an immediate
  // re-render too so the user sees their change without waiting.
  function refreshAfterOp() {
    setTimeout(rerender, 0);
    setTimeout(rerender, 800);
  }

  // === Dialog helpers (mobile-friendly modal, vanilla DOM) ===
  // Reused for create / rename / kill-confirm. No <dialog> element —
  // Android Chrome's IME interaction with dialog::backdrop has
  // surprised us before; rolling a tiny modal is one screenful of code.
  const DIALOG_STYLE_ID = 'ttyview-pane-picker-dialog-style';
  function ensureDialogStyle() {
    if (document.getElementById(DIALOG_STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = DIALOG_STYLE_ID;
    st.textContent = `
      .pp-modal-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.55);
        z-index: 10050; display: flex; align-items: flex-start;
        justify-content: center; padding: 12vh 16px 16px;
      }
      .pp-modal {
        background: var(--ttv-bg-elev, #1e1e1e);
        color: var(--ttv-fg, #e6e6e6);
        border: 1px solid var(--ttv-border, #333);
        border-radius: 8px; padding: 16px; width: 100%; max-width: 420px;
        box-shadow: 0 16px 48px rgba(0,0,0,0.6);
      }
      .pp-modal h3 { margin: 0 0 12px; font-size: 16px; }
      .pp-modal label { display: block; font-size: 12px; color: var(--ttv-muted, #888);
        margin: 12px 0 4px; }
      .pp-modal input[type="text"] {
        width: 100%; box-sizing: border-box;
        background: var(--ttv-bg-elev2, #2a2a2a);
        color: var(--ttv-fg, #e6e6e6);
        border: 1px solid var(--ttv-border, #333);
        border-radius: 4px; font: inherit; font-size: 15px;
        padding: 8px 10px;
      }
      .pp-modal .pp-modal-hint {
        font-size: 11px; color: var(--ttv-muted, #888); margin-top: 4px;
      }
      .pp-modal .pp-modal-err {
        margin-top: 10px; padding: 8px 10px; border-radius: 4px;
        background: rgba(220, 60, 60, 0.18);
        color: #ff9c9c; font-size: 13px;
      }
      .pp-modal .pp-modal-buttons {
        margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end;
      }
      .pp-modal button {
        background: var(--ttv-bg-elev2, #2a2a2a);
        color: var(--ttv-fg, #e6e6e6);
        border: 1px solid var(--ttv-border, #333);
        border-radius: 4px; cursor: pointer; font: inherit; font-size: 14px;
        padding: 8px 14px; min-height: 36px;
      }
      .pp-modal button.pp-primary {
        background: var(--ttv-accent, #2472c8); border-color: var(--ttv-accent, #2472c8);
        color: #fff;
      }
      .pp-modal button.pp-danger {
        background: rgba(220, 60, 60, 0.25); border-color: rgba(220, 60, 60, 0.55);
        color: #ff9c9c;
      }
      /* Toolbar at top of picker list */
      #pane-picker-list .pp-toolbar {
        padding: 8px 16px; display: flex; gap: 8px;
        border-bottom: 1px solid var(--ttv-border, #333);
        background: var(--ttv-bg-elev, #1e1e1e);
        position: sticky; top: 0; z-index: 1;
      }
      #pane-picker-list .pp-toolbar button {
        background: var(--ttv-bg-elev2, #2a2a2a);
        color: var(--ttv-fg, #e6e6e6);
        border: 1px solid var(--ttv-border, #333);
        border-radius: 4px; cursor: pointer; font: inherit; font-size: 13px;
        padding: 6px 12px; min-height: 32px;
      }
      /* Per-row ⋮ kebab */
      #pane-picker-list .pp-item { position: relative; }
      #pane-picker-list .pp-kebab {
        position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
        background: transparent; color: var(--ttv-muted, #888);
        border: 1px solid transparent; border-radius: 4px;
        cursor: pointer; font: inherit; font-size: 18px; line-height: 1;
        padding: 4px 8px; min-width: 32px; min-height: 32px;
      }
      #pane-picker-list .pp-kebab:hover { background: var(--ttv-bg-elev2, #2a2a2a); }
      /* Kebab popover anchored to the row */
      .pp-popover {
        position: fixed; z-index: 10049;
        background: var(--ttv-bg-elev, #1e1e1e);
        border: 1px solid var(--ttv-border, #333);
        border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        min-width: 140px; padding: 4px 0;
      }
      .pp-popover button {
        display: block; width: 100%; text-align: left;
        background: transparent; color: var(--ttv-fg, #e6e6e6);
        border: 0; cursor: pointer; font: inherit; font-size: 14px;
        padding: 10px 14px;
      }
      .pp-popover button:hover { background: var(--ttv-bg-elev2, #2a2a2a); }
      .pp-popover button.pp-danger { color: #ff9c9c; }
    `;
    document.head.appendChild(st);
  }
  // Opens a centered modal with one or more text fields. Returns a
  // promise that resolves with field values on submit, or null on
  // cancel. `danger:true` styles the primary button red and is used
  // for kill-confirm.
  function openDialog({ title, fields, submitLabel, danger, hint }) {
    return new Promise(function(resolve) {
      ensureDialogStyle();
      const overlay = document.createElement('div');
      overlay.className = 'pp-modal-overlay';
      const modal = document.createElement('div');
      modal.className = 'pp-modal';
      overlay.appendChild(modal);
      const h = document.createElement('h3');
      h.textContent = title;
      modal.appendChild(h);
      const inputs = [];
      (fields || []).forEach(function(f) {
        const lbl = document.createElement('label');
        lbl.textContent = f.label;
        modal.appendChild(lbl);
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = f.value || '';
        inp.placeholder = f.placeholder || '';
        inp.autocapitalize = 'off';
        inp.autocomplete = 'off';
        inp.spellcheck = false;
        inputs.push({ key: f.key, el: inp });
        modal.appendChild(inp);
        if (f.hint) {
          const hi = document.createElement('div');
          hi.className = 'pp-modal-hint';
          hi.textContent = f.hint;
          modal.appendChild(hi);
        }
      });
      if (hint) {
        const gh = document.createElement('div');
        gh.className = 'pp-modal-hint';
        gh.textContent = hint;
        gh.style.marginTop = '8px';
        modal.appendChild(gh);
      }
      const err = document.createElement('div');
      err.className = 'pp-modal-err';
      err.style.display = 'none';
      modal.appendChild(err);
      const btnRow = document.createElement('div');
      btnRow.className = 'pp-modal-buttons';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      const submit = document.createElement('button');
      submit.type = 'button';
      submit.textContent = submitLabel || 'OK';
      submit.className = danger ? 'pp-danger' : 'pp-primary';
      btnRow.appendChild(cancel);
      btnRow.appendChild(submit);
      modal.appendChild(btnRow);
      function close(result) {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
          e.preventDefault(); doSubmit();
        }
      }
      function doSubmit() {
        const out = {};
        inputs.forEach(function(i) { out[i.key] = i.el.value.trim(); });
        // Inline error-display path: caller sets err.textContent on
        // a rejected onSubmit via the showError hook on the resolved
        // object. Here we just resolve and let the caller decide.
        close({ values: out, showError: function(m) {
          err.textContent = m; err.style.display = 'block';
        }});
      }
      cancel.addEventListener('click', function() { close(null); });
      submit.addEventListener('click', doSubmit);
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) close(null);
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      if (inputs[0]) setTimeout(function() { inputs[0].el.focus(); }, 50);
    });
  }
  // The resolve-with-callback pattern lets the caller try the API,
  // display an inline error inside the dialog on failure, and keep
  // re-prompting until success or Cancel. Wrap it here.
  async function promptUntilSuccess(opts, doOp) {
    while (true) {
      const r = await openDialog(opts);
      if (!r) return null;
      try {
        await doOp(r.values);
        return r.values;
      } catch (e) {
        r.showError(String(e.message || e));
        // Re-open with the entered values so the user can fix
        // their typo without retyping everything.
        opts.fields = opts.fields.map(function(f) {
          return Object.assign({}, f, { value: r.values[f.key] || '' });
        });
      }
    }
  }
  function closeAnyPopover() {
    const existing = document.querySelector('.pp-popover');
    if (existing) existing.remove();
  }
  function openRowPopover(anchorEl, p) {
    closeAnyPopover();
    const pop = document.createElement('div');
    pop.className = 'pp-popover';
    const r = anchorEl.getBoundingClientRect();
    const popW = 160;
    let left = r.right - popW;
    let top  = r.bottom + 4;
    // Flip up if not enough room below
    if (top + 96 > window.innerHeight) top = r.top - 96;
    if (left < 8) left = 8;
    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
    pop.style.minWidth = popW + 'px';
    const renameBtn = document.createElement('button');
    renameBtn.textContent = 'Rename…';
    renameBtn.addEventListener('click', async function(ev) {
      ev.stopPropagation();
      closeAnyPopover();
      await promptUntilSuccess({
        title: 'Rename session',
        fields: [{ key: 'to', label: 'New name', value: p.session,
                   placeholder: p.session,
                   hint: 'Letters, digits, _ . - · max 64 chars' }],
        submitLabel: 'Rename',
      }, function(vals) { return apiRenameSession(p.session, vals.to); });
      refreshAfterOp();
    });
    const killBtn = document.createElement('button');
    killBtn.className = 'pp-danger';
    killBtn.textContent = 'Kill session…';
    killBtn.addEventListener('click', async function(ev) {
      ev.stopPropagation();
      closeAnyPopover();
      const confirm = await openDialog({
        title: 'Kill session?',
        fields: [],
        hint: 'Kills tmux session "' + p.session + '" and all panes inside it. This is not reversible.',
        submitLabel: 'Kill',
        danger: true,
      });
      if (!confirm) return;
      try {
        await apiKillSession(p.session);
      } catch (e) {
        // Inline alert isn't ideal but a confirm dialog with no
        // inputs has no err slot. Cheap fallback for an edge case.
        alert('Kill failed: ' + (e.message || e));
        return;
      }
      refreshAfterOp();
    });
    pop.appendChild(renameBtn);
    pop.appendChild(killBtn);
    document.body.appendChild(pop);
    // Click-away closes
    setTimeout(function() {
      document.addEventListener('click', function awayHandler(e) {
        if (!pop.contains(e.target)) {
          closeAnyPopover();
          document.removeEventListener('click', awayHandler, true);
        }
      }, true);
    }, 0);
  }
  async function promptCreate() {
    await promptUntilSuccess({
      title: 'New tmux session',
      fields: [
        { key: 'name', label: 'Name',
          placeholder: 'my-session',
          hint: 'Letters, digits, _ . - · max 64 chars' },
        { key: 'cwd', label: 'Starting directory (optional)',
          placeholder: '/home/eyalev/projects/…',
          hint: 'Absolute path. Leave blank for tmux default.' },
      ],
      submitLabel: 'Create',
    }, function(vals) { return apiCreateSession(vals.name, vals.cwd || null); });
    refreshAfterOp();
  }

  // === Renderers ===
  function renderRow(p, panes, opts) {
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
    item.appendChild(sess);
    // Suppress the meta column when every session in the picker is a
    // single pane in w0 — the column is the same `· w0 · 60×28` on
    // every row, just visual noise. User can opt back into the verbose
    // view via Settings → Pane Picker → Always show meta.
    if (!opts || !opts.suppressMeta) {
      const meta = document.createElement('span');
      meta.className = 'pp-meta';
      // Display the pane id with a `p` prefix instead of tmux's
      // raw `%` — easier to read on mobile and avoids the visual
      // confusion with "percent". The underlying `p.id` (still %N)
      // is unchanged; only the rendered string differs.
      const displayId = String(p.id || '').replace(/^%/, 'p');
      const parts = [displayId];
      if (p.window != null) parts.push('w' + p.window);
      parts.push(p.cols + '×' + p.rows);
      meta.textContent = parts.join(' · ');
      item.appendChild(meta);
    }
    item.addEventListener('click', function() {
      tv.closePanePicker();
      // Don't bump recency here — the upcoming pane-changed event
      // will. Avoids double-counting the "I just clicked it" touch.
      tv.selectPane(p.id);
    });
    // ⋮ kebab → row popover (Rename / Kill). stopPropagation so the
    // row's selectPane handler doesn't fire when the user just wants
    // to open the menu.
    const kebab = document.createElement('button');
    kebab.type = 'button';
    kebab.className = 'pp-kebab';
    kebab.setAttribute('aria-label', 'Session actions');
    kebab.textContent = '⋮';
    kebab.addEventListener('click', function(ev) {
      ev.stopPropagation();
      openRowPopover(kebab, p);
    });
    item.appendChild(kebab);
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

    // Recent: panes whose session has a timestamp, sorted desc, top N.
    // Includes the currently-active pane — earlier I excluded it ("no
    // point, you're already there") but the user wanted it in the
    // list (it's at the top by recency, gets the .active highlight).
    const withTs = panes
      .filter(p => recency[p.session])
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

    // "Suppress meta" condition: every session has exactly one pane,
    // and every pane is in window 0. If both hold, the meta column is
    // identical noise — auto-hide unless the user forced
    // alwaysShowMeta. Computed once per render and passed to renderRow
    // so Recent + All sections stay consistent.
    const sessionCounts = panes.reduce((m, p) => (m[p.session] = (m[p.session] || 0) + 1, m), {});
    const allSinglePane = Object.values(sessionCounts).every(n => n === 1);
    const allWindow0    = panes.every(p => p.window == null || p.window === 0 || p.window === '0');
    const suppressMeta  = !settings.alwaysShowMeta && allSinglePane && allWindow0;
    const rowOpts = { suppressMeta };

    pickerSlot.innerHTML = '';
    // Toolbar with ＋ New session. Sticks to the top so it stays
    // reachable when the picker scrolls.
    ensureDialogStyle();
    const toolbar = document.createElement('div');
    toolbar.className = 'pp-toolbar';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '＋ New session';
    addBtn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      promptCreate();
    });
    toolbar.appendChild(addBtn);
    pickerSlot.appendChild(toolbar);

    if (settings.showRecent && withTs.length > 0) {
      pickerSlot.appendChild(renderHeader('Recent'));
      for (const { p } of withTs) pickerSlot.appendChild(renderRow(p, panes, rowOpts));
    }
    pickerSlot.appendChild(renderHeader('All'));
    for (const p of all) pickerSlot.appendChild(renderRow(p, panes, rowOpts));
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

      // "Always show meta" toggle — opt back into the verbose view
      // that always shows the `· id · wN · cols×rows` column. Default
      // off, so the meta column auto-collapses when every session is
      // a single pane in w0.
      const rowMeta = makeRow('Meta column');
      const metaCb = document.createElement('input');
      metaCb.type = 'checkbox'; metaCb.checked = !!settings.alwaysShowMeta;
      metaCb.style.cssText = 'margin-right:8px;';
      metaCb.addEventListener('change', function() {
        settings.alwaysShowMeta = metaCb.checked;
        saveSettings(settings);
        rerender();
      });
      const metaLbl = document.createElement('label');
      metaLbl.style.cssText = 'display:inline-flex;align-items:center;color:var(--ttv-fg);font-size:14px;cursor:pointer;';
      metaLbl.appendChild(metaCb);
      metaLbl.appendChild(document.createTextNode('Always show pane id · window · size'));
      rowMeta.appendChild(metaLbl);
      const metaHint = document.createElement('div');
      metaHint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:6px;';
      metaHint.textContent = 'Off (default): hide the meta column when every session has one pane in w0 — the column would just be identical text on every row.';
      rowMeta.appendChild(metaHint);
      container.appendChild(rowMeta);

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
