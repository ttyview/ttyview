#!/usr/bin/env node
// Verifies group-header move mode: taller (28px) tap target,
// long-press → ▲▼ arrows, ▼ reorders + persists, outside tap
// dismisses. Snapshots the daemon's groups state and RESTORES it
// after — this runs against the live daemon the phone uses.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'http://127.0.0.1:7800';
const OUT = path.resolve('./eval-results/tabs-reorder-' +
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

const KEY = 'ttv-plugin:ttyview-tabs:groups';
const before = await (await fetch(URL + '/api/state')).json();
const savedGroups = before.keys[KEY];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  ignoreHTTPSErrors: true,
  serviceWorkers: 'block',
});
const page = await ctx.newPage();
try {
  await page.goto(URL + '/?_t=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const names = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('.ttvtab-gname')).map(e => e.textContent));
  const order1 = await names();
  const headH = await page.evaluate(() =>
    Math.round(document.querySelector('.ttvtab-ghead').getBoundingClientRect().height));
  console.log('[assert] header height 28px:', headH === 28, '(' + headH + ')');

  // Long-press the first header (mouse pointer events drive the same
  // handlers as touch here).
  const head = page.locator('.ttvtab-ghead').first();
  const box = await head.boundingBox();
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const moving = await page.evaluate(() => ({
    gmoving: !!document.querySelector('.ttvtab-ghead.gmoving'),
    arrows: document.querySelectorAll('.ttvtab-garrow').length,
    upDisabled: document.querySelector('.ttvtab-garrow')?.disabled,
  }));
  console.log('[assert] long-press enters move mode:', moving.gmoving);
  console.log('[assert] two arrows, ▲ disabled at top:', moving.arrows === 2 && moving.upDisabled === true);
  await page.screenshot({ path: path.join(OUT, '01-move-mode.png') });

  // ▼ moves the first group down one.
  await page.locator('.ttvtab-garrow').nth(1).click();
  await page.waitForTimeout(300);
  const order2 = await names();
  console.log('[assert] ▼ moved "' + order1[0] + '" down:',
    order2[0] === order1[1] && order2[1] === order1[0],
    JSON.stringify(order1), '→', JSON.stringify(order2));
  await page.screenshot({ path: path.join(OUT, '02-after-move-down.png') });

  // Outside tap dismisses move mode.
  await page.mouse.click(206, 400);
  await page.waitForTimeout(300);
  const stillMoving = await page.evaluate(() => !!document.querySelector('.ttvtab-ghead.gmoving'));
  console.log('[assert] outside tap dismisses move mode:', !stillMoving);

  // Persistence: reload, order sticks.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const order3 = await names();
  console.log('[assert] order persists across reload:',
    JSON.stringify(order3) === JSON.stringify(order2));
  console.log('[out]', OUT);
} finally {
  await browser.close();
  // Restore the user's real group state.
  if (savedGroups === undefined) {
    await fetch(URL + '/api/state/' + KEY, { method: 'DELETE' });
  } else {
    await fetch(URL + '/api/state/' + KEY, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savedGroups),
    });
  }
  console.log('[cleanup] groups state restored');
}
