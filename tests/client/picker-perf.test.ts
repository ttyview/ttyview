// UX regression: opening the pane picker must be FAST (<50ms from
// click to overlay being visible), even when cell-diff events are
// streaming in and the cell map has thousands of entries.
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';

const PANES = Array.from({ length: 10 }, (_, i) => ({
  id: '%' + i, session: 'session' + i, window: '0', rows: 30, cols: 80,
}));
const BIG_GRID = {
  size: [30, 80],
  primary: Array.from({ length: 30 }, () => ({
    cells: Array.from({ length: 80 }, () => ({ ch: 'x' })),
    wrapped: false,
  })),
  alt: [],
  scrollback: Array.from({ length: 200 }, () => ({
    cells: Array.from({ length: 80 }, () => ({ ch: 'y' })),
    wrapped: false,
  })),
};

describe('pane picker open performance', () => {
  it('opens in under 50ms even with a busy grid', async () => {
    const fetches = { '/panes': PANES };
    for (const p of PANES) {
      (fetches as any)['/panes/' + p.id + '/grid'] = BIG_GRID;
    }
    const c = await loadClient(fetches);
    await new Promise(r => setTimeout(r, 200));

    // Simulate a tide of cell-diff events (CC streaming) — each
    // touches a cell. If the click handler is queued behind these
    // synchronously, opening the picker will be slow.
    for (let i = 0; i < 200; i++) {
      c.recvWs({
        t: 'cell-diff',
        p: '%0',
        ts: Date.now(),
        cells: [{ r: i % 30, c: i % 80, ch: 'q' }],
      });
    }

    const t0 = performance.now();
    (c.document.getElementById('pane-picker-btn') as any).click();
    const overlay = c.document.getElementById('pane-picker-overlay')!;
    const opened = overlay.className.includes('open');
    const t1 = performance.now();

    expect(opened, 'overlay should be open synchronously after click').toBe(true);
    const elapsed = t1 - t0;
    expect(elapsed, `click→opened took ${elapsed.toFixed(1)}ms`).toBeLessThan(50);

    // List should be populated immediately, not deferred
    const items = c.document.querySelectorAll('#pane-picker-list .pp-item');
    expect(items.length).toBe(PANES.length);
  });
});
