// Background-resume resync — pins the 2026-06-12 mobile-cc "stuck
// view" bug. Android throttles hidden pages (timers → 1/s) and then
// freezes them: rAF stops, so queued cell-diffs never flush, and the
// WS can die silently. On return the user stared at a minutes-old
// frame under a green "connected" dot until a 73k-cell stale backlog
// finally replayed. The fix: on becoming visible after a real gap,
// refetch the grid (authoritative), re-sub/probe the WS, and have
// grid-loaded DROP the queued diff backlog instead of replaying it.
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';

const PANES = [{ id: '%1', session: 's1', window: '0', rows: 1, cols: 4 }];
function grid(ch: string) {
  return {
    size: [1, 4],
    primary: [{ cells: [{ ch }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }], wrapped: false }],
    alt: [],
    scrollback: [],
  };
}

function setVisibility(doc: any, state: string) {
  Object.defineProperty(doc, 'visibilityState', {
    get: () => state,
    configurable: true,
  });
}

describe('background-resume resync', () => {
  it('visible after a long hide refetches the grid and re-subs the pane', async () => {
    const c = await loadClient({ '/panes': PANES, '/panes/%1/grid': grid('a') });
    await new Promise(r => setTimeout(r, 100));
    const gridFetches = () =>
      c.fetchCalls.filter(f => f.path === '/panes/%1/grid').length;
    const before = gridFetches();
    const subsBefore = c.wsSent.filter(m => m.t === 'sub').length;

    setVisibility(c.document, 'hidden');
    c.document.dispatchEvent(new c.window.Event('visibilitychange'));
    // Pretend 10s passed while hidden — Date.now is what the client
    // measures the gap with.
    const realNow = c.window.Date.now.bind(c.window.Date);
    c.window.Date.now = () => realNow() + 10_000;
    setVisibility(c.document, 'visible');
    c.document.dispatchEvent(new c.window.Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 100));

    expect(gridFetches()).toBeGreaterThan(before);
    expect(c.wsSent.filter(m => m.t === 'sub').length).toBeGreaterThan(subsBefore);
    // Answer the liveness probe so the 3s probe-timeout doesn't
    // tear down the (fake) socket after the test.
    c.recvWs({ t: 'ack', ok: true, for: 'sub' });
  });

  it('a short hide (<2s) does NOT trigger a refetch', async () => {
    const c = await loadClient({ '/panes': PANES, '/panes/%1/grid': grid('a') });
    await new Promise(r => setTimeout(r, 100));
    const gridFetches = () =>
      c.fetchCalls.filter(f => f.path === '/panes/%1/grid').length;
    const before = gridFetches();

    setVisibility(c.document, 'hidden');
    c.document.dispatchEvent(new c.window.Event('visibilitychange'));
    setVisibility(c.document, 'visible');
    c.document.dispatchEvent(new c.window.Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 100));

    expect(gridFetches()).toBe(before);
  });

  it('grid-loaded drops the queued stale diff backlog', async () => {
    const c = await loadClient({ '/panes': PANES, '/panes/%1/grid': grid('a') });
    await new Promise(r => setTimeout(r, 100));

    // Capture rAF so queued diffs can't flush — mimics a hidden page.
    const queued: Array<(t: number) => void> = [];
    c.window.requestAnimationFrame = (fn: any) => {
      queued.push(fn);
      return queued.length;
    };
    c.window.cancelAnimationFrame = () => {};

    // Stale diff arrives while "hidden" — sits in the queue.
    c.recvWs({ t: 'cell-diff', p: '%1', ts: 0, cells: [{ r: 0, c: 0, ch: 'Z' }] });
    // Resume resync delivers a fresh authoritative snapshot.
    c.window.ttyview._internal.emit('grid-loaded', { paneId: '%1', screen: grid('b') });
    // Now let the captured (stale) rAF callbacks run.
    for (const fn of queued) fn(0);
    await new Promise(r => setTimeout(r, 20));

    const cell = c.document.querySelector('#primary-host .ttv-row')!.firstElementChild!;
    expect(cell.textContent).toBe('b'); // snapshot wins, not the stale 'Z'
  });
});
