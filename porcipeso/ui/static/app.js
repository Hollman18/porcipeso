'use strict';
/* ============================================================
   PorciPeso — aplicación (módulos: Pesaje · Datos · Báscula)
   Siempre habla con el backend real (FastAPI, mismo origen).

   Backend:
     WS   /ws → {"type":"reading","kg","ts_ms","state"} | {"type":"event",…} | {"type":"snapshot",…}
     GET  /api/profiles · POST /api/scale/connect · GET /api/scale/status
     POST /api/sim/start · POST /api/sim/action {action,n,kg_each,seconds} · POST /api/sim/stop
     POST /api/sessions · GET /api/sessions?desde&hasta&q · GET /api/sessions/{id}
     GET  /api/sessions/{id}/events · GET /api/sessions/{id}/stats (opcional)
     POST /api/sessions/{id}/close · GET /api/sessions/{id}/export.xlsx
     POST /api/events/{id}/confirm · POST /api/events/{id}/motivo
     GET  /api/stats/global?desde&hasta → {sesiones,total_animales,total_kg,promedio_global,por_lote}
   ============================================================ */

const $ = id => document.getElementById(id);
const fmt = (n, d = 1) => (typeof n === 'number' && isFinite(n))
  ? n.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseTs = v => {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // ms o s
  const n = Number(v);
  if (!Number.isNaN(n) && String(v).trim() !== '') return n > 1e12 ? n : n * 1000;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};
const hora = ts => { try { const t = parseTs(ts) ?? Date.now(); return new Date(t).toLocaleTimeString('es-CO', { hour12: false, hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } };
const fechaCorta = ts => {
  const t = parseTs(ts);
  if (t == null) return '—';
  try { return new Date(t).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }).replace('.', '') + ' · ' + hora(t); }
  catch { return '—'; }
};
const fechaLarga = ts => {
  const t = parseTs(ts);
  if (t == null) return '';
  try { return new Date(t).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' }); }
  catch { return ''; }
};

/* ---------------- estado global ---------------- */
const APP = {
  session: null,       // {id, nombre}
  snapshot: null,
  refKg: null,
  weights: [],         // pesos individuales estimados → parejo/disparejo
  moves: [],
  lastReadingAt: 0,
  scaleConnected: false,
  simActive: false,    // báscula simulada elegida/corriendo
  lastResult: null,
  howtoThen: null,
  datosDetailId: null,
};

/* ============================================================
   ROUTER DE MÓDULOS (sidebar escritorio + pestañas móvil)
   ============================================================ */
function setModule(mod) {
  for (const b of document.querySelectorAll('[data-mod]')) {
    b.classList.toggle('active', b.dataset.mod === mod);
  }
  for (const [id, name] of [['modPesaje', 'pesaje'], ['modDatos', 'datos'], ['modBascula', 'bascula']]) {
    $(id).classList.toggle('active', name === mod);
  }
  try { history.replaceState(null, '', '#' + mod); } catch { /* sin history */ }
  if (mod === 'datos') refreshDatos().catch(() => {});
  if (mod === 'bascula') initConfig();
  window.scrollTo({ top: 0 });
}
for (const b of document.querySelectorAll('[data-mod]')) {
  b.addEventListener('click', () => setModule(b.dataset.mod));
}

function setSubview(modId, subId) {
  for (const sv of $(modId).querySelectorAll('.subview')) {
    sv.classList.toggle('active', sv.id === subId);
  }
  window.scrollTo({ top: 0 });
}

/* ============================================================
   BANNER API
   ============================================================ */
function apiDown(msg) {
  if (msg) $('apiBannerTxt').textContent = msg;
  $('apiBanner').classList.add('show');
}
function apiOk() { $('apiBanner').classList.remove('show'); }

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    apiDown('No encuentro el programa de la báscula — revisa que el computador esté encendido');
    throw e;
  }
  apiOk();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return await res.json(); } catch { return null; }
}

/* ---------------- configuración guardada (báscula real) ---------------- */
function loadCfg() {
  try { return JSON.parse(localStorage.getItem('porcipeso_cfg') || 'null'); }
  catch { return null; }
}
function saveCfg(cfg) {
  try { localStorage.setItem('porcipeso_cfg', JSON.stringify(cfg)); } catch { /* sin storage */ }
}

/* ============================================================
   BÁSCULA: estado + simulador (vía backend, TODO queda en la BD)
   ============================================================ */
async function scaleStatus() {
  try {
    const st = await api('/api/scale/status');
    const connected = !!(st?.connected ?? st?.status === 'connected');
    APP.scaleConnected = connected;
    const pid = st?.profile_id ?? st?.profile ?? '';
    if (connected && /sim/i.test(String(pid) + String(st?.profile_name ?? ''))) APP.simActive = true;
    return st;
  } catch {
    APP.scaleConnected = false;
    return null;
  }
}

async function startSim() {
  await api('/api/sim/start', { method: 'POST', body: {} });
  APP.simActive = true;
  await scaleStatus();
  if (!APP.scaleConnected) {           // por si el backend separa sim y conexión
    try { await api('/api/scale/connect', { method: 'POST', body: { profile_id: 'sim' } }); APP.scaleConnected = true; }
    catch { /* el sim/start pudo bastar */ }
  }
  refreshSimUi();
}

