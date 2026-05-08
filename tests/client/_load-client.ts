// Loads the bundled HTML/JS client into a happy-dom DOM, isolates
// document/window per test, mocks fetch + WebSocket, and exposes the
// client's window-attached symbols for assertion. Each test gets a
// fresh DOM so they can't leak state across each other.
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = resolve(
  __dirname,
  '../../crates/ttyview-core/ui/index.html',
);

export interface ClientHarness {
  window: any;
  document: Document;
  /** WS frames the client has sent (parsed JSON). */
  wsSent: any[];
  /** Push a server frame into the client's onmessage handler. */
  recvWs: (msg: any) => void;
  /** Resolve the next fetch with this JSON. */
  setFetchResponse: (path: string, body: any, status?: number) => void;
  /** Remove the next fetch override (use real undici). */
  clearFetchOverrides: () => void;
}

export async function loadClient(initialFetches: Record<string, any> = {}): Promise<ClientHarness> {
  const html = readFileSync(HTML_PATH, 'utf-8');

  // Extract inline script body — we'll execute it explicitly after
  // installing fetch/WebSocket stubs on the window.
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  const scriptBody = scriptMatch ? scriptMatch[1] : '';
  const htmlNoScript = html.replace(/<script>[\s\S]*?<\/script>/, '');

  const win = new Window({ url: 'http://test/', innerWidth: 414, innerHeight: 896 });
  const doc = win.document;
  doc.write(htmlNoScript);
  doc.close();

  const wsSent: any[] = [];
  let onMessage: ((ev: { data: string }) => void) | null = null;
  let onOpen: (() => void) | null = null;

  // Stub WebSocket BEFORE running the client script
  class FakeWS {
    readyState = 1; // OPEN
    static OPEN = 1; static CLOSED = 3; static CLOSING = 2; static CONNECTING = 0;
    set onopen(fn: any) { onOpen = fn; queueMicrotask(() => fn?.()); }
    set onmessage(fn: any) { onMessage = fn; }
    set onclose(_fn: any) {}
    set onerror(_fn: any) {}
    send(s: string) { wsSent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
  }
  (win as any).WebSocket = FakeWS;
  (FakeWS as any).OPEN = 1;

  // Stub fetch with a per-path response map
  const fetchOverrides = new Map<string, { body: any; status: number }>();
  for (const [path, body] of Object.entries(initialFetches)) {
    fetchOverrides.set(path, { body, status: 200 });
  }
  (win as any).fetch = async (url: string) => {
    const rawPath = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    // Try multiple lookup keys: raw, decoded, fully-encoded.
    // Client encodes pane ids via encodeURIComponent (so %1 becomes
    // %251 in the URL) but tests usually want to write fixtures
    // keyed by the human-readable id.
    const decoded = decodeURIComponent(rawPath);
    const override =
      fetchOverrides.get(rawPath) ??
      fetchOverrides.get(decoded) ??
      fetchOverrides.get(url);
    if (override) {
      const body = override.body;
      const isStringBody = typeof body === 'string';
      return {
        ok: override.status < 400,
        status: override.status,
        json: async () => isStringBody ? JSON.parse(body) : body,
        text: async () => isStringBody ? body : JSON.stringify(body),
      };
    }
    throw new Error('Unmocked fetch: ' + url + ' (raw=' + rawPath + ', decoded=' + decoded + ')');
  };

  // Provide localStorage if happy-dom doesn't (it does, but be safe)
  if (!(win as any).localStorage) {
    const store = new Map<string, string>();
    (win as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
  }

  // Execute the client's inline script in the window's context.
  // We use the Window's eval so all DOM globals (document, fetch,
  // WebSocket, localStorage) resolve to the stubs we just installed.
  // Catch any errors (so test gets a useful message instead of a
  // silent no-op).
  try {
    (win as any).eval(scriptBody);
  } catch (e) {
    console.error('[harness] script error:', e);
    throw e;
  }

  // Let the client's bootstrap (loadPanes → loadGrid → connectWs)
  // settle. Wait until either the primary rows are populated or
  // 1s elapses. happy-dom doesn't run microtasks identically to a
  // real browser; we poll-and-wait rather than guess a sleep.
  for (let i = 0; i < 50; i++) {
    if (doc.querySelector('#primary-host .ttv-row')) break;
    await new Promise(r => setTimeout(r, 20));
  }

  return {
    window: win,
    document: doc as unknown as Document,
    wsSent,
    recvWs: (msg) => onMessage?.({ data: JSON.stringify(msg) }),
    setFetchResponse: (path, body, status = 200) => {
      fetchOverrides.set(path, { body, status });
    },
    clearFetchOverrides: () => fetchOverrides.clear(),
  };
}
