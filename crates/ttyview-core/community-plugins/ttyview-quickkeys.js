// ttyview-quickkeys — sample inputAccessory plugin.
//
// Adds a row of common-key buttons above the chat input. Tapping a
// button sends the corresponding key sequence to the active pane via
// window.ttyview.sendInput(). Designed for mobile use where Esc/Tab/
// Ctrl-C aren't available from the soft keyboard.
//
// Demonstrates: the inputAccessory contribution point + the
// sendInput() API surface.
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[ttyview-quickkeys] requires apiVersion 1');
    return;
  }
  // Each button: { label shown, keys to send }. Order matters — left
  // to right is what the user sees.
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
        btn.textContent = k.label;
        btn.addEventListener('click', function() {
          // Suppress the soft keyboard losing focus by NOT moving focus.
          // sendInput targets the active pane (resolved inside the API).
          tv.sendInput(null, k.keys);
        });
        // Prevent the button from stealing focus from the textarea —
        // keeps the soft keyboard up so the user can keep typing
        // text after sending an Esc/Tab.
        btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
        btn.addEventListener('touchstart', function(e) { e.preventDefault(); }, { passive: false });
        slot.appendChild(btn);
        buttons.push(btn);
      }
      return function unmount() {
        for (const b of buttons) b.remove();
      };
    },
  });
})();
