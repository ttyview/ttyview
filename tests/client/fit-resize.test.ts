// Fit-resize: when autoFit would need an unreadable font (< 11px) to
// fit the pane's columns on screen, the client narrows the tmux WINDOW
// via the WS {t:"resize"} message instead of applying a microscopic
// font. Origin: clean-slate mobile-cc eval 2026-06-12 — a desktop-width
// pane (80–220 cols) rendered near-unreadable on a phone, with the
// A−/↔/A+ controls hidden by default and no affordance to fix it.
//
// The math under test (happy-dom has no layout, so the client falls
// back to deterministic values): avail = window.innerWidth = 414,
// charW fallback = fontPx * 0.6. Boot font 12px.
//   wide pane (200 cols): target = floor(12 * (414/200) / 7.2) = 3 → <11
//     → resize to cols = floor(414 / (14*0.6)) = 49.
//   narrow pane (40 cols): target = floor(12 * (414/40) / 7.2) = 17 → ≥11
//     → plain font autofit, NO resize (narrow-only invariant).
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';

const WIDE_PANES = [{ id: '%1', session: 's1', window: '0', rows: 30, cols: 200 }];
const NARROW_PANES = [{ id: '%1', session: 's1', window: '0', rows: 30, cols: 40 }];
const GRID = {
  size: [1, 4],
  primary: [{ cells: [{ ch: 'a' }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }], wrapped: false }],
  alt: [], scrollback: [],
};

function resizeFrames(wsSent: any[]) {
  return wsSent.filter(f => f.t === 'resize');
}

describe('fit-resize (auto-narrow wide panes)', () => {
  it('requests a window resize instead of an unreadable font', async () => {
    const c = await loadClient({
      '/panes': WIDE_PANES,
      '/panes/%1/grid': GRID,
    });
    await new Promise(r => setTimeout(r, 150));
    const frames = resizeFrames(c.wsSent);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0].t).toBe('resize');
    expect(frames[0].p).toBe('%1');
    expect(frames[0].rows).toBe(30);
    // cols = floor(avail / (14px * 0.6)) where avail = innerWidth (414)
    // minus host CSS padding — assert the phone-comfortable band rather
    // than a pixel-exact value so a padding tweak doesn't break this.
    expect(frames[0].cols).toBeGreaterThanOrEqual(40);
    expect(frames[0].cols).toBeLessThanOrEqual(50);
    // While the resized grid is in flight the font holds the
    // readability floor, not the microscopic fit.
    const fontPx = parseFloat(
      c.window.document.documentElement.style.getPropertyValue('--ttv-font-size'),
    );
    expect(fontPx).toBeGreaterThanOrEqual(11);
  });

  it('never widens: pane already narrower than the fit target is left alone', async () => {
    const c = await loadClient({
      '/panes': NARROW_PANES,
      '/panes/%1/grid': GRID,
    });
    await new Promise(r => setTimeout(r, 150));
    expect(resizeFrames(c.wsSent)).toEqual([]);
  });

  it('does not spam tmux: identical request is sent once', async () => {
    const c = await loadClient({
      '/panes': WIDE_PANES,
      '/panes/%1/grid': GRID,
    });
    await new Promise(r => setTimeout(r, 150));
    // Several viewport resize events inside the guard window → still
    // exactly one frame for the same (pane, cols).
    c.window.dispatchEvent(new c.window.Event('resize'));
    c.window.dispatchEvent(new c.window.Event('resize'));
    await new Promise(r => setTimeout(r, 100));
    expect(resizeFrames(c.wsSent).length).toBe(1);
  });

  it('grid-reset refreshes /panes before refetching the grid', async () => {
    const c = await loadClient({
      '/panes': NARROW_PANES,
      '/panes/%1/grid': GRID,
    });
    await new Promise(r => setTimeout(r, 150));
    const panesBefore = c.fetchCalls.filter(f => f.path === '/panes').length;
    const gridBefore = c.fetchCalls.filter(f => f.path === '/panes/%1/grid').length;
    c.recvWs({ t: 'grid-reset', p: '%1' });
    await new Promise(r => setTimeout(r, 100));
    expect(c.fetchCalls.filter(f => f.path === '/panes').length).toBe(panesBefore + 1);
    expect(c.fetchCalls.filter(f => f.path === '/panes/%1/grid').length).toBe(gridBefore + 1);
  });
});
