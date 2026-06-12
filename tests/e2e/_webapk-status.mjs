import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9333');
let page = null;
for (const c of browser.contexts()) for (const p of c.pages()) {
  if (p.url() === 'about:blank') page = p;
}
if (!page) page = (browser.contexts()[0].pages())[0];
await page.goto('chrome://webapks');
await page.waitForTimeout(1500);
console.log(await page.evaluate(() => document.body.innerText.slice(0, 1200)));
await browser.close();
