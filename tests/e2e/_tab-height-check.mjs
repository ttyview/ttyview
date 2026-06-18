// One-shot check: the tabs plugin's bottom stack must be the SAME
// height in pinned / ▦ all / 🕘 recent modes, so switching modes never
// bumps the terminal above. Regression guard for the recent-row reserve
// fix (the always-on recent row is pinned-mode-only; its height must be
// reserved in the other modes).
//
//   node _tab-height-check.mjs <base-url>
//
// The caller is responsible for pointing this at a THROWAWAY daemon
// (own tmux socket + config dir) — it seeds pins/recents/settings and
// clicks the mode rail, and at a phone viewport that would otherwise
// narrow real tmux windows via fit-resize.
//
// Exits 0 on success, 1 on failure.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:7901';

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 393, height: 851 },
  ignoreHTTPSErrors: true,
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Seed pins (two groups), recents (live names so the recent row renders
// in pinned mode), and settings — then reload so the plugin reads them.
await page.evaluate(() => {
  const s = window.ttyview.storage('ttyview-tabs');
  s.set('pins', [
    { session: 'alpha-claude1' }, { session: 'alpha-claude2' },
    { session: 'beta-claude1' },
  ]);
  s.set('recents', ['gamma-claude1', 'delta-claude1', 'omega-claude1', 'alpha-claude1']);
  s.set('settings', { rows: 3, maxPerRow: 4, recentRow: true, mode: 'pinned', dots: true });
});
await page.waitForTimeout(800);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.ttvtab-content', { timeout: 8000 });
await page.waitForTimeout(1200);

async function stackHeight() {
  // leftCol = the .ttvtab-content's parent; its height is the pinned
  // constant that must not vary across modes.
  return await page.evaluate(() => {
    const c = document.querySelector('.ttvtab-content');
    if (!c || !c.parentNode) return -1;
    return Math.round(c.parentNode.getBoundingClientRect().height * 10) / 10;
  });
}
async function recentRowPresent() {
  return await page.evaluate(() => !!document.querySelector('.ttvtab-recentrow'));
}

const pinnedH = await stackHeight();
const pinnedHasRecent = await recentRowPresent();

// Switch to all (▦).
await page.click('[aria-label="Show all sessions"]');
await page.waitForTimeout(800);
const allH = await stackHeight();
const allHasRecent = await recentRowPresent();

// Back to pinned, then to recent (🕘).
await page.click('[aria-label="Back to pinned tabs"]');
await page.waitForTimeout(500);
await page.click('[aria-label="Show recent sessions (most recent first)"]');
await page.waitForTimeout(800);
const recentH = await stackHeight();

await browser.close();

console.log(JSON.stringify({
  pinnedH, allH, recentH,
  pinnedHasRecent, allHasRecent,
}, null, 2));

let ok = true;
if (!pinnedHasRecent) {
  console.error('FAIL: recent row did not render in pinned mode — test did not exercise the bug');
  ok = false;
}
if (allHasRecent) {
  console.error('FAIL: recent row leaked into all mode (should be pinned-only)');
  ok = false;
}
const tol = 1.5;
if (Math.abs(pinnedH - allH) > tol || Math.abs(pinnedH - recentH) > tol) {
  console.error(`FAIL: stack height varies across modes — pinned ${pinnedH}, all ${allH}, recent ${recentH} (tol ${tol}px). The terminal would bump.`);
  ok = false;
}
if (ok) {
  console.log(`OK: stack height constant across modes (${pinnedH}px) — no terminal bump.`);
  process.exit(0);
}
process.exit(1);
