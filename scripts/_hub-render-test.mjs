#!/usr/bin/env node
// Smoke test for the tabbed ttyview project-hub page hosted under
// tmux-web. Loads the page, verifies each of the 4 tabs renders its
// expected content (status board, live-app URLs, source/paths,
// per-agent dropdown + log).
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

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

// (1) Tabs render.
const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.tab-btn'))
  .map(b => ({ tab: b.dataset.tab, label: b.textContent.trim(), active: b.classList.contains('active') })));
console.log('[tabs]', JSON.stringify(tabs));

// (2) Overview tab default — status board rendered.
const overview = await page.evaluate(() => {
  const box = document.getElementById('status-box');
  return {
    visible: document.querySelector('.tab-panel[data-tab="overview"]').classList.contains('active'),
    textLen: box?.textContent.length,
    headingCount: box?.querySelectorAll('h2,h3,h4').length,
    pillCount: box?.querySelectorAll('.pill').length,
  };
});
console.log('[overview]', JSON.stringify(overview));

// (3) Apps tab — switch + check URLs filled.
await page.click('.tab-btn[data-tab="apps"]');
await page.waitForTimeout(120);
const apps = await page.evaluate(() => ({
  visible: document.querySelector('.tab-panel[data-tab="apps"]').classList.contains('active'),
  liveAppCount: document.querySelectorAll('.tab-panel[data-tab="apps"] a.link[data-port]').length,
  allFilled: Array.from(document.querySelectorAll('.tab-panel[data-tab="apps"] a.link[data-port]'))
    .every(a => a.href !== window.location.href + '#' && a.textContent.length > 0),
}));
console.log('[apps]', JSON.stringify(apps));

// (4) Paths tab — has the path-row entries.
await page.click('.tab-btn[data-tab="paths"]');
await page.waitForTimeout(120);
const paths = await page.evaluate(() => ({
  visible: document.querySelector('.tab-panel[data-tab="paths"]').classList.contains('active'),
  pathRowCount: document.querySelectorAll('.tab-panel[data-tab="paths"] .path-row').length,
  hasGithubLinks: document.querySelectorAll('.tab-panel[data-tab="paths"] a[href*="github.com"]').length,
}));
console.log('[paths]', JSON.stringify(paths));

// (5) Logs tab — agent dropdown populated, content visible.
await page.click('.tab-btn[data-tab="logs"]');
await page.waitForTimeout(700); // give AGENTS.md fetch time
const logs = await page.evaluate(() => {
  const sel = document.getElementById('agent-select');
  const box = document.getElementById('agent-box');
  const cnt = document.getElementById('agent-count');
  return {
    visible: document.querySelector('.tab-panel[data-tab="logs"]').classList.contains('active'),
    agentOptions: Array.from(sel.options).map(o => o.value),
    selectedAgent: sel.value,
    entryPillText: cnt.textContent,
    boxHeadings: Array.from(box.querySelectorAll('h2,h3,h4')).map(h => h.tagName + ': ' + h.textContent.slice(0, 50)),
    boxTextLen: box.textContent.length,
  };
});
console.log('[logs]', JSON.stringify(logs, null, 2));

// (5b) Combined view: select "All agents" and verify entries from
// multiple agents are interleaved chronologically (descending).
const combined = await page.evaluate(() => {
  const sel = document.getElementById('agent-select');
  sel.value = '__all__';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const box = document.getElementById('agent-box');
  const headings = Array.from(box.querySelectorAll('h4')).map(h => h.textContent.trim());
  // Check that at least one heading mentions an agent name in brackets.
  const hasAgentTags = headings.some(h => /\[\w+\]/.test(h));
  // Headings are now `[agent] YYYY-MM-DD HH:MM — …`.
  const dates = headings.map(h => h.match(/(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/)?.[1] || '').filter(Boolean);
  const sortedDesc = dates.every((d, i) => i === 0 || d <= dates[i - 1]);
  return {
    headingCount: headings.length,
    firstHeading: headings[0],
    hasAgentTags,
    sortedDesc,
    countLabel: document.getElementById('agent-count').textContent,
  };
});
console.log('[combined]', JSON.stringify(combined, null, 2));

// (6) Switch agent: pick the second agent and verify the box changes.
const secondAgentInfo = await page.evaluate(() => {
  const sel = document.getElementById('agent-select');
  if (sel.options.length < 2) return null;
  const before = document.getElementById('agent-box').textContent;
  sel.value = sel.options[1].value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const after = document.getElementById('agent-box').textContent;
  return { changed: before !== after, newAgent: sel.value };
});
console.log('[agent-switch]', JSON.stringify(secondAgentInfo));

console.log('--- assertions ---');
console.log('[ok] 4 tabs present:', tabs.length === 4);
console.log('[ok] Overview active by default, STATUS.md rendered:', overview.visible && overview.textLen > 200 && overview.headingCount >= 3);
console.log('[ok] Apps URLs filled:', apps.visible && apps.liveAppCount === 4 && apps.allFilled);
console.log('[ok] Paths shows path-rows + GitHub links:', paths.visible && paths.pathRowCount >= 8 && paths.hasGithubLinks >= 2);
console.log('[ok] Logs has agent dropdown w/ at least 1 entry:', logs.visible && logs.agentOptions.length >= 1 && logs.boxTextLen > 50);
console.log('[ok] Agent switch refreshes the box:', !secondAgentInfo || secondAgentInfo.changed);
console.log('[ok] All-agents combined view renders + sorts desc:',
  combined.headingCount >= 5 && combined.hasAgentTags && combined.sortedDesc);

await page.screenshot({ path: path.join(OUT, '04-logs.png'), fullPage: true });
console.log('[shot] done:', OUT);
await browser.close();
