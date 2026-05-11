// ttyview-app-name — show the daemon instance name in the header.
//
// Reads `name` from GET /api/instance — populated by the daemon's
// --app-name flag. ttyview-manager passes manifest.name when spawning
// each app's daemon. Plugin renders nothing if no name is set, so it
// safely no-ops on a vanilla ttyview (no flag, no ugliness).
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
    // Default to its own row above the main header. Reads as a title
    // bar on mobile. User can move it back into the right side of
    // the header via Settings → Layout.
    preferredSlot: 'top-bar',
    render: function(slot) {
      const span = document.createElement('span');
      span.style.cssText =
        'font-weight:600;color:var(--ttv-accent);font-size:14px;' +
        'padding:0 4px;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;max-width:100%;flex:1;';
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
