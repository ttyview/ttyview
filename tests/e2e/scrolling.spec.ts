// E2E: scrollback rendering + scroll behavior.
//
// Pumps a few hundred lines of output into the tmux pane, verifies
// they appear in #sb-host as frozen rows, and that scrolling up
// works.
import { test, expect } from '@playwright/test';
import { startE2e, type E2eEnv } from './_helpers.ts';

let env: E2eEnv;

test.beforeAll(async () => { env = await startE2e(); });
test.afterAll(async () => { await env.cleanup(); });

test('scrollback rows render in #sb-host', async ({ page }) => {
  // Pump output so it scrolls off primary into scrollback
  env.tmuxCmd(['send-keys', '-l', '-t', env.paneId,
    'for i in $(seq 1 100); do echo "SBLINE_$i"; done\r']);
  // Wait for it to emit + be parsed by the daemon
  await new Promise(r => setTimeout(r, 1500));

  await page.goto('/');
  await expect(page.locator('#status')).toHaveClass(/\bconnected\b/, { timeout: 5000 });

  // The first batch of fetched scrollback should populate #sb-host
  const sbCount = await page.locator('#sb-host .ttv-row').count();
  expect(sbCount).toBeGreaterThan(50); // rough lower bound

  // Frozen rows have the .frozen class
  const frozenCount = await page.locator('#sb-host .ttv-row.frozen').count();
  expect(frozenCount).toBe(sbCount);
});

test('grid host is scrollable when content exceeds viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveClass(/\bconnected\b/, { timeout: 5000 });

  const dims = await page.locator('#grid-host').evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));
  expect(dims.scrollHeight).toBeGreaterThan(dims.clientHeight);
});

// REGRESSION (black band): output that streams in AFTER the page has loaded
// flows through the LIVE appendScrollback path (WS `scrollback-append`, whose
// rows are raw cell arrays), NOT the buildGrid snapshot path. A shape mismatch
// in buildFrozenRow rendered those rows BLANK — a multi-row band that vanished
// on reload. Every other test in this file pumps output BEFORE goto(), so they
// only exercised the snapshot path and never caught this. Load first, THEN
// stream.
test('live-streamed scrollback rows render content, not a blank band', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveClass(/\bconnected\b/, { timeout: 5000 });
  const before = await page.locator('#sb-host .ttv-row').count();

  // Stream distinctive lines AFTER load → exercises live appendScrollback.
  env.tmuxCmd(['send-keys', '-l', '-t', env.paneId,
    'for i in $(seq 1 120); do echo "LIVELINE_$i marker text here"; done\r']);

  await expect.poll(() => page.locator('#sb-host .ttv-row').count(), { timeout: 8000 })
    .toBeGreaterThan(before + 40);

  const result = await page.evaluate((beforeCount) => {
    const rows = [...document.querySelectorAll('#sb-host .ttv-row')];
    const appended = rows.slice(beforeCount).map((r) => (r.textContent || '').replace(/\s+$/, ''));
    let best = 0, cur = 0;
    for (const t of appended) { if (t === '') { cur++; best = Math.max(best, cur); } else cur = 0; }
    return {
      longestBlankRun: best,
      hasMarker: appended.some((t) => t.includes('LIVELINE_')),
      total: appended.length,
    };
  }, before);

  // Appended rows must carry their text...
  expect(result.hasMarker).toBe(true);
  // ...and must NOT be a band. Before the fix every appended row was blank
  // (run == total); a few legit blank spacer rows are fine, a long run is not.
  expect(result.longestBlankRun).toBeLessThan(5);
});
