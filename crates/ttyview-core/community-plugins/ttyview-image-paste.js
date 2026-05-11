// ttyview-image-paste — paste / drop / pick images into the chat input.
//
// Solves the levelsio "I can't paste screenshots into Claude Code over
// SSH" pain point: the browser accepts an image (clipboard paste, file
// drop, or 📷 picker), uploads it to the daemon's /api/uploads endpoint,
// and on Send hands the staged ids + caption to /api/uploads/send so the
// daemon pastes `<text> [image: /abs/path]` into the tmux pane with the
// load-buffer + paste-buffer + verify-retry-Enter dance.
//
// Three entry paths, two of which only make sense on desktop:
//   - 📷 button         (mobile-friendly — opens gallery / camera picker)
//   - paste event       (desktop Cmd-V'd screenshot)
//   - drag-and-drop     (desktop drop of an image file)
//
// Send is intercepted via capture-phase listeners on #send-btn / Enter
// keydown on #input-text. When the per-pane queue is empty we don't
// intercept and the normal WS send pathway fires unchanged.

(function() {
  const tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[ttyview-image-paste] requires apiVersion 1');
    return;
  }

  const MAX_LONG_EDGE = 2048;
  const DOWNSCALE_MIN_BYTES = 600 * 1024;

  // per-paneId queue of pending images.
  // Each entry: { uid, file, blobUrl, name, status, progress, id, error, xhr }
  // status ∈ 'preparing' | 'uploading' | 'done' | 'error' | 'aborted'
  const queues = new Map();

  function genUid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
           ('u' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
  }

  function getQueue(paneId) {
    if (!queues.has(paneId)) queues.set(paneId, []);
    return queues.get(paneId);
  }

  // Phone photos are 3–8 MB / 12 MP raw; downscaling to a 2048px long
  // edge JPEG at q=0.85 lands around 200–500 KB without visible quality
  // loss. Skip GIFs (preserve animation) and anything already small.
  // Falls back to the original file on any error.
  async function maybeDownscale(file) {
    try {
      if (!file.type || !file.type.startsWith('image/')) return file;
      if (file.type === 'image/gif') return file;
      if (file.size < DOWNSCALE_MIN_BYTES) return file;
      const bmp = await createImageBitmap(file);
      const longEdge = Math.max(bmp.width, bmp.height);
      if (longEdge <= MAX_LONG_EDGE) { bmp.close(); return file; }
      const scale = MAX_LONG_EDGE / longEdge;
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      bmp.close();
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
      if (!blob || blob.size >= file.size) return file;
      const name = (file.name || 'image').replace(/\.\w+$/, '') + '-resized.jpg';
      return new File([blob], name, { type: 'image/jpeg' });
    } catch {
      return file;
    }
  }

  // POST one file to /api/uploads, driving entry.progress from xhr's
  // upload event so the thumb's progress bar moves. Resolves when the
  // entry reaches a terminal state — never rejects (the error is on
  // the entry for the UI to surface).
  function uploadOne(entry, paneId) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      entry.xhr = xhr;
      entry.status = 'uploading';
      paint(paneId);
      xhr.open('POST', '/api/uploads');
      xhr.upload.onprogress = function(e) {
        if (!e.lengthComputable) return;
        entry.progress = e.loaded / e.total;
        paint(paneId);
      };
      xhr.onload = function() {
        entry.xhr = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            entry.id = data.id;
            entry.status = 'done';
            entry.progress = 1;
          } catch {
            entry.status = 'error';
            entry.error = 'bad response';
          }
        } else {
          entry.status = 'error';
          try {
            entry.error = JSON.parse(xhr.responseText).error || ('HTTP ' + xhr.status);
          } catch { entry.error = 'HTTP ' + xhr.status; }
        }
        paint(paneId);
        resolve();
      };
      xhr.onerror = function() {
        entry.xhr = null;
        if (entry.status !== 'aborted') {
          entry.status = 'error';
          entry.error = 'network error';
          paint(paneId);
        }
        resolve();
      };
      xhr.onabort = function() {
        entry.xhr = null;
        entry.status = 'aborted';
        resolve();
      };
      const fd = new FormData();
      fd.append('image', entry.file, entry.file.name || entry.name);
      xhr.send(fd);
    });
  }

  // Attach a single file: downscale, queue, eager-upload. The user can
  // queue multiple files in quick succession; each runs its own upload
  // in parallel (the bottleneck is the network, not the daemon).
  async function attach(file, paneId) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    const uid = genUid();
    const entry = {
      uid,
      file,
      blobUrl: URL.createObjectURL(file),
      name: file.name || 'image',
      status: 'preparing',
      progress: 0,
      id: null,
      error: null,
      xhr: null,
    };
    getQueue(paneId).push(entry);
    paint(paneId);
    try {
      const downscaled = await maybeDownscale(file);
      if (entry.status === 'aborted') return;
      entry.file = downscaled;
    } catch {}
    if (entry.status === 'aborted') return;
    await uploadOne(entry, paneId);
  }

  function remove(uid, paneId) {
    const q = getQueue(paneId);
    const i = q.findIndex(e => e.uid === uid);
    if (i < 0) return;
    const entry = q[i];
    if (entry.xhr) try { entry.xhr.abort(); } catch {}
    if (entry.id) {
      fetch('/api/uploads/' + encodeURIComponent(entry.id), { method: 'DELETE' })
        .catch(() => {});
    }
    try { URL.revokeObjectURL(entry.blobUrl); } catch {}
    q.splice(i, 1);
    paint(paneId);
  }

  // POST the queue to /api/uploads/send and, on success, clear it.
  // Returns true if the send fired (so the Send interceptor can know
  // not to fall through to the normal WS pathway).
  async function sendQueue(paneId, captionText) {
    const q = getQueue(paneId);
    const ready = q.filter(e => e.status === 'done');
    if (ready.length === 0) return false;
    const pending = q.filter(e => e.status === 'preparing' || e.status === 'uploading');
    if (pending.length > 0) {
      // Wait briefly for in-flight uploads. Most are subsecond on LAN;
      // the user explicitly hitting Send while progress bars are still
      // moving is the only common case.
      flash('Waiting for uploads…');
      await Promise.all(pending.map(e => new Promise((resolve) => {
        const tick = setInterval(() => {
          if (e.status !== 'preparing' && e.status !== 'uploading') {
            clearInterval(tick); resolve();
          }
        }, 100);
      })));
    }
    const finalReady = q.filter(e => e.status === 'done');
    if (finalReady.length === 0) {
      flash('All uploads failed', 'error');
      return false;
    }
    const body = {
      pane: paneId,
      ids: finalReady.map(e => e.id),
      text: captionText || '',
    };
    try {
      const res = await fetch('/api/uploads/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = 'send failed';
        try { msg = (await res.json()).error || msg; } catch {}
        flash(msg, 'error');
        return true; // we intercepted; don't fall through on error either
      }
    } catch (e) {
      flash('send failed: ' + e.message, 'error');
      return true;
    }
    // On success: drop the sent entries (commit moved them server-side,
    // ids are stale now anyway). Failed ones stay so the user can retry
    // or remove them.
    const sentIds = new Set(finalReady.map(e => e.id));
    for (const e of q.slice()) {
      if (e.id && sentIds.has(e.id)) {
        try { URL.revokeObjectURL(e.blobUrl); } catch {}
        const i = q.indexOf(e);
        if (i >= 0) q.splice(i, 1);
      }
    }
    const ta = document.getElementById('input-text');
    if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input')); }
    paint(paneId);
    return true;
  }

  // --- preview rendering --------------------------------------------------

  function ensurePreviewEl() {
    let el = document.getElementById('ttv-img-preview');
    if (el) return el;
    const inputRow = document.getElementById('input-row');
    if (!inputRow) return null;
    el = document.createElement('div');
    el.id = 'ttv-img-preview';
    el.style.cssText = [
      'display:none',
      'flex-wrap:wrap',
      'gap:6px',
      'padding:6px 8px',
      'background:rgba(0,0,0,.25)',
      'border-top:1px solid #333',
    ].join(';');
    inputRow.parentNode.insertBefore(el, inputRow);
    injectStyles();
    return el;
  }

  function injectStyles() {
    if (document.getElementById('ttv-img-paste-styles')) return;
    const s = document.createElement('style');
    s.id = 'ttv-img-paste-styles';
    s.textContent = `
      .ttv-img-thumb { position:relative; width:56px; height:56px; border-radius:6px; overflow:hidden; background:#000; flex:0 0 auto; }
      .ttv-img-thumb img { width:100%; height:100%; object-fit:cover; opacity:.6; transition:opacity .15s; }
      .ttv-img-thumb.is-done img { opacity:1; }
      .ttv-img-thumb.is-error img { opacity:.3; filter:grayscale(1); }
      .ttv-img-thumb .ttv-img-remove {
        position:absolute; top:2px; right:2px; width:18px; height:18px;
        border-radius:50%; background:rgba(0,0,0,.7); color:#fff; border:none;
        font-size:13px; line-height:1; padding:0; cursor:pointer;
      }
      .ttv-img-thumb .ttv-img-bar {
        position:absolute; left:0; bottom:0; right:0; height:3px;
        background:rgba(0,0,0,.5);
      }
      .ttv-img-thumb .ttv-img-bar-fill {
        height:100%; background:#4ec9b0; transition:width .1s linear;
      }
      .ttv-img-thumb.is-done .ttv-img-bar,
      .ttv-img-thumb.is-error .ttv-img-bar { display:none; }
      .ttv-img-thumb .ttv-img-badge {
        position:absolute; left:2px; bottom:2px; padding:1px 4px; border-radius:3px;
        background:rgba(0,0,0,.7); color:#fff; font-size:10px; font-family:sans-serif;
      }
      #ttv-img-drop-overlay {
        position:fixed; inset:0; display:none; align-items:center; justify-content:center;
        background:rgba(0,0,0,.55); color:#4ec9b0; font: 600 22px system-ui, sans-serif;
        pointer-events:none; z-index:99999; border:3px dashed #4ec9b0;
      }
      .ttv-img-toast {
        position:fixed; left:50%; bottom:120px; transform:translateX(-50%);
        background:#1e1e1e; color:#d4d4d4; padding:8px 14px; border-radius:6px;
        font:13px system-ui, sans-serif; box-shadow:0 4px 14px rgba(0,0,0,.4);
        z-index:99999; max-width:80vw; pointer-events:none;
      }
      .ttv-img-toast.is-error { background:#5a1f1f; color:#f48771; }
    `;
    document.head.appendChild(s);
  }

  function paint(paneId) {
    const active = (tv.getActivePane() || {}).id;
    if (paneId !== active) return; // Only paint for the visible pane.
    const el = ensurePreviewEl();
    if (!el) return;
    const q = getQueue(paneId);
    if (q.length === 0) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = 'flex';
    el.innerHTML = '';
    for (const e of q) {
      const thumb = document.createElement('div');
      thumb.className = 'ttv-img-thumb is-' + e.status;
      const img = document.createElement('img');
      img.src = e.blobUrl;
      thumb.appendChild(img);

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'ttv-img-remove';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.addEventListener('click', function() { remove(e.uid, paneId); });
      thumb.appendChild(rm);

      const bar = document.createElement('div');
      bar.className = 'ttv-img-bar';
      const fill = document.createElement('div');
      fill.className = 'ttv-img-bar-fill';
      fill.style.width = Math.round(e.progress * 100) + '%';
      bar.appendChild(fill);
      thumb.appendChild(bar);

      if (e.status === 'done' || e.status === 'error') {
        const badge = document.createElement('div');
        badge.className = 'ttv-img-badge';
        badge.textContent = e.status === 'done' ? '✓' : '⚠';
        if (e.status === 'error') badge.title = e.error || 'upload failed';
        thumb.appendChild(badge);
      }

      el.appendChild(thumb);
    }
  }

  function flash(msg, level) {
    document.querySelectorAll('.ttv-img-toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.className = 'ttv-img-toast' + (level === 'error' ? ' is-error' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), level === 'error' ? 3500 : 1800);
  }

  // --- drop overlay (desktop) ---------------------------------------------

  function ensureDropOverlay() {
    let el = document.getElementById('ttv-img-drop-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ttv-img-drop-overlay';
    el.textContent = 'Drop image to attach';
    document.body.appendChild(el);
    return el;
  }

  function hasImageItems(dt) {
    if (!dt) return false;
    if (dt.types) {
      for (const t of dt.types) if (t === 'Files') return true;
    }
    return false;
  }

  // --- pane bookkeeping ---------------------------------------------------
  //
  // The preview area sits above the global #input-row but the queue is
  // per-pane. When the user switches panes we redraw to show only the
  // active pane's queue.
  tv.on('pane-changed', function() {
    const id = (tv.getActivePane() || {}).id;
    paint(id);
  });

  // --- contribution: 📷 inputAccessory button -----------------------------

  let unmountGlobal = null;

  tv.contributes.inputAccessory({
    id: 'ttyview-image-paste',
    name: 'Image Paste',
    render: function(slot) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.tabIndex = -1;                  // don't blur the textarea
      btn.textContent = '📷';
      btn.title = 'Attach image (paste or drop also work)';
      btn.addEventListener('pointerup', function(e) {
        if (e.button !== undefined && e.button !== 0) return;
        openPicker();
      });
      btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
      slot.appendChild(btn);

      if (!unmountGlobal) unmountGlobal = wireGlobal();

      return function unmount() {
        btn.remove();
        if (unmountGlobal) { unmountGlobal(); unmountGlobal = null; }
        const el = document.getElementById('ttv-img-preview');
        if (el) el.remove();
        const ov = document.getElementById('ttv-img-drop-overlay');
        if (ov) ov.remove();
      };
    },
  });

  function openPicker() {
    const pane = tv.getActivePane();
    if (!pane) return;
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.multiple = true;
    inp.onchange = function() {
      for (const f of inp.files) attach(f, pane.id);
    };
    inp.click();
  }

  // --- Send interception + paste / drop wiring ---------------------------
  //
  // Returns a teardown function that removes every listener. Idempotent
  // via the `unmountGlobal` guard above.
  function wireGlobal() {
    const ta = document.getElementById('input-text');
    const sendBtn = document.getElementById('send-btn');
    const overlay = ensureDropOverlay();

    function activePane() { return (tv.getActivePane() || {}).id || null; }
    function queueOf() {
      const id = activePane();
      return id ? getQueue(id) : null;
    }

    // Paste: grab image clipboardData.items, pre-empt the textarea
    // pasting "[object File]" or similar.
    function onPaste(e) {
      const pane = activePane();
      if (!pane) return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      let consumed = false;
      for (const it of items) {
        if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) { attach(f, pane); consumed = true; }
        }
      }
      if (consumed) e.preventDefault();
    }

    function onDragOver(e) {
      if (!hasImageItems(e.dataTransfer)) return;
      e.preventDefault();
      overlay.style.display = 'flex';
    }
    function onDragLeave(e) {
      // window-relative; only hide when the cursor really leaves.
      if (e.relatedTarget === null) overlay.style.display = 'none';
    }
    function onDrop(e) {
      overlay.style.display = 'none';
      if (!e.dataTransfer || !e.dataTransfer.files) return;
      const pane = activePane();
      if (!pane) return;
      let any = false;
      for (const f of e.dataTransfer.files) {
        if (f.type && f.type.startsWith('image/')) { attach(f, pane); any = true; }
      }
      if (any) e.preventDefault();
    }

    // Intercept Send when the active-pane queue has any non-error
    // entries. Capture-phase so we run before the page's bubble-phase
    // listener on the same element.
    function shouldIntercept() {
      const q = queueOf();
      return !!(q && q.some(e => e.status !== 'error' && e.status !== 'aborted'));
    }
    function intercept(e) {
      if (!shouldIntercept()) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const pane = activePane();
      const text = ta ? ta.value : '';
      sendQueue(pane, text);
    }
    function onSendClick(e) { intercept(e); }
    function onTaKeydown(e) {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      intercept(e);
    }

    ta && ta.addEventListener('paste', onPaste);
    ta && ta.addEventListener('keydown', onTaKeydown, true);
    sendBtn && sendBtn.addEventListener('click', onSendClick, true);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);

    return function tearDown() {
      ta && ta.removeEventListener('paste', onPaste);
      ta && ta.removeEventListener('keydown', onTaKeydown, true);
      sendBtn && sendBtn.removeEventListener('click', onSendClick, true);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
    };
  }
})();
