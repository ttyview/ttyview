// ttyview-cc — Claude Code conversation view (terminalView plugin).
//
// Reads CC's on-disk JSONL transcript for the active pane via the
// daemon's /panes/:id/cc-transcript endpoint and renders it as a
// chat-bubble UI: user / assistant / tool-use turns. Polls every
// POLL_MS for new turns; the daemon does the file-tail work.
//
// Why a separate view (not a layer on top of cell-grid): CC's TUI
// renders the same conversation into the terminal pane, but at the
// width tmux gave it (often cramped on phones), with chrome that
// re-leaks into scrollback on every redraw. Reading the JSONL means
// no parser quirks, mobile-friendly word wrap, stable timestamps,
// and trivial copy/paste of any individual turn.
//
// Style is purely CSS-vars-based so any active theme applies. Pair
// with the Terminal Green theme to make it look like a CRT.
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;
  const POLL_MS = 2000;

  tv.contributes.terminalView({
    id: 'ttyview-cc',
    name: 'Claude Code',
    description: 'Chat-style render of the active pane\'s CC JSONL transcript.',
    render: function(host, ctx) {
      host.innerHTML = '';
      host.style.cssText += 'overflow-y:auto;padding:8px 10px;' +
        'font-family: ui-monospace,Menlo,Consolas,monospace;' +
        'font-size: var(--ttv-font-size, 13px);' +
        'line-height: 1.4;' +
        'color: var(--ttv-fg);';

      const $status = document.createElement('div');
      $status.style.cssText = 'color:var(--ttv-muted);font-size:11px;padding:4px 0 8px;';
      $status.textContent = 'Loading CC transcript…';
      host.appendChild($status);

      const $list = document.createElement('div');
      $list.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
      host.appendChild($list);

      // ---- styles inserted once per render() ----
      // Inlined so the plugin is self-contained — no <style> tag in
      // the bundle, no class-name collisions with the platform.
      const styleId = 'ttyview-cc-style';
      if (!document.getElementById(styleId)) {
        const st = document.createElement('style');
        st.id = styleId;
        st.textContent = `
          .ccv-turn { padding: 6px 9px; border-radius: 6px; max-width: 100%; word-break: break-word; white-space: pre-wrap; }
          .ccv-user { background: var(--ttv-bg-elev2); border-left: 3px solid var(--ttv-accent); }
          .ccv-assistant { background: var(--ttv-bg-elev); border-left: 3px solid var(--ttv-fg); }
          .ccv-tool-use { background: var(--ttv-bg-elev); border-left: 3px solid var(--ttv-muted); font-size: 0.92em; }
          .ccv-tool-result { background: var(--ttv-bg-elev2); border-left: 3px solid var(--ttv-muted); font-size: 0.88em; opacity: 0.85; }
          .ccv-thinking { color: var(--ttv-muted); font-style: italic; opacity: 0.85; }
          .ccv-meta { color: var(--ttv-muted); font-size: 10px; margin-bottom: 3px; display: flex; gap: 8px; }
          .ccv-meta .role { font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
          .ccv-tool-name { color: var(--ttv-accent); font-weight: 600; }
          .ccv-empty { color: var(--ttv-muted); padding: 8px; }
        `;
        document.head.appendChild(st);
      }

      // ---- format helpers ----
      function fmtTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        if (isNaN(+d)) return '';
        const pad = (n) => (n < 10 ? '0' : '') + n;
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      }
      function asText(content) {
        // CC's `message.content` is either a string or an array of
        // { type, text } / { type:'tool_use', name, input } / etc.
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content.map(function(b) {
          if (!b || typeof b !== 'object') return '';
          if (b.type === 'text' && typeof b.text === 'string') return b.text;
          return '';
        }).filter(Boolean).join('\n');
      }
      function findToolUses(content) {
        if (!Array.isArray(content)) return [];
        return content.filter(function(b) { return b && b.type === 'tool_use'; });
      }
      function findThinking(content) {
        if (!Array.isArray(content)) return [];
        return content.filter(function(b) { return b && b.type === 'thinking'; })
          .map(function(b) { return b.thinking || ''; })
          .filter(Boolean);
      }

      function renderTurn(t) {
        const div = document.createElement('div');
        const meta = document.createElement('div'); meta.className = 'ccv-meta';
        const role = document.createElement('span'); role.className = 'role';
        const time = document.createElement('span');
        time.textContent = fmtTime(t.timestamp);
        if (t.type === 'user' && t.message) {
          div.className = 'ccv-turn ccv-user';
          role.textContent = 'user';
          meta.appendChild(role); meta.appendChild(time);
          div.appendChild(meta);
          const body = document.createElement('div');
          body.textContent = asText(t.message.content) || '(empty)';
          div.appendChild(body);
        } else if (t.type === 'assistant' && t.message) {
          div.className = 'ccv-turn ccv-assistant';
          role.textContent = 'assistant';
          meta.appendChild(role); meta.appendChild(time);
          div.appendChild(meta);
          const text = asText(t.message.content);
          if (text) {
            const body = document.createElement('div');
            body.textContent = text;
            div.appendChild(body);
          }
          // thinking blocks (collapsed-looking)
          const thinking = findThinking(t.message.content);
          for (const th of thinking) {
            const tdiv = document.createElement('div');
            tdiv.className = 'ccv-thinking';
            tdiv.textContent = '💭 ' + th;
            div.appendChild(tdiv);
          }
          // tool uses (one row per tool call, indented)
          const tools = findToolUses(t.message.content);
          for (const tu of tools) {
            const tdiv = document.createElement('div');
            tdiv.className = 'ccv-turn ccv-tool-use';
            const name = document.createElement('span');
            name.className = 'ccv-tool-name';
            name.textContent = '⚙ ' + (tu.name || 'tool') + ' ';
            tdiv.appendChild(name);
            const inputSummary = (function() {
              const i = tu.input || {};
              // Pick the most representative field per known tool.
              if (typeof i.command === 'string') return i.command;
              if (typeof i.file_path === 'string') return i.file_path;
              if (typeof i.pattern === 'string') return i.pattern;
              if (typeof i.path === 'string') return i.path;
              if (typeof i.url === 'string') return i.url;
              try { return JSON.stringify(i).slice(0, 200); } catch { return ''; }
            })();
            const summary = document.createElement('span');
            summary.textContent = inputSummary;
            tdiv.appendChild(summary);
            div.appendChild(tdiv);
          }
          if (!text && tools.length === 0 && thinking.length === 0) {
            const body = document.createElement('div');
            body.textContent = '(no rendered content)';
            body.style.color = 'var(--ttv-muted)';
            div.appendChild(body);
          }
        } else {
          // Other types (system, file-history-snapshot, last-prompt,
          // permission-mode, …) — collapse to a one-liner so the user
          // can see them happened without overwhelming the chat.
          return null;  // skip
        }
        return div;
      }

      // ---- polling loop ----
      let lastCount = -1;
      let lastJsonl = '';
      let pollTimer = null;
      let stopped = false;

      async function fetchAndRender() {
        const pane = ctx.api.getActivePane();
        if (!pane) {
          $status.textContent = 'No active pane.';
          $list.innerHTML = '';
          return;
        }
        try {
          const r = await fetch('/panes/' + encodeURIComponent(pane.id) + '/cc-transcript?tail=300');
          if (!r.ok) {
            const txt = await r.text().catch(function() { return ''; });
            $status.textContent = 'Not a CC pane (' + r.status + '): ' + txt;
            $list.innerHTML = '';
            return;
          }
          const data = await r.json();
          const wasAtBottom = (host.scrollHeight - host.scrollTop - host.clientHeight) < 30;
          // Cheap change-detection: skip rebuild if file + count match.
          if (data.jsonl === lastJsonl && data.count === lastCount) return;
          lastJsonl = data.jsonl;
          lastCount = data.count;
          $status.textContent = data.count + ' turns · ' + (data.jsonl.split('/').pop() || '');
          $list.innerHTML = '';
          for (const t of data.turns || []) {
            const el = renderTurn(t);
            if (el) $list.appendChild(el);
          }
          if ($list.children.length === 0) {
            const e = document.createElement('div');
            e.className = 'ccv-empty';
            e.textContent = 'JSONL has no user/assistant turns yet.';
            $list.appendChild(e);
          }
          if (wasAtBottom) host.scrollTop = host.scrollHeight;
        } catch (e) {
          $status.textContent = 'Fetch error: ' + (e && e.message);
        }
      }
      function schedule() {
        if (stopped) return;
        pollTimer = setTimeout(async function() {
          await fetchAndRender();
          schedule();
        }, POLL_MS);
      }

      fetchAndRender().then(schedule);

      const offPane = tv.on('pane-changed', function() {
        // New pane → reset cache so the new transcript renders even if
        // counts happen to coincide.
        lastCount = -1; lastJsonl = '';
        fetchAndRender();
      });

      return function unmount() {
        stopped = true;
        if (pollTimer) clearTimeout(pollTimer);
        offPane();
        const st = document.getElementById(styleId);
        if (st) st.remove();
        host.innerHTML = '';
      };
    },
  });
})();
