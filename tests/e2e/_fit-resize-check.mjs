// One-shot live check for the fit-resize feature against a running
// mobile-cc / ttyview instance. Phone-sized viewport; asserts the
// client narrows a wide tmux window via WS {t:"resize"} and the grid
// re-renders at a readable font.
//
//   node _fit-resize-check.mjs <base-url>
//
// Exits 0 on success, 1 on failure. Prints what it saw either way.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:7800';

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 393, height: 851 },
  ignoreHTTPSErrors: true,
});

const wsFrames = [];
page.on('websocket', ws => {
  ws.on('framesent', f => {
    try {
      const m = JSON.parse(f.payload);
      if (m.t === 'resize') wsFrames.push(m);
    } catch {}
  });
});

await page.goto(BASE, { waitUntil: 'networkidle' });
// Give boot + pane select + autoFit + the resize round-trip time to land.
await page.waitForTimeout(4000);

const state = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return {
    fontSize: cs.getPropertyValue('--ttv-font-size').trim(),
    fitResizeLs: localStorage.getItem('ttv-fit-resize'),
  };
});

console.log('resize frames sent:', JSON.stringify(wsFrames));
console.log('client state:', JSON.stringify(state));

await browser.close();

if (wsFrames.length === 0) {
  console.error('FAIL: no {t:"resize"} frame was sent');
  process.exit(1);
}
const f = wsFrames[0];
if (!(f.cols >= 45 && f.cols <= 75)) {
  console.error(`FAIL: requested cols ${f.cols} outside phone band 45–75`);
  process.exit(1);
}
const px = parseFloat(state.fontSize);
if (!(px >= 11)) {
  console.error(`FAIL: font settled at ${state.fontSize} (< 11px floor)`);
  process.exit(1);
}
console.log('OK: fit-resize narrowed the pane and font is readable');
