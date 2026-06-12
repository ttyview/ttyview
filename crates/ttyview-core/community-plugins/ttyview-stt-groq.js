// ttyview-stt-groq — dictate into the message input, with a choice of
// engines (superset of ttyview-stt; bundle ONE of the two, not both —
// they contribute the same mic button).
//
//   • Web Speech (default) — the browser's SpeechRecognition, zero
//     config, instant. Segment mode: one utterance per tap, interim
//     text previews live in the textarea. Same behavior as the plain
//     ttyview-stt plugin.
//   • Groq Whisper + LLM cleanup — records audio (MediaRecorder),
//     sends it to Groq's Whisper API (`whisper-large-v3-turbo`), then
//     passes the transcript through `llama-3.3-70b-versatile` to fix
//     punctuation, near-miss technical words, and Whisper's hallucinated
//     trailing sign-offs ("Thank you", "Bye", …). The pipeline is a
//     port of tmux-web's /api/stt/groq-clean, but runs entirely in the
//     browser: Groq's API is CORS-open, so no daemon endpoint or proxy
//     is needed. Bring your own API key (free tier is plenty) —
//     Settings → Voice Input. The key lives in this origin's
//     localStorage; on a loopback/tailnet-only daemon that's your own
//     browser profile, but don't paste a key you can't rotate.
//
// While a Groq recording runs, Web Speech (when available) provides a
// live interim preview in the textarea; the final Groq transcript
// replaces it. If the Groq call fails, the preview text is kept as a
// degraded-but-useful fallback.
//
// Stage timings + errors are logged via window.ttyviewLog('stt-groq',…)
// when the logs plugin is present (Settings → Client Logs).
(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const hasMediaRec = !!(navigator.mediaDevices && window.MediaRecorder);
  if (!SR && !hasMediaRec) return;   // nothing we could ever do — no dead button

  const STORAGE = tv.storage('ttyview-stt-groq');
  const DEFAULTS = {
    engine: 'webspeech',           // 'webspeech' | 'groq'
    groqKey: '',
    language: 'en',                // Whisper language hint; '' = auto-detect
    cleanup: true,                 // LLM cleanup pass after Whisper
    livePreview: true,             // Web Speech interim preview during Groq recording
    vocab: 'Claude Code, tmux, ttyview, mobile-cc, git, commit, rebase, branch, ' +
           'repo, diff, merge, cargo, rustc, npm, systemd, journalctl, ssh, sudo, ' +
           'regex, JSON, API, CLI, stdout, stderr, localhost, daemon, plugin',
  };
  const STT_MODEL = 'whisper-large-v3-turbo';
  const CLEANUP_MODEL = 'llama-3.3-70b-versatile';
  const GROQ_BASE = 'https://api.groq.com/openai/v1';
  const MAX_RECORD_MS = 120000;    // safety cap — a forgotten mic shouldn't record forever

  // Ported from tmux-web's CLEANUP_PROMPTS['technical-vocab'], generalized.
  const CLEANUP_PROMPT =
    'Clean this dictated text for a developer driving Claude Code in a terminal. ' +
    'Correct obvious near-misses for technical words, paths, flags, and session names ' +
    'only when they are clearly present in the transcript. Never invent terms from ' +
    'context. Whisper STT frequently hallucinates a trailing "Thank you", "Thanks for ' +
    'watching", "Bye", "you", or similar sign-off when the recording ends in silence — ' +
    'remove ONLY such trailing sign-offs that look hallucinated (a single short polite ' +
    'phrase isolated at the very end after a complete sentence). Do not remove "Thank ' +
    'you" if it appears mid-sentence or is part of the actual message. Return only the ' +
    'cleaned text.';

  function loadSettings() { return Object.assign({}, DEFAULTS, STORAGE.get('settings') || {}); }
  function saveSettings(s) { STORAGE.set('settings', s); }

  // Android's platform SpeechRecognition grabs the mic away from a
  // concurrently-running MediaRecorder — the recording comes out as
  // silence and Whisper returns empty text (observed 2026-06-12 on the
  // user's phone: state reached 'transcribing', Groq answered 200 with
  // ""). So no live preview during Groq recordings on Android, ever.
  const IS_ANDROID = /Android/i.test(navigator.userAgent);

  function log(ev, data) {
    const rec = Object.assign({ ev: ev }, data || {});
    try {
      if (typeof window.ttyviewLog === 'function') window.ttyviewLog('stt-groq', rec);
    } catch (_) {}
    // Also ship to the daemon's diag log (--diag-log JSONL) so STT
    // failures are debuggable from the host without the phone.
    try {
      if (typeof window.ttvDiag === 'function') window.ttvDiag('stt-groq', rec);
    } catch (_) {}
  }

  function input() { return document.getElementById('input-text'); }
  function setText(t) {
    const el = input();
    if (!el) return;
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // Committed text the dictation appends after — whatever was already typed.
  function typedBase() {
    const el = input();
    return el && el.value ? el.value.replace(/\s+$/, '') + ' ' : '';
  }

  function ensureStyles() {
    if (document.getElementById('ttyview-stt-groq-style')) return;
    const st = document.createElement('style');
    st.id = 'ttyview-stt-groq-style';
    st.textContent = `
      .ttv-sttg-rec {
        border-color: #ff4444 !important;
        color: #ff4444 !important;
      }
      .ttv-sttg-rec svg { animation: ttv-sttg-pulse 1s ease-in-out infinite; }
      .ttv-sttg-busy svg { animation: ttv-sttg-pulse 0.6s ease-in-out infinite; }
      @keyframes ttv-sttg-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.35; }
      }
      .ttv-sttg-toast {
        position: fixed; left: 50%; transform: translateX(-50%);
        bottom: 110px; z-index: 9999; max-width: 86vw;
        background: var(--ttv-bg-elev2, #222); color: var(--ttv-fg, #ddd);
        border: 1px solid var(--ttv-border, #444); border-radius: 8px;
        padding: 8px 14px; font-size: 13px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        opacity: 0; transition: opacity 0.2s;
      }
      .ttv-sttg-toast.err { border-color: #ff4444; color: #ff6666; }
      .ttv-sttg-toast.show { opacity: 1; }
    `;
    document.head.appendChild(st);
  }

  let toastEl = null, toastTimer = null;
  function toast(msg, isErr) {
    ensureStyles();
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'ttv-sttg-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.toggle('err', !!isErr);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { toastEl.classList.remove('show'); }, 3500);
  }

  // Same outline mic icon as ttyview-stt / tmux-web.
  const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>';

  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (const c of candidates) {
      try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (_) {}
    }
    return '';
  }
  function extForMime(mime) {
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('mp4'))  return 'mp4';
    if (mime.includes('ogg'))  return 'ogg';
    return 'webm';
  }

  // === Groq pipeline (browser-direct; Groq's API is CORS-open) ===

  async function groqTranscribe(blob, mime, settings) {
    const fd = new FormData();
    fd.append('file', blob, 'audio.' + extForMime(mime));
    fd.append('model', STT_MODEL);
    fd.append('response_format', 'json');
    if (settings.language) fd.append('language', settings.language);
    // Whisper "prompt" biases recognition toward this vocabulary.
    if (settings.vocab) fd.append('prompt', settings.vocab.slice(0, 800));
    const t0 = performance.now();
    const r = await fetch(GROQ_BASE + '/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + settings.groqKey },
      body: fd,
    });
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) {
      const body = await r.text().catch(function() { return ''; });
      log('stt-error', { status: r.status, ms: ms, body: body.slice(0, 200) });
      throw new Error('Groq STT failed (HTTP ' + r.status + ')');
    }
    const j = await r.json();
    const text = (j.text || '').trim();
    log('stt-done', { ms: ms, text_len: text.length, text: text.slice(0, 160), audio_bytes: blob.size });
    return text;
  }

  // Cleanup failure is non-fatal: fall back to the raw transcript.
  async function groqCleanup(text, settings) {
    const promptText =
      CLEANUP_PROMPT +
      '\n\nContext and vocabulary:\n' + (settings.vocab || '(none)') +
      '\n\nRaw transcript:\n' + text +
      '\n\nIf the raw transcript is empty or silence, return exactly EMPTY.';
    const t0 = performance.now();
    try {
      const r = await fetch(GROQ_BASE + '/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + settings.groqKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: CLEANUP_MODEL,
          temperature: 0,
          messages: [{ role: 'user', content: promptText }],
        }),
      });
      const ms = Math.round(performance.now() - t0);
      if (!r.ok) {
        log('cleanup-error', { status: r.status, ms: ms });
        return text;
      }
      const j = await r.json();
      let cleaned = ((j.choices && j.choices[0] && j.choices[0].message &&
                      j.choices[0].message.content) || '').trim();
      if (cleaned === 'EMPTY') cleaned = '';
      log('cleanup-done', { ms: ms, raw_len: text.length, cleaned_len: cleaned.length, cleaned: cleaned.slice(0, 160), changed: cleaned !== text });
      // The model over-triggers on the "return EMPTY for silence"
      // instruction for short utterances (observed 2026-06-12: a real
      // 36-char transcript came back EMPTY). Whisper already decided
      // there was speech — never let cleanup erase it.
      if (!cleaned) {
        log('cleanup-emptied-fallback-raw', { raw_len: text.length });
        return text;
      }
      return cleaned;
    } catch (e) {
      log('cleanup-error', { error: String(e && e.message || e) });
      return text;
    }
  }

  // === The mic button ===

  tv.contributes.inputAccessory({
    id: 'ttyview-stt-groq',
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

      // State machine: 'idle' | 'recording' | 'transcribing' (groq only).
      let state = 'idle';
      let base = '';            // committed text — typed prefix + finalized speech
      let preview = '';         // last Web Speech text during a Groq recording
      let rec = null;           // SpeechRecognition (webspeech engine / preview)
      let mediaRec = null;      // MediaRecorder (groq engine)
      let chunks = [];
      let mime = '';
      let safetyTimer = null;

      function setUiState(s) {
        state = s;
        btn.classList.toggle('ttv-sttg-rec', s === 'recording');
        btn.classList.toggle('ttv-sttg-busy', s === 'transcribing');
        btn.title = s === 'recording'    ? 'Listening… tap to stop'
                  : s === 'transcribing' ? 'Transcribing…'
                  : 'Dictate (tap to start/stop)';
      }

      // --- Web Speech: full engine (segment mode) or Groq live preview ---
      function startRecognition(opts) {
        if (!SR) return null;
        const r = new SR();
        r.lang = loadSettings().language
          ? loadSettings().language : (navigator.language || 'en-US');
        // Whisper takes bare codes ("en"); Web Speech wants BCP-47. "en"
        // works in Chrome, but normalize the common case for safety.
        if (r.lang === 'en') r.lang = 'en-US';
        r.interimResults = true;
        r.continuous = !!opts.continuous;
        r.onresult = function(e) {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            if (res.isFinal) {
              if (opts.commitFinals) base += res[0].transcript.trim() + ' ';
              else preview += res[0].transcript.trim() + ' ';
            } else {
              interim += res[0].transcript;
            }
          }
          const committed = opts.commitFinals ? base : base + preview;
          setText(interim ? committed + interim : committed);
        };
        r.onerror = function(e) {
          if (e.error !== 'no-speech' && e.error !== 'aborted') {
            log('webspeech-error', { error: e.error });
          }
        };
        r.onend = opts.onend || null;
        try { r.start(); } catch (e) { return null; }
        return r;
      }

      function startWebSpeech() {
        if (!SR) {
          toast('Web Speech unavailable in this browser — switch the engine to Groq in Settings → Voice Input', true);
          return;
        }
        base = typedBase();
        rec = startRecognition({
          commitFinals: true,
          onend: function() {
            // Fires after stop(), errors, and natural silence alike.
            rec = null;
            setUiState('idle');
            setText(base);
          },
        });
        if (rec) setUiState('recording');
      }

      // --- Groq engine ---
      async function startGroq(settings) {
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
          toast('Microphone access denied', true);
          log('mic-denied', { error: String(e && e.message || e) });
          return;
        }
        mime = pickMime();
        try {
          mediaRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        } catch (e) {
          stream.getTracks().forEach(function(t) { t.stop(); });
          toast('Recording unsupported on this browser', true);
          log('mediarec-failed', { error: String(e && e.message || e), mime: mime });
          return;
        }
        mime = mediaRec.mimeType || mime || 'audio/webm';
        chunks = [];
        base = typedBase();
        preview = '';
        mediaRec.ondataavailable = function(e) {
          if (e.data && e.data.size) chunks.push(e.data);
        };
        mediaRec.onstop = function() {
          stream.getTracks().forEach(function(t) { t.stop(); });
          finishGroq(settings);
        };
        mediaRec.start();
        log('record-start', { mime: mime, preview: settings.livePreview && !!SR && !IS_ANDROID });
        if (settings.livePreview && SR && !IS_ANDROID) {
          rec = startRecognition({ commitFinals: false, onend: function() { rec = null; } });
        }
        setUiState('recording');
        safetyTimer = setTimeout(function() {
          if (state === 'recording') stopGroqRecording();
        }, MAX_RECORD_MS);
      }

      function stopGroqRecording() {
        clearTimeout(safetyTimer);
        if (rec) { try { rec.abort(); } catch (_) {} rec = null; }
        if (mediaRec && mediaRec.state !== 'inactive') {
          try { mediaRec.stop(); } catch (_) {}   // onstop → finishGroq
        }
      }

      async function finishGroq(settings) {
        mediaRec = null;
        const blob = new Blob(chunks, { type: mime });
        chunks = [];
        log('record-stop', { bytes: blob.size, preview_len: preview.length });
        if (blob.size < 1000) {
          setUiState('idle');
          setText(base);
          toast('No audio captured');
          return;
        }
        setUiState('transcribing');
        // Keep whatever the preview heard visible while Groq works.
        setText(base + preview);
        try {
          let text = await groqTranscribe(blob, mime, settings);
          if (text && settings.cleanup) text = await groqCleanup(text, settings);
          setUiState('idle');
          if (!text) {
            log('stt-empty', { preview_len: preview.length });
            setText(base + preview);
            if (!preview) toast('No speech detected');
            return;
          }
          setText(base + text + ' ');
        } catch (e) {
          // Degrade to the Web Speech preview if we have one.
          setUiState('idle');
          setText(base + preview);
          toast(String(e && e.message || e) + (preview ? ' — kept Web Speech text' : ''), true);
        }
      }

      btn.addEventListener('pointerup', function(e) {
        if (e.button !== undefined && e.button !== 0) return;
        const settings = loadSettings();
        if (settings.engine === 'groq' && hasMediaRec) {
          if (!settings.groqKey) {
            toast('No Groq API key — add one in Settings → Voice Input', true);
            return;
          }
          if (state === 'idle') startGroq(settings);
          else if (state === 'recording') stopGroqRecording();
          // 'transcribing': ignore taps until the pipeline settles
        } else {
          if (rec) rec.stop();
          else if (state === 'idle') startWebSpeech();
        }
      });
      btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
      slot.appendChild(btn);

      return function unmount() {
        clearTimeout(safetyTimer);
        if (rec) { try { rec.abort(); } catch (_) {} rec = null; }
        if (mediaRec && mediaRec.state !== 'inactive') {
          try { mediaRec.stream.getTracks().forEach(function(t) { t.stop(); }); } catch (_) {}
          try { mediaRec.stop(); } catch (_) {}
        }
        mediaRec = null;
        btn.remove();
      };
    },
  });

  // === Settings tab ===

  tv.contributes.settingsTab({
    id: 'ttyview-stt-groq',
    title: 'Voice Input',
    render: function(container) {
      const s = loadSettings();
      container.innerHTML = '';

      const css = {
        row: 'margin-bottom:14px;',
        label: 'display:block;font-size:12px;color:var(--ttv-muted);margin-bottom:6px;',
        input: 'width:100%;box-sizing:border-box;background:var(--ttv-bg-elev2);color:var(--ttv-fg);' +
               'border:1px solid var(--ttv-border);border-radius:4px;font:inherit;font-size:14px;padding:6px 10px;',
        hint: 'color:var(--ttv-muted);font-size:11px;margin-top:4px;',
        check: 'display:inline-flex;align-items:center;gap:8px;color:var(--ttv-fg);font-size:14px;cursor:pointer;',
      };

      const intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
      intro.textContent =
        'The 🎤 button next to the message box. Web Speech is the browser\'s built-in ' +
        'recognition — free, instant, zero config. Groq records the audio and runs it ' +
        'through Whisper plus an LLM cleanup pass — noticeably more accurate on ' +
        'technical vocabulary, needs an API key from console.groq.com (free tier works).';
      container.appendChild(intro);

      function row(build) {
        const div = document.createElement('div');
        div.style.cssText = css.row;
        build(div);
        container.appendChild(div);
        return div;
      }

      // Engine
      row(function(div) {
        const lbl = document.createElement('label');
        lbl.style.cssText = css.label;
        lbl.textContent = 'Engine';
        div.appendChild(lbl);
        const sel = document.createElement('select');
        sel.style.cssText = css.input;
        const opts = [
          ['webspeech', 'Web Speech (built-in, instant)'],
          ['groq', 'Groq Whisper + LLM cleanup (BYO key, more accurate)'],
        ];
        for (const [v, t] of opts) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          if (v === s.engine) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', function() {
          const cur = loadSettings();
          cur.engine = sel.value;
          saveSettings(cur);
        });
        div.appendChild(sel);
        if (!hasMediaRec) {
          const hint = document.createElement('div');
          hint.style.cssText = css.hint;
          hint.textContent = 'MediaRecorder unavailable in this browser — the Groq engine won\'t work here.';
          div.appendChild(hint);
        }
      });

      // Groq API key + test
      row(function(div) {
        const lbl = document.createElement('label');
        lbl.style.cssText = css.label;
        lbl.textContent = 'Groq API key';
        div.appendChild(lbl);
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;gap:8px;';
        const inp = document.createElement('input');
        // NOT type=password — that summons the phone's password manager
        // (LastPass "Save password?" sheets) for what is just an API key
        // in localStorage. Mask via CSS instead and tag the field with
        // the opt-out attributes the common managers honor.
        inp.type = 'text';
        inp.name = 'groq-api-key';
        inp.placeholder = 'gsk_…';
        inp.autocomplete = 'off';
        inp.spellcheck = false;
        inp.setAttribute('autocorrect', 'off');
        inp.setAttribute('autocapitalize', 'off');
        inp.setAttribute('data-lpignore', 'true');   // LastPass
        inp.setAttribute('data-1p-ignore', 'true');  // 1Password
        inp.setAttribute('data-bwignore', 'true');   // Bitwarden
        inp.value = s.groqKey;
        inp.style.cssText = css.input + 'flex:1;-webkit-text-security:disc;';
        inp.addEventListener('change', function() {
          const cur = loadSettings();
          cur.groqKey = inp.value.trim();
          saveSettings(cur);
        });
        wrap.appendChild(inp);
        const test = document.createElement('button');
        test.type = 'button';
        test.textContent = 'Test';
        test.style.cssText = 'background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);' +
                             'border-radius:4px;font:inherit;font-size:13px;padding:6px 14px;cursor:pointer;';
        test.addEventListener('click', async function() {
          const key = inp.value.trim();
          if (!key) { toast('Enter a key first', true); return; }
          test.disabled = true;
          test.textContent = '…';
          try {
            const r = await fetch(GROQ_BASE + '/models', { headers: { 'Authorization': 'Bearer ' + key } });
            toast(r.ok ? 'Key works ✓' : 'Key rejected (HTTP ' + r.status + ')', !r.ok);
          } catch (e) {
            toast('Could not reach Groq: ' + String(e && e.message || e), true);
          }
          test.disabled = false;
          test.textContent = 'Test';
        });
        wrap.appendChild(test);
        div.appendChild(wrap);
        const hint = document.createElement('div');
        hint.style.cssText = css.hint;
        hint.textContent = 'Stored in this browser\'s localStorage for this origin only.';
        div.appendChild(hint);
      });

      // Language
      row(function(div) {
        const lbl = document.createElement('label');
        lbl.style.cssText = css.label;
        lbl.textContent = 'Language (ISO code, blank = auto-detect)';
        div.appendChild(lbl);
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = 'en';
        inp.value = s.language;
        inp.style.cssText = css.input + 'max-width:120px;';
        inp.addEventListener('change', function() {
          const cur = loadSettings();
          cur.language = inp.value.trim();
          saveSettings(cur);
        });
        div.appendChild(inp);
      });

      // Toggles
      function toggleRow(label, hintText, key) {
        row(function(div) {
          const cbLbl = document.createElement('label');
          cbLbl.style.cssText = css.check;
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!s[key];
          cb.addEventListener('change', function() {
            const cur = loadSettings();
            cur[key] = cb.checked;
            saveSettings(cur);
          });
          cbLbl.appendChild(cb);
          cbLbl.appendChild(document.createTextNode(label));
          div.appendChild(cbLbl);
          if (hintText) {
            const hint = document.createElement('div');
            hint.style.cssText = css.hint + 'margin-left:26px;';
            hint.textContent = hintText;
            div.appendChild(hint);
          }
        });
      }
      toggleRow('LLM cleanup pass', 'Fixes punctuation, technical near-misses, and Whisper\'s hallucinated trailing sign-offs. Adds ~0.5 s.', 'cleanup');
      toggleRow('Live preview while recording', 'Shows Web Speech interim text in the message box during a Groq recording; the Groq transcript replaces it. Desktop only — on Android the platform recognizer steals the mic from the recording, so preview is always off there.', 'livePreview');

      // Vocabulary
      row(function(div) {
        const lbl = document.createElement('label');
        lbl.style.cssText = css.label;
        lbl.textContent = 'Technical vocabulary (comma-separated — biases Whisper and the cleanup pass)';
        div.appendChild(lbl);
        const ta = document.createElement('textarea');
        ta.rows = 3;
        ta.value = s.vocab;
        ta.style.cssText = css.input + 'resize:vertical;';
        ta.addEventListener('change', function() {
          const cur = loadSettings();
          cur.vocab = ta.value.trim();
          saveSettings(cur);
        });
        div.appendChild(ta);
      });
    },
  });
})();
