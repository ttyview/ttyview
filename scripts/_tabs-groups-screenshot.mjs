#!/usr/bin/env node
// Verifies the grouped-tabs UI (project groups + header rows + left
// bracket + right rail): loads the real daemon state, screenshots the
// grid, taps a group header to collapse, screenshots again, and
// prints structural assertions (groups present, labels stripped,
// rail present, distinct bracket colors, collapse worked).
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'http://127.0.0.1:7800';
const OUT = path.resolve('./eval-results/tabs-groups-' +
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

// This runs against the live daemon — snapshot the groups state and
// restore it on exit so the collapse-tap below doesn't persist into
// the user's real UI.
const GROUPS_KEY = 'ttv-plugin:ttyview-tabs:groups';
const stateBefore = await (await fetch(URL + '/api/state')).json();
const savedGroups = stateBefore.keys[GROUPS_KEY];
let restoredOnce = false;
process.on('beforeExit', async () => {
  // Once-guard: an async beforeExit handler keeps the event loop
  // alive, which re-fires beforeExit forever.
  if (restoredOnce) return;
  restoredOnce = true;
  if (savedGroups === undefined) {
    await fetch(URL + '/api/state/' + GROUPS_KEY, { method: 'DELETE' });
  } else {
    await fetch(URL + '/api/state/' + GROUPS_KEY, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savedGroups),
    });
  }
  console.log('[cleanup] groups state restored');
});

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  ignoreHTTPSErrors: true,
  serviceWorkers: 'block',
  hasTouch: true,
});
const page = await ctx.newPage();
page.on('console', m => {
  if (['error', 'warning'].includes(m.type()))
    console.log('[b]', m.type(), m.text().slice(0, 200));
});

await page.goto(URL + '/?_t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

function inventory() {
  return page.evaluate(() => {
    const root = document.querySelector('.ttvtab-content');
    if (!root) return { error: 'no .ttvtab-content' };
    const cs = getComputedStyle(root);
    const groups = Array.from(root.querySelectorAll('.ttvtab-group')).map(g => ({
      name: g.querySelector('.ttvtab-gname')?.textContent,
      count: g.querySelector('.ttvtab-gcount')?.textContent,
      caret: g.querySelector('.ttvtab-gcaret')?.textContent,
      bracket: getComputedStyle(g).borderLeftColor,
      collapsed: !g.querySelector('.ttvtab-row'),
      tabs: Array.from(g.querySelectorAll('.ttvtab')).map(t => ({
        text: t.querySelector('.ttvtab-label')?.textContent,
        full: t.title,
        active: t.classList.contains('active'),
        missing: t.classList.contains('missing'),
        w: Math.round(t.getBoundingClientRect().width),
      })),
    }));
    const rail = document.querySelector('.ttvtab-rail');
    const contentRect = root.getBoundingClientRect();
    return {
      contentH: Math.round(contentRect.height),
      scrollH: root.scrollHeight,
      minH: root.style.minHeight,
      groups,
      rail: rail ? {
        buttons: Array.from(rail.querySelectorAll('.ttvtab')).map(b => ({
          label: b.textContent.trim(), title: b.title,
          x: Math.round(b.getBoundingClientRect().x),
          inViewport: b.getBoundingClientRect().right <= window.innerWidth,
        })),
      } : null,
      ungroupedRows: Array.from(root.children)
        .filter(c => c.classList.contains('ttvtab-row')).length,
    };
  });
}

const inv1 = await inventory();
console.log('[inv expanded]', JSON.stringify(inv1, null, 2));
await page.screenshot({ path: path.join(OUT, '01-groups-expanded.png') });

// Tap the first group header → collapse.
const firstHead = page.locator('.ttvtab-ghead').first();
const headName = await firstHead.locator('.ttvtab-gname').textContent();
await firstHead.tap();
await page.waitForTimeout(400);
const inv2 = await inventory();
await page.screenshot({ path: path.join(OUT, '02-first-group-collapsed.png') });

// Assertions.
const g1 = inv1.groups || [];
const colors = new Set(g1.map(g => g.bracket));
const mcc = g1.find(g => g.name === 'mcc');
const collapsedNow = (inv2.groups || []).find(g => g.name === headName);
console.log('[assert] groups rendered:', g1.length >= 2, '(' + g1.map(g => g.name).join(', ') + ')');
console.log('[assert] distinct bracket colors:', colors.size === g1.length);
console.log('[assert] rail present + in viewport:', !!inv1.rail && inv1.rail.buttons.every(b => b.inViewport));
console.log('[assert] mcc labels are full names (ellipsis ok):', !!mcc && mcc.tabs.every(t => /^mcc(\d+|.*…)/.test(t.text || '')));
console.log('[assert] mcc titles keep full session:', !!mcc && mcc.tabs.every(t => /^mcc\d+$/.test(t.full || '')));
console.log('[assert] collapse worked on "' + headName + '":', !!collapsedNow && collapsedNow.collapsed && collapsedNow.caret === '▸');
console.log('[assert] height capped (min==', inv1.minH + '):', inv1.contentH > 0 && Math.abs(inv1.contentH - parseInt(inv1.minH || '0', 10)) <= 1);

console.log('[out]', OUT);
await browser.close();
