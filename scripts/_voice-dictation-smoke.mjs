#!/usr/bin/env node
// Smoke test for the voice-dictation plugin. Headless Chrome can't
// actually exercise the SpeechRecognition mic, but we can:
//   1. confirm the 🎤 button renders in the keys row
//   2. confirm the settings tab is registered
//   3. simulate a "final result" event into the plugin's onresult
//      handler and verify the transcript lands in #input-text,
//      including the "say enter to submit" path.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const URL = process.argv[2] || 'https://127.0.0.1:7800';
const OUT = path.resolve('./eval-results/voice-' +
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  ignoreHTTPSErrors: true,
  serviceWorkers: 'block',
});
const page = await ctx.newPage();

// Stub SpeechRecognition BEFORE the page scripts run — the plugin
// reads window.SpeechRecognition at top level. Capture the
// constructed instance so the test can fire fake `onresult`.
await page.addInitScript(() => {
  class StubRecognition extends EventTarget {
    constructor() { super(); this.continuous = false; this.interimResults = false; this.lang = ''; }
    start() { window.__voice_started = true; }
    stop()  { window.__voice_started = false; this.onend && this.onend(); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = StubRecognition;
  window.__lastRecognition = null;
  const orig = window.SpeechRecognition;
  window.SpeechRecognition = function() {
    const r = new orig();
    window.__lastRecognition = r;
    return r;
  };
});

await page.goto(URL + '/?_t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// (1) Inventory the mic button.
const inv1 = await page.evaluate(() => {
  const slot = document.getElementById('input-accessory');
  if (!slot) return { error: 'no #input-accessory slot' };
  const allButtons = Array.from(slot.querySelectorAll('button'));
  const mic = allButtons.find(b => b.textContent === '🎤' || b.textContent === '🔴');
  return {
    micPresent: !!mic,
    micLabel: mic?.textContent,
    btnCount: allButtons.length,
    settingsTabRegistered: !!window.ttyview._internal.registries.settingsTab.get('ttyview-voice-dictation'),
  };
});
console.log('[render]', JSON.stringify(inv1, null, 2));

// (2) Tap mic, fire a fake transcript, verify input contents.
await page.evaluate(() => {
  const slot = document.getElementById('input-accessory');
  const mic = Array.from(slot.querySelectorAll('button')).find(b => b.textContent === '🎤');
  mic.dispatchEvent(new PointerEvent('pointerup', { button: 0 }));
});
await page.waitForTimeout(150);

const inv2 = await page.evaluate(() => ({
  micLabel: Array.from(document.querySelectorAll('#input-accessory button'))
    .find(b => b.textContent === '🔴' || b.textContent === '🎤')?.textContent,
  recognitionExists: !!window.__lastRecognition,
  voiceStarted: !!window.__voice_started,
  lang: window.__lastRecognition?.lang,
}));
console.log('[after-tap]', JSON.stringify(inv2, null, 2));

// Fake a final transcript "hello world". Builds an event matching
// the SpeechRecognition shape the plugin reads (resultIndex +
// results[i][0].transcript + results[i].isFinal).
await page.evaluate(() => {
  const r = window.__lastRecognition;
  r.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: 'hello world' }, isFinal: true, length: 1 }],
  });
});
await page.waitForTimeout(100);
const inv3 = await page.evaluate(() => ({
  inputValue: document.getElementById('input-text').value,
}));
console.log('[transcript]', JSON.stringify(inv3));

// Now fire a "and enter" phrase — should strip "enter" + send.
let sendClicked = false;
await page.exposeFunction('__notifySend', () => { sendClicked = true; });
await page.evaluate(() => {
  const send = document.getElementById('send-btn');
  send.addEventListener('click', () => window.__notifySend(), { once: true });
  const r = window.__lastRecognition;
  r.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: 'send this enter' }, isFinal: true, length: 1 }],
  });
});
await page.waitForTimeout(500);
const inv4 = await page.evaluate(() => ({
  inputValueAfterEnter: document.getElementById('input-text').value,
}));
console.log('[say-enter]', JSON.stringify(inv4), 'sendClicked=', sendClicked);

console.log('--- assertions ---');
console.log('[ok] mic button rendered:', inv1.micPresent);
console.log('[ok] settings tab registered:', inv1.settingsTabRegistered);
console.log('[ok] tap toggles to 🔴 + starts recognition:',
  inv2.micLabel === '🔴' && inv2.voiceStarted);
console.log('[ok] transcript appended:', inv3.inputValue.includes('hello world'));
console.log('[ok] say-enter strips word + clicks Send:',
  !inv4.inputValueAfterEnter.includes('enter') && sendClicked);

await page.screenshot({ path: path.join(OUT, '01-page.png') });
console.log('[shot] done:', OUT);
await browser.close();
