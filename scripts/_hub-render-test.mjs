#!/usr/bin/env node
// Smoke test for the new ttyview project-hub page hosted under
// tmux-web. Loads the page, waits for STATUS.md to render, and
// inventories the headings + pill counts to verify the inline
// markdown render is doing its job.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'https://127.0.0.1:7681/ttyview-links.html';
const OUT = path.resolve('./eval-results/hub-' +
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[page-err]', e.message.slice(0, 200)));

console.log('[goto]', URL);
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

const inv = await page.evaluate(() => {
  const box = document.getElementById('status-box');
  if (!box) return { error: 'no #status-box' };
  return {
    box_exists: true,
    box_text_len: box.textContent.length,
    headings: Array.from(box.querySelectorAll('h2,h3,h4')).map(h => h.tagName + ': ' + h.textContent.trim().slice(0, 60)),
    pill_count: box.querySelectorAll('.pill').length,
    link_count: box.querySelectorAll('a').length,
    ul_li_count: box.querySelectorAll('ul li').length,
    sample_first_li: box.querySelector('ul li')?.textContent?.trim().slice(0, 80),
    has_load_error: /Could not load/.test(box.textContent),
    live_app_count: document.querySelectorAll('a.link[data-port]').length,
    apps_with_hostname: Array.from(document.querySelectorAll('a.link[data-port]'))
      .filter(a => a.href.includes('127.0.0.1') || a.href.includes(location.hostname))
      .length,
  };
});
console.log('[inv]', JSON.stringify(inv, null, 2));
console.log('--- assertions ---');
console.log('[ok] hub page reachable:', !!inv.box_exists);
console.log('[ok] STATUS.md rendered:', inv.box_text_len > 200 && !inv.has_load_error);
console.log('[ok] headings parsed:', inv.headings.length >= 3);
console.log('[ok] bullets rendered:', inv.ul_li_count >= 5);
console.log('[ok] live-app URLs filled:', inv.live_app_count === inv.apps_with_hostname);

await page.screenshot({ path: path.join(OUT, '01-hub.png'), fullPage: true });
console.log('[shot] done:', OUT);
await browser.close();