function refreshSimUi() {
  $('chipSim1').hidden = !APP.simActive;
  $('chipSim2').hidden = !APP.simActive;
  $('simPanel').hidden = !APP.simActive;
}

async function simAction(body) {
  try { await api('/api/sim/action', { method: 'POST', body }); }
  catch { /* banner activo */ }
}

for (const b of document.querySelectorAll('#simPanel [data-sim]')) {
  b.addEventListener('click', async () => {
    b.disabled = true;
    const v = b.dataset.sim;
    if (v.startsWith('on-')) await simAction({ action: 'pigs_on', n: parseInt(v.slice(3), 10) || 1 });
    else if (v === 'off') await simAction({ action: 'pig_off', n: 1 });
    else if (v === 'nervous') await simAction({ action: 'nervous', seconds: 5 });
    setTimeout(() => { b.disabled = false; }, 800);
  });
}

/* ============================================================
   MÓDULO PESAJE — inicio
   ============================================================ */
async function refreshPesajeHome() {
  const chip = $('scaleChip'), btn = $('bStart'), note = $('startNote'), simBtn = $('bUseSim');
  const st = await scaleStatus();
  refreshSimUi();
  if (APP.scaleConnected) {
    chip.className = 'chip ' + (APP.simActive ? 'sim' : 'ok');
    chip.textContent = APP.simActive ? 'Báscula simulada' : (st?.profile_name ?? st?.name ?? 'Báscula conectada');
    btn.textContent = 'Empezar a pesar';
    note.hidden = true;
    simBtn.hidden = APP.simActive; // ya está activa
    return;
  }
  const cfg = loadCfg();
  if (cfg?.profile_id) {
    chip.className = 'chip';
    chip.textContent = cfg.name ?? 'Báscula guardada';
    btn.textContent = 'Empezar a pesar';
    note.textContent = 'Me conecto a la báscula cuando empieces.';
    note.hidden = false;
    simBtn.hidden = false;
  } else {
    chip.className = 'chip err';
    chip.textContent = st === null ? 'Programa apagado' : 'Sin báscula';
    btn.textContent = 'Empezar a pesar';
    note.textContent = 'No hay báscula configurada. Puedes usar la báscula simulada para probar todo el sistema — queda guardado de verdad.';
    note.hidden = false;
    simBtn.hidden = false;
  }
}

$('bStart').onclick = () => {
  const seen = (() => { try { return localStorage.getItem('porcipeso_howto') === '1'; } catch { return false; } })();
  if (!seen) { APP.howtoThen = gotoSetup; openHowto(); }
  else gotoSetup();
};
$('bUseSim').onclick = async () => {
  $('bUseSim').disabled = true;
  try { await startSim(); await refreshPesajeHome(); }
  catch { /* banner activo */ }
  finally { $('bUseSim').disabled = false; }
};
$('bUseSim2').onclick = async () => {
  $('bUseSim2').disabled = true;
  try {
    await startSim();
    const res = $('testResult');
    res.className = 'test-result show ok';
    res.textContent = 'Báscula simulada activa ✓ — ve al módulo Pesaje y empieza.';
  } catch {
    const res = $('testResult');
    res.className = 'test-result show fail';
    res.textContent = 'No pude iniciar el simulador — ¿está corriendo el programa?';
  } finally { $('bUseSim2').disabled = false; }
};

/* ---------------- overlay ¿cómo funciona? ---------------- */
function openHowto() { try { $('dlgHowto').showModal(); } catch { /* abierto */ } }
$('bHowto').onclick = () => { APP.howtoThen = null; openHowto(); };
$('bHowto2').onclick = () => { APP.howtoThen = null; openHowto(); };
$('bHowtoOk').onclick = () => {
  try { localStorage.setItem('porcipeso_howto', '1'); } catch { /* sin storage */ }
  $('dlgHowto').close();
  const next = APP.howtoThen; APP.howtoThen = null;
  if (typeof next === 'function') next();
};

/* ============================================================
   MÓDULO PESAJE — preparar
   ============================================================ */
function defaultName() {
  const d = new Date();
  const dia = d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }).replace('.', '');
  const h = d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `Lote ${dia}, ${h}`;
}
function gotoSetup() {
  $('inpNombre').value = defaultName();
  $('setupError').classList.remove('show');
  $('setupErrorActions').classList.remove('show');
  $('bComenzar').disabled = false;
  refreshSimUi();
  setSubview('modPesaje', 'pvSetup');
}
$('bSetupBack').onclick = () => { setSubview('modPesaje', 'pvHome'); refreshPesajeHome().catch(() => {}); };
$('bSetupSim').onclick = async () => {
  try {
    await startSim();
    $('setupError').classList.remove('show');
    $('setupErrorActions').classList.remove('show');
  } catch { /* banner activo */ }
};
$('bSetupConfig').onclick = () => setModule('bascula');

