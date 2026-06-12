// ttyview-logs — on-device client log viewer.
//
// Phones have no devtools; when a session sticks or input vanishes,
// the evidence is in the client's diag events and console errors —
// which are invisible on-device (ttvDiag ships them to the daemon's
// --diag-log, but reading that needs a shell). This plugin keeps a
// ring buffer of:
//   - every ttvDiag record (wraps window.ttvDiag — WS lifecycle,
//     sub acks, input failures, stalls)
//   - console.error / console.warn calls
//   - uncaught errors + unhandled promise rejections
// and renders them in Settings → Client Logs (newest first), with
// one-tap copy of the visible buffer for pasting into a bug report.
//
// Inspired by tmux-web's on-page debug surfaces. Capture is installed
// at plugin load and stays on for the page's lifetime — logs from
// BEFORE the settings tab is opened are the whole point.
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  const MAX = 500;
  const buf = [];           // { ts, kind, text }
  let painters = [];        // { paint, root } — live settings-tab views

  function push(kind, text) {
    buf.push({ ts: Date.now(), kind, text: String(text).slice(0, 2000) });
    if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    // settingsTab has no unmount contract — prune painters whose DOM
    // got torn down, repaint the live ones.
    painters = painters.filter(p => p.root.isConnected);
    for (const p of painters) { try { p.paint(); } catch (_) {} }
  }

  // --- capture: ttvDiag (wrap, preserve original behavior) ---
  if (typeof window.ttvDiag === 'function' && !window.ttvDiag.__ttvLogsWrapped) {
    const orig = window.ttvDiag;
    const wrapped = function(category, data) {
      try {
        push('diag', category + ' ' + JSON.stringify(data || {}));
      } catch (_) {}
      return orig.apply(this, arguments);
    };
    wrapped.__ttvLogsWrapped = true;
    window.ttvDiag = wrapped;
  }

  // --- capture: console.error / console.warn (wrap, still print) ---
  for (const level of ['error', 'warn']) {
    const orig = console[level];
    console[level] = function() {
      try {
        push(level, Array.from(arguments).map(a => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (_) { return String(a); }
        }).join(' '));
      } catch (_) {}
      return orig.apply(console, arguments);
    };
  }

  // --- capture: uncaught errors / rejections ---
  window.addEventListener('error', function(e) {
    push('uncaught', (e.message || '?') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?'));
  });
  window.addEventListener('unhandledrejection', function(e) {
    let r = e.reason;
    push('unhandledrejection', (r && r.message) || String(r));
  });

  // --- custom user/plugin logs ---
  // window.ttyviewLog('my-tag', {...}) from any plugin, the console,
  // or ad-hoc instrumentation. Kept separate from the core diag
  // stream so the viewer can filter "what the platform saw" vs
  // "what I added while debugging".
  window.ttyviewLog = function(tag, data) {
    try {
      push('custom', String(tag) + (data !== undefined ? ' ' + JSON.stringify(data) : ''));
    } catch (_) {}
  };

  push('diag', 'ttyview-logs capture installed');

  function fmtTs(ts) {
    const d = new Date(ts);
    const pad = (n, w) => String(n).padStart(w || 2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
  }

  const KIND_COLOR = {
    error: '#f48771',
    uncaught: '#f48771',
    unhandledrejection: '#f48771',
    warn: '#dcdcaa',
    diag: 'var(--ttv-muted)',
    custom: 'var(--ttv-accent)',
  };

  // Source filter groups: core diag stream vs errors vs custom logs.
  const FILTERS = [
    { id: 'all',    label: 'All',    match: () => true },
    { id: 'diag',   label: 'Core',   match: k => k === 'diag' },
    { id: 'errors', label: 'Errors', match: k => k === 'error' || k === 'warn' || k === 'uncaught' || k === 'unhandledrejection' },
    { id: 'custom', label: 'Custom', match: k => k === 'custom' },
  ];
  let activeFilter = 'all';

  tv.contributes.settingsTab({
    id: 'ttyview-logs',
    title: 'Client Logs',
    render: function(container) {
      container.innerHTML = '';

      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap;';
      function mkBtn(label) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = 'background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);border-radius:4px;cursor:pointer;font-size:12px;padding:6px 12px;';
        return b;
      }
      const copyBtn = mkBtn('Copy all');
      const clearBtn = mkBtn('Clear');
      const count = document.createElement('span');
      count.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-left:auto;';
      bar.appendChild(copyBtn);
      bar.appendChild(clearBtn);
      bar.appendChild(count);
      container.appendChild(bar);

      // Source filter chips.
      const filterBar = document.createElement('div');
      filterBar.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
      const chipBtns = {};
      function syncChips() {
        for (const f of FILTERS) {
          const on = activeFilter === f.id;
          chipBtns[f.id].style.borderColor = on ? 'var(--ttv-accent)' : 'var(--ttv-border)';
          chipBtns[f.id].style.color = on ? 'var(--ttv-accent)' : 'var(--ttv-muted)';
        }
      }
      for (const f of FILTERS) {
        const chip = mkBtn(f.label);
        chip.style.padding = '4px 10px';
        chip.addEventListener('click', function() {
          activeFilter = f.id;
          syncChips();
          paint();
        });
        chipBtns[f.id] = chip;
        filterBar.appendChild(chip);
      }
      container.appendChild(filterBar);

      const list = document.createElement('div');
      list.style.cssText = 'font: 11px/1.5 ui-monospace, monospace; overflow-wrap: anywhere;';
      container.appendChild(list);

      function paint() {
        const flt = FILTERS.find(f => f.id === activeFilter) || FILTERS[0];
        const visible = buf.filter(e => flt.match(e.kind));
        count.textContent = visible.length + (activeFilter === 'all' ? '' : '/' + buf.length) + ' entries';
        list.innerHTML = '';
        // Newest first — the thing you're debugging just happened.
        for (let i = visible.length - 1; i >= 0; i--) {
          const e = visible[i];
          const row = document.createElement('div');
          row.style.cssText = 'padding:2px 0;border-bottom:1px solid var(--ttv-border);color:' + (KIND_COLOR[e.kind] || 'var(--ttv-fg)') + ';';
          row.textContent = fmtTs(e.ts) + ' [' + e.kind + '] ' + e.text;
          list.appendChild(row);
        }
      }

      copyBtn.addEventListener('click', function() {
        const text = buf.map(e => fmtTs(e.ts) + ' [' + e.kind + '] ' + e.text).join('\n');
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
          .then(() => { copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy all', 1200); })
          .catch(() => { copyBtn.textContent = 'Copy failed'; setTimeout(() => copyBtn.textContent = 'Copy all', 1200); });
      });
      clearBtn.addEventListener('click', function() {
        buf.length = 0;
        paint();
      });

      syncChips();
      paint();
      painters.push({ paint, root: list });
    },
  });
})();
