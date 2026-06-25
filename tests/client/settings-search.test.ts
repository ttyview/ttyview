// Settings search (VSCode-style flatten + filter). Loads the real client
// (ui/index.html) into the harness DOM, registers a few plugin settingsTabs
// with realistic content, opens Settings, and drives the actual search box.
// Exercises the load-bearing, no-metadata logic: render-all-offscreen, the
// control-anchored row partition, substring match (incl. <select> options),
// the whole-tab fallback, built-in title-only entries, <mark> highlight,
// the empty state, and teardown-on-clear.
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';

// happy-dom is narrow (innerWidth 414) → opening Settings shows the master
// list without auto-selecting a tab, so no /plugins/installed fetch fires.
async function openSettingsWithTabs(c: any) {
  const tv = (c.window as any).ttyview;
  const doc = c.document;

  // Voice Input: a description + an API-key text input + an Engine <select>
  // whose options include "Groq Whisper" (so the Engine row legitimately
  // matches "groq" via the option text — substring over rendered content).
  tv.contributes.settingsTab({
    id: 'voice', title: 'Voice Input',
    render(el: any) {
      const d = el.ownerDocument;
      const p = d.createElement('p');
      p.textContent = 'Configure the Voice Input engine and API key.';
      el.appendChild(p);
      const r1 = d.createElement('div'); r1.className = 'row';
      const l1 = d.createElement('label'); l1.textContent = 'Groq API key';
      const i1 = d.createElement('input'); i1.setAttribute('placeholder', 'gsk_…');
      r1.appendChild(l1); r1.appendChild(i1); el.appendChild(r1);
      const r2 = d.createElement('div'); r2.className = 'row';
      const l2 = d.createElement('label'); l2.textContent = 'Engine';
      const s = d.createElement('select');
      s.innerHTML = '<option>Web Speech</option><option>Groq Whisper</option>';
      r2.appendChild(l2); r2.appendChild(s); el.appendChild(r2);
    },
  });

  // Scrollback: a label then a wrapper holding TWO controls (slider + number)
  // → forces the partition to recurse into the wrapper.
  tv.contributes.settingsTab({
    id: 'scroll', title: 'Scrollback',
    render(el: any) {
      const d = el.ownerDocument;
      const lab = d.createElement('div'); lab.textContent = 'Scrollback rows';
      el.appendChild(lab);
      const wrap = d.createElement('div');
      const sl = d.createElement('input'); sl.type = 'range';
      const n = d.createElement('input'); n.type = 'number'; n.value = '2000';
      wrap.appendChild(sl); wrap.appendChild(n); el.appendChild(wrap);
    },
  });

  // Pinch Zoom: the only occurrence of "magnify" is a bare text block with no
  // control → exercises the whole-tab fallback.
  tv.contributes.settingsTab({
    id: 'pinch', title: 'Pinch Zoom',
    render(el: any) {
      const d = el.ownerDocument;
      const note = d.createElement('div');
      note.textContent = 'Magnify the terminal with a two-finger gesture.';
      el.appendChild(note);
      const b = d.createElement('button'); b.textContent = 'Sharp';
      el.appendChild(b);
    },
  });

  doc.getElementById('settings-btn').dispatchEvent(new (c.window as any).Event('click'));
  await new Promise(r => setTimeout(r, 20));
  return { tv, doc };
}

async function type(c: any, value: string) {
  const $s = c.document.getElementById('settings-search');
  $s.value = value;
  $s.dispatchEvent(new (c.window as any).Event('input'));
  // input handler debounces 120ms.
  await new Promise(r => setTimeout(r, 160));
}

function visibleGroups(c: any): string[] {
  return Array.from(c.document.querySelectorAll('.ss-group'))
    .filter((g: any) => !g.hidden)
    .map((g: any) => g.querySelector('.ss-group-head').textContent);
}
function visibleRowTexts(c: any): string[] {
  return Array.from(c.document.querySelectorAll('.ss-row'))
    .filter((r: any) => !r.classList.contains('ss-hide') &&
      r.closest('.ss-group') && !r.closest('.ss-group').hidden)
    .map((r: any) => r.textContent.trim())
    .filter(Boolean);
}
function marks(c: any): string[] {
  return Array.from(c.document.querySelectorAll('mark.ss-hl')).map((m: any) => m.textContent);
}

const FETCHES = {
  '/panes': [{ id: '%1', session: 'alpha', window: '0', rows: 1, cols: 4, idle_ms: 100 }],
  '/panes/%1/grid': { size: [1, 4], primary: [{ cells: [{ ch: 'a' }], wrapped: false }], alt: [], scrollback: [] },
  '/api/state': { schema: 1, keys: {} },
};

describe('settings search (flatten + filter)', () => {
  it('filters to the matching tab + rows and highlights the match', async () => {
    const c = await loadClient(FETCHES);
    await openSettingsWithTabs(c);
    await type(c, 'groq');
    expect(c.document.getElementById('settings-overlay').classList.contains('searching')).toBe(true);
    expect(visibleGroups(c)).toEqual(['Voice Input']);
    // Every visible row actually contains the query (the API-key row, and the
    // Engine row via its "Groq Whisper" option).
    const rows = visibleRowTexts(c);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(t => /groq/i.test(t))).toBe(true);
    expect(marks(c).length).toBeGreaterThan(0);
    expect(marks(c).every(m => m.toLowerCase() === 'groq')).toBe(true);
  });

  it('matches a setting description and a recursed multi-control wrapper', async () => {
    const c = await loadClient(FETCHES);
    await openSettingsWithTabs(c);
    await type(c, 'scrollback');
    expect(visibleGroups(c)).toEqual(['Scrollback']);
  });

  it('whole-tab fallback: matches text in a control-less block', async () => {
    const c = await loadClient(FETCHES);
    await openSettingsWithTabs(c);
    await type(c, 'magnify');
    expect(visibleGroups(c)).toEqual(['Pinch Zoom']);
  });

  it('built-in meta tabs match by title only', async () => {
    const c = await loadClient(FETCHES);
    await openSettingsWithTabs(c);
    await type(c, 'about');
    expect(visibleGroups(c)).toEqual(['About']);
  });

  it('is case-insensitive', async () => {
    const c = await loadClient(FETCHES);
    await openSettingsWithTabs(c);
    await type(c, 'GROQ');
    expect(visibleGroups(c)).toEqual(['Voice Input']);
  });

  it('shows an empty state and a 0-result status for no match', async () => {
    const c = await loadClient(FETCHES);
    await openSettingsWithTabs(c);
    await type(c, 'zzzznope');
    expect(visibleGroups(c)).toEqual([]);
    const empty = c.document.getElementById('ss-empty');
    expect(empty && !empty.hidden).toBe(true);
    expect(c.document.getElementById('settings-search-status').textContent).toMatch(/0 results/);
  });

  it('tears down results and leaves search mode when cleared', async () => {
    const c = await loadClient(FETCHES);
    await openSettingsWithTabs(c);
    await type(c, 'groq');
    expect(visibleGroups(c).length).toBe(1);
    await type(c, '');
    expect(c.document.getElementById('settings-overlay').classList.contains('searching')).toBe(false);
    expect(c.document.querySelectorAll('.ss-group').length).toBe(0);
    expect(marks(c).length).toBe(0);
  });
});
