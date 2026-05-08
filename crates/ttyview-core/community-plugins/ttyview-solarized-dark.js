// ttyview-solarized-dark — sample theme plugin.
//
// Maps Solarized Dark colors onto ttyview's seven CSS theme variables.
// Once installed, activate from Settings → Plugins → Themes (or via
// window.ttyview._internal.setActiveThemeId('ttyview-solarized-dark') in
// the console).
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[ttyview-solarized-dark] requires apiVersion 1');
    return;
  }
  tv.contributes.theme({
    id: 'ttyview-solarized-dark',
    name: 'Solarized Dark',
    vars: {
      '--ttv-bg':       '#002b36',  // base03
      '--ttv-bg-elev':  '#073642',  // base02
      '--ttv-bg-elev2': '#073642',  // base02
      '--ttv-fg':       '#93a1a1',  // base1
      '--ttv-border':   '#586e75',  // base01
      '--ttv-accent':   '#268bd2',  // blue
      '--ttv-muted':    '#586e75',  // base01
    },
  });
})();
