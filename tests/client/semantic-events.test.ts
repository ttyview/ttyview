// Semantic-event plumbing for plugins: tv.on('semantic') must
// deliver detector events for ALL panes, not just the active one.
// The daemon only sends events for subscribed panes, so the client
// lazily adds kinds:['semantic','tick'] subs for every pane when the first ('tick' powers the all-panes status-dot 'active' state)
// 'semantic' listener registers, keeps them alive across pane
// switches (unsub drops ALL of a pane's subs server-side), and
// dedups the active pane's double delivery (full sub + semantic
// sub both carry the event).
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';

const PANES = [
  { id: '%1', session: 's1', window: '0', rows: 1, cols: 4, idle_ms: 100 },
  { id: '%2', session: 's2', window: '0', rows: 1, cols: 4, idle_ms: 99999 },
];
const GRID = {
  size: [1, 4],
  primary: [{ cells: [{ ch: 'a' }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }], wrapped: false }],
  alt: [], scrollback: [],
};

const SEM = (pane: string, name: string, at_gen: number) => ({
  t: 'semantic', p: pane, event: { name, at_gen, data: { pane } },
});

async function load() {
  const c = await loadClient({
    '/panes': PANES,
    '/panes/%1/grid': GRID,
    '/panes/%2/grid': GRID,
  });
  await new Promise(r => setTimeout(r, 100));
  return c;
}

describe('semantic events plugin API', () => {
  it('exposes refreshPanes() which re-fetches and emits panes-updated', async () => {
    const c = await load();
    const tv = (c.window as any).ttyview;
    expect(typeof tv.refreshPanes).toBe('function');
    const updates: any[] = [];
    tv.on('panes-updated', (l: any) => updates.push(l));
    const list = await tv.refreshPanes();
    expect(list.length).toBe(2);
    expect(updates.length).toBe(1);
    expect(updates[0][0].id).toBe('%1');
  });

  it('first semantic listener subscribes kinds:[semantic] to every pane', async () => {
    const c = await load();
    const tv = (c.window as any).ttyview;
    const before = c.wsSent.filter(m => m.t === 'sub' && m.kinds).length;
    expect(before).toBe(0);
    tv.on('semantic', () => {});
    const semSubs = c.wsSent.filter(m => m.t === 'sub' && Array.isArray(m.kinds));
    expect(semSubs.map(m => m.p).sort()).toEqual(['%1', '%2']);
    for (const s of semSubs) expect(s.kinds).toEqual(['semantic', 'tick']);
  });

  it('delivers semantic frames for background panes and dedups doubles', async () => {
    const c = await load();
    const tv = (c.window as any).ttyview;
    const got: any[] = [];
    tv.on('semantic', (e: any) => got.push(e));
    // Background pane (%2 — active is %1)
    c.recvWs(SEM('%2', 'claude.permission_prompt', 7));
    expect(got.length).toBe(1);
    expect(got[0]).toMatchObject({
      pane: '%2', name: 'claude.permission_prompt', at_gen: 7,
    });
    // Same event again (active pane's full sub + semantic sub) → deduped
    c.recvWs(SEM('%2', 'claude.permission_prompt', 7));
    expect(got.length).toBe(1);
    // Different generation → new event
    c.recvWs(SEM('%2', 'claude.permission_resolved', 9));
    expect(got.length).toBe(2);
  });

  it('restores the semantic sub for a pane after switching away from it', async () => {
    const c = await load();
    const tv = (c.window as any).ttyview;
    tv.on('semantic', () => {});
    c.wsSent.length = 0;
    await tv.selectPane('%2');
    // unsub %1 dropped ALL of %1's server-side subs — the client must
    // re-send the semantic-only sub for %1 right after.
    const unsubIdx = c.wsSent.findIndex(m => m.t === 'unsub' && m.p === '%1');
    expect(unsubIdx).toBeGreaterThanOrEqual(0);
    const resub = c.wsSent.slice(unsubIdx + 1).find(
      m => m.t === 'sub' && m.p === '%1' && Array.isArray(m.kinds) && m.kinds[0] === 'semantic');
    expect(resub).toBeTruthy();
  });
});
