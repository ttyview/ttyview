// ttyview-terminal-green — green-on-black CRT theme.
//
// Pairs especially well with the Claude Code view to make the chat
// look like a vintage VT220.
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  tv.contributes.theme({
    id: 'ttyview-terminal-green',
    name: 'Terminal Green',
    vars: {
      '--ttv-bg':       '#000000',
      '--ttv-bg-elev':  '#0a0a0a',
      '--ttv-bg-elev2': '#0e0e0e',
      '--ttv-fg':       '#00ff66',
      '--ttv-border':   '#114422',
      '--ttv-accent':   '#00ff99',
      '--ttv-muted':    '#338855',
    },
  });
})();
