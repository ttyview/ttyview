// ttyview-clock — sample community plugin.
//
// Registers a single headerWidget contribution that shows the
// current local time in HH:MM:SS, ticking once per second.
// Demonstrates the contribution-point + lifecycle pattern.
(function() {
  const PLUGIN_ID = 'ttyview-clock';
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[' + PLUGIN_ID + '] requires ttyview apiVersion 1');
    return;
  }
  tv.contributes.headerWidget({
    id: PLUGIN_ID,
    name: 'Clock',
    render: function(slot) {
      const span = document.createElement('span');
      span.style.cssText = 'font-variant-numeric:tabular-nums;color:#6ed29a;font-size:11px;padding:0 6px;';
      slot.appendChild(span);
      function tick() {
        const d = new Date();
        const pad = (n) => (n < 10 ? '0' : '') + n;
        span.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      }
      tick();
      const intervalId = setInterval(tick, 1000);
      return function unmount() {
        clearInterval(intervalId);
        span.remove();
      };
    },
  });
})();
