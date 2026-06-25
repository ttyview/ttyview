// ttyview-tabs status dots: waiting (permission prompt, semantic
// events), active (recent output via WS 'tick' events — all-panes
// kinds:['semantic','tick'] subs), attention (active session went idle
// — DOT_ACTIVE_MS decay — while not viewed). Loads the real plugin file
// into the harness DOM and drives it through the events a live daemon emits.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadClient } from './_load-client.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TABS_SRC = readFileSync(resolve(
  __dirname,
  '../../crates/ttyview-core/community-plugins/ttyview-tabs.js',
), 'utf-8');

const GRID = {
  size: [1, 4],
  primary: [{ cells: [{ ch: 'a' }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }], wrapped: false }],
  alt: [], scrollback: [],
};

function panes(idle1: number, idle2: number) {
  return [
    { id: '%1', session: 'alpha', window: '0', rows: 1, cols: 4, idle_ms: idle1 },
    { id: '%2', session: 'beta', window: '0', rows: 1, cols: 4, idle_ms: idle2 },
  ];
}

async function loadWithTabs(idle1: number, idle2: number) {
  const c = await loadClient({
    '/panes': panes(idle1, idle2),
    '/panes/%1/grid': GRID,
    '/panes/%2/grid': GRID,
    '/api/state': { schema: 1, keys: {} },
  });
  await new Promise(r => setTimeout(r, 100));
  // Pin both sessions so tabs render in pinned mode, then load the
  // real plugin source.
  (c.window as any).localStorage.setItem(
    'ttv-plugin:ttyview-tabs:pins',
    JSON.stringify([
      { id: '%1', session: 'alpha' },
      { id: '%2', session: 'beta' },
    ]));
  (c.window as any).eval(TABS_SRC);
  await new Promise(r => setTimeout(r, 50));
  return c;
}

function dotOnTab(c: any, session: string): string | null {
  const tabs = Array.from(c.document.querySelectorAll('.ttvtab')) as HTMLElement[];
  const tab = tabs.find(t => (t as any).title === session || (t as any).title?.startsWith(session + ' '));
  if (!tab) return null;
  const dot = tab.querySelector('.ttvtab-dot');
  if (!dot) return null;
  return dot.className.replace('ttvtab-dot', '').trim();
}

describe('ttyview-tabs status dots', () => {
  it('shows a pulsing active dot for sessions with recent output', async () => {
    const c = await loadWithTabs(99000, 99000);
    // A pane producing output emits a WS 'tick' → its session goes 'active'.
    c.recvWs({ t: 'tick', p: '%1', gen: 1 });
    expect(dotOnTab(c, 'alpha')).toBe('active');
    expect(dotOnTab(c, 'beta')).toBeNull();
  });

  it('waiting dot follows claude.permission_prompt / _resolved', async () => {
    const c = await loadWithTabs(99000, 99000);
    c.recvWs({
      t: 'semantic', p: '%2',
      event: { name: 'claude.permission_prompt', at_gen: 5, data: {} },
    });
    expect(dotOnTab(c, 'beta')).toBe('waiting');
    c.recvWs({
      t: 'semantic', p: '%2',
      event: { name: 'claude.permission_resolved', at_gen: 8, data: {} },
    });
    expect(dotOnTab(c, 'beta')).toBeNull();
  });

  it('active → idle while unviewed becomes attention; viewing clears it', async () => {
    // viewed pane is %1/alpha; beta goes active via a tick
    const c = await loadWithTabs(99000, 99000);
    const tv = (c.window as any).ttyview;
    c.recvWs({ t: 'tick', p: '%2', gen: 1 });
    expect(dotOnTab(c, 'beta')).toBe('active');
    // No more ticks: after DOT_ACTIVE_MS the active dot decays, and since beta
    // isn't the viewed session, it becomes 'attention'.
    await new Promise(r => setTimeout(r, 4200));
    expect(dotOnTab(c, 'beta')).toBe('attention');
    // switching to beta clears it
    await tv.selectPane('%2');
    await new Promise(r => setTimeout(r, 50));
    expect(dotOnTab(c, 'beta')).toBeNull();
  }, 9000); // allow for the 4s decay

  it('waiting outranks active for the same session', async () => {
    const c = await loadWithTabs(99000, 99000);
    c.recvWs({ t: 'tick', p: '%1', gen: 1 });
    expect(dotOnTab(c, 'alpha')).toBe('active');
    c.recvWs({
      t: 'semantic', p: '%1',
      event: { name: 'claude.permission_prompt', at_gen: 3, data: {} },
    });
    expect(dotOnTab(c, 'alpha')).toBe('waiting');
  });
});
