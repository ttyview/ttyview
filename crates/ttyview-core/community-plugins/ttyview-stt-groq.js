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
// While a Groq recording runs, a LIVE PREVIEW streams words into the
// textarea as you speak; the final Groq transcript replaces it when you
// stop. If the Groq call fails, the preview text is kept as a
// degraded-but-useful fallback. Two preview engines, auto-selected:
//   • Deepgram streaming (preferred when a Deepgram key is set) — the
//     SAME MediaRecorder chunks fan out to a browser-direct WebSocket
//     (wss://api.deepgram.com/v1/listen, nova-3, interim_results). This
//     is the only real-time engine that works ON ANDROID, where the
//     platform Web Speech recognizer can't share the mic with
//     MediaRecorder. Browser-direct via the ['token', key] subprotocol —
//     no daemon proxy needed (a port of tmux-web's /ws/deepgram). BYO
//     Deepgram key in Settings → Voice Input.
//   • Web Speech (fallback when there's no Deepgram key) — the browser's
//     SpeechRecognition. Desktop only; skipped on Android for the
//     mic-contention reason above.
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
    deepgramKey: '',               // BYO — enables real-time streaming preview (works on Android)
    language: 'en',                // Whisper language hint; '' = auto-detect
    cleanup: true,                 // LLM cleanup pass after Whisper
    livePreview: true,             // live interim preview during Groq recording (Deepgram if keyed, else Web Speech)
    vocab: 'Claude Code, tmux, ttyview, mobile-cc, git, commit, rebase, branch, ' +
           'repo, diff, merge, cargo, rustc, npm, systemd, journalctl, ssh, sudo, ' +
           'regex, JSON, API, CLI, stdout, stderr, localhost, daemon, plugin',
  };
  const STT_MODEL = 'whisper-large-v3-turbo';
  const CLEANUP_MODEL = 'llama-3.3-70b-versatile';
  const GROQ_BASE = 'https://api.groq.com/openai/v1';
  const DG_LISTEN = 'wss://api.deepgram.com/v1/listen';   // Deepgram streaming STT
  const DG_MODEL = 'nova-3';
  const MAX_RECORD_MS = 120000;    // safety cap — a forgotten mic shouldn't record forever

  // Ported from tmux-web's CLEANUP_PROMPTS['technical-vocab'], generalized.
  const CLEANUP_PROMPT =
    'Clean this dictated text for a developer driving Claude Code in a terminal. ' +
    'Ensure the result has natural sentence capitalization and punctuation ' +
    '(periods, commas, question marks) the way a person would type it — add ' +
    'punctuation and capitalization where the raw transcript lacks it, without ' +
    'changing the wording. ' +
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
    // The textarea caps its height (~120px) then scrolls. As live
    // transcription appends words, keep the caret/tail in view so the
    // newest words are visible instead of stuck above the fold.
    el.scrollTop = el.scrollHeight;
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
    // Whisper "prompt" both biases recognition toward this vocabulary AND
    // primes the OUTPUT STYLE. A bare comma word-list makes Whisper emit
    // lowercase, unpunctuated text (why the final used to look "flatter"
    // than the Deepgram live preview). Lead with a properly punctuated
    // sentence so the transcript keeps sentence casing + punctuation, then
    // append the vocabulary for biasing.
    if (settings.vocab) {
      fd.append('prompt',
        'The following is a clearly punctuated technical message. Vocabulary: ' +
        settings.vocab.slice(0, 760));
    } else {
      fd.append('prompt', 'The following is a clearly punctuated technical message.');
    }
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
      // Set when the user hits Send while a recording/transcription is in
      // flight: instead of sending the half-finished preview text, we stop
      // the recording, let the pipeline (Whisper + LLM cleanup) finish, and
      // auto-send the final text once the textarea settles. Gives a second
      // way to finish dictation — tap the mic OR tap Send.
      let pendingSend = false;
      let base = '';            // committed text — typed prefix + finalized speech
      let preview = '';         // latest live-preview text (Deepgram or Web Speech)
      let previewLocked = false;// once the Groq final lands, stop letting late preview events clobber it
      let rec = null;           // SpeechRecognition (webspeech engine / preview)
      let mediaRec = null;      // MediaRecorder (groq engine)
      let chunks = [];
      let mime = '';
      let safetyTimer = null;
      // Deepgram streaming preview state.
      let dgWs = null;          // WebSocket to Deepgram (browser-direct)
      let dgFinals = [];        // finalized utterances, in order
      let dgInterim = '';       // most recent interim
      let dgPending = [];       // chunks captured before the WS handshake completed (preserves WebM header)

      // Which live-preview engine to run during a Groq recording. Deepgram
      // wins when keyed — it's the only one that works on Android (the
      // platform Web Speech recognizer can't share the mic with
      // MediaRecorder there). Web Speech is the desktop-only fallback.
      function previewEngine(settings) {
        if (!settings.livePreview) return 'none';
        if (settings.deepgramKey) return 'deepgram';
        if (SR && !IS_ANDROID) return 'webspeech';
        return 'none';
      }

      // --- Deepgram streaming (browser-direct; auth via subprotocol) ---
      function dgCompose() {
        const parts = [];
        if (dgFinals.length) parts.push(dgFinals.join(' ').trim());
        if (dgInterim) parts.push(dgInterim.trim());
        return parts.join(' ').replace(/\s+/g, ' ').trim();
      }

      // Fan a MediaRecorder chunk out to Deepgram. Buffer until the WS is
      // OPEN so the first chunk (WebM container header) always arrives
      // first — without it Deepgram can't parse the stream and stays silent.
      function dgFeed(blob) {
        if (!dgWs) return;
        blob.arrayBuffer().then(function(buf) {
          if (!dgWs) return;
          if (dgWs.readyState === WebSocket.OPEN) {
            try { dgWs.send(buf); } catch (_) {}
          } else if (dgWs.readyState === WebSocket.CONNECTING) {
            dgPending.push(buf);
          }
        }).catch(function() {});
      }

      function startDeepgram(settings) {
        dgFinals = []; dgInterim = ''; dgPending = [];
        const params = new URLSearchParams({
          model: DG_MODEL,
          language: settings.language || 'en',
          interim_results: 'true',
          smart_format: 'true',
          punctuate: 'true',
          endpointing: '300',
        });
        // Nova-3 keyterm biasing from the same vocabulary list.
        (settings.vocab || '').split(',')
          .map(function(s) { return s.trim(); })
          .filter(Boolean).slice(0, 100)
          .forEach(function(t) { params.append('keyterm', t); });
        let ws;
        try {
          // Browsers can't set an Authorization header on a WebSocket;
          // Deepgram accepts the key as the second subprotocol token.
          ws = new WebSocket(DG_LISTEN + '?' + params.toString(), ['token', settings.deepgramKey]);
          ws.binaryType = 'arraybuffer';
        } catch (e) {
          log('dg-create-error', { error: String(e && e.message || e) });
          return;
        }
        dgWs = ws;
        const t0 = performance.now();
        ws.onopen = function() {
          const flushed = dgPending.length;
          for (const buf of dgPending) { try { ws.send(buf); } catch (_) { break; } }
          dgPending = [];
          log('dg-open', { ms: Math.round(performance.now() - t0), flushed: flushed });
        };
        ws.onmessage = function(ev) {
          let msg;
          try {
            const raw = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
            msg = JSON.parse(raw);
          } catch (_) { return; }
          if (!msg || msg.type !== 'Results') return;
          const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
          const txt = ((alt && alt.transcript) || '').trim();
          if (!txt) return;
          if (msg.is_final) { dgFinals.push(txt); dgInterim = ''; }
          else dgInterim = txt;
          preview = dgCompose();
          if (!previewLocked) setText(base + preview);
        };
        ws.onerror = function() { log('dg-error', {}); };
        ws.onclose = function(e) {
          log('dg-close', { code: e && e.code, finals: dgFinals.length, preview_len: preview.length });
        };
      }

      function stopDeepgram() {
        const ws = dgWs;
        dgWs = null;
        if (!ws) return;
        // Ask Deepgram to flush + finalize the last interim before we close,
        // then give it a moment to send the final transcript back.
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {}
        setTimeout(function() { try { ws.close(); } catch (_) {} }, 300);
      }

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
            finishAutoSend();
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
        previewLocked = false;
        const eng = previewEngine(settings);
        mediaRec.ondataavailable = function(e) {
          if (e.data && e.data.size) {
            chunks.push(e.data);
            if (eng === 'deepgram') dgFeed(e.data);
          }
        };
        mediaRec.onstop = function() {
          stream.getTracks().forEach(function(t) { t.stop(); });
          finishGroq(settings);
        };
        // Deepgram needs a steady stream of chunks; a timeslice makes
        // ondataavailable fire periodically instead of only at stop.
        if (eng === 'deepgram') { startDeepgram(settings); mediaRec.start(250); }
        else mediaRec.start();
        log('record-start', { mime: mime, preview: eng });
        if (eng === 'webspeech') {
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
        stopDeepgram();
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
          previewLocked = true;
          setUiState('idle');
          setText(base);
          toast('No audio captured');
          finishAutoSend();
          return;
        }
        setUiState('transcribing');
        // Keep whatever the preview heard visible while Groq works. Late
        // Deepgram finals (from CloseStream) keep refining it during the
        // await — we only lock the text once Groq's canonical result lands.
        setText(base + preview);
        try {
          let text = await groqTranscribe(blob, mime, settings);
          if (text && settings.cleanup) text = await groqCleanup(text, settings);
          previewLocked = true;
          setUiState('idle');
          if (!text) {
            log('stt-empty', { preview_len: preview.length });
            setText(base + preview);
            if (!preview) toast('No speech detected');
            finishAutoSend();
            return;
          }
          setText(base + text + ' ');
          finishAutoSend();
        } catch (e) {
          // Degrade to the live-preview text (Deepgram or Web Speech) if any.
          previewLocked = true;
          setUiState('idle');
          setText(base + preview);
          toast(String(e && e.message || e) + (preview ? ' — kept live preview' : ''), true);
          finishAutoSend();
        }
      }

      // Once the pipeline has settled (final text in the textarea), honor a
      // Send that arrived mid-recording: click the real Send button now that
      // state is 'idle', so it goes through core's submitInput (textarea
      // read + \r + clear + WS-failure handling) unchanged. No-op + clears
      // the flag when there's nothing to send.
      function finishAutoSend() {
        if (!pendingSend) return;
        pendingSend = false;
        const el = input();
        if (!el || !el.value.trim()) return;
        const sb = document.getElementById('send-btn');
        if (sb) sb.click();
      }

      // Intercept Send while a recording/transcription is in flight (capture
      // phase, so core's own click→submitInput is suppressed). Stop the
      // recording if needed; finishAutoSend fires when the pipeline settles.
      function onSendClickCapture(e) {
        if (state === 'idle') return;   // normal send — let core handle it
        e.preventDefault();
        e.stopImmediatePropagation();
        pendingSend = true;
        if (state === 'recording') {
          if (mediaRec) stopGroqRecording();              // Groq engine
          else if (rec) { try { rec.stop(); } catch (_) {} }  // Web Speech engine
        }
        // 'transcribing': pipeline already running; finishAutoSend fires when it settles.
      }
      const sendBtnEl = document.getElementById('send-btn');
      if (sendBtnEl) sendBtnEl.addEventListener('click', onSendClickCapture, true);

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
        if (sendBtnEl) sendBtnEl.removeEventListener('click', onSendClickCapture, true);
        if (rec) { try { rec.abort(); } catch (_) {} rec = null; }
        if (dgWs) { try { dgWs.close(); } catch (_) {} dgWs = null; }
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
        'technical vocabulary, needs an API key from console.groq.com (free tier works). ' +
        'Add a Deepgram key too for real-time preview: with the Groq engine, your words ' +
        'stream into the box live as you speak, then the Groq transcript replaces them.';
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

      // Deepgram API key + test — enables real-time streaming preview.
      row(function(div) {
        const lbl = document.createElement('label');
        lbl.style.cssText = css.label;
        lbl.textContent = 'Deepgram API key (real-time live preview)';
        div.appendChild(lbl);
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;gap:8px;';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.name = 'deepgram-api-key';
        inp.placeholder = 'Token…';
        inp.autocomplete = 'off';
        inp.spellcheck = false;
        inp.setAttribute('autocorrect', 'off');
        inp.setAttribute('autocapitalize', 'off');
        inp.setAttribute('data-lpignore', 'true');
        inp.setAttribute('data-1p-ignore', 'true');
        inp.setAttribute('data-bwignore', 'true');
        inp.value = s.deepgramKey;
        inp.style.cssText = css.input + 'flex:1;-webkit-text-security:disc;';
        inp.addEventListener('change', function() {
          const cur = loadSettings();
          cur.deepgramKey = inp.value.trim();
          saveSettings(cur);
        });
        wrap.appendChild(inp);
        const test = document.createElement('button');
        test.type = 'button';
        test.textContent = 'Test';
        test.style.cssText = 'background:var(--ttv-bg-elev2);color:var(--ttv-fg);border:1px solid var(--ttv-border);' +
                             'border-radius:4px;font:inherit;font-size:13px;padding:6px 14px;cursor:pointer;';
        test.addEventListener('click', function() {
          const key = inp.value.trim();
          if (!key) { toast('Enter a key first', true); return; }
          if (!('WebSocket' in window)) { toast('No WebSocket support in this browser', true); return; }
          test.disabled = true;
          test.textContent = '…';
          // Test the exact browser-direct path we use at record time: open
          // the listen socket with the token subprotocol. onopen ⇒ the key
          // authenticated; an early close ⇒ rejected. Avoids REST CORS.
          let done = false;
          let ws;
          const finish = function(ok, msg, isErr) {
            if (done) return;
            done = true;
            test.disabled = false;
            test.textContent = 'Test';
            toast(msg, isErr);
            try { if (ws) ws.close(); } catch (_) {}
          };
          try {
            ws = new WebSocket(DG_LISTEN + '?model=' + DG_MODEL, ['token', key]);
          } catch (e) {
            finish(false, 'Could not open Deepgram socket: ' + String(e && e.message || e), true);
            return;
          }
          const tid = setTimeout(function() { finish(false, 'Deepgram did not respond', true); }, 5000);
          ws.onopen = function() { clearTimeout(tid); finish(true, 'Key works ✓', false); };
          ws.onclose = function(e) {
            clearTimeout(tid);
            // 1000/1005 after an onopen is normal; a close before open is auth failure.
            finish(false, 'Key rejected' + (e && e.code ? ' (code ' + e.code + ')' : ''), true);
          };
          ws.onerror = function() { /* onclose carries the verdict */ };
        });
        wrap.appendChild(test);
        div.appendChild(wrap);
        const hint = document.createElement('div');
        hint.style.cssText = css.hint;
        hint.textContent = 'Optional. With a key set, words stream into the message box as you speak ' +
          '(Deepgram nova-3) — the only live-preview engine that works on Android. The final ' +
          'transcript still comes from Groq Whisper. Get a key at console.deepgram.com (free credit). ' +
          'Stored in this browser\'s localStorage for this origin only.';
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
      toggleRow('Live preview while recording', 'Streams words into the message box during a Groq recording; the Groq transcript replaces them when you stop. Uses Deepgram (real-time, works on Android) when a Deepgram key is set; otherwise falls back to Web Speech, which is desktop-only — on Android the platform recognizer steals the mic from the recording.', 'livePreview');

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
