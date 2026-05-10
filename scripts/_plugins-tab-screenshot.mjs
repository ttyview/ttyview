#!/usr/bin/env node
// Verifies the new Obsidian-style Plugins tab: per-plugin rows with
// toggle switches, Enabled / Disabled sections, enabled-first sort.
// Headless Chrome at Pixel 7 viewport against the live mobile-cc app.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'https://127.0.0.1:7800';
const OUT = path.resolve('./eval-results/plugins-tab-' +
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 }, // Pixel 7
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

// Open settings via the header gear.
await page.click('#settings-btn');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, '01-master.png') });

// Drill into Plugins.
const items = await page.$$('#settings-master .ms-item');
let pluginsItem = null;
for (const it of items) {
  const txt = await it.evaluate(n => n.querySelector('span')?.textContent || '');
  if (txt === 'Plugins') { pluginsItem = it; break; }
}
if (!pluginsItem) { console.log('NO PLUGINS ITEM'); process.exit(2); }
await pluginsItem.click();
// renderPluginsTab is async (fetches /plugins/installed).
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, '02-plugins-tab-top.png') });

// Inventory: section headers + plugin cards in order, toggle states.
const inv = await page.evaluate(() => {
  const detail = document.getElementById('settings-detail');
  if (!detail) return { error: 'no detail' };
  const out = { headers: [], plugins: [] };
  for (const h of detail.querySelectorAll('h3')) out.headers.push(h.textContent);
  for (const card of detail.querySelectorAll('.plugin-card')) {
    const name = card.querySelector('.name')?.textContent || '';
    const desc = card.querySelector('.desc')?.textContent?.slice(0, 80) || '';
    const meta = card.querySelector('.meta')?.textContent || '';
    const tog = card.querySelector('.pl-toggle input');
    const badges = Array.from(card.querySelectorAll('.badge')).map(b => b.textContent);
    const actions = Array.from(card.querySelectorAll('button')).map(b => b.textContent);
    out.plugins.push({
      name,
      disabled: card.classList.contains('disabled'),
      hasToggle: !!tog,
      toggleChecked: tog ? tog.checked : null,
      badges, actions, meta, desc,
    });
  }
  return out;
});
console.log('[inv]', JSON.stringify(inv, null, 2));

// Try toggling the first non-core plugin off, then on again, screenshot each.
// The <input> inside .pl-toggle is visually hidden (opacity:0, width:0) —
// click the <label> instead.
const togglableLabels = await page.$$('.plugin-card .pl-toggle');
console.log('[toggles]', togglableLabels.length, 'toggle labels found');
if (togglableLabels.length > 0) {
  await togglableLabels[0].scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '03-before-toggle.png') });

  await togglableLabels[0].click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '04-after-toggle-off.png') });

  // The first plugin should now be in the Disabled section.
  const afterToggle = await page.evaluate(() => {
    const detail = document.getElementById('settings-detail');
    const cards = Array.from(detail.querySelectorAll('.plugin-card'));
    return cards.map(c => ({
      name: c.querySelector('.name')?.textContent,
      disabled: c.classList.contains('disabled'),
      checked: c.querySelector('.pl-toggle input')?.checked ?? null,
    }));
  });
  console.log('[after-toggle]', JSON.stringify(afterToggle, null, 2));

  // Toggle back on. Find the same plugin by name and click its toggle.
  const firstName = inv.plugins.find(p => p.hasToggle)?.name;
  if (firstName) {
    await page.evaluate(name => {
      const cards = document.querySelectorAll('.plugin-card');
      for (const c of cards) {
        if (c.querySelector('.name')?.textContent === name) {
          c.querySelector('.pl-toggle input')?.click();
          return;
        }
      }
    }, firstName);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, '05-after-toggle-on.png') });
  }
}

// Full-page screenshot of the tab (master+detail).
await page.screenshot({ path: path.join(OUT, '06-final.png'), fullPage: true });

console.log('[shot] done. screenshots:', OUT);
await browser.close();