$('formSetup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const nombre = (fd.get('nombre') ?? '').toString().trim() || defaultName();
  const extras = {};
  for (const k of ['corral', 'destino', 'placa', 'conductor']) {
    extras[k] = (fd.get(k) ?? '').toString().trim();
  }
  $('bComenzar').disabled = true;
  $('setupError').classList.remove('show');
  $('setupErrorActions').classList.remove('show');

  // 1) asegurar báscula (invisible para quien pesa)
  try {
    await scaleStatus();
    if (!APP.scaleConnected) {
      if (APP.simActive) {
        await startSim();
      } else {
        const cfg = loadCfg();
        if (!cfg?.profile_id) throw new Error('sin báscula');
        const body = { profile_id: cfg.profile_id };
        if (cfg.port) body.port = cfg.port;
        await api('/api/scale/connect', { method: 'POST', body });
        APP.scaleConnected = true;
      }
    }
  } catch {
    $('setupError').textContent = 'No pude hablar con la báscula. ¿Quieres usar la simulada, o revisar la conexión?';
    $('setupError').classList.add('show');
    $('setupErrorActions').classList.add('show');
    $('bComenzar').disabled = false;
    return;
  }

  // 2) crear el pesaje (queda en la base de datos)
  try {
    const r = await api('/api/sessions', {
      method: 'POST',
      body: { lote: nombre, ...extras, operador: '' },
    });
    APP.session = { id: r?.id ?? r?.session_id ?? null, nombre };
    startWeighing(nombre);
  } catch {
    $('setupError').textContent = 'No pude guardar el pesaje. Inténtalo de nuevo en un momento.';
    $('setupError').classList.add('show');
  } finally {
    $('bComenzar').disabled = false;
  }
});

/* ============================================================
   MÓDULO PESAJE — pesando
   ============================================================ */
function setStep(n, ref) {
  const g = $('stepGuide');
  if (n === 1) g.innerHTML = '<b>PASO 1</b> · Sube UN cerdo solo — es el cerdo de prueba para calibrar';
  else g.innerHTML = `<b>PASO 2</b> · Sube los demás como quieras (de a 1, 2, 3…); yo cuento${ref ? ` — cerdo de prueba: ${fmt(ref, 0)} kg` : ''}`;
}

function startWeighing(nombre) {
  APP.snapshot = null; APP.refKg = null;
  APP.weights = []; APP.moves = [];
  hist.length = 0;
  questions.length = 0; activeQuestion = null;
  narrLockUntil = 0;
  $('pesajeTitle').textContent = nombre;
  $('nCerdos').textContent = '0';
  $('nTotal').innerHTML = '0 <em>kg</em>';
  $('nProm').innerHTML = '— <em>kg</em>';
  renderMoves();
  setStep(1);
  refreshSimUi();
  say('Esperando el primer cerdo… súbelo solo, sin compañía', 'calm');
  setSubview('modPesaje', 'pvWeigh');
}

/* ---------------- LA NARRACIÓN ---------------- */
let narrLockUntil = 0;
let activeQuestion = null;
const questions = [];

function say(text, tone = '', stickyMs = 0) {
  if (activeQuestion) return;
  const n = $('narration');
  n.className = 'narration' + (tone ? ' ' + tone : '');
  $('narrTxt').textContent = text;
  $('narrBtns').hidden = true;
  if (stickyMs) narrLockUntil = Date.now() + stickyMs;
}
function ambient(text, tone = '') {
  if (activeQuestion || Date.now() < narrLockUntil) return;
  const n = $('narration');
  n.className = 'narration' + (tone ? ' ' + tone : '');
  $('narrTxt').textContent = text;
  $('narrBtns').hidden = true;
}

function askNext() {
  if (activeQuestion || !questions.length) return;
  activeQuestion = questions.shift();
  const q = activeQuestion;
  $('narration').className = 'narration ask';
  $('narrTxt').textContent = q.delta > 0 ? '¿Cuántos subieron?' : '¿Cuántos se bajaron?';
  const box = $('narrBtns');
  box.innerHTML = '';
  for (const o of q.options) {
    const b = document.createElement('button');
    b.textContent = String(o);
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api(`/api/events/${q.eventId}/confirm`, { method: 'POST', body: { n: o } });
        addMove(q.delta < 0 ? 'down' : 'up', q.delta < 0 ? '↩' : '✓',
          q.delta > 0 ? `Me dijiste que subieron ${o} (+${fmt(q.delta)} kg)`
                      : `Me dijiste que se bajaron ${o} (${fmt(q.delta)} kg)`);
        activeQuestion = null;
        say(q.delta > 0 ? `✓ Anotado: subieron ${o}` : `✓ Anotado: se bajaron ${o} — ya los desconté`, 'calm', 4000);
        if (q.delta > 0) for (let i = 0; i < o; i++) APP.weights.push(q.delta / o);
        askNext();
      } catch {
        b.disabled = false;
      }
    };
    box.appendChild(b);
  }
  box.hidden = false;
}

/* ---------------- lecturas (WS) ---------------- */
const hist = [];
function onReading(m) {
  const kg = Number(m?.kg ?? 0);
  APP.lastReadingAt = Date.now();
  $('led').innerHTML = `${fmt(kg, kg >= 100 ? 0 : 1)} <small>kg</small>`;
  $('led').classList.add('pulse');
  hist.push(kg); if (hist.length > 300) hist.shift();
  drawSpark();
  const st = m?.state;
  if (st === 'movimiento') ambient('Se están moviendo… espero a que se calmen', 'busy');
  else if (st === 'sin_senal') ambient('⚠ Perdí la señal de la báscula — revisa el cable', 'alert');
  else if (st === 'estable') {
    if (!APP.session) return;
    if (APP.refKg == null) ambient('Esperando el primer cerdo… súbelo solo, sin compañía', 'calm');
    else ambient('Todo tranquilo. Puedes subir más cerdos: de a 1, 2 o 3', '');
  }
}

