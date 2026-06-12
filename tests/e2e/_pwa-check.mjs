import { chromium } from 'playwright';
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('http://127.0.0.1:7800/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const cdp = await context.newCDPSession(page);
const manifest = await cdp.send('Page.getAppManifest');
const errors = await cdp.send('Page.getInstallabilityErrors');
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? { scope: reg.scope, active: !!reg.active, scriptURL: reg.active?.scriptURL } : null;
});
console.log(JSON.stringify({
  manifestUrl: manifest.url,
  manifestParsed: !!manifest.data,
  manifestErrors: manifest.errors,
  installabilityErrors: errors.installabilityErrors,
  serviceWorker: sw,
}, null, 2));
await browser.close();
