import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9333');
const contexts = browser.contexts();
let page = null;
for (const c of contexts) for (const p of c.pages()) {
  if (p.url().startsWith('http://localhost:7800')) page = p;
}
if (!page) { console.error('target page not found'); process.exit(1); }
await page.waitForTimeout(2000);
const cdp = await page.context().newCDPSession(page);
const manifest = await cdp.send('Page.getAppManifest');
const errors = await cdp.send('Page.getInstallabilityErrors');
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? { scope: reg.scope, active: !!reg.active, controlling: !!navigator.serviceWorker.controller } : null;
});
console.log(JSON.stringify({
  onDevice: 'Android Chrome ' + (await browser.version?.() ?? ''),
  url: page.url(),
  manifestUrl: manifest.url,
  manifestParsed: !!manifest.data,
  manifestErrors: manifest.errors,
  installabilityErrors: errors.installabilityErrors,
  serviceWorker: sw,
}, null, 2));
await browser.close();
