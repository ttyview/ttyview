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
// to above-input (the slot quickkeys uses by default).
await page.evaluate(() => {
  localStorage.setItem('ttv-plugin:ttyview-tabs:pins', JSON.stringify([
    { id: '%4', session: 'tmux-web3' },
    { id: '%9', session: 'fin-agent-local-very-long' },
    { id: '%5', session: 'ttyview1' },
    { id: '%7', session: 'claude3' },
    { id: '%9', session: 'assoc-manager-prod-debug' },
    { id: '%2', session: 'tmux-web1' },
    { id: '%6', session: 'tmux-web5' },
  ]));
  localStorage.setItem('ttv-plugin:ttyview-tabs:settings',
    JSON.stringify({ rows: 1, maxPerRow: 5 }));
  // The layout map — exactly what the user changed.
  localStorage.setItem('ttv-layout', JSON.stringify({
    'ttyview-tabs': 'above-input',
  }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(900);

await page.screenshot({ path: path.join(OUT, '01-tabs-above-input.png') });

// Inventory the above-input slot to verify structure.
const inv = await page.evaluate(() => {
  const slot = document.getElementById('input-accessory');
  if (!slot) return { error: 'no input-accessory slot' };
  const cs = getComputedStyle(slot);
  const rect = slot.getBoundingClientRect();
  const children = Array.from(slot.children).map(c => ({
    pluginId: c.dataset.pluginId,
    rect: {
      x: Math.round(c.getBoundingClientRect().x),
      y: Math.round(c.getBoundingClientRect().y),
      w: Math.round(c.getBoundingClientRect().width),
      h: Math.round(c.getBoundingClientRect().height),
    },
    tabs: c.querySelectorAll('.ttvtab').length,
  }));
  return {
    slot: { display: cs.display, flexDirection: cs.flexDirection, h: Math.round(rect.height) },
    children,
  };
});
console.log('[inv]', JSON.stringify(inv, null, 2));

console.log('[shot] done:', OUT);
await browser.close();
