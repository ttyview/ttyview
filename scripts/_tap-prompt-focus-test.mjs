#!/usr/bin/env node
// Verifies tap-prompt-to-focus: a short tap on the row holding CC's
// cursor (the prompt row, ±1) focuses #input-text. Long-press or
// drag does NOT focus. Toggle off (via the display-toggles plugin)
// disables the behaviour entirely.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'https://127.0.0.1:7800';
const OUT = path.resolve('./eval-results/tap-prompt-' +
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  ignoreHTTPSErrors: true,
  serviceWorkers: 'block',
  hasTouch: true, // pointerType=touch for the gesture
});
const page = await ctx.newPage();
page.on('console', m => {
  const t = m.text();
  if (t.startsWith('[fire]') || t.startsWith('[tapdbg')) console.log(t);
  else if (['error','warning'].includes(m.type()))
    console.log('[b]', m.type(), t.slice(0, 200));
});

await page.goto(URL + '/?_t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(1500); // give grid-loaded time to land

// Inventory: where is the cursor row, and what's its bounding rect?
const info1 = await page.evaluate(() => {
  const primary = document.getElementById('primary-host');
  if (!primary) return { error: 'no #primary-host' };
  const rows = Array.from(primary.children);
  if (rows.length === 0) return { error: 'no rows rendered' };
  // The cell-grid plugin stores cursorRowIdx in a closure — read
  // it indirectly by looking at the active pane's cursor[0].
  const active = window.ttyview.getActivePane();
  const cursorRow = active?.cursor?.[0];
  const tapTarget = (cursorRow != null && rows[cursorRow]) ? rows[cursorRow] : rows[rows.length - 3];
  const rect = tapTarget.getBoundingClientRect();
  return {
    cursorRow,
    rowsRendered: rows.length,
    tapY: Math.round(rect.y + rect.height / 2),
    tapX: Math.round(rect.x + rect.width / 2),
    bodyTapPromptFocus: document.body.classList.contains('ttv-tap-prompt-focus'),
    inputFocusedBefore: document.activeElement === document.getElementById('input-text'),
  };
});
console.log('[info]', JSON.stringify(info1, null, 2));

// Hook in document-level debug listener to see what fires anywhere.
await page.evaluate(() => {
  ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click'].forEach(t => {
    document.addEventListener(t, e => {
      console.log('[fire]', t, 'target=', e.target.tagName, 'id=', e.target.id || '-', 'cls=', e.target.className || '-');
    }, { capture: true });
  });
});
console.log('[debug] elementAt:', await page.evaluate(({x, y}) => {
  const el = document.elementFromPoint(x, y);
  return el ? { tag: el.tagName, id: el.id, cls: el.className, parent: el.parentElement?.id } : null;
}, { x: info1.tapX, y: info1.tapY }));

// Short tap on the cursor row.
await page.touchscreen.tap(info1.tapX, info1.tapY);
await page.waitForTimeout(200);
const afterShortTap = await page.evaluate(() => ({
  inputFocused: document.activeElement === document.getElementById('input-text'),
  active: document.activeElement?.id,
}));
console.log('[short-tap]', JSON.stringify(afterShortTap));

// Blur, then long-press: pointerdown, hold 500ms, pointerup at same spot.
await page.evaluate(() => document.activeElement?.blur && document.activeElement.blur());
await page.waitForTimeout(100);

// Use raw CDP-style mouse with delay since touchscreen has no hold API.
// 500ms hold > 350ms threshold → should NOT focus input.
const tapEl = await page.evaluateHandle(() => {
  const primary = document.getElementById('primary-host');
  const active = window.ttyview.getActivePane();
  const cursorRow = active?.cursor?.[0];
  return cursorRow != null ? primary.children[cursorRow] : primary.children[primary.children.length - 3];
});
await tapEl.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: info1.tapX, clientY: info1.tapY });
await page.waitForTimeout(500);
await tapEl.dispatchEvent('pointerup', { pointerType: 'touch', clientX: info1.tapX, clientY: info1.tapY });
await page.waitForTimeout(200);
const afterLongPress = await page.evaluate(() => ({
  inputFocused: document.activeElement === document.getElementById('input-text'),
  active: document.activeElement?.id,
}));
console.log('[long-press]', JSON.stringify(afterLongPress));

// Now flip toggle off + retry short tap → must NOT focus.
await page.evaluate(() => document.activeElement?.blur && document.activeElement.blur());
await page.evaluate(() => {
  const KEY = 'ttv-plugin:ttyview-display-toggles:tapPromptFocus';
  localStorage.setItem(KEY, 'false');
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const info2 = await page.evaluate(() => {
  const primary = document.getElementById('primary-host');
  const rows = Array.from(primary.children);
  const active = window.ttyview.getActivePane();
  const cursorRow = active?.cursor?.[0];
  const tapTarget = (cursorRow != null && rows[cursorRow]) ? rows[cursorRow] : rows[rows.length - 3];
  const rect = tapTarget.getBoundingClientRect();
  return {
    bodyTapPromptFocus: document.body.classList.contains('ttv-tap-prompt-focus'),
    cursorRow,
    tapY: Math.round(rect.y + rect.height / 2),
    tapX: Math.round(rect.x + rect.width / 2),
  };
});
console.log('[toggle-off info]', JSON.stringify(info2));
await page.touchscreen.tap(info2.tapX, info2.tapY);
await page.waitForTimeout(200);
const afterToggleOff = await page.evaluate(() => ({
  inputFocused: document.activeElement === document.getElementById('input-text'),
  active: document.activeElement?.id,
}));
console.log('[short-tap-toggle-off]', JSON.stringify(afterToggleOff));

console.log('--- assertions ---');
console.log('[assert] toggle ON, short tap focuses input:', afterShortTap.inputFocused);
console.log('[assert] toggle ON, long press does NOT focus:', !afterLongPress.inputFocused);
console.log('[assert] toggle OFF, short tap does NOT focus:', !afterToggleOff.inputFocused);

await browser.close();
