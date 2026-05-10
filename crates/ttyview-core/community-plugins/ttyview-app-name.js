// ttyview-app-name — show the daemon instance name in the header.
//
// Reads `name` from GET /api/instance — populated by the daemon's
// --app-name flag. ttyview-manager passes manifest.name when spawning
// each app's daemon. Plugin renders nothing if no name is set, so it
// safely no-ops on a vanilla ttyview-daemon (no flag, no ugliness).
//
// Document title is also updated to match — handy when several
// ttyview tabs are open in the same browser; each tab's title in the
// task switcher shows its app name.
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  tv.contributes.headerWidget({
    id: 'ttyview-app-name',
    name: 'App Name',
    render: function(slot) {
      const span = document.createElement('span');
      span.style.cssText =
        'font-weight:600;color:var(--ttv-accent);font-size:13px;' +
        'padding:0 6px;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;max-width:160px;';
      slot.appendChild(span);

      let cancelled = false;
      const origTitle = document.title;
      fetch('/api/instance').then(function(r) { return r.ok ? r.json() : null; })
        .then(function(info) {
          if (cancelled || !info) return;
          if (info.name) {
            span.textContent = info.name;
            // Browser tab title — same effect as <title>, makes the
            // OS task switcher / chrome's tab strip readable.
            document.title = info.name + ' · ttyview';
          } else {
            span.textContent = '';
            span.style.display = 'none';
          }
        })
        .catch(function() {});

      return function unmount() {
        cancelled = true;
        document.title = origTitle;
        span.remove();
      };
    },
  });
})();
