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

// Regression guard for the 2026-06-21 "yanked to bottom" bug: the
// background scrollback prefill prepends older rows above the viewport
// and compensates scrollTop itself. If #grid-host kept the browser
// default `overflow-anchor: auto`, the browser ALSO compensated → the
// view drifted to the bottom every chunk while history loaded. Cheap
// guard against the CSS fix being removed.
test('#grid-host disables native scroll anchoring (overflow-anchor:none)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveClass(/\bconnected\b/, { timeout: 5000 });
  const oa = await page.locator('#grid-host')
    .evaluate((el) => getComputedStyle(el).overflowAnchor);
  expect(oa).toBe('none');
});

// Behavioral regression test for the same bug. Deep scrollback + a
// raised `ttv-scrollback-rows` triggers the two-phase load; we HOLD the
// deep grid fetch until after the user has scrolled up, so the prepend
// provably happens while the user is off the bottom — exactly the buggy
// scenario — then assert the anchored row stays put and we don't snap
// back to the live tail.
test('background prefill keeps the viewport anchored (no yank to bottom)', async ({ page }) => {
  // Pump deep scrollback into the pane.
  env.tmuxCmd(['send-keys', '-l', '-t', env.paneId,
    'for i in $(seq 1 1500); do echo "PFLINE_$i"; done\r']);
  await new Promise((r) => setTimeout(r, 2000));

  // Want more than the 200-line fast tail so the prefill actually runs.
  await page.addInitScript(() => localStorage.setItem('ttv-scrollback-rows', '2000'));

  // Gate the DEEP fetch (max_scrollback > 200) on a promise we resolve
  // only after scrolling up — makes the prepend ordering deterministic.
  let releaseDeep: () => void = () => {};
  const deepGate = new Promise<void>((res) => { releaseDeep = res; });
  await page.route(/\/grid\?/, async (route) => {
    const m = route.request().url().match(/max_scrollback=(\d+)/);
    if (m && Number(m[1]) > 200) await deepGate;
    await route.continue();
  });

  await page.goto('/');
  await expect(page.locator('#status')).toHaveClass(/\bconnected\b/, { timeout: 5000 });
  // Fast paint settled: the 200-line tail is in the DOM, view at bottom.
  await expect.poll(() => page.locator('#sb-host .ttv-row').count(), { timeout: 5000 })
    .toBeGreaterThan(100);

  // Scroll up off the bottom; record a non-empty anchor row + its
  // viewport-relative offset.
  const before = await page.evaluate(() => {
    const host = document.getElementById('grid-host') as HTMLElement;
    host.scrollTop = Math.min(150, host.scrollHeight - host.clientHeight - 1);
    const hostTop = host.getBoundingClientRect().top;
    const rows = Array.from(host.querySelectorAll('.ttv-row')) as HTMLElement[];
    for (const r of rows) {
      const off = r.getBoundingClientRect().top - hostTop;
      const label = (r.textContent || '').trim();
      if (off >= 0 && label) return { label, offset: off, scrollTop: host.scrollTop };
    }
    return { label: '', offset: 0, scrollTop: host.scrollTop };
  });
  expect(before.label.length).toBeGreaterThan(0);

  // Release the deep fetch; prefill prepends the older rows in chunks.
  releaseDeep();
  await expect.poll(() => page.locator('#sb-host .ttv-row').count(), { timeout: 8000 })
    .toBeGreaterThan(800);
  await page.waitForTimeout(400); // let the final chunks + scroll settle

  const after = await page.evaluate((label: string) => {
    const host = document.getElementById('grid-host') as HTMLElement;
    const hostTop = host.getBoundingClientRect().top;
    const rows = Array.from(host.querySelectorAll('.ttv-row')) as HTMLElement[];
    const anchor = rows.find((r) => (r.textContent || '').trim() === label) || null;
    const maxScroll = host.scrollHeight - host.clientHeight;
    return {
      found: !!anchor,
      offset: anchor ? anchor.getBoundingClientRect().top - hostTop : NaN,
      atBottom: (maxScroll - host.scrollTop) < 5,
    };
  }, before.label);

  expect(after.found).toBe(true);
  // The anchored row must stay at ~the same viewport position. The bug
  // drove it off-screen as the view was dragged to the bottom.
  expect(Math.abs(after.offset - before.offset)).toBeLessThan(8);
  // And we must NOT have been snapped back to the live tail.
  expect(after.atBottom).toBe(false);
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