setInterval(() => {
  if (!$('pvWeigh').classList.contains('active')) return;
  if (APP.lastReadingAt && Date.now() - APP.lastReadingAt > 3000) {
    ambient('⚠ Perdí la señal de la báscula — revisa el cable', 'alert');
    $('led').classList.remove('pulse');
  }
}, 1500);

/* ---------------- snapshot (WS) ---------------- */
function onSnapshot(s) {
  if (!s) return;
  APP.snapshot = s;
  if (s.ref_kg != null && APP.refKg == null) { APP.refKg = s.ref_kg; setStep(2, s.ref_kg); }
  $('nCerdos').textContent = s.count ?? 0;
  $('nTotal').innerHTML = `${fmt(s.total_kg ?? 0, 0)} <em>kg</em>`;
  $('nProm').innerHTML = `${s.avg_kg != null ? fmt(s.avg_kg, 0) : '—'} <em>kg</em>`;
}

/* ---------------- eventos (WS) ---------------- */
function onEvent(ev) {
  if (!ev) return;
  const tipo = ev.tipo ?? 'subida';
  const delta = Number(ev.delta_kg ?? 0);
  const pendiente = !!ev.ambiguo && ev.animales_confirmados == null;
  const n = Math.abs(ev.animales_confirmados ?? ev.animales_estimados ?? 1);

  if (tipo === 'referencia') {
    APP.refKg = delta;
    APP.weights.push(delta);
    setStep(2, delta);
    say(`Calibrado: el cerdo de prueba pesa ${fmt(delta, 0)} kg. Ya puedes subir los demás`, 'calm', 6000);
    addMove('up', '✓', `Cerdo de prueba: ${fmt(delta)} kg — quedé calibrado`);
    return;
  }
  if (pendiente) {
    const opts = (Array.isArray(ev.opciones) && ev.opciones.length) ? ev.opciones : guessOptions(delta);
    questions.push({ eventId: ev.id, delta, options: opts });
    addMove('ask', '?', `No estuve seguro con ${fmt(Math.abs(delta))} kg — te pregunté`);
    askNext();
    return;
  }
  if (tipo === 'bajada' || delta < 0) {
    say(n > 1 ? `↩ Se bajaron ${n} — ya los desconté` : '↩ Uno se bajó — ya lo desconté', '', 5000);
    addMove('down', '↩', `${n > 1 ? `Se bajaron ${n}` : 'Se bajó 1'} (${fmt(delta)} kg)`, ev.id);
    return;
  }
  if (tipo === 'reingreso') {
    say('✓ Volvió a subir — lo conté de nuevo', 'calm', 5000);
    addMove('up', '✓', `Volvió a subir 1 (+${fmt(delta)} kg)`);
    APP.weights.push(delta / (n || 1));
    return;
  }
  say(n > 1 ? `✓ Subieron ${n} cerdos` : '✓ Subió 1 cerdo', 'calm', 5000);
  addMove('up', '✓', `${n > 1 ? `Subieron ${n}` : 'Subió 1'} (+${fmt(delta)} kg)`);
  for (let i = 0; i < n; i++) APP.weights.push(delta / n);
}

function guessOptions(delta) {
  const avg = APP.snapshot?.avg_kg;
  if (!avg) return [1, 2];
  const nRaw = Math.abs(delta) / avg;
  const lo = Math.max(1, Math.floor(nRaw)), hi = Math.max(lo, Math.ceil(nRaw));
  return lo === hi ? [lo, lo + 1] : [lo, hi];
}

/* ---------------- movimientos ---------------- */
function addMove(cls, ico, text, eventId = null) {
  APP.moves.unshift({ t: hora(), cls, ico, text, eventId, motivo: null });
  renderMoves();
}
function renderMoves() {
  for (const boxId of ['movesList', 'movesListDone']) {
    const box = $(boxId);
    if (!box) continue;
    box.innerHTML = '';
    for (const mv of APP.moves) {
      const div = document.createElement('div');
      div.className = 'mv ' + mv.cls;
      div.innerHTML = `<span class="t mono">${escapeHtml(mv.t)}</span>` +
        `<span class="ico">${escapeHtml(mv.ico)}</span>` +
        `<span class="d">${escapeHtml(mv.text)}</span>`;
      if (mv.cls === 'down' && mv.eventId != null) {
        if (mv.motivo) {
          const s = document.createElement('span');
          s.className = 'why-set';
          s.textContent = `motivo: ${mv.motivo}`;
          div.appendChild(s);
        } else {
          const b = document.createElement('button');
          b.className = 'why';
          b.textContent = '¿por qué se bajó?';
          b.onclick = () => openWhy(mv);
          div.appendChild(b);
        }
      }
      box.appendChild(div);
    }
  }
}

let whyTarget = null;
function openWhy(mv) { whyTarget = mv; try { $('dlgWhy').showModal(); } catch { /* abierto */ } }
$('bWhyCancel').onclick = () => $('dlgWhy').close();
for (const b of document.querySelectorAll('#dlgWhy [data-motivo]')) {
  b.onclick = async () => {
    if (!whyTarget) return;
    const motivo = b.dataset.motivo;
    try {
      await api(`/api/events/${whyTarget.eventId}/motivo`, { method: 'POST', body: { motivo } });
      whyTarget.motivo = motivo;
      renderMoves();
      $('dlgWhy').close();
    } catch { /* banner activo */ }
    whyTarget = null;
  };
}

