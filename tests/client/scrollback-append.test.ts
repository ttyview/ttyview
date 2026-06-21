// Regression: LIVE-appended scrollback rows must render with their content,
// not as blank rows.
//
// The bug (mobile "black band", fixed 2026-06-21): buildFrozenRow expected the
// Line OBJECT shape `{cells}` (what buildGrid passes from a /grid snapshot),
// but appendScrollback hands it RAW CELL ARRAYS — the daemon's
// `scrollback-append` WS event ships `rows: Vec<Vec<Cell>>`. The array form hit
// `rowSpec.cells === undefined`, so every row that scrolled off primary during
// live streaming rendered BLANK. A reload re-rendered via the snapshot path
// (correct shape), which is why the band "disappeared on reload". This pins
// BOTH shapes so the divergence can't come back.
import { describe, it, expect } from 'vitest';
import { loadClient, type ClientHarness } from './_load-client.ts';

const PANES = [{ id: '%1', session: 's1', window: '0', rows: 2, cols: 6 }];
const GRID = {
  size: [2, 6],
  primary: [
    { cells: [{ ch: 'p' }, { ch: '1' }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }], wrapped: false },
    { cells: [{ ch: 'p' }, { ch: '2' }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }], wrapped: false },
  ],
  alt: [],
  // snapshot scrollback uses the Line OBJECT shape `{cells}`
  scrollback: [{ cells: [{ ch: 'S' }, { ch: 'B' }, { ch: '0' }], wrapped: false }],
};

// raw cell ARRAY shape — exactly how the daemon serializes Vec<Vec<Cell>>
function row(text: string): Array<{ ch: string }> {
  return [...text].map((ch) => ({ ch }));
}

async function load(): Promise<ClientHarness> {
  const c = await loadClient({
    '/panes': PANES,
    '/panes/%1/grid': GRID,
    '/api/state': { schema: 1, keys: {} },
  });
  await new Promise((r) => setTimeout(r, 50));
  return c;
}

function sbText(c: ClientHarness): string[] {
  const host = c.document.getElementById('sb-host')!;
  return [...host.children].map((r) => (r.textContent || '').replace(/\s+$/, ''));
}

describe('scrollback rendering (black-band regression)', () => {
  it('renders SNAPSHOT scrollback (Line object shape) with content', async () => {
    const c = await load();
    expect(sbText(c)).toContain('SB0');
  });

  it('renders LIVE appended scrollback (raw cell-array shape) with content, not blank', async () => {
    const c = await load();
    c.recvWs({ t: 'scrollback-append', p: '%1', from_count: 1, to_count: 3, rows: [row('hello'), row('world')] });
    await new Promise((r) => setTimeout(r, 10));
    const text = sbText(c);
    expect(text).toContain('hello');
    expect(text).toContain('world');
  });

  it('a run of live-appended content rows yields NO blank band', async () => {
    const c = await load();
    const rows = Array.from({ length: 15 }, (_, i) => row('line-' + i));
    c.recvWs({ t: 'scrollback-append', p: '%1', from_count: 1, to_count: 16, rows });
    await new Promise((r) => setTimeout(r, 10));
    const text = sbText(c);
    // The exact symptom was a multi-row run of blanks. Assert the longest
    // consecutive blank run across the appended rows is 0.
    let best = 0,
      cur = 0;
    for (const t of text) {
      if (t === '') {
        cur++;
        best = Math.max(best, cur);
      } else cur = 0;
    }
    expect(best).toBe(0);
    expect(text).toContain('line-0');
    expect(text).toContain('line-14');
  });
});
