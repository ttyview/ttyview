// Session-memory regression: when the user reloads, the last
// selected pane should be restored. Falls back through pane-id
// → session-name → first pane.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadClient } from './_load-client.ts';

const PANES = [
  { id: '%1', session: 's1', window: '0', rows: 1, cols: 4 },
  { id: '%2', session: 's2', window: '0', rows: 1, cols: 4 },
  { id: '%3', session: 's3', window: '0', rows: 1, cols: 4 },
];
const GRID = (label: string) => ({
  size: [1, 4],
  primary: [{ cells: [{ ch: label }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }], wrapped: false }],
  alt: [],
  scrollback: [],
});
const FETCHES = {
  '/panes': PANES,
  '/panes/%1/grid': GRID('1'),
  '/panes/%2/grid': GRID('2'),
  '/panes/%3/grid': GRID('3'),
};

describe('session memory across reloads', () => {
  it('first load with no saved state picks first pane', async () => {
    const c = await loadClient(FETCHES);
    await new Promise(r => setTimeout(r, 100));
    // Verify via the picker label (visible state) instead of probing
    // the script's let-scoped activePaneId (not on window).
    const label = c.document.getElementById('pane-picker-label')!.textContent!;
    expect(label).toContain('s1');
  });

  it('after selecting a pane, the choice is saved to localStorage', async () => {
    const c = await loadClient(FETCHES);
    await new Promise(r => setTimeout(r, 100));
    await (c.window as any).selectPane('%2');
    expect(c.window.localStorage.getItem('ttv-last-pane-id')).toBe('%2');
    expect(c.window.localStorage.getItem('ttv-last-session')).toBe('s2');
  });

  it('reload restores the saved pane by id', async () => {
    // Round 1: select %3
    const c1 = await loadClient(FETCHES);
    await new Promise(r => setTimeout(r, 100));
    await (c1.window as any).selectPane('%3');
    const savedStore = (c1.window as any).localStorage;
    const savedId = savedStore.getItem('ttv-last-pane-id');
    const savedSess = savedStore.getItem('ttv-last-session');
    expect(savedId).toBe('%3');

    // Round 2: simulate reload by loading a fresh DOM with the same
    // localStorage values prepopulated. (happy-dom gives each Window
    // a fresh localStorage, so we manually carry the saved values.)
    const c2 = await loadClient(FETCHES);
    c2.window.localStorage.setItem('ttv-last-pane-id', savedId!);
    c2.window.localStorage.setItem('ttv-last-session', savedSess!);
    // Re-run the bootstrap by calling pickInitialPane + selectPane
    // (the live bootstrap already ran with empty localStorage).
    const initial = (c2.window as any).pickInitialPane(PANES);
    expect(initial.id).toBe('%3');
  });

  it('falls back to session-name match when pane id changed', async () => {
    const c = await loadClient(FETCHES);
    c.window.localStorage.setItem('ttv-last-pane-id', '%999');     // gone
    c.window.localStorage.setItem('ttv-last-session', 's2');       // still here
    const initial = (c.window as any).pickInitialPane(PANES);
    expect(initial.id).toBe('%2');
  });

  it('falls back to first pane when nothing matches', async () => {
    const c = await loadClient(FETCHES);
    c.window.localStorage.setItem('ttv-last-pane-id', '%999');
    c.window.localStorage.setItem('ttv-last-session', 'gone');
    const initial = (c.window as any).pickInitialPane(PANES);
    expect(initial.id).toBe('%1');
  });
});
