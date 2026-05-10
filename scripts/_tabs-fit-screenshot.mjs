#!/usr/bin/env node
// Verifies the pinned-tabs fit mode: when maxPerRow > 0, every row's
// tabs share the row width equally with middle-ellipsis truncation
// for long names. Drives the live mobile-cc app, sets the setting,
// pins several sessions, then screenshots the tab row.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'https://127.0.0.1:7800';
const OUT = path.resolve('./eval-results/tabs-fit-' +
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

// Seed pins via the plugin's localStorage namespace + settings.
await page.evaluate(() => {
  // Plugin storage namespace shim — same key format the plugin uses.
  const PIN_KEY  = 'ttv-plugin:ttyview-tabs:pins';
  const SET_KEY  = 'ttv-plugin:ttyview-tabs:settings';
  // Real sessions + a synthetic long name to stress middle-ellipsis.
  // Sessions that don't resolve will render as "missing" — still
  // included to test ellipsis on long names.
  const pins = [
    { id: '%4', session: 'tmux-web3' },
    { id: '%9', session: 'fin-agent-local-very-long' },
    { id: '%5', session: 'ttyview1' },
    { id: '%7', session: 'claude3' },
    { id: '%9', session: 'assoc-manager-prod-debug' },
    { id: '%2', session: 'tmux-web1' },
    { id: '%6', session: 'tmux-web5' },
  ];
  localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  localStorage.setItem(SET_KEY, JSON.stringify({ rows: 1, maxPerRow: 5 }));
});
console.log('[shot] seeded 7 pins + maxPerRow=5');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(900);

// Screenshot the tab bar area.
await page.screenshot({ path: path.join(OUT, '01-fit-mode-5-per-row.png') });

// Inventory: how many rows, how many tabs in each, how each was truncated.
const inv = await page.evaluate(() => {
  const slot = document.querySelector('.tb-slot') || document.getElementById('tab-bar');
  if (!slot) return { error: 'no tab slot found' };
  const out = {
    slotWidth: slot.getBoundingClientRect().width,
    rows: [],
  };
  // If fit mode, there's a column of .ttvtab-row.fit elements.
  // Otherwise tabs are direct children of slot.
  const rowEls = slot.querySelectorAll('.ttvtab-row');
  const groups = rowEls.length ? Array.from(rowEls) : [slot];
  for (const grp of groups) {
    const tabs = grp.querySelectorAll('.ttvtab');
    const tabInfo = Array.from(tabs).map(t => {
      const label = t.querySelector('.ttvtab-label');
      const rect = t.getBoundingClientRect();
      return {
        rendered: label?.textContent || '',
        full: t.title,
        wPx: Math.round(rect.width),
        overflow: label ? label.scrollWidth > label.clientWidth : null,
        truncated: label && label.textContent !== t.title,
      };
    });
    out.rows.push({
      fit: grp.classList?.contains('fit') ?? null,
      rowWidth: Math.round(grp.getBoundingClientRect().width),
      tabs: tabInfo,
    });
  }
  return out;
});
console.log('[inv]', JSON.stringify(inv, null, 2));

// Tab-bar-only screenshot for clarity.
const headerHandle = await page.$('.tb-slot') || await page.$('#tab-bar');
if (headerHandle) {
  await headerHandle.screenshot({ path: path.join(OUT, '02-tab-bar-crop.png') });
}

// Now switch to maxPerRow=4 to see that 4 tabs (the first chunk) have
// more breathing room and 3 fit on row 2.
await page.evaluate(() => {
  const SET_KEY = 'ttyview-plugin:ttyview-tabs:settings';
  localStorage.setItem(SET_KEY, JSON.stringify({ rows: 1, maxPerRow: 4 }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(OUT, '03-fit-mode-4-per-row.png') });

console.log('[shot] done:', OUT);
await browser.close();
