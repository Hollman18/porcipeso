/* Saca PANTALLAZOS REALES de la app PorciPeso corriendo en :8688.
 * Uso: node shots.js
 * Salida: ../shots/*.png
 *
 * Maneja el flujo real del motor (modo lote):
 *   calibracion (base vacía) → sube cerdo de prueba → bajar_prueba
 *   → se baja → REFERENCIA → fase lote (PASO 2) → grupos → conteo.
 * Si el motor pregunta (evento ambiguo), responde la opción correcta.
 */
const { chromium } = require('playwright');
const path = require('path');

const BASE = 'http://127.0.0.1:8688';
const OUT = p => path.join(__dirname, '..', 'shots', p);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function prep(ctx) {
  await ctx.addInitScript(() => {
    localStorage.setItem('porcipeso_onboard', '1');
    localStorage.setItem('porcipeso_howto', '1');
  });
}

async function startSimAndSession(page, nombre) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const useSim = page.locator('#bUseSim');
  if (await useSim.isVisible()) {
    await useSim.click();
    await page.waitForFunction(() =>
      document.getElementById('scaleChip').textContent.includes('simulada'));
  }
  await page.click('#bStart');
  await page.waitForSelector('#pvMode.active');
  await page.click('#bModeLote');
  await page.waitForSelector('#pvSetup.active');
  await page.fill('#inpNombre', nombre);
  await page.click('#bComenzar');
  await page.waitForSelector('#pvWeigh.active');
  await page.waitForSelector('#simPanel:not([hidden])');
}

const simClick = (page, v) => page.click(`#simPanel [data-sim="${v}"]`);

/* espera a que el contador llegue a `expected`; responde preguntas con `g` */
async function waitCount(page, expected, g) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => ({
      count: parseInt(document.getElementById('nCerdos').textContent, 10) || 0,
      asking: !document.getElementById('narrBtns').hidden &&
              document.querySelectorAll('#narrBtns button').length > 0,
    }));
    if (st.count >= expected) return;
    if (st.asking) {
      await page.evaluate(n => {
        const btns = [...document.querySelectorAll('#narrBtns button')];
        const b = btns.find(x => x.textContent.trim() === String(n)) || btns[0];
        if (b && !b.disabled) b.click();
      }, g);
      await sleep(1500);
    }
    await sleep(400);
  }
  throw new Error(`el contador nunca llegó a ${expected}`);
}

async function runLote(page, nombre, groups) {
  await startSimAndSession(page, nombre);
  await sleep(3500);              // base vacía estable (calibración)
  await simClick(page, 'on-1');   // PASO 1: cerdo de prueba
  await page.waitForFunction(() =>
    document.getElementById('stepGuide').textContent.includes('bájalo') ||
    document.getElementById('narrTxt').textContent.includes('bájalo'),
    { timeout: 25000 });
  await sleep(600);
  await simClick(page, 'off');    // se baja el de prueba → REFERENCIA
  await page.waitForFunction(() =>
    document.getElementById('stepGuide').textContent.includes('PASO 2'),
    { timeout: 25000 });
  await sleep(600);
  let expected = 0;
  for (const g of groups) {       // PASO 2: el lote en grupos
    expected += g;
    await simClick(page, `on-${g}`);
    await waitCount(page, expected, g);
    await sleep(800);
  }
}

async function terminar(page) {
  await page.click('#bTerminar');
  await page.waitForSelector('#pvDone.active', { timeout: 20000 });
  await sleep(1200);
}

(async () => {
  const browser = await chromium.launch();

  /* ---------- 1) MÓVIL 390x844: pesaje en vivo + resultados ---------- */
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  await prep(mctx);
  const m = await mctx.newPage();

  await runLote(m, 'Lote 47 — corral C-2', [3, 2]);
  await sleep(2500); // narración asentada ("Todo tranquilo…")
  await m.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  await m.screenshot({ path: OUT('pesaje-movil.png') });
  console.log('shot: pesaje-movil.png');

  await terminar(m);
  await m.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  await m.screenshot({ path: OUT('resultados-movil.png') });
  console.log('shot: resultados-movil.png');
  await mctx.close();

  /* ---------- 2) DESKTOP 1440x900: sesiones extra + módulo Datos ---------- */
  const dctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await prep(dctx);
  const d = await dctx.newPage();

  for (const [nombre, groups] of [
    ['Lote 45 — corral B-1', [5, 3]],
    ['Lote 46 — corral A-3', [2, 2, 1]],
    ['Lote 48 — engorde D-1', [3]],
  ]) {
    await runLote(d, nombre, groups);
    await terminar(d);
    console.log('sesión cerrada:', nombre);
  }

  // módulo Datos con todo poblado
  await d.click('.sidenav .navbtn[data-mod="datos"]');
  await sleep(1500);
  await d.click('#bDatosRefresh');
  await sleep(1500);
  const col = d.locator('#colPesajes');
  if (!(await col.evaluate(el => el.open))) await col.locator('summary').click();
  await sleep(800);
  await d.screenshot({ path: OUT('datos-desktop.png') });
  console.log('shot: datos-desktop.png');

  await dctx.close();
  await browser.close();
  console.log('OK');
})().catch(e => { console.error(e); process.exit(1); });
