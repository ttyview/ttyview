// One-off live check: ttyview-live-sync against the running mobile-cc
// on :7800. Opens the real UI headless, pushes a toast + a theme change
// through the ttyview-ui CLI, and asserts both apply WITHOUT a reload.
// Restores the prior theme when done. Run: node _live-sync-check.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const URL = 'http://127.0.0.1:7800/';
const CLI = new URL_('../../scripts/ttyview-ui', import.meta.url).pathname;
function URL_(p, b) { return new globalThis.URL(p, b); }
const ui = (...args) =>
  execFileSync(CLI, args, { encoding: 'utf8', env: { ...process.env, TTYVIEW_UI_URL: 'http://127.0.0.1:7800' } }).trim();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
let failed = false;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed = true;
};

try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500); // boot + live-sync baseline poll

  const hasPlugin = await page.evaluate(() => !!window.__ttvLiveSync);
  check('live-sync plugin loaded', hasPlugin);

  // --- toast ---
  ui('toast', 'e2e: hello from the agent');
  await page.waitForTimeout(3500); // ≤ 2 poll cycles
  const toastText = await page.evaluate(() => {
    const el = document.querySelector('#ttv-live-sync-toasts .ttv-toast');
    return el ? el.textContent : null;
  });
  check('toast rendered without reload', toastText === 'e2e: hello from the agent');

  // --- theme switch (restored after) ---
  const prevTheme = await page.evaluate(() =>
    window.ttyview._internal.getActiveThemeId());
  ui('theme', 'ttyview-terminal-green');
  await page.waitForTimeout(3500);
  const newTheme = await page.evaluate(() =>
    window.ttyview._internal.getActiveThemeId());
  check('theme applied without reload', newTheme === 'ttyview-terminal-green');
  ui('theme', prevTheme || 'none');
  await page.waitForTimeout(3500);
  const restored = await page.evaluate(() =>
    window.ttyview._internal.getActiveThemeId());
  check('theme restored', restored === (prevTheme || null));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
