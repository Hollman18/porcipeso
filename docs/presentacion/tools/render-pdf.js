/* Imprime deck.html → porcipeso-presentacion.pdf (16:9, 1280x720 por slide). */
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const deck = path.join(__dirname, '..', 'deck.html');
  const out = path.join(__dirname, '..', 'porcipeso-presentacion.pdf');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('file://' + deck, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await page.pdf({
    path: out,
    width: '1280px',
    height: '720px',
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  await browser.close();
  console.log('PDF:', out);
})().catch(e => { console.error(e); process.exit(1); });
