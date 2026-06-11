// ttyview-stt — dictate into the message input (speech-to-text).
//
// 🎤 button in the input row (right of the textarea, the tmux-web
// arrangement). Tap to start listening, tap again to stop; recognition
// also stops itself after a pause (segment mode — one utterance per
// tap, natural for driving Claude Code one message at a time).
// Interim results preview live in the textarea; the final transcript
// is appended to whatever was already typed.
//
// Engine: the browser's Web Speech API (SpeechRecognition) — the
// zero-config engine tier from tmux-web's STT stack. On Android
// Chrome this uses Google's online recognizer; it needs a secure
// context (https / localhost) and mic permission on first use.
// Server-side engines (Groq/Deepgram-style, as in tmux-web) would
// need daemon endpoints + API keys — out of scope for this plugin;
// a future ttyview-stt-groq could contribute the same slot.
//
// If the browser has no SpeechRecognition (e.g. Firefox), the plugin
// contributes nothing — no dead button.
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  function ensureStyles() {
    if (document.getElementById('ttyview-stt-style')) return;
    const st = document.createElement('style');
    st.id = 'ttyview-stt-style';
    st.textContent = `
      .ttv-stt-live {
        border-color: #ff4444 !important;
        color: #ff4444 !important;
      }
      .ttv-stt-live svg {
        animation: ttv-stt-pulse 1s ease-in-out infinite;
      }
      @keyframes ttv-stt-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.35; }
      }
    `;
    document.head.appendChild(st);
  }

  // tmux-web's mic icon (outline). stroke uses currentColor so the
  // accent follows the active theme and the recording state can turn
  // it red by recoloring the button.
  const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>';

  tv.contributes.inputAccessory({
    id: 'ttyview-stt',
    name: 'Voice Input',
    preferredSlot: 'input-right',
    render: function(slot) {
      ensureStyles();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.tabIndex = -1;                  // don't blur the textarea
      btn.innerHTML = MIC_SVG;
      btn.style.color = 'var(--ttv-accent)';
      btn.title = 'Dictate (tap to start/stop)';

      let rec = null;       // active SpeechRecognition, null when idle
      let base = '';        // committed text — typed prefix + finalized speech

      function input() { return document.getElementById('input-text'); }
      function setText(t) {
        const el = input();
        if (!el) return;
        el.value = t;
        // Let core's autosize / send-button logic react like typing.
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      function setLive(on) {
        btn.classList.toggle('ttv-stt-live', on);
        btn.title = on ? 'Listening… tap to stop' : 'Dictate (tap to start/stop)';
      }

      function start() {
        const r = new SR();
        r.lang = navigator.language || 'en-US';
        r.interimResults = true;
        r.continuous = false;             // segment mode: stop after a pause
        const el = input();
        base = el && el.value ? el.value.replace(/\s+$/, '') + ' ' : '';
        r.onresult = function(e) {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            if (res.isFinal) base += res[0].transcript.trim() + ' ';
            else interim += res[0].transcript;
          }
          setText(interim ? base + interim : base);
        };
        r.onerror = function(e) {
          // 'no-speech' / 'aborted' are routine; surface the rest.
          if (e.error !== 'no-speech' && e.error !== 'aborted') {
            console.warn('[ttyview-stt] recognition error:', e.error);
          }
        };
        r.onend = function() {
          // Fires after stop(), errors, and natural silence alike —
          // single place to return to idle. Drop any uncommitted
          // interim text (it was never finalized).
          rec = null;
          setLive(false);
          setText(base);
        };
        rec = r;
        setLive(true);
        try { r.start(); } catch (e) {
          rec = null;
          setLive(false);
          console.warn('[ttyview-stt] start failed:', e);
        }
      }

      btn.addEventListener('pointerup', function(e) {
        if (e.button !== undefined && e.button !== 0) return;
        if (rec) rec.stop();
        else start();
      });
      btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
      slot.appendChild(btn);

      return function unmount() {
        if (rec) { try { rec.abort(); } catch (_) {} rec = null; }
        btn.remove();
      };
    },
  });
})();
