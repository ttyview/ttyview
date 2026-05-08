// ttyview-text — alternative terminal-view plugin.
//
// Renders the pane as plain text (one <div> per row, just textContent —
// no per-cell <span>, no fg/bg colors). Lighter DOM than cell-grid, and
// it proves the platform supports replacing the entire render strategy
// — not just swapping color schemes.
//
// Live updates work the same way cell-grid does: subscribes to
// 'grid-loaded' / 'cell-diff' / 'scrollback-append' / 'pane-clearing'
// events. The internal representation is a 2D char array; each cell-diff
// updates one entry and re-flattens that single row's textContent.
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[ttyview-text] requires apiVersion 1');
    return;
  }
  tv.contributes.terminalView({
    id: 'ttyview-text',
    name: 'Plain Text',
    description: 'Plain-text terminal view (no colors, no per-cell DOM). ' +
      'Sample alternative renderer that demonstrates the terminal-view ' +
      'API isn\'t cell-grid-shaped.',
    render: function(host, ctx) {
      host.innerHTML = '';
      // Container styles: monospaced, scroll, full host.
      host.style.cssText += 'font-family: ui-monospace,Menlo,Consolas,monospace;' +
        'font-size: var(--ttv-font-size, 12px);' +
        'line-height: 1.2;' +
        'overflow-y: auto;' +
        'overflow-x: hidden;' +
        'padding: 4px 6px;' +
        'white-space: pre;' +
        'word-break: keep-all;';

      // Plugin-private DOM
      const $sb = document.createElement('div');
      $sb.style.cssText = 'opacity:0.78;';  // dim scrollback so it reads as "past"
      const $pri = document.createElement('div');
      host.appendChild($sb);
      host.appendChild($pri);

      // Plugin-private state. rows[r] = Array<string> for the live
      // (primary/alt) buffer. Scrollback rows are immutable strings.
      let rows = [];
      let rowEls = [];

      function rowText(arr) {
        // Trailing-trim so blank columns don't bloat textContent.
        return arr.join('').replace(/\s+$/, '');
      }
      function frozenLine(rowSpec) {
        const cells = rowSpec.cells || [];
        let s = '';
        for (let c = 0; c < cells.length; c++) {
          const cell = cells[c];
          const w = cell.width != null ? cell.width : 1;
          s += w === 0 ? '' : (cell.ch || ' ');
        }
        return s.replace(/\s+$/, '');
      }
      function buildGrid(screen) {
        $sb.innerHTML = '';
        $pri.innerHTML = '';
        rows = [];
        rowEls = [];
        const sb = screen.scrollback || [];
        const sbFrag = document.createDocumentFragment();
        for (let r = 0; r < sb.length; r++) {
          const div = document.createElement('div');
          div.textContent = frozenLine(sb[r]);
          sbFrag.appendChild(div);
        }
        $sb.appendChild(sbFrag);
        const lines = (screen.alt && screen.alt.length) ? screen.alt : (screen.primary || []);
        for (let r = 0; r < lines.length; r++) {
          const cells = lines[r].cells || [];
          const arr = new Array(cells.length);
          for (let c = 0; c < cells.length; c++) {
            const cell = cells[c];
            const w = cell.width != null ? cell.width : 1;
            arr[c] = w === 0 ? '' : (cell.ch || ' ');
          }
          rows.push(arr);
          const div = document.createElement('div');
          div.textContent = rowText(arr);
          $pri.appendChild(div);
          rowEls.push(div);
        }
        host.scrollTop = host.scrollHeight;
      }
      // rAF batch identical to cell-grid's; tap response stays instant
      // even under streaming load.
      let pending = [];
      let rafId = 0;
      function flush() {
        rafId = 0;
        const dirtyRows = new Set();
        for (const d of pending) {
          if (d.p !== ctx.api.getActivePane()?.id) continue;
          for (const e of d.cells) {
            if (e.r >= rows.length || e.c >= rows[e.r].length) continue;
            const ch = (e.width === 0) ? '' : (e.ch || ' ');
            if (rows[e.r][e.c] !== ch) {
              rows[e.r][e.c] = ch;
              dirtyRows.add(e.r);
            }
          }
        }
        pending = [];
        for (const r of dirtyRows) {
          if (rowEls[r]) rowEls[r].textContent = rowText(rows[r]);
        }
      }
      function appendScrollback(evt) {
        if (!evt.rows || evt.rows.length === 0) return;
        const wasAtBottom = (host.scrollHeight - host.scrollTop - host.clientHeight) < 30;
        const frag = document.createDocumentFragment();
        for (const row of evt.rows) {
          const div = document.createElement('div');
          div.textContent = frozenLine(row);
          frag.appendChild(div);
        }
        $sb.appendChild(frag);
        if (wasAtBottom) host.scrollTop = host.scrollHeight;
      }

      const offGrid  = tv.on('grid-loaded',       function(d) { buildGrid(d.screen); });
      const offDiff  = tv.on('cell-diff',         function(d) {
        pending.push(d);
        if (!rafId) rafId = requestAnimationFrame(flush);
      });
      const offSb    = tv.on('scrollback-append', appendScrollback);
      const offClear = tv.on('pane-clearing',     function() {
        $sb.innerHTML = ''; $pri.innerHTML = '';
        rows = []; rowEls = [];
      });

      return function unmount() {
        offGrid(); offDiff(); offSb(); offClear();
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        pending = [];
        rows = []; rowEls = [];
        host.innerHTML = '';
      };
    },
  });
})();
