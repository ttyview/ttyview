// ttyview-live-sync — server→browser live apply contract.
//
// The plugin polls /api/state, diffs, and applies. Pinned here:
//  1. Theme/view changes apply WITHOUT echoing a PUT back (restore
//     semantics, persist:false) and without a reload.
//  2. Plugin-storage changes write the localStorage cache and emit
//     'storage-changed' so the owning plugin (ttyview-tabs) reconciles.
//  3. The command queue applies each command exactly once per device
//     (seq cursor), and a fresh device never replays history.
//  4. Echoes of this browser's own writes are no-ops.
import { describe, it, expect } from 'vitest';
import { loadClient, type ClientHarness } from './_load-client.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = readFileSync(
  resolve(__dirname, '../../crates/ttyview-core/community-plugins/ttyview-live-sync.js'),
  'utf-8',
);
const TABS_SRC = readFileSync(
  resolve(__dirname, '../../crates/ttyview-core/community-plugins/ttyview-tabs.js'),
  'utf-8',
);

const PANES = [{ id: '%1', session: 's1', window: '0', rows: 1, cols: 4 }];
const GRID = {
  size: [1, 4],
  primary: [{ cells: [{ ch: 'a' }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }], wrapped: false }],
  alt: [], scrollback: [],
};

function state(keys: Record<string, any>) {
  return { schema: 1, keys };
}

async function loadWithLiveSync(initialKeys: Record<string, any> = {}): Promise<ClientHarness> {
  const c = await loadClient({
    '/panes': PANES,
    '/panes/%1/grid': GRID,
    '/api/state': state(initialKeys),
  });
  (c.window as any).eval(PLUGIN_SRC);
  // Let the plugin's eval-time baseline syncNow() settle.
  await new Promise(r => setTimeout(r, 50));
  return c;
}

describe('ttyview-live-sync', () => {
  it('applies a server-side theme change live, without echoing a PUT', async () => {
    const c = await loadWithLiveSync({});
    const tv = (c.window as any).ttyview;
    tv.contributes.theme({ id: 'test-theme', name: 'T', vars: { '--ttv-bg': '#111111' } });

    c.setFetchResponse('/api/state', state({ 'ttv-active-theme': 'test-theme' }));
    await (c.window as any).__ttvLiveSync.syncNow();

    expect(tv._internal.getActiveThemeId()).toBe('test-theme');
    expect((c.window as any).localStorage.getItem('ttv-active-theme')).toBe('test-theme');
    const puts = c.fetchCalls.filter(
      f => f.method === 'PUT' && f.path === '/api/state/ttv-active-theme',
    );
    expect(puts).toEqual([]);
  });

  it('applies a server-side view change live', async () => {
    const c = await loadWithLiveSync({});
    const tv = (c.window as any).ttyview;
    tv.contributes.terminalView({ id: 'test-view', name: 'V', render: () => {} });

    c.setFetchResponse('/api/state', state({ 'ttv-active-view': 'test-view' }));
    await (c.window as any).__ttvLiveSync.syncNow();

    expect(tv._internal.getActiveTerminalViewId()).toBe('test-view');
  });

  it('plugin-storage change writes the cache and emits storage-changed', async () => {
    const c = await loadWithLiveSync({});
    const tv = (c.window as any).ttyview;
    const events: any[] = [];
    tv.on('storage-changed', (e: any) => events.push(e));

    c.setFetchResponse('/api/state', state({
      'ttv-plugin:demo:cfg': { a: 1 },
    }));
    await (c.window as any).__ttvLiveSync.syncNow();

    expect((c.window as any).localStorage.getItem('ttv-plugin:demo:cfg')).toBe('{"a":1}');
    expect(events).toEqual([
      { pluginId: 'demo', key: 'cfg', value: { a: 1 }, source: 'live-sync' },
    ]);
  });

  it('echo of an unchanged localStorage value does not re-emit', async () => {
    const c = await loadWithLiveSync({ 'ttv-plugin:demo:cfg': { a: 1 } });
    const tv = (c.window as any).ttyview;
    const events: any[] = [];
    tv.on('storage-changed', (e: any) => events.push(e));

    // Snapshot baseline had no cfg seen as a *diff* (first fetch is
    // baseline-no-apply); force a diff cycle where localStorage already
    // matches — boot hydration wrote it.
    c.setFetchResponse('/api/state', state({
      'ttv-plugin:demo:cfg': { a: 1 },
      'ttv-plugin:other:x': 2,
    }));
    await (c.window as any).__ttvLiveSync.syncNow();

    // Only the genuinely-new key emitted; the already-cached one was an echo.
    expect(events.map(e => e.pluginId)).toEqual(['other']);
  });

  it('command queue: fresh device skips history, then applies each toast once', async () => {
    const now = Date.now();
    const c = await loadWithLiveSync({
      'ttv-agent-cmd-queue': [{ seq: 5, ts: now, action: 'toast', message: 'old', sticky: false }],
    });
    const doc = c.document;
    // Baseline drain set the cursor to 5 without showing anything.
    expect(doc.querySelectorAll('#ttv-live-sync-toasts .ttv-toast').length).toBe(0);

    c.setFetchResponse('/api/state', state({
      'ttv-agent-cmd-queue': [
        { seq: 5, ts: now, action: 'toast', message: 'old', sticky: false },
        { seq: 6, ts: Date.now(), action: 'toast', message: 'build done', sticky: false },
      ],
    }));
    await (c.window as any).__ttvLiveSync.syncNow();
    expect(doc.querySelectorAll('#ttv-live-sync-toasts .ttv-toast').length).toBe(1);

    // Same queue again → cursor blocks a replay.
    await (c.window as any).__ttvLiveSync.syncNow();
    expect(doc.querySelectorAll('#ttv-live-sync-toasts .ttv-toast').length).toBe(1);
  });

  it('sticky toasts persist and survive staleness; transient stale ones are dropped', async () => {
    const c = await loadWithLiveSync({});
    const doc = c.document;
    const staleTs = Date.now() - 10 * 60 * 1000;
    c.setFetchResponse('/api/state', state({
      'ttv-agent-cmd-queue': [
        { seq: 1, ts: staleTs, action: 'toast', message: 'stale transient', sticky: false },
        { seq: 2, ts: staleTs, action: 'toast', message: 'need your input', sticky: true },
      ],
    }));
    await (c.window as any).__ttvLiveSync.syncNow();
    const toasts = doc.querySelectorAll('#ttv-live-sync-toasts .ttv-toast');
    expect(toasts.length).toBe(1);
    expect(toasts[0].textContent).toContain('need your input');
    expect(toasts[0].className).toContain('ttv-toast-sticky');
  });

  it('ttyview-tabs reconciles pins on storage-changed', async () => {
    const c = await loadWithLiveSync({});
    const tv = (c.window as any).ttyview;
    (c.window as any).eval(TABS_SRC);
    await new Promise(r => setTimeout(r, 50));

    c.setFetchResponse('/api/state', state({
      'ttv-plugin:ttyview-tabs:pins': [{ id: '%1', session: 's1' }],
    }));
    await (c.window as any).__ttvLiveSync.syncNow();
    await new Promise(r => setTimeout(r, 50));

    // The tabs plugin re-read pins and re-rendered: a tab for s1 exists.
    const labels = Array.from(
      c.document.querySelectorAll('.ttvtab'),
    ).map(el => (el.textContent || '').trim());
    expect(labels.some(t => t.includes('s1'))).toBe(true);
  });
});