/* ---------------- terminar ---------------- */
$('bTerminar').onclick = async () => {
  if (!APP.session?.id) { setSubview('modPesaje', 'pvHome'); return; }
  if (activeQuestion || questions.length) {
    $('narration').classList.add('ask');
    $('narrTxt').textContent = 'Primero respóndeme la pregunta ☝ y luego terminamos';
    return;
  }
  $('bTerminar').disabled = true;
  try {
    const r = await api(`/api/sessions/${APP.session.id}/close`, { method: 'POST', body: {} });
    if (APP.simActive) api('/api/sim/stop', { method: 'POST', body: {} }).catch(() => {});
    showResults(r ?? {});
  } catch { /* banner activo */ }
  finally { $('bTerminar').disabled = false; }
};

/* ============================================================
   MÓDULO PESAJE — resultados
   ============================================================ */
function showResults(r) {
  const snap = APP.snapshot ?? {};
  const total = r?.total_kg ?? snap.total_kg ?? 0;
  const count = r?.total_animales ?? snap.count ?? 0;
  const avg = r?.promedio_final ?? snap.avg_kg ?? (count ? total / count : 0);
  APP.lastResult = { total, count, avg };

  $('doneSub').textContent = `${APP.session?.nombre ?? 'Pesaje'} · ${hora()}`;
  $('rCards').innerHTML = `
    <div class="rcard"><div class="rv">${Number(count) || 0}</div><div class="rk">cerdos</div></div>
    <div class="rcard"><div class="rv">${fmt(total, 0)}</div><div class="rk">kg en total</div></div>
    <div class="rcard"><div class="rv">${fmt(avg, 0)}</div><div class="rk">kg de promedio</div></div>`;

  renderVerdict($('verdict'), uniformity(APP.weights));
  $('inpConteo').value = '';
  $('countMsg').className = 'count-msg';
  renderMoves();
  setSubview('modPesaje', 'pvDone');
}

function uniformity(ws) {
  if (!Array.isArray(ws) || ws.length < 4) return null;
  const m = ws.reduce((a, b) => a + b, 0) / ws.length;
  if (!m) return null;
  return (ws.filter(w => Math.abs(w - m) <= 0.10 * m).length / ws.length) * 100;
}
function renderVerdict(el, u) {
  if (u == null) { el.hidden = true; return; }
  el.hidden = false;
  if (u >= 70) {
    el.className = 'verdict parejo';
    el.textContent = `Lote parejo: ${Math.max(1, Math.round(u / 10))} de cada 10 cerdos están cerca del promedio.`;
  } else {
    el.className = 'verdict disparejo';
    el.textContent = 'Lote disparejo: hay cerdos muy distintos entre sí — mira el detalle.';
  }
}

$('bComparar').onclick = (e) => {
  e.preventDefault();
  const mine = APP.lastResult?.count ?? 0;
  const yours = parseInt($('inpConteo').value, 10);
  const msg = $('countMsg');
  if (Number.isNaN(yours)) { msg.className = 'count-msg'; return; }
  if (yours === mine) {
    msg.className = 'count-msg show match';
    msg.textContent = `¡Coincidimos! Los dos contamos ${mine}.`;
  } else {
    msg.className = 'count-msg show diff';
    msg.textContent = `Tú contaste ${yours} y yo ${mine}. Puede que uno se haya ${yours > mine ? 'bajado sin que lo viera' : 'contado de más'} — revisa el detalle de abajo.`;
  }
};

$('bExcel').onclick = () => {
  if (APP.session?.id != null) window.open(`/api/sessions/${APP.session.id}/export.xlsx`, '_blank');
};
$('bOtroLote').onclick = () => { APP.session = null; gotoSetup(); };
$('bVerDatos').onclick = () => setModule('datos');

/* ============================================================
   MÓDULO DATOS — resumen global + filtros + tabla + por lote
   ============================================================ */
