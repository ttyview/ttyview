// ttyview-voice-dictation — 🎤 button that transcribes speech into
// the Message input via the browser's Web Speech API.
//
// Behaviour mirrors tmux-web's vkbd mic (the reference impl): tap to
// toggle; continuous mode; each final phrase is appended to the
// Message textarea with a trailing space; if the phrase ends with
// "enter" (or "enter."), strip that word and tap the Send button.
//
// Chrome on Android times out continuous recognition after ~60 s of
// silence and fires `end`. While `active` is true we restart it
// automatically — the user only sees the toggle as "always on" until
// they tap to stop.
//
// Contributes:
//   - inputAccessory  →  🎤 button in the keys row (above the input)
//   - settingsTab     →  Settings → Voice Dictation (lang + sayEnter)
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[voice-dictation] requires apiVersion 1');
    return;
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    console.warn('[voice-dictation] SpeechRecognition API unavailable in this browser');
    return;
  }

  const STORAGE = tv.storage('ttyview-voice-dictation');
  const DEFAULTS = { lang: 'en-US', sayEnterToSubmit: true };
  function loadSettings() { return Object.assign({}, DEFAULTS, STORAGE.get('settings') || {}); }
  function saveSettings(s) { STORAGE.set('settings', s); }

  let settings = loadSettings();
  let recognition = null;
  let active = false;
  let micBtn = null;
  let restartTimer = null;

  function getInput()   { return document.getElementById('input-text'); }
  function getSendBtn() { return document.getElementById('send-btn'); }

  function appendToInput(text) {
    const $i = getInput();
    if (!$i) return;
    const cur = $i.value;
    const sep = (cur && !/\s$/.test(cur)) ? ' ' : '';
    $i.value = cur + sep + text + ' ';
    // Trigger input event so listeners (autosize, etc.) see the change.
    $i.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function submit() {
    const $b = getSendBtn();
    if ($b) $b.click();
  }

  function buildRecognition() {
    const r = new Recognition();
    r.continuous     = true;
    r.interimResults = false;
    r.lang           = settings.lang;
    r.onresult = function(event) {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (!event.results[i].isFinal) continue;
        let text = (event.results[i][0].transcript || '').trim();
        if (!text) continue;
        let shouldSubmit = false;
        if (settings.sayEnterToSubmit) {
          const m = text.match(/\benter\.?$/i);
          if (m) {
            shouldSubmit = true;
            text = text.slice(0, m.index).trimEnd();
          }
        }
        if (text) appendToInput(text);
        // Slight delay so the input event lands before Send is clicked.
        if (shouldSubmit) setTimeout(submit, 200);
      }
    };
    r.onend = function() {
      // Chrome stops continuous recognition after ~60 s of silence —
      // restart it if the user hasn't tapped stop.
      if (active) {
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(function() {
          try { r.start(); } catch {}
        }, 200);
      } else {
        updateBtn();
      }
    };
    r.onerror = function(e) {
      console.warn('[voice-dictation]', e.error || e);
      // Permanent failures: bail out.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        stopRecognition();
      }
    };
    return r;
  }

  function startRecognition() {
    if (!recognition) recognition = buildRecognition();
    recognition.lang = settings.lang;
    active = true;
    try { recognition.start(); }
    catch (e) { /* already started; ignore */ }
    updateBtn();
  }
  function stopRecognition() {
    active = false;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (recognition) {
      try { recognition.stop(); } catch {}
    }
    updateBtn();
  }
  function toggle() {
    if (active) stopRecognition(); else startRecognition();
  }

  function updateBtn() {
    if (!micBtn) return;
    if (active) {
      micBtn.textContent = '🔴';
      micBtn.title = 'Recording — tap to stop';
      micBtn.classList.add('ttv-mic-recording');
    } else {
      micBtn.textContent = '🎤';
      micBtn.title = 'Tap to dictate';
      micBtn.classList.remove('ttv-mic-recording');
    }
  }

  function ensureStyle() {
    const id = 'ttv-voice-dictation-style';
    if (document.getElementById(id)) return;
    const st = document.createElement('style');
    st.id = id;
    st.textContent = `
      @keyframes ttv-mic-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.55 } }
      .ttv-mic-recording {
        background: rgba(255, 68, 68, 0.18) !important;
        animation: ttv-mic-pulse 1s ease-in-out infinite;
      }
    `;
    document.head.appendChild(st);
  }

  tv.contributes.inputAccessory({
    id: 'ttyview-voice-dictation',
    name: 'Voice Dictation',
    render: function(slot) {
      ensureStyle();
      settings = loadSettings();
      micBtn = document.createElement('button');
      micBtn.type = 'button';
      micBtn.tabIndex = -1;
      updateBtn();
      micBtn.addEventListener('pointerup', function(e) {
        if (e.button !== undefined && e.button !== 0) return;
        toggle();
      });
      // Don't steal focus from the textarea on mouse / desktop.
      micBtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
      slot.appendChild(micBtn);
      return function unmount() {
        stopRecognition();
        if (micBtn && micBtn.parentNode) micBtn.parentNode.removeChild(micBtn);
        micBtn = null;
      };
    },
  });

  tv.contributes.settingsTab({
    id: 'ttyview-voice-dictation',
    title: 'Voice Dictation',
    render: function(container) {
      settings = loadSettings();
      container.innerHTML = '';
      const intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
      intro.textContent =
        'Tap the 🎤 button to dictate. Each finished phrase appends to the Message box. ' +
        'Browser Web Speech API — needs microphone permission per site. ' +
        'On Chrome Android, recognition stops after ~60 s of silence; the plugin auto-restarts it ' +
        'until you tap to stop.';
      container.appendChild(intro);

      // Language
      const r1 = document.createElement('div');
      r1.style.cssText = 'margin-bottom:14px;';
      const lbl1 = document.createElement('label');
      lbl1.style.cssText = 'display:block;font-size:12px;color:var(--ttv-muted);margin-bottom:6px;';
      lbl1.textContent = 'Recognition language';
      r1.appendChild(lbl1);
      const sel = document.createElement('select');
      sel.style.cssText = 'background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);border-radius:4px;font:inherit;font-size:14px;padding:6px 10px;';
      const langs = [
        ['en-US', 'English (US)'],
        ['en-GB', 'English (UK)'],
        ['he-IL', 'Hebrew (Israel)'],
        ['es-ES', 'Spanish (Spain)'],
        ['fr-FR', 'French (France)'],
        ['de-DE', 'German (Germany)'],
        ['pt-PT', 'Portuguese (Portugal)'],
        ['pt-BR', 'Portuguese (Brazil)'],
      ];
      for (const [v, t] of langs) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        if (v === settings.lang) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', function() {
        settings.lang = sel.value;
        saveSettings(settings);
        if (recognition) recognition.lang = settings.lang;
      });
      r1.appendChild(sel);
      container.appendChild(r1);

      // "Say enter" toggle
      const r2 = document.createElement('div');
      r2.style.cssText = 'margin-bottom:14px;';
      const cbLbl = document.createElement('label');
      cbLbl.style.cssText = 'display:inline-flex;align-items:center;gap:8px;color:var(--ttv-fg);font-size:14px;cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!settings.sayEnterToSubmit;
      cb.addEventListener('change', function() {
        settings.sayEnterToSubmit = cb.checked;
        saveSettings(settings);
      });
      cbLbl.appendChild(cb);
      cbLbl.appendChild(document.createTextNode('Say "enter" at the end of a phrase to submit'));
      r2.appendChild(cbLbl);
      const hint = document.createElement('div');
      hint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin-top:4px;margin-left:26px;';
      hint.textContent = 'When on, finishing a phrase with the word "enter" strips it and taps Send.';
      r2.appendChild(hint);
      container.appendChild(r2);
    },
  });
})();
