// ttyview-display-toggles — Settings → "Display" tab with toggles
// for hidden-by-default header chrome.
//
// v0.1: just one toggle (font controls A−/↔/A+). Designed to grow:
// add new entries to TOGGLES below + a CSS rule in core for each.
//
// State: per-plugin scoped storage. Body class names are applied
// at mount time AND on each setting flip; persistence survives
// reload via the boot loader re-eval'ing the plugin source.
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  const STORAGE = tv.storage('ttyview-display-toggles');

  // Toggle definitions. `bodyClass` is applied to <body> when the
  // toggle is ON; the matching `body.<class> ...` rule lives in core
  // CSS (or another plugin's CSS). `defaultOn` gives the default
  // state when no setting exists yet (false = hidden by default).
  //
  // Entries with `lsKey` instead of `bodyClass` are behavioral flags
  // that core reads from BARE localStorage (the ttv-autofit /
  // ttv-font-size pattern) — the toggle writes 'true'/'false' there
  // and pokes core via a window resize event, no CSS involved.
  const TOGGLES = [
    {
      key:       'showFontCtl',
      label:     'Show font controls (A− / ↔ / A+)',
      bodyClass: 'ttv-show-font-ctl',
      defaultOn: false,
      hint:      'Compact header without these on mobile; auto-fit usually does the right thing.',
    },
    {
      key:       'tapPromptFocus',
      label:     'Tap CC prompt to focus input',
      bodyClass: 'ttv-tap-prompt-focus',
      defaultOn: true,
      hint:      'Short tap on the row where the cursor sits (CC’s prompt area, ±1 row) focuses the bottom Message box. Long-press still selects text.',
    },
    {
      key:       'fitResize',
      label:     'Auto-resize wide panes to fit this screen',
      lsKey:     'ttv-fit-resize',
      defaultOn: true,
      hint:      'When a pane is too wide to read here (e.g. created from a desktop terminal), narrow its tmux window to fit a readable font. Narrow-only; the window is released when you disconnect.',
    },
  ];

  function isOn(t) {
    if (t.lsKey) {
      const v = localStorage.getItem(t.lsKey);
      return v === null ? t.defaultOn : v !== 'false';
    }
    const v = STORAGE.get(t.key);
    return (v === true || v === false) ? v : t.defaultOn;
  }
  function setOn(t, on) {
    if (t.lsKey) {
      localStorage.setItem(t.lsKey, on ? 'true' : 'false');
      // Core re-reads the flag inside autoFit; a resize event is the
      // cheapest way to trigger a re-fit pass right now.
      try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      return;
    }
    STORAGE.set(t.key, on);
  }
  function applyAll() {
    for (const t of TOGGLES) {
      if (t.bodyClass) document.body.classList.toggle(t.bodyClass, isOn(t));
    }
  }

  // Apply once at plugin mount so settings stick across reloads.
  applyAll();

  tv.contributes.settingsTab({
    id:    'ttyview-display-toggles',
    title: 'Display',
    render: function(container) {
      container.innerHTML = '';
      const intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
      intro.textContent = 'Toggles for built-in header chrome. Disabled chrome is hidden via CSS — re-enabling restores it instantly.';
      container.appendChild(intro);

      for (const t of TOGGLES) {
        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom:14px;';
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:10px;color:var(--ttv-fg);font-size:14px;cursor:pointer;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isOn(t);
        cb.style.cssText = 'width:18px;height:18px;flex:none;';
        cb.addEventListener('change', function() {
          setOn(t, cb.checked);
          applyAll();
        });
        label.appendChild(cb);
        const text = document.createElement('span');
        text.textContent = t.label;
        label.appendChild(text);
        row.appendChild(label);
        if (t.hint) {
          const hint = document.createElement('div');
          hint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:4px;margin-left:28px;';
          hint.textContent = t.hint;
          row.appendChild(hint);
        }
        container.appendChild(row);
      }
    },
  });
})();
