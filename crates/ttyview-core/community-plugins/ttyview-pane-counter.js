// ttyview-pane-counter — sample community plugin.
//
// Adds a header widget showing "panes: TOTAL (IDLE idle)" where
// IDLE is the number of panes that haven't seen activity in >5 min.
// Re-renders on the `panes-updated` event.
(function() {
  const PLUGIN_ID = 'ttyview-pane-counter';
  const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[' + PLUGIN_ID + '] requires ttyview apiVersion 1');
    return;
  }
  tv.contributes.headerWidget({
    id: PLUGIN_ID,
    name: 'Pane Counter',
    render: function(slot) {
      const span = document.createElement('span');
      span.style.cssText = 'color:#999;font-size:11px;padding:0 6px;';
      slot.appendChild(span);
      function refresh() {
        const panes = tv.listPanes();
        const idle = panes.filter(p => (p.idle_ms || 0) > IDLE_THRESHOLD_MS).length;
        span.textContent = 'panes:' + panes.length + ' (' + idle + ' idle)';
      }
      refresh();
      const off = tv.on('panes-updated', refresh);
      return function unmount() {
        off();
        span.remove();
      };
    },
  });
})();
