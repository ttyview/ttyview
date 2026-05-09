// ttyview-quickkeys — sample inputAccessory plugin.
//
// Adds a row of common-key buttons above the chat input. Tapping a
// button sends the corresponding key sequence to the active pane via
// window.ttyview.sendInput(). Designed for mobile use where Esc/Tab/
// Ctrl-C aren't available from the soft keyboard.
//
// Demonstrates: the inputAccessory contribution point + the
// sendInput() API surface.
//
// Why pointerup (not click): on Android Chrome, calling
// `e.preventDefault()` on `touchstart` to stop the textarea losing
// focus also suppresses the synthetic `click` event for some builds.
// Diag logs from 2026-05-09 showed taps reaching `touchstart` but no
// `inp` events from these buttons — click handler simply never fired.
// Switching to `pointerup` fires on tap / mouse / pen alike with no
// reliance on the synthetic click pipeline. Focus is kept on the
// textarea via `tabindex=-1` (button isn't focusable) plus
// `mousedown.preventDefault` (cancels the desktop focus-on-mousedown).
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[ttyview-quickkeys] requires apiVersion 1');
    return;
  }
  const KEYS = [
    { label: 'Esc',    keys: '\x1b'  },
    { label: 'Tab',    keys: '\t'    },
    { label: '↑',      keys: '\x1b[A' },
    { label: '↓',      keys: '\x1b[B' },
    { label: '←',      keys: '\x1b[D' },
    { label: '→',      keys: '\x1b[C' },
    { label: 'Ctrl-C', keys: '\x03'  },
    { label: 'Ctrl-D', keys: '\x04'  },
    { label: 'Ctrl-L', keys: '\x0c'  },
    { label: 'Enter',  keys: '\r'    },
  ];
  tv.contributes.inputAccessory({
    id: 'ttyview-quickkeys',
    name: 'Quick Keys',
    render: function(slot) {
      const buttons = [];
      for (const k of KEYS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.tabIndex = -1;          // not focusable → tap doesn't blur the textarea
        btn.textContent = k.label;
        btn.addEventListener('pointerup', function(e) {
          if (e.button !== undefined && e.button !== 0) return;  // ignore right/middle
          if (typeof window.ttvDiag === 'function') {
            window.ttvDiag('qk-tap', { label: k.label, ptr: e.pointerType });
          }
          const ok = tv.sendInput(null, k.keys);
          if (typeof window.ttvDiag === 'function') {
            window.ttvDiag('qk-result', { label: k.label, ok: !!ok });
          }
        });
        // Cancel default focus-on-mousedown for desktop (touch path
        // doesn't focus thanks to tabindex=-1).
        btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
        slot.appendChild(btn);
        buttons.push(btn);
      }
      return function unmount() {
        for (const b of buttons) b.remove();
      };
    },
  });
})();
