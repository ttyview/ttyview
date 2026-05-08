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
  await expect(page.locator('#status')).toContainText('connected', { timeout: 5000 });

  // The first batch of fetched scrollback should populate #sb-host
  const sbCount = await page.locator('#sb-host .ttv-row').count();
  expect(sbCount).toBeGreaterThan(50); // rough lower bound

  // Frozen rows have the .frozen class
  const frozenCount = await page.locator('#sb-host .ttv-row.frozen').count();
  expect(frozenCount).toBe(sbCount);
});

test('grid host is scrollable when content exceeds viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('connected', { timeout: 5000 });

  const dims = await page.locator('#grid-host').evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));
  expect(dims.scrollHeight).toBeGreaterThan(dims.clientHeight);
});
