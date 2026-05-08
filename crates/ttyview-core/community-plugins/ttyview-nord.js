// ttyview-nord — Arctic, north-bluish theme by Arctic Ice Studio.
// https://www.nordtheme.com/
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  tv.contributes.theme({
    id: 'ttyview-nord',
    name: 'Nord',
    vars: {
      '--ttv-bg':       '#2e3440',  // nord0 (Polar Night)
      '--ttv-bg-elev':  '#3b4252',  // nord1
      '--ttv-bg-elev2': '#434c5e',  // nord2
      '--ttv-fg':       '#eceff4',  // nord6 (Snow Storm)
      '--ttv-border':   '#4c566a',  // nord3
      '--ttv-accent':   '#88c0d0',  // nord8 (Frost — calm cyan)
      '--ttv-muted':    '#81a1c1',  // nord9
    },
  });
})();
