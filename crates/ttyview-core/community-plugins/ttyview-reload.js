// ttyview-reload — one-tap full app reload.
//
// The bundled UI is fetched fresh from the daemon on every page load
// (the PWA service worker is a pure passthrough, no caching), so a
// plain location.reload() always picks up a redeployed daemon's UI
// and plugins. Inside an installed PWA there's no URL bar to pull —
// this button fills that gap. Especially handy while iterating on
// plugins/daemon: deploy, tap, see it.
//
// Contributes a header button and a command-palette entry.
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  // Outline refresh-cw icon, same stroke style as the input-row icons.
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';

  function reloadApp() {
    try { location.reload(); } catch (_) {}
  }

  tv.contributes.headerWidget({
    id: 'ttyview-reload',
    name: 'Reload App',
    render: function(slot) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = ICON;
      btn.style.color = 'var(--ttv-accent)';
      btn.style.display = 'inline-flex';
      btn.style.alignItems = 'center';
      btn.title = 'Reload app';
      btn.setAttribute('aria-label', 'Reload app');
      btn.addEventListener('click', reloadApp);
      slot.appendChild(btn);
      return function unmount() { btn.remove(); };
    },
  });

  tv.contributes.command({
    id: 'ttyview-reload',
    name: 'Reload app',
    handler: reloadApp,
  });
})();
