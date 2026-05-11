#!/usr/bin/env node
// Verify the cell-grid blue palette color. Before: #0000ee (unreadable
// on dark bg). After: #2472c8 (VS Code Dark+, matches tmux-web).
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'https://127.0.0.1:7800';
const SESSION = process.argv[3]; // optional ?session=
const OUT = path.resolve('./eval-results/palette-blue-' +
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  ignoreHTTPSErrors: true,
  serviceWorkers: 'block',
});
const page = await ctx.newPage();

let target = URL + '/?_t=' + Date.now();
if (SESSION) target += '&session=' + encodeURIComponent(SESSION);
await page.goto(target, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Scan every cell in #primary-host and report any with color #2472c8
// (or its RGB form) vs the old #0000ee.
const inv = await page.evaluate(() => {
  const out = { blue: 0, oldBlue: 0, sample: [] };
  const cells = document.querySelectorAll('#primary-host .ttv-cell');
  for (const c of cells) {
    const s = c.style.color;
    if (!s) continue;
    if (s.includes('rgb(36, 114, 200)')) {
      out.blue++;
      if (out.sample.length < 5) out.sample.push({ ch: c.textContent, color: s });
    }
    if (s.includes('rgb(0, 0, 238)')) {
      out.oldBlue++;
    }
  }
  return out;
});
console.log('[blue-cells]', JSON.stringify(inv, null, 2));

await page.screenshot({ path: path.join(OUT, '01-page.png') });
console.log('[shot] done:', OUT);
await browser.close();
