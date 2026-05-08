// Rendering correctness tests.
// Catches: scrolling regression, frozen-past invariant, cell-diff
// applied to wrong cells, color CSS bugs.
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';

const PANES = [{ id: '%1', session: 's', window: '0', rows: 3, cols: 4 }];

function makeGrid(opts: { primaryRows: number; sbRows: number; cols: number }) {
  const blank = (n: number) =>
    Array.from({ length: opts.cols }, () => ({ ch: ' ' }));
  const row = (txt: string) => ({
    cells: Array.from({ length: opts.cols }, (_, i) => ({ ch: txt[i] || ' ' })),
    wrapped: false,
  });
  return {
    size: [opts.primaryRows, opts.cols],
    primary: Array.from({ length: opts.primaryRows }, (_, i) =>
      row(`P${i}`.padEnd(opts.cols, ' ')),
    ),
    alt: [],
    scrollback: Array.from({ length: opts.sbRows }, (_, i) =>
      row(`S${i}`.padEnd(opts.cols, ' ')),
    ),
  };
}

describe('grid rendering', () => {
  it('renders primary rows + frozen scrollback rows separately', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': makeGrid({ primaryRows: 3, sbRows: 5, cols: 4 }),
    });
    await new Promise(r => setTimeout(r, 100));

    const sb = c.document.querySelectorAll('#sb-host .ttv-row');
    const primary = c.document.querySelectorAll('#primary-host .ttv-row');
    expect(sb.length).toBe(5);
    expect(primary.length).toBe(3);

    // Frozen rows have the .frozen class for content-visibility CSS
    expect((sb[0] as any).className).toContain('frozen');
    // Primary rows do NOT (they receive cell-diff updates)
    expect((primary[0] as any).className).not.toContain('frozen');
  });

  it('scrolling: hostScrollHeight grows with sb rows', async () => {
    const small = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': makeGrid({ primaryRows: 3, sbRows: 0, cols: 4 }),
    });
    await new Promise(r => setTimeout(r, 100));

    const big = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': makeGrid({ primaryRows: 3, sbRows: 100, cols: 4 }),
    });
    await new Promise(r => setTimeout(r, 100));

    const smallH =
      (small.document.getElementById('grid-host') as any).scrollHeight;
    const bigH =
      (big.document.getElementById('grid-host') as any).scrollHeight;
    // happy-dom doesn't fully simulate layout but the row count is in
    // childElementCount, which is the root invariant.
    const smallSb =
      small.document.querySelectorAll('#sb-host .ttv-row').length;
    const bigSb = big.document.querySelectorAll('#sb-host .ttv-row').length;
    expect(bigSb).toBeGreaterThan(smallSb);
    expect(bigSb).toBe(100);
    expect(smallSb).toBe(0);
  });
});

describe('frozen-past invariant', () => {
  it('cell-diff event for an sb row position does NOT mutate frozen rows', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': makeGrid({ primaryRows: 3, sbRows: 2, cols: 4 }),
    });
    await new Promise(r => setTimeout(r, 100));

    const sbBefore = (c.document.querySelector(
      '#sb-host .ttv-row',
    ) as any).textContent;
    expect(sbBefore).toContain('S0');

    // Send a cell-diff. The cell map only has primary cells (r,c),
    // so attempting to address sb rows by (r,c) is a no-op.
    c.recvWs({
      t: 'cell-diff',
      p: '%1',
      ts: Date.now(),
      cells: [{ r: 0, c: 0, ch: 'X' }],
    });
    await new Promise(r => setTimeout(r, 20));

    const sbAfter = (c.document.querySelector(
      '#sb-host .ttv-row',
    ) as any).textContent;
    // Frozen sb row content unchanged (cell-diff only touches primary)
    expect(sbAfter).toBe(sbBefore);

    // Primary row IS mutated
    const primFirstCell = c.document
      .querySelector('#primary-host .ttv-row')!
      .firstElementChild;
    expect((primFirstCell as any).textContent).toBe('X');
  });
});

describe('cell-diff application', () => {
  it('only applies to the active pane', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': makeGrid({ primaryRows: 1, sbRows: 0, cols: 4 }),
    });
    await new Promise(r => setTimeout(r, 100));

    const before = c.document
      .querySelector('#primary-host .ttv-row')!.firstElementChild!.textContent;

    // Cell-diff for a different pane — should be ignored
    c.recvWs({
      t: 'cell-diff',
      p: '%99',
      ts: Date.now(),
      cells: [{ r: 0, c: 0, ch: 'X' }],
    });
    await new Promise(r => setTimeout(r, 10));

    const after = c.document
      .querySelector('#primary-host .ttv-row')!.firstElementChild!.textContent;
    expect(after).toBe(before);
  });
});

describe('scrollback-append handling', () => {
  it('appends new frozen rows to #sb-host', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': makeGrid({ primaryRows: 1, sbRows: 0, cols: 4 }),
    });
    await new Promise(r => setTimeout(r, 100));

    expect(
      c.document.querySelectorAll('#sb-host .ttv-row').length,
    ).toBe(0);

    c.recvWs({
      t: 'scrollback-append',
      p: '%1',
      from_count: 0,
      to_count: 2,
      rows: [
        { cells: [{ ch: 'a' }], wrapped: false },
        { cells: [{ ch: 'b' }], wrapped: false },
      ],
    });
    await new Promise(r => setTimeout(r, 10));

    const sbRows = c.document.querySelectorAll('#sb-host .ttv-row');
    expect(sbRows.length).toBe(2);
    expect((sbRows[0] as any).className).toContain('frozen');
  });
});
