#!/usr/bin/env node
// Verifies the auto-hide-meta behaviour for the pane picker. With
// every current session being a single pane in w0, the right-side
// meta column (id · wN · cols×rows) should disappear. Flipping
// the Settings → Always show meta toggle brings it back.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'https://127.0.0.1:7800';
const OUT = path.resolve('./eval-results/picker-meta-' +
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

await page.goto(URL + '/?_t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// Open pane picker via the title-bar selector.
await page.click('#pane-picker-btn');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, '01-picker-auto-hidden.png') });

const inv1 = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('#pane-picker-list .pp-item'));
  return rows.map(r => ({
    session: r.querySelector('.pp-session')?.textContent,
    meta:    r.querySelector('.pp-meta')?.textContent ?? null,
  }));
});
console.log('[auto-hide] rows:', JSON.stringify(inv1, null, 2));

// Now flip the setting on via localStorage (matches what the
// settings tab does) and re-render.
await page.evaluate(() => {
  const KEY = 'ttv-plugin:ttyview-pane-picker:settings';
  const s = JSON.parse(localStorage.getItem(KEY) || '{}');
  s.alwaysShowMeta = true;
  localStorage.setItem(KEY, JSON.stringify(s));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.click('#pane-picker-btn');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, '02-picker-meta-forced.png') });

const inv2 = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('#pane-picker-list .pp-item'));
  return rows.map(r => ({
    session: r.querySelector('.pp-session')?.textContent,
    meta:    r.querySelector('.pp-meta')?.textContent ?? null,
  }));
});
console.log('[forced]    rows:', JSON.stringify(inv2, null, 2));

console.log('[shot] done:', OUT);
await browser.close();
