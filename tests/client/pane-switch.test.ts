// UX regression: switching panes must show a loading state in the
// SAME tick that the user clicks (synchronously), so the perceived
// latency is "instant". The grid contents must clear before the
// async /grid fetch resolves.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadClient } from './_load-client.ts';

const PANES = [
  { id: '%1', session: 's1', window: '0', rows: 3, cols: 4 },
  { id: '%2', session: 's2', window: '0', rows: 3, cols: 4 },
];
const G1 = {
  size: [3, 4],
  primary: [{ cells: [{ ch: 'a' }, { ch: 'a' }, { ch: 'a' }, { ch: 'a' }], wrapped: false }],
  alt: [],
  scrollback: [
    { cells: [{ ch: '1' }, { ch: '1' }, { ch: '1' }, { ch: '1' }], wrapped: false },
  ],
};
const G2 = {
  size: [3, 4],
  primary: [{ cells: [{ ch: 'b' }, { ch: 'b' }, { ch: 'b' }, { ch: 'b' }], wrapped: false }],
  alt: [],
  scrollback: [],
};

describe('pane switch — instant UI feedback', () => {
  it('clears the old grid synchronously when selectPane runs', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': G1,
      '/panes/%2/grid': G2,
    });
    await new Promise(r => setTimeout(r, 100));

    // After bootstrap: %1 is selected and rendered (1 sb row, 1 primary)
    expect(c.document.querySelectorAll('#sb-host .ttv-row').length).toBe(1);
    expect(c.document.querySelectorAll('#primary-host .ttv-row').length).toBe(1);

    // Trigger selectPane(%2) but DON'T await it.
    const sw = (c.window as any).selectPane('%2');

    // BEFORE awaiting: old grid should be cleared. Loading class set.
    // (Sync clear in selectPane runs before the await.)
    // Note: the function is async but its first statements are sync.
    // We just need the old DOM gone before /grid fetch resolves.
    expect(c.document.querySelectorAll('#sb-host .ttv-row').length).toBe(0);
    expect(c.document.querySelectorAll('#primary-host .ttv-row').length).toBe(0);
    expect(c.document.getElementById('grid-host')!.className).toContain('loading');

    await sw;

    // AFTER awaiting: new grid built, loading class removed
    expect(c.document.querySelectorAll('#primary-host .ttv-row').length).toBe(1);
    expect(c.document.getElementById('grid-host')!.className).not.toContain('loading');
  });
});

describe('custom pane picker (no native select)', () => {
  it('opens overlay, lists panes, dispatches selectPane on tap', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': G1,
      '/panes/%2/grid': G2,
    });
    await new Promise(r => setTimeout(r, 100));

    const overlay = c.document.getElementById('pane-picker-overlay')!;
    expect(overlay.className).not.toContain('open');

    // Open via picker button
    (c.document.getElementById('pane-picker-btn') as any).click();
    expect(overlay.className).toContain('open');

    // Items rendered
    const items = c.document.querySelectorAll('#pane-picker-list .pp-item');
    expect(items.length).toBe(2);
    expect((items[0] as any).getAttribute('data-pane-id')).toBe('%1');
    expect((items[1] as any).getAttribute('data-pane-id')).toBe('%2');
    // Active class on the currently-selected pane
    expect((items[0] as any).className).toContain('active');

    // Tap second item → closes overlay, dispatches selectPane
    (items[1] as any).click();
    expect(overlay.className).not.toContain('open');
    await new Promise(r => setTimeout(r, 100));

    // %2 grid loaded
    const primFirst = c.document
      .querySelector('#primary-host .ttv-row')!.firstElementChild;
    expect((primFirst as any).textContent).toBe('b');
  });

  it('label updates when a pane is selected', async () => {
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': G1,
      '/panes/%2/grid': G2,
    });
    await new Promise(r => setTimeout(r, 100));

    const label = c.document.getElementById('pane-picker-label')!;
    expect(label.textContent).toContain('s1');

    await (c.window as any).selectPane('%2');
    expect(label.textContent).toContain('s2');
  });
});