function filterQuery() {
  const fd = new FormData($('formFilters'));
  const p = new URLSearchParams();
  for (const k of ['desde', 'hasta', 'q']) {
    const v = (fd.get(k) ?? '').toString().trim();
    if (v) p.set(k, v);
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

async function refreshDatos() {
  setSubview('modDatos', 'dvList');
  await Promise.all([loadGlobalStats(), loadSessionsTable()]);
}
$('formFilters').addEventListener('submit', (e) => { e.preventDefault(); refreshDatos().catch(() => {}); });
$('bDatosRefresh').onclick = () => refreshDatos().catch(() => {});

async function loadGlobalStats() {
  const box = $('gStats'), lotes = $('porLote');
  try {
    const s = await api('/api/stats/global' + filterQuery());
    const cards = [
      ['Pesajes', s?.sesiones ?? s?.pesajes ?? 0, ''],
      ['Cerdos totales', s?.total_animales ?? 0, ''],
      ['Kg totales', fmt(Number(s?.total_kg ?? 0), 0), 'kg'],
      ['Promedio global', s?.promedio_global != null ? fmt(Number(s.promedio_global), 0) : '—', 'kg'],
    ];
    box.innerHTML = cards.map(([k, v, u]) =>
      `<div class="gstat"><div class="k">${k}</div><div class="v">${escapeHtml(v)}${u ? ` <em>${u}</em>` : ''}</div></div>`).join('');

    const pl = Array.isArray(s?.por_lote) ? s.por_lote : [];
    if (!pl.length) {
      lotes.innerHTML = '<div class="empty">Sin datos todavía — termina tu primer pesaje y aquí aparece.</div>';
    } else {
      lotes.innerHTML = pl.map(l => {
        const nombre = l?.lote ?? l?.nombre ?? '—';
        const parts = [];
        const ses = l?.sesiones ?? l?.pesajes;
        if (ses != null) parts.push(`<b>${Number(ses) || 0}</b> pesaje${ses === 1 ? '' : 's'}`);
        const an = l?.total_animales ?? l?.cerdos ?? l?.animales;
        if (an != null) parts.push(`<b>${Number(an) || 0}</b> cerdos`);
        const kg = l?.total_kg ?? l?.kg;
        if (kg != null) parts.push(`<b>${fmt(Number(kg), 0)}</b> kg`);
        const pr = l?.promedio ?? l?.promedio_final ?? l?.promedio_global;
        if (pr != null) parts.push(`<b>${fmt(Number(pr), 0)}</b> kg prom.`);
        return `<div class="lotecard"><div class="ln">${escapeHtml(nombre)}</div><div class="lm">${parts.join(' · ') || 'sin totales'}</div></div>`;
      }).join('');
    }
  } catch {
    box.innerHTML = '<div class="empty">No pude cargar el resumen — el programa no contesta.</div>';
  }
}

async function loadSessionsTable() {
  const tb = $('dataRows');
  tb.innerHTML = '<tr><td colspan="7" class="empty">Cargando pesajes…</td></tr>';
  let sessions = [];
  try {
    const data = await api('/api/sessions' + filterQuery());
    sessions = Array.isArray(data) ? data : (data?.sessions ?? []);
  } catch {
    tb.innerHTML = '<tr><td colspan="7" class="empty">No pude cargar los pesajes — el programa no contesta.</td></tr>';
    return;
  }
  if (!sessions.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">No hay pesajes con ese filtro. ¡Ve al módulo Pesaje y haz el primero!</td></tr>';
    return;
  }
  tb.innerHTML = '';
  for (const s of sessions) {
    const tr = document.createElement('tr');
    const estado = s?.estado ?? 'abierta';
    tr.innerHTML = `
      <td class="mono">${escapeHtml(fechaCorta(s?.hora_entrada ?? s?.created_at))}</td>
      <td><b>${escapeHtml(s?.lote ?? `Pesaje ${s?.id ?? ''}`)}</b></td>
      <td class="mono">${escapeHtml(s?.total_animales ?? '—')}</td>
      <td class="mono">${s?.total_kg != null ? fmt(Number(s.total_kg), 0) : '—'}</td>
      <td class="mono">${s?.promedio_final != null ? fmt(Number(s.promedio_final), 0) : '—'}</td>
      <td data-uni>—</td>
      <td><span class="pill ${escapeHtml(estado)}">${escapeHtml(estado === 'abierta' ? 'en curso' : estado)}</span></td>`;
    tr.onclick = () => { openDatosDetail(s?.id).catch(() => {}); };
    tb.appendChild(tr);
    if (estado !== 'abierta' && s?.id != null) fillUniCell(tr, s.id);
  }
}

const uniCache = new Map();
async function fillUniCell(tr, id) {
  try {
    const u = await uniformityFor(id);
    const td = tr.querySelector('[data-uni]');
    if (!td) return;
    if (u == null) { td.textContent = '—'; return; }
    td.innerHTML = u >= 70
      ? '<span class="pill parejo">parejo</span>'
      : '<span class="pill disparejo">disparejo</span>';
  } catch { /* sin chip */ }
}
async function uniformityFor(id) {
  if (uniCache.has(id)) return uniCache.get(id);
  let u = null;
  try {
    const st = await api(`/api/sessions/${id}/stats`);
    u = st?.uniformidad ?? st?.uniformity ?? null;
  } catch { u = null; }
  if (u == null) {
    let events = [];
    try {
      const d = await api(`/api/sessions/${id}/events`);
      events = Array.isArray(d) ? d : (d?.events ?? []);
    } catch { events = []; }
    u = uniformity(weightsFrom(events));
  }
  uniCache.set(id, u);
  return u;
}
function weightsFrom(events) {
  const ws = [];
  for (const ev of events) {
    const tipo = ev?.tipo;
    const n = Math.abs(ev?.animales_confirmados ?? ev?.animales_estimados ?? 0);
    const delta = Number(ev?.delta_kg ?? 0);
    if ((tipo === 'referencia' || tipo === 'subida' || tipo === 'reingreso') && delta > 0 && n >= 1) {
      for (let i = 0; i < n; i++) ws.push(delta / n);
    }
  }
  return ws;
}

/* ---------------- detalle en Datos ---------------- */
async function openDatosDetail(id) {
  if (id == null) return;
  APP.datosDetailId = id;
  let s = null, events = [];
  try { s = await api(`/api/sessions/${id}`); } catch { return; }
  try {
    const d = await api(`/api/sessions/${id}/events`);
    events = Array.isArray(d) ? d : (d?.events ?? []);
  } catch { events = []; }

  $('dNombre').textContent = s?.lote ?? `Pesaje ${id}`;
  const cuando = [fechaLarga(s?.hora_entrada), s?.hora_entrada ? `${hora(s.hora_entrada)}${s?.hora_salida ? ' – ' + hora(s.hora_salida) : ''}` : '']
    .filter(Boolean).join(' · ');
  $('dCuando').textContent = cuando || 'Sin fecha registrada';

  const total = s?.total_kg, count = s?.total_animales, avg = s?.promedio_final;
  $('dCards').innerHTML = `
    <div class="rcard"><div class="rv">${count != null ? Number(count) || 0 : '—'}</div><div class="rk">cerdos</div></div>
    <div class="rcard"><div class="rv">${total != null ? fmt(Number(total), 0) : '—'}</div><div class="rk">kg en total</div></div>
    <div class="rcard"><div class="rv">${avg != null ? fmt(Number(avg), 0) : '—'}</div><div class="rk">kg de promedio</div></div>`;

  renderVerdict($('dVerdict'), await uniformityFor(id).catch(() => null));

  const extras = [
    s?.corral ?? s?.corral_origen ? `Corral: ${s.corral ?? s.corral_origen}` : null,
    s?.destino ? `Destino: ${s.destino}` : null,
    s?.placa ?? s?.placa_vehiculo ? `Camión: ${s.placa ?? s.placa_vehiculo}` : null,
    s?.conductor ? `Conductor: ${s.conductor}` : null,
    s?.conteo_fisico != null ? `Conteo a mano: ${Number(s.conteo_fisico) || 0}` : null,
  ].filter(Boolean);
  $('dExtra').textContent = extras.join(' · ');
  $('dExtra').hidden = !extras.length;

  renderDatosMoves(events);
  setSubview('modDatos', 'dvDetail');
}

function renderDatosMoves(events) {
  const box = $('dMoves');
  box.innerHTML = '';
  const sorted = [...events].sort((a, b) => (parseTs(a?.ts_ms) ?? 0) - (parseTs(b?.ts_ms) ?? 0));
  for (const ev of sorted) {
    const tipo = ev?.tipo ?? 'subida';
    const delta = Number(ev?.delta_kg ?? 0);
    const down = tipo === 'bajada' || delta < 0;
    const pendiente = !!ev?.ambiguo && ev?.animales_confirmados == null;
    const n = Math.abs(ev?.animales_confirmados ?? ev?.animales_estimados ?? 1);
    let cls = 'up', ico = '✓', txt;
    if (tipo === 'referencia') {
      txt = `Cerdo de prueba: ${fmt(Math.abs(delta))} kg — la báscula quedó calibrada`;
    } else if (pendiente) {
      cls = 'ask'; ico = '?';
      txt = `Hubo una duda con ${fmt(Math.abs(delta))} kg que quedó sin responder`;
    } else if (down) {
      cls = 'down'; ico = '↩';
      txt = `${n > 1 ? `Se bajaron ${n}` : 'Se bajó 1'} (${fmt(delta)} kg)${ev?.motivo_bajada ? ` · motivo: ${ev.motivo_bajada}` : ''}`;
    } else if (tipo === 'reingreso') {
      txt = `Volvió a subir 1 (+${fmt(delta)} kg)`;
    } else {
      txt = `${n > 1 ? `Subieron ${n}` : 'Subió 1'} (+${fmt(delta)} kg)`;
    }
    if (ev?.confirmado_por) txt += ' · confirmado por el operador';
    const div = document.createElement('div');
    div.className = 'mv ' + cls;
    div.innerHTML = `<span class="t mono">${escapeHtml(hora(ev?.ts_ms))}</span>` +
      `<span class="ico">${escapeHtml(ico)}</span>` +
      `<span class="d">${escapeHtml(txt)}</span>`;
    box.appendChild(div);
  }
  if (!sorted.length) box.innerHTML = '<div class="empty">No quedó registro del paso a paso.</div>';
}

$('bBackDatos').onclick = () => { setSubview('modDatos', 'dvList'); APP.datosDetailId = null; };
$('bExportDatos').onclick = () => {
  if (APP.datosDetailId != null) window.open(`/api/sessions/${APP.datosDetailId}/export.xlsx`, '_blank');
};

/* ============================================================
   MÓDULO BÁSCULA (técnico)
   ============================================================ */
let configLoaded = false;
function initConfig() {
  if (!configLoaded) {
    configLoaded = true;
    loadProfilesInto($('cfgProfile')).catch(() => {});
    const cfg = loadCfg();
    if (cfg?.port) $('cfgPort').value = cfg.port;
  }
  $('testResult').className = 'test-result';
}

async function loadProfilesInto(sel) {
  try {
    const data = await api('/api/profiles');
    const profiles = Array.isArray(data) ? data : (data?.profiles ?? []);
    sel.innerHTML = '<option value="">— Elige la báscula —</option>';
    const byBrand = {};
    for (const p of profiles) (byBrand[p?.brand ?? 'Otras'] ??= []).push(p);
    for (const brand of Object.keys(byBrand).sort()) {
      const og = document.createElement('optgroup');
      og.label = brand;
      for (const p of byBrand[brand]) {
        const o = document.createElement('option');
        o.value = p?.id ?? '';
        o.textContent = p?.name ?? p?.id ?? '?';
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    const cfg = loadCfg();
    if (cfg?.profile_id) sel.value = cfg.profile_id;
  } catch {
    sel.innerHTML = '<option value="">(no pude cargar el catálogo — ¿está corriendo el programa?)</option>';
  }
}

let lastKg = null;
$('bProbar').onclick = async () => {
  const sel = $('cfgProfile');
  const res = $('testResult');
  if (!sel.value) {
    res.className = 'test-result show fail';
    res.textContent = 'Primero elige la marca y el modelo de la báscula.';
    return;
  }
  $('bProbar').disabled = true;
  res.className = 'test-result show';
  res.textContent = 'Probando…';
  const t0 = Date.now();
  try {
    const body = { profile_id: sel.value };
    const port = $('cfgPort').value.trim();
    if (port) body.port = port;
    await api('/api/scale/connect', { method: 'POST', body });
    const kg = await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (APP.lastReadingAt > t0) { clearInterval(iv); resolve(lastKg); }
        else if (Date.now() - t0 > 4000) { clearInterval(iv); resolve(null); }
      }, 200);
    });
    if (kg != null) {
      res.className = 'test-result show ok';
      res.textContent = `La báscula responde: ${fmt(kg)} kg ✓`;
    } else {
      const st = await api('/api/scale/status').catch(() => null);
      if (st?.connected) {
        res.className = 'test-result show ok';
        res.textContent = 'Conectada ✓ — aún no recibo peso; revisa que la báscula esté encendida.';
      } else {
        res.className = 'test-result show fail';
        res.textContent = 'La báscula no responde. Revisa el cable, el puerto y que esté encendida.';
      }
    }
  } catch {
    res.className = 'test-result show fail';
    res.textContent = 'No pude probar: el programa de la báscula no contesta.';
  } finally {
    $('bProbar').disabled = false;
  }
};

