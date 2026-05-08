// E2E: send-input round-trip.
//
// Spawns a real tmux server + a real ttyview-daemon, drives the
// browser-served UI with Playwright, types into the input box, hits
// Send, and verifies the keys arrived in the tmux pane.
//
// This is the highest-value regression test for the project: it
// covers the wire protocol AND the daemon's send-keys path AND the
// client's input handling, end-to-end.
import { test, expect } from '@playwright/test';
import { startE2e, type E2eEnv } from './_helpers.ts';

let env: E2eEnv;

test.beforeAll(async () => { env = await startE2e(); });
test.afterAll(async () => { await env.cleanup(); });

test('typing in the input box → keys arrive in the tmux pane', async ({ page }) => {
  await page.goto('/');
  // #pane-select is intentionally display:none — the visible UI is
  // the custom #pane-picker-btn. We only need the select to be
  // attached + populated for the value check below.
  await expect(page.locator('#pane-select')).toBeAttached();

  // The daemon attached to a single tmux session. The pane select
  // should default to its only pane.
  const selValue = await page.locator('#pane-select').inputValue();
  expect(selValue).toBe(env.paneId);

  // Wait for grid to load
  await expect(page.locator('#status')).toContainText('connected', { timeout: 5000 });

  // Type into the input + click Send
  const marker = 'TTV_E2E_' + Date.now();
  await page.locator('#input-text').fill(marker);
  await page.locator('#send-btn').click();

  // Verify the marker landed in the actual tmux pane.
  // Bash is running in the pane — `send-keys -l` types the chars
  // and the trailing \r submits. The pane should NOT show "command
  // not found" for a non-existent command? Actually bash will
  // print "<marker>: command not found" — both ways the marker
  // appears in capture-pane output.
  for (let i = 0; i < 30; i++) {
    const captured = env.tmuxCapturePane(env.paneId);
    if (captured.includes(marker)) return; // pass
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('marker never appeared in tmux pane after 3s');
});

test('Enter in the textarea also submits', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('connected', { timeout: 5000 });

  const marker = 'TTV_ENTER_' + Date.now();
  await page.locator('#input-text').fill(marker);
  await page.locator('#input-text').press('Enter');

  for (let i = 0; i < 30; i++) {
    const captured = env.tmuxCapturePane(env.paneId);
    if (captured.includes(marker)) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Enter-submitted marker never appeared in tmux pane');
});

test('client sends WS frames with t:"input" (not kind:"input")', async ({ page }) => {
  // Capture WS traffic via Playwright's CDP integration. If anyone
  // ever flips back to kind: this test fails before the marker test
  // even gets to run.
  const sentFrames: string[] = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => sentFrames.push(typeof f.payload === 'string' ? f.payload : ''));
  });

  await page.goto('/');
  await expect(page.locator('#status')).toContainText('connected', { timeout: 5000 });

  await page.locator('#input-text').fill('hi');
  await page.locator('#send-btn').click();
  await page.waitForTimeout(300);

  const inputFrames = sentFrames
    .map(s => { try { return JSON.parse(s); } catch { return null; } })
    .filter(f => f && f.t === 'input');
  expect(inputFrames.length).toBeGreaterThan(0);
  expect(inputFrames[0]).toMatchObject({ t: 'input', p: env.paneId });
  expect(inputFrames[0]).not.toHaveProperty('kind');
  expect(inputFrames[0].keys).toBe('hi\r');
});
