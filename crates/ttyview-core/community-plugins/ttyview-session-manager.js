// ttyview-session-manager — Settings tab for managing tmux sessions.
//
// Sibling to ttyview-pane-picker's inline ＋/⋮ UX. Same /api/sessions
// endpoints; this just gives you a full table view instead of an
// in-picker mini-menu. Useful when you want to triage a pile of
// stale sessions, or rename multiple in a row.
//
// One contribution: settingsTab. Renders a table of sessions
// (one row per unique tmux session, deduped from the pane list)
// with Rename / Kill actions per row + ＋ Create at the top. Calls
// shared API helpers via fetch — keeps the dialog UX consistent
// with the pane-picker plugin, which is the load-bearing entry
// point. (Plugins can't import each other, so the two clones of
// these helpers are intentional; if a third place ever needs them
// we'll lift them into a contributed util.)

(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  // === API ===
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

  // === Modal helpers (mobile-friendly, vanilla DOM) ===
  const STYLE_ID = 'ttyview-session-manager-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      .sm-modal-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.55);
        z-index: 10050; display: flex; align-items: flex-start;
        justify-content: center; padding: 12vh 16px 16px;
      }
      .sm-modal {
        background: var(--ttv-bg-elev, #1e1e1e);
        color: var(--ttv-fg, #e6e6e6);
        border: 1px solid var(--ttv-border, #333);
        border-radius: 8px; padding: 16px; width: 100%; max-width: 420px;
        box-shadow: 0 16px 48px rgba(0,0,0,0.6);
      }
      .sm-modal h3 { margin: 0 0 12px; font-size: 16px; }
      .sm-modal label { display: block; font-size: 12px; color: var(--ttv-muted, #888);
        margin: 12px 0 4px; }
      .sm-modal input[type="text"] {
        width: 100%; box-sizing: border-box;
        background: var(--ttv-bg-elev2, #2a2a2a);
        color: var(--ttv-fg, #e6e6e6);
        border: 1px solid var(--ttv-border, #333);
        border-radius: 4px; font: inherit; font-size: 15px; padding: 8px 10px;
      }
      .sm-modal .sm-hint { font-size: 11px; color: var(--ttv-muted, #888); margin-top: 4px; }
      .sm-modal .sm-err {
        margin-top: 10px; padding: 8px 10px; border-radius: 4px;
        background: rgba(220, 60, 60, 0.18); color: #ff9c9c; font-size: 13px;
      }
      .sm-modal .sm-buttons {
        margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end;
      }
      .sm-modal button {
        background: var(--ttv-bg-elev2, #2a2a2a);
        color: var(--ttv-fg, #e6e6e6);
        border: 1px solid var(--ttv-border, #333);
        border-radius: 4px; cursor: pointer; font: inherit; font-size: 14px;
        padding: 8px 14px; min-height: 36px;
      }
      .sm-modal button.sm-primary {
        background: var(--ttv-accent, #2472c8); border-color: var(--ttv-accent, #2472c8);
        color: #fff;
      }
      .sm-modal button.sm-danger {
        background: rgba(220, 60, 60, 0.25); border-color: rgba(220, 60, 60, 0.55);
        color: #ff9c9c;
      }
      /* Settings-tab table */
      .sm-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      .sm-table th, .sm-table td {
        text-align: left; padding: 8px 10px;
        border-bottom: 1px solid var(--ttv-border, #2a2a2a);
        font-size: 14px; color: var(--ttv-fg, #e6e6e6);
      }
      .sm-table th {
        color: var(--ttv-muted, #888); font-weight: 500;
        font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
      }
      .sm-table .sm-row-actions { text-align: right; white-space: nowrap; }
      .sm-table .sm-row-actions button {
        background: transparent; color: var(--ttv-muted, #888);
        border: 1px solid transparent; border-radius: 4px;
        cursor: pointer; font: inherit; font-size: 13px;
        padding: 6px 10px; min-height: 32px; margin-left: 4px;
      }
      .sm-table .sm-row-actions button:hover {
        background: var(--ttv-bg-elev2, #2a2a2a);
        color: var(--ttv-fg, #e6e6e6);
        border-color: var(--ttv-border, #333);
      }
      .sm-table .sm-row-actions button.sm-danger { color: #ff9c9c; }
      .sm-toolbar { margin: 4px 0 12px; }
      .sm-toolbar button {
        background: var(--ttv-bg-elev2, #2a2a2a);
        color: var(--ttv-fg, #e6e6e6);
        border: 1px solid var(--ttv-border, #333);
        border-radius: 4px; cursor: pointer; font: inherit; font-size: 14px;
        padding: 8px 14px; min-height: 36px;
      }
      .sm-empty {
        color: var(--ttv-muted, #888); font-size: 13px;
        padding: 24px 8px; text-align: center;
      }
    `;
    document.head.appendChild(st);
  }
  function openDialog({ title, fields, submitLabel, danger, hint }) {
    return new Promise(function(resolve) {
      ensureStyle();
      const overlay = document.createElement('div');
      overlay.className = 'sm-modal-overlay';
      const modal = document.createElement('div');
      modal.className = 'sm-modal';
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
          hi.className = 'sm-hint';
          hi.textContent = f.hint;
          modal.appendChild(hi);
        }
      });
      if (hint) {
        const gh = document.createElement('div');
        gh.className = 'sm-hint';
        gh.textContent = hint;
        gh.style.marginTop = '8px';
        modal.appendChild(gh);
      }
      const err = document.createElement('div');
      err.className = 'sm-err';
      err.style.display = 'none';
      modal.appendChild(err);
      const btnRow = document.createElement('div');
      btnRow.className = 'sm-buttons';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      const submit = document.createElement('button');
      submit.type = 'button';
      submit.textContent = submitLabel || 'OK';
      submit.className = danger ? 'sm-danger' : 'sm-primary';
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
  async function promptUntilSuccess(opts, doOp) {
    while (true) {
      const r = await openDialog(opts);
      if (!r) return null;
      try {
        await doOp(r.values);
        return r.values;
      } catch (e) {
        r.showError(String(e.message || e));
        opts.fields = opts.fields.map(function(f) {
          return Object.assign({}, f, { value: r.values[f.key] || '' });
        });
      }
    }
  }

  // === Settings tab ===
  tv.contributes.settingsTab({
    id: 'ttyview-session-manager',
    title: 'Sessions',
    render: function(container) {
      ensureStyle();
      container.innerHTML = '';

      const intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 12px;';
      intro.textContent = 'Create, rename and kill tmux sessions. Same actions live inline in the pane picker.';
      container.appendChild(intro);

      const toolbar = document.createElement('div');
      toolbar.className = 'sm-toolbar';
      const newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.textContent = '＋ New session';
      toolbar.appendChild(newBtn);
      container.appendChild(toolbar);

      const tableWrap = document.createElement('div');
      container.appendChild(tableWrap);

      function refresh() {
        const panes = tv.listPanes() || [];
        // Dedupe to unique sessions; remember pane count so kill-confirm
        // can say "kills N panes".
        const counts = {};
        panes.forEach(function(p) {
          if (!p.session) return;
          counts[p.session] = (counts[p.session] || 0) + 1;
        });
        const sessions = Object.keys(counts).sort(function(a, b) { return a.localeCompare(b); });
        tableWrap.innerHTML = '';
        if (sessions.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'sm-empty';
          empty.textContent = 'No sessions. Tap ＋ to create one.';
          tableWrap.appendChild(empty);
          return;
        }
        const tbl = document.createElement('table');
        tbl.className = 'sm-table';
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>Session</th><th>Panes</th><th></th></tr>';
        tbl.appendChild(thead);
        const tbody = document.createElement('tbody');
        sessions.forEach(function(name) {
          const tr = document.createElement('tr');
          const td1 = document.createElement('td');
          td1.textContent = name;
          const td2 = document.createElement('td');
          td2.textContent = String(counts[name]);
          td2.style.color = 'var(--ttv-muted, #888)';
          const td3 = document.createElement('td');
          td3.className = 'sm-row-actions';
          const renameBtn = document.createElement('button');
          renameBtn.textContent = 'Rename';
          renameBtn.addEventListener('click', async function() {
            await promptUntilSuccess({
              title: 'Rename session',
              fields: [{ key: 'to', label: 'New name', value: name,
                         placeholder: name,
                         hint: 'Letters, digits, _ . - · max 64 chars' }],
              submitLabel: 'Rename',
            }, function(vals) { return apiRenameSession(name, vals.to); });
            setTimeout(refresh, 0);
            setTimeout(refresh, 800);
          });
          const killBtn = document.createElement('button');
          killBtn.className = 'sm-danger';
          killBtn.textContent = 'Kill';
          killBtn.addEventListener('click', async function() {
            const n = counts[name];
            const confirm = await openDialog({
              title: 'Kill session?',
              fields: [],
              hint: 'Kills tmux session "' + name + '" and its ' + n +
                    ' pane' + (n === 1 ? '' : 's') + '. This is not reversible.',
              submitLabel: 'Kill',
              danger: true,
            });
            if (!confirm) return;
            try { await apiKillSession(name); }
            catch (e) { alert('Kill failed: ' + (e.message || e)); return; }
            setTimeout(refresh, 0);
            setTimeout(refresh, 800);
          });
          td3.appendChild(renameBtn);
          td3.appendChild(killBtn);
          tr.appendChild(td1);
          tr.appendChild(td2);
          tr.appendChild(td3);
          tbody.appendChild(tr);
        });
        tbl.appendChild(tbody);
        tableWrap.appendChild(tbl);
      }

      newBtn.addEventListener('click', async function() {
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
        setTimeout(refresh, 0);
        setTimeout(refresh, 800);
      });

      // Re-render whenever the pane list changes (covers external
      // tmux new-session / kill-session as well as our own ops).
      const offUpdated = tv.on('panes-updated', refresh);
      refresh();

      // Settings tabs don't have a formal unmount hook today; the
      // platform replaces the container's innerHTML when switching
      // tabs, which naturally drops our listeners. Leak risk is
      // minimal — the listener queue gc's stale handlers eventually.
      void offUpdated;
    },
  });
})();
