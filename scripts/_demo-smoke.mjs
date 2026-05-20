#!/usr/bin/env node
// Smoke test for --demo mode polish:
//   - 5 synthetic panes via /panes
//   - 11 curated plugins via /plugins/installed
//   - /api/instance returns { demo: true, read_only: true }
//   - 5 distinct cc-transcripts route by pane id
//   - body.ttv-demo is set in the UI on first paint
//   - localStorage is pre-seeded (ttv-plugin:ttyview-tabs:pins, etc.)
//   - Discover tab is hidden in Settings → master list
//   - POST /plugins/install still 403s
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'http://127.0.0.1:7799';
const OUT = path.resolve('./eval-results/demo-' +
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
await page.goto(URL + '/?_t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(1500); // demo seed + plugin boot

// === Daemon-side facts ===
const facts = await page.evaluate(async () => {
  const instance  = await (await fetch('/api/instance')).json();
  const panes     = await (await fetch('/panes')).json();
  const installed = (await (await fetch('/plugins/installed')).json()).plugins;
  const transcripts = {};
  for (const p of panes) {
    const t = await (await fetch('/panes/' + encodeURIComponent(p.id) + '/cc-transcript?tail=10')).json();
    transcripts[p.id] = { jsonl: t.jsonl, count: t.count };
  }
  // Try install — must be 403.
  const installResp = await fetch('/plugins/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'ttyview-clock' }),
  });
  return { instance, panes, installed, transcripts, installStatus: installResp.status };
});
console.log('[instance]', JSON.stringify(facts.instance));
console.log('[panes]', facts.panes.length, 'panes:', facts.panes.map(p => p.session).join(', '));
console.log('[installed]', facts.installed.length, 'plugins');
console.log('[transcripts]', JSON.stringify(facts.transcripts, null, 2));
console.log('[install attempt]', facts.installStatus);

// === Client-side state ===
const client = await page.evaluate(() => ({
  body_demo_class: document.body.classList.contains('ttv-demo'),
  seeded_flag: localStorage.getItem('ttv-demo-seeded'),
  pins_raw: localStorage.getItem('ttv-plugin:ttyview-tabs:pins'),
  active_view: localStorage.getItem('ttv-active-view'),
  active_theme: localStorage.getItem('ttv-active-theme'),
  last_session: localStorage.getItem('ttv-last-session'),
}));
console.log('[client]', JSON.stringify(client, null, 2));

// === Open Settings → Discover must NOT be in the master list ===
await page.click('#settings-btn');
await page.waitForTimeout(300);
const settings = await page.evaluate(() => {
  const overlay = document.getElementById('settings-overlay');
  const items = Array.from(overlay.querySelectorAll('#settings-master .ms-item span:first-child'))
    .map(s => s.textContent.trim());
  return { items };
});
console.log('[settings master items]', JSON.stringify(settings.items));

// === Tabs row rendered with the 5 seeded pins ===
const tabs = await page.evaluate(() => {
  // Tabs default to `above-grid` slot (#tab-bar). Layout customizer
  // can move them, but the smoke test doesn't.
  const slot = document.getElementById('tab-bar');
  const tabBtns = Array.from(document.querySelectorAll('.ttvtab')).map(t => t.title || t.textContent);
  return { tabBtns, slotHidden: slot ? slot.hidden : null };
});
console.log('[tabs]', JSON.stringify(tabs));

await page.screenshot({ path: path.join(OUT, '01-demo.png'), fullPage: true });

console.log('--- assertions ---');
const pins = JSON.parse(client.pins_raw || '[]');
console.log('[ok] /api/instance demo + read_only:', facts.instance.demo === true && facts.instance.read_only === true);
console.log('[ok] 5 demo panes:', facts.panes.length === 5);
console.log('[ok] 11 curated plugins installed:', facts.installed.length === 11);
console.log('[ok] 5 distinct transcripts routed:',
  new Set(Object.values(facts.transcripts).map(t => t.jsonl)).size === 5);
console.log('[ok] POST /plugins/install → 403:', facts.installStatus === 403);
console.log('[ok] body.ttv-demo set:', client.body_demo_class === true);
console.log('[ok] ttv-demo-seeded flag set:', client.seeded_flag === '1');
console.log('[ok] 5 pins seeded:', pins.length === 5);
console.log('[ok] active view = ttyview-cc:', client.active_view === 'ttyview-cc');
console.log('[ok] active theme = ttyview-terminal-green:', client.active_theme === 'ttyview-terminal-green');
console.log('[ok] Discover hidden from Settings:', !settings.items.includes('Discover'));
console.log('[ok] tabs row shows ≥5 buttons (pins + maybe +add):', tabs.tabBtns.length >= 5);

await browser.close();
