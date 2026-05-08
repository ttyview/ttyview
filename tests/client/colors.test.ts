// Color regression: panel serializes colors as Rust enum variants
// {"Indexed": N} or {"Rgb": {r,g,b}} — NOT {kind:"palette", idx:N}.
// This file asserts colorToCss in the bundled client decodes the
// real shape correctly. Caught a bug where every CC pane rendered
// monochrome because the wrong discriminator was checked.
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';

const PANES = [{ id: '%1', session: 's', window: '0', rows: 1, cols: 4 }];

function makeColoredGrid() {
  return {
    size: [1, 4],
    primary: [{
      cells: [
        { ch: 'R', fg: { Indexed: 9 } },          // palette red
        { ch: 'G', fg: { Indexed: 246 } },         // palette dim grey
        { ch: 'B', fg: { Rgb: { r: 80, g: 200, b: 120 } } }, // rgb green
        { ch: 'D' },                               // default (no fg)
      ],
      wrapped: false,
    }],
    alt: [],
    scrollback: [],
  };
}

describe('panel color schema', () => {
  it('Indexed (palette) cells get a color: rule', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': makeColoredGrid(),
    });
    await new Promise(r => setTimeout(r, 100));

    const cells = c.document.querySelectorAll('#primary-host .ttv-cell');
    const styles = Array.from(cells).map((s: any) => s.style.cssText);

    // Cell 0 (Indexed:9 — bright red): style should set a color
    expect(styles[0]).toContain('color:');
    expect(styles[0]).toMatch(/(rgb|#)/i);

    // Cell 1 (Indexed:246 — palette grey)
    expect(styles[1]).toContain('color:');

    // Cell 2 (Rgb 80,200,120) — should produce rgb(80,200,120)
    // happy-dom normalizes cssText with spaces, hence the regex
    expect(styles[2]).toMatch(/color:\s*rgb\(\s*80,\s*200,\s*120\)/);

    // Cell 3 (no fg) — no color rule
    expect(styles[3]).not.toContain('color:');
  });

  it('legacy {kind:palette, idx} shape still decodes (defensive)', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': {
        size: [1, 1],
        primary: [{ cells: [{ ch: 'X', fg: { idx: 9 } }], wrapped: false }],
        alt: [], scrollback: [],
      },
    });
    await new Promise(r => setTimeout(r, 100));

    const cell = c.document.querySelector('#primary-host .ttv-cell') as any;
    expect(cell.style.cssText).toContain('color:');
  });

  it('null/default fg produces no color rule', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': {
        size: [1, 1],
        primary: [{ cells: [{ ch: 'X', fg: null }], wrapped: false }],
        alt: [], scrollback: [],
      },
    });
    await new Promise(r => setTimeout(r, 100));

    const cell = c.document.querySelector('#primary-host .ttv-cell') as any;
    expect(cell.style.cssText).not.toContain('color:');
  });
});