$('bGuardarCfg').onclick = () => {
  const sel = $('cfgProfile');
  const res = $('testResult');
  if (!sel.value) {
    res.className = 'test-result show fail';
    res.textContent = 'Elige una báscula antes de guardar.';
    return;
  }
  const name = sel.selectedOptions?.[0]?.textContent ?? sel.value;
  saveCfg({ profile_id: sel.value, port: $('cfgPort').value.trim(), name });
  APP.simActive = false;
  res.className = 'test-result show ok';
  res.textContent = `Guardado: ${name} ✓`;
};

/* ============================================================
   WEBSOCKET (reconexión suave)
   ============================================================ */
let ws = null, wsAttempts = 0, wsTimer = null;

function wsConnect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try { ws = new WebSocket(`${proto}://${location.host}/ws`); }
  catch { scheduleReconnect(); return; }
  ws.onopen = () => { wsAttempts = 0; apiOk(); };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    routeMessage(m);
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => { try { ws.close(); } catch { /* cerrado */ } };
}
function scheduleReconnect() {
  if (wsTimer) return;
  const delay = Math.min(15000, 1000 * 2 ** wsAttempts);
  wsAttempts++;
  wsTimer = setTimeout(() => { wsTimer = null; wsConnect(); }, delay);
}
function routeMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'reading') { lastKg = Number(m.kg ?? 0); onReading(m); }
  else if (m.type === 'event') onEvent(m.event ?? m.data ?? m);
  else if (m.type === 'snapshot') onSnapshot(m.snapshot ?? m.data ?? m);
}

