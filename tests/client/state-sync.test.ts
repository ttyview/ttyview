// Server-authoritative client state (/api/state) — sync contract.
//
// Two bugs found 2026-06-10 (see AGENT_LOG.md, ttyview1) are pinned
// here so they can't regress:
//  1. Boot-time view/theme restore must NOT persist (PUT) its
//     fallback — a fresh browser used to clobber the server-saved
//     view for every device.
//  2. hydrateServerState must write the bare keys (ttv-active-view,
//     ttv-active-theme) RAW into localStorage — JSON.stringify'd
//     values ('"ttyview-cc"') never match a registry id, so the
//     server-chosen view/theme silently never applied.
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';

const PANES = [{ id: '%1', session: 's1', window: '0', rows: 1, cols: 4 }];
const GRID = {
  size: [1, 4],
  primary: [{ cells: [{ ch: 'a' }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }], wrapped: false }],
  alt: [], scrollback: [],
};

function stateFixture(keys: Record<string, any>) {
  return { schema: 1, keys };
}

describe('server-authoritative state sync', () => {
  it('fresh client does NOT PUT its boot fallback to /api/state', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': GRID,
      '/api/state': stateFixture({ 'ttv-active-view': 'some-plugin-view' }),
      '/api/state/ttv-active-view': { ok: true },
    });
    await new Promise(r => setTimeout(r, 150));
    const puts = c.fetchCalls.filter(
      f => f.method === 'PUT' && f.path === '/api/state/ttv-active-view',
    );
    // The boot restore + cell-grid fallback are restore paths, not user
    // choices — nothing may write the server during page load.
    expect(puts).toEqual([]);
  });

  it('hydration stores bare keys raw (not JSON-quoted)', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': GRID,
      '/api/state': stateFixture({
        'ttv-active-view': 'some-plugin-view',
        'ttv-plugin:demo:obj': { a: 1 },
      }),
    });
    await new Promise(r => setTimeout(r, 150));
    const ls = (c.window as any).localStorage;
    expect(ls.getItem('ttv-active-view')).toBe('some-plugin-view');
    // Plugin-storage keys stay JSON (read via JSON.parse).
    expect(ls.getItem('ttv-plugin:demo:obj')).toBe('{"a":1}');
  });

  it('server-chosen view applies when its plugin registers late', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': GRID,
      '/api/state': stateFixture({ 'ttv-active-view': 'late-view' }),
      '/api/state/ttv-active-view': { ok: true },
    });
    await new Promise(r => setTimeout(r, 150));
    const tv = (c.window as any).ttyview;
    // Pre-registration: fallback is cell-grid.
    expect(tv._internal.getActiveTerminalViewId()).toBe('cell-grid');
    // Simulate the community plugin eval'ing after boot.
    tv.contributes.terminalView({ id: 'late-view', name: 'Late', render: () => {} });
    await new Promise(r => setTimeout(r, 50));
    expect(tv._internal.getActiveTerminalViewId()).toBe('late-view');
    // And that late-registration apply is restore, not a user choice.
    const puts = c.fetchCalls.filter(
      f => f.method === 'PUT' && f.path === '/api/state/ttv-active-view',
    );
    expect(puts).toEqual([]);
  });

  it('a real user switch still persists via PUT', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': GRID,
      '/api/state': stateFixture({}),
      '/api/state/ttv-active-view': { ok: true },
    });
    await new Promise(r => setTimeout(r, 150));
    const tv = (c.window as any).ttyview;
    tv.contributes.terminalView({ id: 'user-view', name: 'U', render: () => {} });
    tv._internal.setActiveTerminalViewId('user-view'); // no opts → persist
    await new Promise(r => setTimeout(r, 50));
    const puts = c.fetchCalls.filter(
      f => f.method === 'PUT' && f.path === '/api/state/ttv-active-view',
    );
    expect(puts.length).toBe(1);
    expect(puts[0].body).toBe('user-view');
    expect((c.window as any).localStorage.getItem('ttv-active-view')).toBe('user-view');
  });
});
