#!/usr/bin/env node
// Reproduces the user-reported regression: Pinned Tabs moved to the
// "above-input" slot via the Layout customizer. Before the fix, the
// tabs vanished (pushed off-screen by the row-flex sibling) and the
// quickkeys row stretched vertically. After the fix, the parent slot
// flips to column so tabs sit ABOVE quickkeys.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'https://127.0.0.1:7800';
const OUT = path.resolve('./eval-results/tabs-above-input-' +
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  ignoreHTTPSErrors: true,
  serviceWorkers: 'block',
});
const page = await ctx.newPage();
page.on('console', m => {
  if (['error','warning'].includes(m.type()))
    console.log('[b]', m.type(), m.text().slice(0, 200));
});

console.log('[shot] goto', URL);
await page.goto(URL + '/?_t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// Seed pins + settings + the layout override that moves Pinned Tabs
// to above-input (the slot quickkeys uses by default). Use REAL pane
// ids from the current tmux server, but deliberately mis-pair one
// pin: its stored `id` belongs to a different session than `session`,
// exercising the "stale id after tmux restart" code path. The
// resolver must ignore the stale id and re-resolve by session — and
// must NOT light up that tab as active when the stale id matches the
// current active pane.
await page.evaluate(async () => {
  const panes = await (await fetch('/panes')).json();
  const byName = Object.fromEntries(panes.map(p => [p.session, p.id]));
  // Pins with REAL ids except the first — tmux-web3 gets the id of
  // 'claude4' as a stale-cache simulation. Real session string,
  // wrong cached id.
  const pins = [
    { id: byName['claude4'] || '%99', session: 'tmux-web3' }, // stale id
    { id: byName['ttyview1'],         session: 'ttyview1' },
    { id: byName['claude3'],          session: 'claude3' },
    { id: byName['tmux-web1'],        session: 'tmux-web1' },
    { id: byName['tmux-web5'],        session: 'tmux-web5' },
    { id: byName['assistant1'],       session: 'assistant1' },
  ];
  localStorage.setItem('ttv-plugin:ttyview-tabs:pins', JSON.stringify(pins));
  localStorage.setItem('ttv-plugin:ttyview-tabs:settings',
    JSON.stringify({ rows: 1, maxPerRow: 5 }));
  localStorage.setItem('ttv-layout', JSON.stringify({ 'ttyview-tabs': 'above-input' }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(900);

// Switch to claude4 — the pane whose id is stale-cached on the
// tmux-web3 pin. After this, tmux-web3's tab MUST NOT be marked
// active (it was before the resolvePin fix).
const claude4Id = await page.evaluate(async () => {
  const panes = await (await fetch('/panes')).json();
  const c4 = panes.find(p => p.session === 'claude4');
  if (c4) await window.ttyview.selectPane(c4.id);
  return c4?.id;
});
console.log('[shot] switched active to claude4 =', claude4Id);
await page.waitForTimeout(500);

await page.screenshot({ path: path.join(OUT, '01-tabs-above-input.png') });

// Inventory the above-input slot to verify structure + per-row
// independent scrolling + correct active highlight.
const inv = await page.evaluate(() => {
  const active = window.ttyview?.getActivePane?.();
  const slot = document.getElementById('input-accessory');
  if (!slot) return { error: 'no input-accessory slot' };
  const cs = getComputedStyle(slot);
  const slotRect = slot.getBoundingClientRect();
  const children = Array.from(slot.children).map(c => {
    const ccs = getComputedStyle(c);
    return {
      pluginId: c.dataset.pluginId,
      overflowX: ccs.overflowX,
      scrollW: c.scrollWidth,
      clientW: c.clientWidth,
      independentlyScrollable: c.scrollWidth > c.clientWidth + 1,
      tabs: Array.from(c.querySelectorAll('.ttvtab')).map(t => ({
        text: t.querySelector('.ttvtab-label')?.textContent,
        full: t.title,
        active: t.classList.contains('active'),
        missing: t.classList.contains('missing'),
      })),
    };
  });
  return {
    active,
    slotClass: slot.className,
    slotDisplay: cs.display,
    slotFlexDir: cs.flexDirection,
    slotOverflowX: cs.overflowX,
    slotH: Math.round(slotRect.height),
    children,
  };
});
console.log('[inv]', JSON.stringify(inv, null, 2));

// Assertions printed inline so CI / eyeball both see them.
const aip = inv.children.find(c => c.pluginId === 'ttyview-tabs');
const tab = aip?.tabs.find(t => t.full === 'tmux-web3');
console.log('[assert] parent has ttv-stacked-slot:',
  inv.slotClass.includes('ttv-stacked-slot'));
console.log('[assert] slot overflow-x hidden:', inv.slotOverflowX === 'hidden');
console.log('[assert] tmux-web3 tab NOT active:', tab && !tab.active,
  '(would be a regression of stale-id bug if true=active=true)');

console.log('[shot] done:', OUT);
await browser.close();