/* ---------------- curva bajo el peso ---------------- */
const cv = $('spark'), cx = cv.getContext('2d');
function drawSpark() {
  const css = getComputedStyle(document.documentElement);
  const grid = css.getPropertyValue('--panel-edge').trim() || '#39443C';
  const line = css.getPropertyValue('--led').trim() || '#FF4A2E';
  cx.clearRect(0, 0, cv.width, cv.height);
  const maxY = Math.max(400, ...hist) * 1.15;
  cx.strokeStyle = grid; cx.lineWidth = 1;
  const ym = cv.height / 2;
  cx.beginPath(); cx.moveTo(0, ym); cx.lineTo(cv.width, ym); cx.stroke();
  cx.strokeStyle = line; cx.lineWidth = 2.5; cx.beginPath();
  hist.forEach((v, i) => {
    const x = i / (hist.length - 1 || 1) * cv.width;
    const y = cv.height - (v / maxY) * cv.height;
    i ? cx.lineTo(x, y) : cx.moveTo(x, y);
  });
  cx.stroke();
}

/* ============================================================
   ARRANQUE
   ============================================================ */
(function init() {
  // PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  wsConnect();

  // ruta inicial: #datos / #bascula / #pesaje (historial.html redirige a #datos)
  const h = (location.hash || '').replace('#', '');
  const params = new URLSearchParams(location.search);
  setModule(['datos', 'bascula', 'pesaje'].includes(h) ? h : 'pesaje');

  // compat: ?demo=1 de versiones anteriores → arranca la báscula simulada
  if (params.get('demo') === '1') {
    startSim().then(() => refreshPesajeHome()).catch(() => {});
    try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* sin history */ }
  }

  refreshPesajeHome().catch(() => {});
  drawSpark();
})();
