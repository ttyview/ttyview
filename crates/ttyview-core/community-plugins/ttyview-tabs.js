// ttyview-tabs — pinned-pane tab row above the grid.
//
// Tap a tab to switch panes (uses ttyview.selectPane). '+' pins the
// active pane. Long-press a tab to unpin. State persists via the
// per-plugin storage namespace, keyed by SESSION NAME (with pane id
// kept as a fast-path resolver) — so the tabs survive a tmux server
// restart that mints new pane ids, falling back to session-name match.
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  const STORAGE_KEY = 'pins';
  const LONG_PRESS_MS = 500;

  tv.contributes.tabBar({
    id: 'ttyview-tabs',
    name: 'Pinned Tabs',
    render: function(slot) {
      // Inline styles so the plugin is self-contained — no external
      // stylesheet, no class-name collisions with the platform.
      const styleId = 'ttyview-tabs-style';
      if (!document.getElementById(styleId)) {
        const st = document.createElement('style');
        st.id = styleId;
        st.textContent = `
          .ttvtab {
            flex: none;
            background: var(--ttv-bg-elev2);
            color: var(--ttv-fg);
            border: 1px solid var(--ttv-border);
            border-radius: 4px;
            padding: 5px 10px;
            font-size: 12px;
            font-family: inherit;
            white-space: nowrap;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            user-select: none;
            -webkit-user-select: none;
            touch-action: manipulation;
          }
          .ttvtab:active { filter: brightness(1.15); }
          .ttvtab.active {
            background: var(--ttv-bg);
            border-color: var(--ttv-accent);
            color: var(--ttv-accent);
          }
          .ttvtab.missing { opacity: 0.45; font-style: italic; }
          .ttvtab .ttvtab-x {
            font-size: 14px; line-height: 1;
            opacity: 0;
            transition: opacity 80ms;
          }
          .ttvtab.editing .ttvtab-x { opacity: 0.7; }
          .ttvtab.editing { animation: ttvtab-pulse 0.6s infinite alternate; }
          @keyframes ttvtab-pulse { from { background: var(--ttv-bg-elev2); } to { background: var(--ttv-border); } }
          .ttvtab-add {
            background: transparent;
            border: 1px dashed var(--ttv-border);
            color: var(--ttv-muted);
          }
          .ttvtab-add:active { color: var(--ttv-accent); border-color: var(--ttv-accent); }
        `;
        document.head.appendChild(st);
      }

      const storage = tv.storage('ttyview-tabs');
      // Stored shape: [ { id: '%5', session: 'tmux-web1' } ]
      let pins = (function() {
        const v = storage.get(STORAGE_KEY);
        return Array.isArray(v) ? v : [];
      })();

      let editingId = null;   // id of tab currently in long-press "remove?" mode

      function savePins() { storage.set(STORAGE_KEY, pins); }

      function resolvePin(pin, panes) {
        // Fast path: exact pane id match (same tmux server still up).
        if (pin.id) {
          const byId = panes.find(p => p.id === pin.id);
          if (byId) return byId;
        }
        // Fallback: session-name match. Handles tmux server restart →
        // new pane ids; the user picked the session, not a pane snapshot.
        if (pin.session) {
          const bySess = panes.find(p => p.session === pin.session);
          if (bySess) {
            // Refresh the stored id so future fast-paths hit.
            pin.id = bySess.id;
            savePins();
            return bySess;
          }
        }
        return null;
      }

      function render() {
        slot.innerHTML = '';
        const panes = tv.listPanes();
        const active = tv.getActivePane();
        // Existing tabs
        for (const pin of pins.slice()) {
          const resolved = resolvePin(pin, panes);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ttvtab';
          if (editingId === pin.id) btn.classList.add('editing');
          if (!resolved) btn.classList.add('missing');
          else if (active && resolved.id === active.id) btn.classList.add('active');
          // Label: prefer session name (stable across restarts).
          const label = document.createElement('span');
          label.textContent = pin.session || pin.id || '?';
          btn.appendChild(label);
          // Inline x — visible only in editing mode (long-press).
          const xs = document.createElement('span');
          xs.className = 'ttvtab-x';
          xs.textContent = '×';
          btn.appendChild(xs);
          attachTapHandlers(btn, pin, resolved);
          slot.appendChild(btn);
        }
        // Pin-current button — only show if active pane isn't already
        // pinned. Provides obvious affordance for adding tabs.
        if (active && !pins.find(p => p.session === active.session)) {
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'ttvtab ttvtab-add';
          add.textContent = '+ ' + (active.session || active.id);
          add.title = 'Pin current pane';
          add.addEventListener('click', function() {
            pins.push({ id: active.id, session: active.session });
            savePins();
            render();
          });
          // Don't steal focus from the textarea on mobile.
          add.addEventListener('mousedown', function(e) { e.preventDefault(); });
          add.addEventListener('touchstart', function(e) { e.preventDefault(); }, { passive: false });
          slot.appendChild(add);
        }
      }

      function attachTapHandlers(btn, pin, resolved) {
        let pressTimer = null;
        let longPressed = false;

        function clearTimer() {
          if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        }
        function startPress() {
          longPressed = false;
          clearTimer();
          pressTimer = setTimeout(function() {
            longPressed = true;
            // Enter editing mode for this pin — next click on the tab
            // (or its × glyph) removes it. Tapping anywhere else
            // dismisses the editing state.
            editingId = pin.id || pin.session;
            render();
          }, LONG_PRESS_MS);
        }
        function endPress(e) {
          clearTimer();
          if (longPressed) {
            // Long-press ALREADY triggered editing — don't fire click.
            longPressed = false;
            return;
          }
          // Short tap.
          if (editingId === (pin.id || pin.session)) {
            // We were in editing mode for this tab → tap unpins it.
            pins = pins.filter(p => (p.id || p.session) !== (pin.id || pin.session));
            editingId = null;
            savePins();
            render();
            return;
          }
          if (editingId) {
            // Editing mode was on for a DIFFERENT tab — exit it.
            editingId = null;
            render();
            return;
          }
          // Normal tap → switch to the resolved pane (if available).
          if (resolved) {
            tv.selectPane(resolved.id);
          }
        }
        btn.addEventListener('pointerdown', function(e) { startPress(); });
        btn.addEventListener('pointerup',   function(e) { endPress(e); });
        btn.addEventListener('pointerleave', function() { clearTimer(); longPressed = false; });
        btn.addEventListener('pointercancel', function() { clearTimer(); longPressed = false; });
        // Don't steal focus from the textarea on mobile.
        btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
        btn.addEventListener('touchstart', function(e) { e.preventDefault(); }, { passive: false });
      }

      // Re-render whenever the active pane changes or the pane list refreshes
      // (otherwise the active highlight + "+" affordance stays stale).
      const off1 = tv.on('pane-changed',  render);
      const off2 = tv.on('panes-updated', render);

      // Tap-anywhere-else in the tab strip → exit editing mode.
      slot.addEventListener('click', function(e) {
        if (!e.target.closest('.ttvtab') && editingId !== null) {
          editingId = null;
          render();
        }
      });

      render();
      return function unmount() {
        off1(); off2();
        const st = document.getElementById(styleId);
        if (st) st.remove();
        slot.innerHTML = '';
      };
    },
  });
})();
