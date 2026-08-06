'use strict';
/* ============================================================
   PorciPeso — aplicación (módulos: Pesaje · Datos · Báscula)
   Siempre habla con el backend real (FastAPI, mismo origen).

   Backend:
     WS   /ws → {"type":"reading","kg","ts_ms","state"} | {"type":"event",…} | {"type":"snapshot",…}
            el snapshot puede traer "fase": calibracion|bajar_prueba|lote|unidades
            (si no viene, la UI degrada al comportamiento clásico)
     GET  /api/profiles · POST /api/scale/connect · GET /api/scale/status
     GET  /api/bt/devices (opcional: lista Bluetooth emparejados)
     POST /api/sim/start · POST /api/sim/action {action,n,kg_each,seconds} · POST /api/sim/stop
     POST /api/sessions {lote, modo: "lote"|"unidades", …}
     GET  /api/sessions?desde&hasta&q · GET /api/sessions/{id}
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
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
/* App móvil (APK / build www): el shim define window.__PORCIPESO_SHIM__ antes
   de cargar este archivo. SHIM.native = plugins Bluetooth/USB reales.
   En escritorio (FastAPI sirve esta carpeta sin shim.js) queda null y el
   wizard se comporta exactamente como siempre. */
const SHIM = (typeof window !== 'undefined' && window.__PORCIPESO_SHIM__) || null;

/* Flag AVANZADO (mismo mecanismo que la sección Nube): destapa opciones
   que el usuario común no necesita — la Nube y el método Cable serial.
   Activar: abrir con ?avanzado=1, o localStorage porcipeso_avanzado='1'. */
const ADVANCED_UI = (() => {
  try {
    return localStorage.getItem('porcipeso_avanzado') === '1'
      || new URLSearchParams(location.search).get('avanzado') === '1';
  } catch { return false; }
})();

/* ---------------- estado global ---------------- */
const APP = {
  session: null,       // {id, nombre}
  mode: 'lote',        // 'lote' | 'unidades'
  fase: null,          // calibracion | bajar_prueba | lote | unidades (si el backend la manda)
  faseSupported: false,
  loteAnnounced: false,
  unitCount: 0,        // modo unidades: cerdos ya pesados
  snapshot: null,
  refKg: null,
  candKg: null,        // peso del cerdo de prueba mientras espera bajarse
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
  if (mod === 'bascula') initBascula();
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

/* como api() pero conserva el {detail} del backend en el mensaje de error
   (los endpoints nuevos del wizard responden motivos en humano) */
async function apiJson(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error(data?.detail ? String(data.detail) : `HTTP ${res.status}`);
  return data;
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
    if (st?.fase) { APP.faseSupported = true; if (APP.session) applyFase(st.fase, st); }
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

/* conecta usando la configuración guardada por el asistente */
async function connectFromCfg(cfg) {
  if (!cfg?.profile_id && cfg?.method !== 'sim') throw new Error('sin báscula');
  if (cfg.method === 'sim' || cfg.profile_id === 'sim') { await startSim(); return; }
  const body = { profile_id: cfg.profile_id };
  if (SHIM && (cfg.method === 'otg' || cfg.method === 'cable') && cfg.usb) {
    // OTG: Android asigna otro deviceId en cada conexión → re-resolver por vid:pid
    const devices = await apiJson('/api/usb/devices');
    const arr = Array.isArray(devices) ? devices : (devices?.devices ?? []);
    const match = arr.find(d => d?.vid === cfg.usb.vid && d?.pid === cfg.usb.pid) ?? arr[0];
    if (!match) throw new Error('sin dispositivo USB (¿cable OTG conectado?)');
    body.transport = 'usb';
    body.device_id = match.deviceId;
    if (cfg.baudrate) body.baudrate = cfg.baudrate;
    // perfil "auto" (OTG a prueba de tontos): reconecta con el parser detectado
    if (cfg.profile_id === 'auto' && cfg.parser) body.parser = cfg.parser;
  } else if (cfg.host) {
    body.host = cfg.host;
    if (cfg.tcp_port) body.tcp_port = cfg.tcp_port;
  } else if (cfg.port) {
    body.port = cfg.port;
    if (SHIM && cfg.method === 'bluetooth') {
      body.transport = 'bluetooth';
      // perfil "auto": reconecta con el parser que detectó la primera vez
      if (cfg.profile_id === 'auto' && cfg.parser) body.parser = cfg.parser;
    }
  }
  if (SHIM && cfg.invert_bits != null) body.invert_bits = cfg.invert_bits;
  // números al revés: aplica en móvil Y escritorio (app.py también lo acepta)
  if (cfg.reverse_frame != null) body.reverse_frame = cfg.reverse_frame;
  await api('/api/scale/connect', { method: 'POST', body });
  APP.scaleConnected = true;
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
  if (!seen) { APP.howtoThen = gotoMode; openHowto(); }
  else gotoMode();
};
$('bUseSim').onclick = async () => {
  $('bUseSim').disabled = true;
  try { await startSim(); await refreshPesajeHome(); }
  catch { /* banner activo */ }
  finally { $('bUseSim').disabled = false; }
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
   ONBOARDING — primera apertura de la app
   ============================================================ */
const OB = { i: 0, n: 4, maxSeen: 0 };
function obShow(i) {
  OB.i = Math.max(0, Math.min(OB.n - 1, i));
  OB.maxSeen = Math.max(OB.maxSeen, OB.i);
  for (const s of document.querySelectorAll('.ob-slide')) {
    const k = Number(s.dataset.ob);
    s.classList.toggle('active', k === OB.i);
    s.classList.toggle('left', k < OB.i);
  }
  const dots = $('obDots').children;
  for (let k = 0; k < dots.length; k++) dots[k].classList.toggle('active', k === OB.i);
  $('obNext').textContent = OB.i === OB.n - 1 ? '¡A pesar!' : 'Siguiente';
  $('obSkip').hidden = OB.i === OB.n - 1;
}
function obFinish(goWizard = false) {
  try {
    localStorage.setItem('porcipeso_onboard', '1');
    if (OB.maxSeen >= 2) localStorage.setItem('porcipeso_howto', '1'); // ya vio los 3 pasos
  } catch { /* sin storage */ }
  try { $('dlgOnboard').close(); } catch { /* cerrado */ }
  if (goWizard) { setModule('bascula'); openWizard(); }
}
$('obNext').onclick = () => { OB.i === OB.n - 1 ? obFinish() : obShow(OB.i + 1); };
$('obSkip').onclick = () => obFinish();
$('obConnect').onclick = () => obFinish(true);
$('obLater').onclick = () => obShow(2);
$('dlgOnboard').addEventListener('close', () => {
  try { localStorage.setItem('porcipeso_onboard', '1'); } catch { /* sin storage */ }
});

/* ============================================================
   MÓDULO PESAJE — elegir modo
   ============================================================ */
function gotoMode() { setSubview('modPesaje', 'pvMode'); }
$('bModeBack').onclick = () => { setSubview('modPesaje', 'pvHome'); refreshPesajeHome().catch(() => {}); };
$('bModeLote').onclick = () => { APP.mode = 'lote'; gotoSetup(); };
$('bModeUnidades').onclick = () => { APP.mode = 'unidades'; gotoSetup(); };

/* ============================================================
   MÓDULO PESAJE — preparar
   ============================================================ */
function defaultName() {
  const d = new Date();
  const dia = d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }).replace('.', '');
  const h = d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `Lote ${dia}, ${h}`;
}
function stampNow() {
  const d = new Date();
  const f = d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '');
  const h = d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${f}, ${h}`;
}
function updateSaveWhen() { $('saveWhen').textContent = stampNow(); }
setInterval(() => { if ($('pvSetup').classList.contains('active')) updateSaveWhen(); }, 15000);

function gotoSetup() {
  $('inpNombre').value = '';               // limpio: la fecha va aparte, fija
  updateSaveWhen();
  const chip = $('chipMode');
  chip.hidden = false;
  chip.className = 'chip ok';
  chip.textContent = APP.mode === 'unidades' ? '🐷 Por unidades' : '⚖ Por lote';
  $('setupError').classList.remove('show');
  $('setupErrorActions').classList.remove('show');
  $('bComenzar').disabled = false;
  refreshSimUi();
  setSubview('modPesaje', 'pvSetup');
}
$('bSetupBack').onclick = () => gotoMode();
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
        await connectFromCfg(loadCfg());
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
      body: { lote: nombre, modo: APP.mode, ...extras, operador: '' },
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
function setGuide(html) { $('stepGuide').innerHTML = html; }
function setStep(n, ref) {
  if (n === 1) setGuide('<b>PASO 1</b> · Sube UN cerdo de prueba, solo');
  else setGuide(`<b>PASO 2</b> · Sube los demás como quieras (de a 1, 2, 3…); yo cuento${ref ? ` — cerdo de prueba: ${fmt(ref, 0)} kg` : ''}`);
}

function startWeighing(nombre) {
  APP.snapshot = null; APP.refKg = null; APP.candKg = null;
  APP.fase = null; APP.loteAnnounced = false; APP.unitCount = 0;
  APP.weights = []; APP.moves = [];
  hist.length = 0;
  questions.length = 0; activeQuestion = null;
  narrLockUntil = 0;
  $('pesajeTitle').textContent = nombre;
  $('nCerdos').textContent = '0';
  $('nTotal').innerHTML = '0 <em>kg</em>';
  $('nProm').innerHTML = '— <em>kg</em>';
  renderMoves();
  if (APP.mode === 'unidades') {
    setGuide('🐷 De a <b>UN</b> cerdo a la vez — yo llevo la cuenta');
    say('Sube un cerdo a la báscula', 'calm');
  } else {
    setStep(1);
    say('Esperando el cerdo de prueba… súbelo solo, sin compañía', 'calm');
  }
  refreshSimUi();
  setSubview('modPesaje', 'pvWeigh');
}

/* ---------------- FASES (si el backend las manda) ----------------
   lote:     calibracion → bajar_prueba → lote
   unidades: unidades
   Si "fase" nunca llega, la UI usa el flujo clásico (evento referencia). */
function applyFase(fase, src) {
  if (!fase) return;
  APP.faseSupported = true;
  if (!APP.session || fase === APP.fase) return;
  // si el backend aún no conoce el modo unidades, no dejamos que las
  // fases del flujo lote pisen la narración de unidades
  if (APP.mode === 'unidades' && fase !== 'unidades') return;
  APP.fase = fase;
  // durante bajar_prueba el backend aún no confirma ref_kg: usamos el peso
  // que está sobre la báscula (kg_now) como peso del cerdo de prueba
  const ref = src?.ref_kg ?? APP.refKg ?? src?.kg_now ?? APP.candKg;
  if (fase === 'bajar_prueba' && ref != null) APP.candKg = ref;
  if (fase === 'calibracion') {
    setStep(1);
    say('Esperando el cerdo de prueba… súbelo solo, sin compañía', 'calm');
  } else if (fase === 'bajar_prueba') {
    setGuide(`✓ Cerdo de prueba: <b>${fmt(ref, 0)} kg</b> — ahora bájalo de la báscula`);
    say(`✓ Cerdo de prueba: ${fmt(ref, 0)} kg — ahora bájalo de la báscula`, 'calm', 4000);
  } else if (fase === 'lote') {
    setStep(2, ref);
    if (!APP.loteAnnounced) {
      APP.loteAnnounced = true;
      say('¡Listo! Ya puedes subir TODO el lote 🎉', 'calm', 6000);
    }
  } else if (fase === 'unidades') {
    setGuide('🐷 De a <b>UN</b> cerdo a la vez — yo llevo la cuenta');
  }
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
  connCardLive(kg); // chip vivo de la tarjeta ⚙ Báscula (si está a la vista)
  if (m?.fase) { APP.faseSupported = true; if (APP.session) applyFase(m.fase, m); }
  $('led').innerHTML = `${fmt(kg, kg >= 100 ? 0 : 1)} <small>kg</small>`;
  $('led').classList.add('pulse');
  hist.push(kg); if (hist.length > 300) hist.shift();
  drawSpark();
  const st = m?.state;
  if (st === 'movimiento') ambient('Se están moviendo… espero a que se calmen', 'busy');
  else if (st === 'sin_senal') ambient('⚠ Perdí la señal de la báscula — revisa el cable', 'alert');
  else if (st === 'estable') {
    if (!APP.session) return;
    if (APP.fase === 'bajar_prueba') {
      ambient(`✓ Cerdo de prueba: ${fmt(APP.refKg ?? APP.candKg, 0)} kg — ahora bájalo de la báscula`, 'calm');
    } else if (APP.mode === 'unidades') {
      ambient(APP.unitCount
        ? 'Yo llevo la cuenta — bájalo y sube el siguiente cuando quieras'
        : 'Sube un cerdo a la báscula', 'calm');
    } else if (APP.refKg == null) {
      // el motor pasa a bajar_prueba sin re-emitir snapshot: si hay un peso
      // estable considerable durante la calibración, ES el cerdo de prueba
      if (APP.fase === 'calibracion' && kg >= 40) {
        APP.candKg = kg;
        setGuide(`✓ Cerdo de prueba: <b>${fmt(kg, 0)} kg</b> — ahora bájalo de la báscula`);
        ambient(`✓ Cerdo de prueba: ${fmt(kg, 0)} kg — ahora bájalo de la báscula`, 'calm');
      } else {
        ambient('Esperando el cerdo de prueba… súbelo solo, sin compañía', 'calm');
      }
    } else {
      ambient('Todo tranquilo. Puedes subir más cerdos: de a 1, 2 o 3', '');
    }
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
  if (s.ref_kg != null && APP.refKg == null) {
    APP.refKg = s.ref_kg;
    if (!s.fase && APP.mode === 'lote') setStep(2, s.ref_kg); // flujo clásico sin fases
  }
  applyFase(s.fase, s);
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
    if (APP.mode === 'unidades') {
      APP.unitCount = 1;
      say(`✓ Cerdo #1: ${fmt(delta, 0)} kg — bájalo y sube el siguiente`, 'calm', 5000);
      addMove('up', '✓', `Cerdo #1: ${fmt(delta)} kg`);
    } else if (APP.faseSupported) {
      // motor con fases: la narración la llevan las fases (bajar_prueba → lote);
      // la referencia se emite al BAJAR el cerdo de prueba — aquí solo registro
      addMove('up', '✓', `Cerdo de prueba: ${fmt(delta)} kg — quedé calibrado`);
    } else {
      setStep(2, delta);
      say(`Calibrado: el cerdo de prueba pesa ${fmt(delta, 0)} kg. Ya puedes subir los demás`, 'calm', 6000);
      addMove('up', '✓', `Cerdo de prueba: ${fmt(delta)} kg — quedé calibrado`);
    }
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
    if (APP.mode === 'unidades') {
      say('Listo — sube el siguiente 🐷', 'calm', 3000);
      addMove('down', '↩', `Se bajó de la báscula (${fmt(delta)} kg)`);
    } else {
      say(n > 1 ? `↩ Se bajaron ${n} — ya los desconté` : '↩ Uno se bajó — ya lo desconté', '', 5000);
      addMove('down', '↩', `${n > 1 ? `Se bajaron ${n}` : 'Se bajó 1'} (${fmt(delta)} kg)`, ev.id);
    }
    return;
  }
  if (APP.mode === 'unidades') {
    APP.unitCount += n;
    const each = delta / (n || 1);
    say(`✓ Cerdo #${APP.unitCount}: ${fmt(each, 0)} kg — bájalo y sube el siguiente`, 'calm', 5000);
    addMove('up', '✓', `Cerdo #${APP.unitCount}: ${fmt(each)} kg`);
    for (let i = 0; i < n; i++) APP.weights.push(each);
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
    // nube: el backend empuja el cierre ya; refresco el chip ☁️ enseguida
    try { window.PPAuth?.pokeStatus?.(); } catch { /* sin nube */ }
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
// Informe PDF con marca (escritorio: reportlab; móvil: el shim abre
// la vista imprimible y Android genera el PDF nativo con print()).
$('bPdf').onclick = () => {
  if (APP.session?.id != null) window.open(`/api/sessions/${APP.session.id}/report.pdf`, '_blank');
};
$('bOtroLote').onclick = () => { APP.session = null; APP.fase = null; gotoMode(); };
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
    $('sumPorLote').textContent = `Por lote (${pl.length})`;
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
    $('sumPorLote').textContent = 'Por lote';
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
    $('sumPesajes').textContent = 'Pesajes';
    return;
  }
  $('sumPesajes').textContent = `Pesajes (${sessions.length})`;
  if (!sessions.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">Aún no hay pesajes aquí. ¡Ve al módulo Pesaje y haz el primero!</td></tr>';
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
$('bExportPdfDatos').onclick = () => {
  if (APP.datosDetailId != null) window.open(`/api/sessions/${APP.datosDetailId}/report.pdf`, '_blank');
};
$('bExportDatos').onclick = () => {
  if (APP.datosDetailId != null) window.open(`/api/sessions/${APP.datosDetailId}/export.xlsx`, '_blank');
};

/* ============================================================
   MÓDULO BÁSCULA — INICIO: TARJETA DE ESTADO
   Con config guardada → tarjeta (nombre, método, estado vivo,
   Conectar/Desconectar/Cambiar). Sin config → botón grande que
   abre el wizard. Desconectar corta el driver pero CONSERVA la
   config: reconectar es un solo toque.
   ============================================================ */
const CC_FRESH_MS = 6000; // lectura "viva" = llegó hace menos de esto

function methodIcon(m) {
  return m === 'otg' ? '🔌' : m === 'serial' ? '🖥' : m === 'sim' ? '🎛' : '📶';
}

/* métodos visibles del paso 1 en ESTA plataforma (para el salto de pregunta) */
function visibleMethods() {
  const out = ['bluetooth'];
  if (SHIM) out.push('otg');
  else if (ADVANCED_UI) out.push('serial');
  return out;
}

function initBascula() { showBasculaHome(); }

/* msg opcional {cls,text} → se muestra en el resultado de la tarjeta */
function showBasculaHome(msg) {
  $('wizard').hidden = true;
  $('connHome').hidden = false;
  const cfg = loadCfg();
  const has = !!cfg?.profile_id;
  $('connEmpty').hidden = has;
  $('connCard').hidden = !has;
  $('basculaTitle').textContent = has ? 'Báscula' : 'Conectar la báscula';
  if (has) {
    const m = migrateMethod(cfg.method);
    $('ccName').textContent = cfg.name ?? 'Báscula';
    $('ccIcon').textContent = methodIcon(m);
    $('ccMethod').textContent = METHOD_LABEL[m] ?? '';
  }
  const res = $('ccResult');
  if (msg?.text) {
    res.className = 'test-result show' + (msg.cls ? ' ' + msg.cls : '');
    res.textContent = msg.text;
  } else {
    res.className = 'test-result';
    res.textContent = '';
  }
  updateConnCard().catch(() => {});
}

async function updateConnCard() {
  if ($('connCard').hidden) return;
  const st = await scaleStatus(); // también refresca APP.scaleConnected
  renderConnChip(st);
}

function renderConnChip(st) {
  const chip = $('ccChip');
  const connected = APP.scaleConnected;
  const ts = st?.last_ts_ms != null ? parseTs(st.last_ts_ms) : null;
  const fresh = (APP.lastReadingAt && Date.now() - APP.lastReadingAt < CC_FRESH_MS)
    || (ts != null && Date.now() - ts < CC_FRESH_MS);
  if (connected && fresh && st?.last_kg != null) {
    chip.className = 'chip ok';
    chip.textContent = `Conectada · ${fmt(st.last_kg)} kg`;
  } else if (connected) {
    chip.className = 'chip';
    chip.textContent = 'Sin señal';
  } else {
    chip.className = 'chip err';
    chip.textContent = st === null ? 'Programa apagado' : 'Sin conectar';
  }
  $('bccDisconnect').hidden = !connected;
  $('bccConnect').hidden = connected;
}

/* latido en vivo: cada lectura del WS refresca el chip sin esperar el poll */
function connCardLive(kg) {
  if ($('connCard').hidden || !$('modBascula').classList.contains('active')) return;
  if (!APP.scaleConnected) return;
  const chip = $('ccChip');
  chip.className = 'chip ok';
  chip.textContent = `Conectada · ${fmt(Number(kg))} kg`;
  $('bccDisconnect').hidden = false;
  $('bccConnect').hidden = true;
}

/* poll suave mientras la tarjeta está a la vista (estado + "Sin señal") */
setInterval(() => {
  if (!$('modBascula').classList.contains('active') || $('connCard').hidden) return;
  updateConnCard().catch(() => {});
}, 2500);

$('bConnStart').onclick = () => openWizard();
$('bccChange').onclick = () => openWizard();

$('bccDisconnect').onclick = async () => {
  const b = $('bccDisconnect');
  b.disabled = true;
  try {
    await apiJson('/api/scale/disconnect', { method: 'POST', body: {} });
    APP.scaleConnected = false;
    APP.simActive = false;
    APP.lastReadingAt = 0;
    refreshSimUi();
    showBasculaHome({ cls: '', text: 'Báscula desconectada. Tu configuración queda guardada — reconectas con un toque.' });
  } catch (e) {
    showBasculaHome({ cls: 'fail', text: e?.message ?? 'No pude desconectar la báscula.' });
  } finally {
    b.disabled = false;
  }
};

$('bccConnect').onclick = async () => {
  const b = $('bccConnect');
  b.disabled = true;
  const res = $('ccResult');
  res.className = 'test-result show';
  res.textContent = 'Conectando…';
  try {
    await connectFromCfg(loadCfg());
    showBasculaHome({ cls: 'ok', text: '✓ Conectada — esperando la primera lectura de la báscula…' });
  } catch {
    showBasculaHome({ cls: 'fail', text: 'No pude conectar. Revisa que la báscula esté encendida, o toca «Cambiar de báscula».' });
  } finally {
    b.disabled = false;
  }
};

/* ============================================================
   MÓDULO BÁSCULA — WIZARD DE CONEXIÓN (método → marca → dirección)
   ============================================================ */
const WIZ = {
  method: null,          // bluetooth | otg (app) | serial (escritorio) | sim (legacy)
  profileId: null,
  profileName: null,
  catalog: null,         // perfiles del backend (cache)
  catalogOpen: false,
  signal: 'auto',        // señal ELÉCTRICA: auto | direct | inverted (app móvil)
  reverse: false,        // 🔁 números al revés (reverse_frame) — toggle manual
  usbDevice: null,       // {deviceId, vid, pid, name} elegido (OTG)
  detected: null,        // resultado del detector {invert_bits, reverse_frame, baudrate}
  advanced: false,       // BT: "Ajustes avanzados" = elegir marca/señal a mano
};

const BAUDRATES = [1200, 2400, 4800, 9600, 19200];

const COMMON_PROFILES = [
  { id: 'matrix-adr00', name: 'Trumax / Lexus Matrix', d: 'El más usado en granjas porcinas' },
  { id: 'yaohua-xk3190-a12e', name: 'Yaohua XK3190-A12E', d: 'Indicador muy común en básculas de plataforma' },
  { id: 'gmt-tuxon-s-ascii', name: 'GMT Tuxon S', d: 'Salida continua estándar' },
];

const METHOD_LABEL = {
  bluetooth: '📶 Bluetooth',
  otg: '🔌 OTG',
  serial: '🖥 Cable serial',
  sim: '🎛 Simulada',
};

/* migración de configs guardadas con los métodos viejos (cable/red) */
function migrateMethod(method) {
  if (method === 'cable') return SHIM ? 'otg' : 'serial';
  if (method === 'red') return 'serial';
  return method;
}

function initWizard() {
  // arranca siempre en el paso 1, con lo guardado preseleccionado
  WIZ.advanced = false;
  const cfg = loadCfg();
  if (cfg?.method && !WIZ.method) {
    WIZ.method = migrateMethod(cfg.method);
    WIZ.profileId = cfg.profile_id ?? null;
    WIZ.profileName = cfg.name ?? null;
    if (cfg.signal) WIZ.signal = cfg.signal;
    WIZ.reverse = !!cfg.reverse_frame;
  }
  // métodos que no existen (o están tapados) en esta plataforma no se precargan
  if (SHIM && WIZ.method === 'serial') WIZ.method = null;
  if (!SHIM && WIZ.method === 'otg') WIZ.method = null;
  if (!SHIM && !ADVANCED_UI && WIZ.method === 'serial') WIZ.method = null;
  $('testResult').className = 'test-result';
  showHexPanel(false);
  wizGo(1);
}

/* abre el wizard (tapa la tarjeta). Si en esta plataforma queda UNA sola
   opción de conexión (ej. escritorio sin avanzado = solo Bluetooth), la
   pregunta "¿cómo la vas a conectar?" se salta y entra directo. */
function openWizard() {
  $('connHome').hidden = true;
  $('wizard').hidden = false;
  $('basculaTitle').textContent = 'Conectar la báscula';
  initWizard();
  $('bWizHome').hidden = !loadCfg()?.profile_id; // ◂ Volver a la tarjeta
  const methods = visibleMethods();
  if (methods.length === 1) chooseMethod(methods[0]);
}
$('bWizHome').onclick = () => showBasculaHome();

function wizGo(step) {
  for (const [i, id] of [[1, 'wizPane1'], [2, 'wizPane2'], [3, 'wizPane3']]) {
    $(id).classList.toggle('active', i === step);
  }
  for (const i of [1, 2, 3]) {
    const dot = $('wsDot' + i);
    dot.classList.toggle('active', i === step);
    dot.classList.toggle('done', i < step);
  }
  // BT/OTG automático (APK): una sola pantalla, sin pasos ni Probar/Guardar —
  // tocar el dispositivo hace todo (detectar, conectar, guardar).
  const autoFlow = SHIM && !WIZ.advanced
    && (WIZ.method === 'bluetooth' || WIZ.method === 'otg');
  const steps = document.querySelector('#wizard .wizsteps');
  if (steps) steps.hidden = autoFlow && step === 3;
  const actions = $('bProbar')?.closest('.config-actions');
  if (actions) actions.hidden = autoFlow && step === 3;
  $('testResult').className = 'test-result';
  showHexPanel(false);
  if (step === 2) renderCommons();
  if (step === 3) renderAddr();
  window.scrollTo({ top: 0 });
}

function showHexPanel(show) {
  const el = $('hexPanel');
  if (!el) return;
  el.hidden = !show;
  if (show) el.textContent = 'Esperando bytes…';
}

/* Tarjetas por plataforma (paso 1 = UNA sola pregunta):
   - 📶 Bluetooth: siempre (en el APK es el camino principal, automático).
   - 🔌 OTG: solo en la app Android (cable USB al celular).
   - 🖥 Cable serial: solo en escritorio Y con el flag avanzado
     (?avanzado=1 / localStorage porcipeso_avanzado — igual que la Nube).
   La báscula simulada vive en el módulo Pesaje ("Usar báscula simulada"). */
{
  const otgCard = document.querySelector('#wizPane1 [data-method="otg"]');
  const serialCard = document.querySelector('#wizPane1 [data-method="serial"]');
  if (otgCard) otgCard.hidden = !SHIM;
  if (serialCard) serialCard.hidden = !!SHIM || !ADVANCED_UI;
}

function chooseMethod(m) {
  WIZ.method = m;
  if (WIZ.profileId === 'sim') { WIZ.profileId = null; WIZ.profileName = null; }
  // Bluetooth y OTG en el APK: SIN marcas ni catálogo — directo a buscar y
  // auto-detectar (paso 3). Las marcas/velocidades quedan solo en Cable
  // serial y en "Ajustes avanzados" de Bluetooth/OTG.
  if (SHIM && !WIZ.advanced && (m === 'bluetooth' || m === 'otg')) {
    wizGo(3);
  } else {
    wizGo(2);
  }
}

for (const b of document.querySelectorAll('#wizPane1 [data-method]')) {
  b.addEventListener('click', () => chooseMethod(b.dataset.method));
}
$('bWizBack2').onclick = () => {
  WIZ.advanced = false;
  // con UNA sola opción de conexión el paso 1 se saltó: atrás = inicio
  if (visibleMethods().length === 1) { showBasculaHome(); return; }
  wizGo(1);
};
$('bWizBack3').onclick = () => {
  if (WIZ.method === 'sim') { wizGo(1); return; }
  if (SHIM && !WIZ.advanced && (WIZ.method === 'bluetooth' || WIZ.method === 'otg')) {
    wizGo(1);
    return;
  }
  wizGo(2);
};

/* ---- paso 2: marca y modelo ---- */
function renderCommons() {
  const box = $('wizCommons');
  box.innerHTML = '';
  for (const p of COMMON_PROFILES) {
    const b = document.createElement('button');
    b.className = 'commoncard' + (WIZ.profileId === p.id ? ' sel' : '');
    b.innerHTML = `<span class="c-t">${escapeHtml(p.name)}</span><span class="c-d">${escapeHtml(p.d)}</span>`;
    b.onclick = () => { selectProfile(p.id, p.name); };
    box.appendChild(b);
  }
}

function selectProfile(id, name) {
  WIZ.profileId = id;
  WIZ.profileName = name;
  wizGo(3);
}

$('bWizAll').onclick = async () => {
  WIZ.catalogOpen = !WIZ.catalogOpen;
  $('wizCatalog').hidden = !WIZ.catalogOpen;
  $('bWizAll').textContent = WIZ.catalogOpen ? 'Ocultar el catálogo ▴' : 'Ver todas las marcas ▾';
  if (WIZ.catalogOpen && !WIZ.catalog) await loadCatalog();
};

async function loadCatalog() {
  const box = $('wizCatalog');
  box.innerHTML = '<div class="empty">Cargando catálogo…</div>';
  try {
    const data = await api('/api/profiles');
    WIZ.catalog = Array.isArray(data) ? data : (data?.profiles ?? []);
  } catch {
    box.innerHTML = '<div class="empty">No pude cargar el catálogo — ¿está corriendo el programa?</div>';
    return;
  }
  const byBrand = {};
  for (const p of WIZ.catalog) (byBrand[p?.brand ?? 'Otras'] ??= []).push(p);
  box.innerHTML = '';
  for (const brand of Object.keys(byBrand).sort()) {
    const g = document.createElement('div');
    g.className = 'cat-group';
    g.innerHTML = `<div class="cat-brand">${escapeHtml(brand)}</div>`;
    for (const p of byBrand[brand]) {
      const b = document.createElement('button');
      b.className = 'cat-item' + (WIZ.profileId === p?.id ? ' sel' : '');
      b.textContent = p?.name ?? p?.id ?? '?';
      b.onclick = () => selectProfile(p?.id ?? '', p?.name ?? p?.id ?? '?');
      g.appendChild(b);
    }
    box.appendChild(g);
  }
}

/* ---- paso 3: dirección según el método ---- */
function renderAddr() {
  const box = $('wizAddr');
  const cfg = loadCfg();
  const same = cfg?.method === WIZ.method && cfg?.profile_id === WIZ.profileId;
  $('wizSel').textContent = WIZ.method === 'sim'
    ? '🎛 Báscula simulada — para practicar'
    : `${METHOD_LABEL[WIZ.method] ?? ''} · ${WIZ.profileName ?? 'báscula'}`;

  if (WIZ.method === 'sim') {
    $('wizQ3').textContent = 'Nada más que configurar';
    box.innerHTML = '<p class="wizhelp">La báscula simulada corre dentro del programa: sirve para practicar y probar todo el sistema. Los pesajes quedan guardados de verdad.</p>';
    return;
  }
  if (WIZ.method === 'otg' || WIZ.method === 'cable') {
    // ============ CAMINO PRINCIPAL OTG (a prueba de tontos) ============
    // Igual que Bluetooth: sin marcas, sin baudios, sin señal — buscar →
    // tocar el dispositivo USB → detección automática completa (todas las
    // velocidades × 4 combinaciones × todos los parsers, perfil "auto").
    if (SHIM && !WIZ.advanced) {
      renderOtgAuto();
      return;
    }
    if (SHIM) {
      // App móvil, "Ajustes avanzados": marca elegida a mano + baudios + señal
      $('wizQ3').textContent = '¿Qué hay conectado al teléfono?';
      const savedBaud = same && cfg?.baudrate ? Number(cfg.baudrate) : 9600;
      box.innerHTML = `
        <button class="btn-primary scanbtn" id="bUsbScan" type="button">🔍 Buscar dispositivos USB</button>
        <div class="btlist" id="usbList"></div>
        <label class="addrlbl">Velocidad (baudios)
          <select id="wizBaud">${BAUDRATES.map(b =>
            `<option value="${b}"${b === savedBaud ? ' selected' : ''}>${b}</option>`).join('')}
          </select>
        </label>
        ${reverseToggleHtml()}
        ${signalSelectorHtml()}
        <p class="wizhelp">🔌 Conecta el indicador al teléfono con un <b>cable OTG</b> y un adaptador
          USB-serial (FTDI, CH340, CP210x, PL2303 o CDC). Si Android pregunta si permites el
          acceso al dispositivo USB, acepta.</p>
        <details class="wizhelp-more">
          <summary>¿No aparece nada?</summary>
          <p>Prueba otro cable OTG (algunos son solo de carga), revisa que el adaptador esté bien
          puesto y toca «Buscar dispositivos USB» de nuevo. Con «🪄 Detectar automáticamente» yo
          pruebo todas las velocidades (1200–19200), las dos polaridades de señal y el orden de
          los números.</p>
        </details>`;
      $('bUsbScan').onclick = () => { scanUsbDevices().catch(() => {}); };
      bindSignalSel();
      bindReverseToggle();
      scanUsbDevices().catch(() => {});
      return;
    }
    // (config vieja 'cable' en escritorio → cae al método serial)
    WIZ.method = 'serial';
  }
  if (WIZ.method === 'serial') {
    // Escritorio: puerto COM/tty, o conversor de red (el viejo método
    // "Red" vive aquí — si llenas la dirección IP, se usa la red).
    $('wizQ3').textContent = '¿Dónde está conectada?';
    const hostVal = same && cfg?.host ? `${cfg.host}${cfg.tcp_port ? ':' + cfg.tcp_port : ''}` : '';
    box.innerHTML = `
      <label class="addrlbl">Puerto del cable
        <input id="wizPort" placeholder="Ej: COM3 o /dev/ttyUSB0" autocomplete="off" value="${escapeHtml(same ? cfg?.port ?? '' : '')}">
      </label>
      <details class="wizhelp-more">
        <summary>¿Cómo encuentro el puerto?</summary>
        <p>En <b>Windows</b>: clic derecho en Inicio → Administrador de dispositivos → "Puertos (COM y LPT)". Ahí aparece algo como <b>COM3</b>.<br>
        En <b>Linux</b>: suele ser <b>/dev/ttyUSB0</b>.<br>
        Si desconectas y conectas el cable, el que aparece y desaparece es el tuyo.</p>
      </details>
      <details class="wizhelp-more" ${hostVal ? 'open' : ''}>
        <summary>¿Usas un conversor de red (ethernet/wifi)?</summary>
        <label class="addrlbl">Dirección IP y puerto
          <input id="wizHost" inputmode="decimal" placeholder="Ej: 192.168.0.50:8899" autocomplete="off" value="${escapeHtml(hostVal)}">
        </label>
        <p class="wizhelp">Si llenas la dirección IP, me conecto por red y el puerto del cable se ignora. Casi siempre es algo como 192.168.x.x:8899.</p>
      </details>
      ${reverseToggleHtml()}`;
    bindReverseToggle();
    return;
  }
  // bluetooth
  if (SHIM && !WIZ.advanced) {
    // ============ CAMINO PRINCIPAL (a prueba de tontos) ============
    // Sin marcas, sin catálogo, sin señal: buscar → tocar → la app
    // detecta sola el parser y la polaridad (perfil "auto") y conecta.
    $('wizQ3').textContent = 'Elige tu báscula';
    $('wizSel').textContent = '📶 Bluetooth — sin configurar nada: yo detecto la marca y la señal';
    box.innerHTML = `
      <div class="bt-auto-status" id="btAutoStatus">🔍 Buscando básculas Bluetooth…</div>
      <div class="btlist" id="btList"></div>
      <div class="config-actions">
        <button id="bBtScan" type="button">🔍 Buscar de nuevo</button>
      </div>
      <p class="wizhelp">¿No aparece? Empareja primero el módulo en <b>Ajustes → Bluetooth</b>
        (PIN <b>1234</b>) y vuelve a buscar.</p>
      <button class="btn-link discreet" id="bBtAdvanced" type="button">Ajustes avanzados — elegir marca y señal a mano</button>`;
    $('bBtScan').onclick = () => { btAutoScan().catch(() => {}); };
    $('bBtAdvanced').onclick = () => { WIZ.advanced = true; wizGo(2); };
    btAutoScan().catch(() => {});
    return;
  }
  $('wizQ3').textContent = '¿Dónde está el adaptador Bluetooth?';
  if (SHIM) {
    // App móvil, "Ajustes avanzados": marca elegida a mano + señal forzable
    box.innerHTML = `
      <button class="btn-primary scanbtn" id="bBtScan" type="button">🔍 Buscar básculas Bluetooth</button>
      <div class="btlist" id="btList"></div>
      <label class="addrlbl">Dirección del adaptador
        <input id="wizPort" placeholder="Ej: 00:14:03:xx:xx:xx" autocomplete="off" value="${escapeHtml(same ? cfg?.port ?? '' : '')}">
      </label>
      <p class="wizhelp">¿No aparece? Empareja primero el módulo en <b>Ajustes → Bluetooth</b>
        (PIN <b>1234</b>) y vuelve a buscar.</p>
      ${reverseToggleHtml()}
      ${signalSelectorHtml()}
      <details class="wizhelp-more">
        <summary>Símbolos raros, o no llega el peso</summary>
        <p>Puede ser <b>señal invertida</b> (módulo HC-05/BC04 soldado a una línea TTL al revés):
        usa «🪄 Detectar automáticamente» y yo la corrijo solo.<br><br>
        También puede ser la <b>velocidad</b>: en Bluetooth los baudios los fija el módulo
        (HC-05/BLU2), <b>no se pueden cambiar desde el celular</b> — si el módulo quedó a otra
        velocidad que el indicador (ej. 38400 vs 9600), hay que reconfigurar el módulo con
        comandos AT.</p>
      </details>`;
    $('bBtScan').onclick = () => { scanBtDevices().catch(() => {}); };
    bindSignalSel();
    bindReverseToggle();
    return;
  }
  if (IS_MOBILE) {
    box.innerHTML = `
      <div class="btlist" id="btList"><div class="empty">Buscando dispositivos emparejados…</div></div>
      <label class="addrlbl">Dirección del adaptador
        <input id="wizPort" placeholder="Ej: 00:1D:43:xx:xx:xx" autocomplete="off" value="${escapeHtml(same ? cfg?.port ?? '' : '')}">
      </label>
      <p class="wizhelp">📱 Primero <b>empareja el BLU2</b> en los ajustes Bluetooth del teléfono (PIN <b>1234</b>). Después vuelve aquí y elígelo de la lista.</p>
      <details class="wizhelp-more">
        <summary>Si aparecen símbolos extraños o no llega el peso</summary>
        <p>El BLU2 y el indicador deben tener exactamente los mismos <b>baudios, bits, paridad y bits de parada</b> (por ejemplo, 9600 8N1). Cambiar “Charset” en una app terminal no repara una configuración serial incorrecta.</p>
      </details>`;
    fillBtDevices();
  } else {
    box.innerHTML = `
      <p class="wizhelp">💻 En un computador, el BLU2 emparejado aparece como un <b>puerto COM</b> más (Bluetooth → puerto serial). Empareja primero el BLU2 en los ajustes Bluetooth (PIN <b>1234</b>) y luego escribe el puerto que le asignó Windows.</p>
      <label class="addrlbl">Puerto
        <input id="wizPort" placeholder="Ej: COM5" autocomplete="off" value="${escapeHtml(same ? cfg?.port ?? '' : '')}">
      </label>`;
  }
}

async function fillBtDevices() {
  const list = $('btList');
  if (!list) return;
  let devices = null;
  try {
    const d = await api('/api/bt/devices');
    const arr = Array.isArray(d) ? d : (d?.devices ?? null);
    devices = Array.isArray(arr) ? arr : null;
  } catch { devices = null; }
  if (!list.isConnected) return;                 // cambió de paso mientras cargaba
  if (!devices || !devices.length) { list.innerHTML = ''; return; }  // sin soporte → queda el campo manual
  list.innerHTML = '<div class="bt-title">Dispositivos emparejados:</div>';
  for (const dev of devices) {
    const name = dev?.name ?? dev?.nombre ?? 'Dispositivo';
    const addr = dev?.address ?? dev?.addr ?? dev?.mac ?? dev?.port ?? '';
    const b = document.createElement('button');
    b.className = 'bt-item';
    b.innerHTML = `<span class="bt-n">${escapeHtml(name)}</span><span class="bt-a mono">${escapeHtml(addr)}</span>`;
    b.onclick = () => {
      const inp = $('wizPort');
      if (inp) inp.value = addr;
      for (const x of list.querySelectorAll('.bt-item')) x.classList.toggle('sel', x === b);
    };
    list.appendChild(b);
  }
}

/* ---- 🔁 números al revés (reverse_frame): la báscula manda "001" cuando
   marca 100, o "0.4321" cuando pesa 1234.0. Separado de la señal
   ELÉCTRICA (invert_bits), que queda como opción avanzada. ---- */
function reverseToggleHtml() {
  return `
    <label class="revtoggle">
      <input type="checkbox" id="revToggle"${WIZ.reverse ? ' checked' : ''}>
      <span>🔁 ¿Los números se ven al revés? <small>(ves 001 cuando la báscula marca 100)</small></span>
    </label>
    <div class="test-result" id="revLive"></div>`;
}

function bindReverseToggle() {
  const t = $('revToggle');
  if (!t) return;
  t.onchange = async () => {
    WIZ.reverse = t.checked;
    WIZ.detected = null; // corrección manual: olvida la detección previa
    const live = $('revLive');
    const a = wizAddress();
    if (!a.ok || a.body == null) return;
    // EN VIVO: reconecta con la corrección y muestra el valor corregido
    // para que el usuario confirme viéndolo (si aún no hay conexión, el
    // cambio aplica al Probar/Guardar).
    if (!APP.scaleConnected) return;
    if (live) { live.className = 'test-result show'; live.textContent = 'Aplicando…'; }
    const t0 = Date.now();
    try {
      await api('/api/scale/connect', { method: 'POST', body: a.body });
      const kg = await new Promise((resolve) => {
        const iv = setInterval(() => {
          if (APP.lastReadingAt > t0) { clearInterval(iv); resolve(lastKg); }
          else if (Date.now() - t0 > 4000) { clearInterval(iv); resolve(null); }
        }, 200);
      });
      if (!live || !live.isConnected) return;
      if (kg != null) {
        live.className = 'test-result show ok';
        live.textContent = `Ahora leo: ${fmt(kg)} kg — ¿se ve bien?`;
      } else {
        live.className = 'test-result show';
        live.textContent = 'Cambio aplicado — esperando una lectura de la báscula…';
      }
    } catch {
      if (live && live.isConnected) {
        live.className = 'test-result show fail';
        live.textContent = 'No pude aplicar el cambio — prueba la conexión de nuevo.';
      }
    }
  };
}

/* ---- señal ELÉCTRICA directa / invertida / detectar (app móvil,
   opción avanzada — distinta del 🔁 de números al revés) ---- */
function signalSelectorHtml() {
  const opts = [
    ['auto', '🪄 Detectar automáticamente'],
    ['direct', '⚡ Directa (normal)'],
    ['inverted', '🔄 Invertida'],
  ];
  return `
    <details class="wizhelp-more">
      <summary>⚡ Señal eléctrica (avanzado)</summary>
      <div class="addrlbl">Señal eléctrica
        <div class="sigsel" id="sigSel">
          ${opts.map(([v, t]) =>
            `<button type="button" data-sig="${v}"${WIZ.signal === v ? ' class="sel"' : ''}>${t}</button>`).join('')}
        </div>
      </div>
      <p class="wizhelp">Si el módulo va soldado a la tarjeta del indicador y llegan símbolos raros,
        la señal ELÉCTRICA puede venir <b>invertida</b> (bits al revés — distinto del orden de los
        números). «Detectar» lo resuelve solo al probar la conexión.</p>
    </details>`;
}

function bindSignalSel() {
  const sel = $('sigSel');
  if (!sel) return;
  for (const b of sel.querySelectorAll('[data-sig]')) {
    b.onclick = () => {
      WIZ.signal = b.dataset.sig;
      WIZ.detected = null;                 // cambió la elección: olvidar detección previa
      for (const x of sel.querySelectorAll('[data-sig]')) x.classList.toggle('sel', x === b);
    };
  }
}

/* invert_bits efectivo según el selector (null = no mandar nada) */
function signalInvert() {
  if (WIZ.signal === 'inverted') return true;
  if (WIZ.signal === 'direct') return false;
  if (WIZ.detected) return !!WIZ.detected.invert_bits;   // 🪄 ya detectado
  const cfg = loadCfg();
  return cfg?.invert_bits != null ? !!cfg.invert_bits : null;
}

/* ---- buscador Bluetooth (modo AVANZADO): mismo escaneo en vivo, pero
   tocar un dispositivo solo llena la dirección (la marca la elige el user) */
async function scanBtDevices() {
  await liveBtScan((dev) => {
    const inp = $('wizPort');
    if (inp) inp.value = dev.address;
    if (!dev.paired) {
      wizResult('', 'Ese módulo aún no está emparejado: empareja primero en Ajustes → Bluetooth (PIN 1234).');
    }
  });
}

/* ---- búsqueda Bluetooth EN VIVO (emparejados al instante + cercanos
   llegando durante el ciclo de discovery nativo, ~12 s) ----
   La usan el flujo automático (tocar = conectar) y el avanzado
   (tocar = llenar la dirección). "Buscar de nuevo" reinicia el ciclo. */
let btScanSeq = 0;
const waitMs = (ms) => new Promise(r => setTimeout(r, ms));

function renderBtDeviceRows(list, devices, onPick) {
  list.innerHTML = devices.length ? '<div class="bt-title">Toca el tuyo para elegirlo:</div>' : '';
  for (const dev of devices) {
    const b = document.createElement('button');
    b.className = 'bt-item';
    b.innerHTML = `<span class="bt-n">${escapeHtml(dev?.name || `Dispositivo BT (${dev?.address ?? ''})`)}</span>` +
      `<span class="bt-a mono">${escapeHtml(dev?.address ?? '')}</span>` +
      `<span class="bt-badge ${dev?.paired ? 'paired' : ''}">${dev?.paired ? 'emparejado' : 'cercano'}</span>`;
    b.onclick = () => {
      for (const x of list.querySelectorAll('.bt-item')) x.classList.toggle('sel', x === b);
      onPick({ name: dev?.name || '', address: dev?.address ?? '', paired: !!dev?.paired });
    };
    list.appendChild(b);
  }
}

/* aviso accionable MIUI/Android: Ubicación del sistema apagada */
function btLocationWarning(list) {
  const warn = document.createElement('div');
  warn.className = 'empty';
  warn.innerHTML = '📍 Para buscar dispositivos cercanos, Android exige la <b>Ubicación encendida</b> — actívala un momento y vuelve a buscar. ';
  const b = document.createElement('button');
  b.className = 'btn-primary';
  b.textContent = 'Activar ubicación';
  b.onclick = () => { apiJson('/api/bt/location/open', { method: 'POST', body: {} }).catch(() => {}); };
  warn.appendChild(document.createElement('br'));
  warn.appendChild(b);
  list.appendChild(warn);
}

async function liveBtScan(onPick) {
  const list = $('btList'), status = $('btAutoStatus'), btn = $('bBtScan');
  if (!list) return;
  const seq = ++btScanSeq;
  const dead = () => seq !== btScanSeq || !list.isConnected;
  if (btn) btn.disabled = true;
  if (status && status.isConnected) status.textContent = '🔍 Buscando básculas Bluetooth… (deja el módulo encendido)';
  list.innerHTML = '<div class="empty">Buscando…</div>';

  // 1) EMPAREJADOS al instante
  let shown = [];
  try {
    const paired = await apiJson('/api/bt/devices');
    if (dead()) return;
    shown = Array.isArray(paired) ? paired : [];
    renderBtDeviceRows(list, shown, onPick);
  } catch (e) {
    if (!dead()) {
      list.innerHTML = `<div class="empty">${escapeHtml(e?.message ?? 'No pude buscar dispositivos Bluetooth.')}</div>`;
      if (status && status.isConnected) status.textContent = '';
    }
    if (btn) btn.disabled = false;
    return;
  }
  if (status && status.isConnected) status.textContent = shown.length ? 'Toca tu báscula para conectarla:' : '';

  // 2) CERCANOS en vivo: discovery nativo (~12 s) con spinner
  const spin = document.createElement('div');
  spin.className = 'empty bt-spin';
  spin.textContent = '⌛ Buscando cercanos…';
  list.appendChild(spin);
  try {
    await apiJson('/api/bt/discovery/start', { method: 'POST', body: {} });
  } catch (e) {
    if (dead()) return;
    spin.remove();
    if (/Ubicación encendida/i.test(e?.message ?? '')) {
      btLocationWarning(list); // emparejados se quedan; aviso accionable
    } else if (!shown.length) {
      list.innerHTML = `<div class="empty">${escapeHtml(e?.message ?? 'No pude buscar cercanos.')}</div>`;
    }
    finishBtScan(list, shown, btn);
    return;
  }

  let merged = shown;
  for (let i = 0; i < 30; i++) { // ~21 s de tope por si FINISHED no llega
    await waitMs(700);
    if (dead()) return;
    let d = null;
    try { d = await apiJson('/api/bt/discovery'); } catch { break; }
    if (dead()) return;
    const devices = Array.isArray(d?.devices) ? d.devices : merged;
    if (devices.length !== merged.length) {
      merged = devices;
      renderBtDeviceRows(list, merged, onPick); // agrega cercanos EN VIVO
      list.appendChild(spin);
    }
    if (d?.finished) break;
  }
  if (dead()) return;
  spin.remove();
  finishBtScan(list, merged, btn);
}

function finishBtScan(list, devices, btn) {
  if (btn) btn.disabled = false;
  const cercanos = devices.filter(d => !d.paired).length;
  if (!devices.length) {
    list.innerHTML = '<div class="empty">No encontré dispositivos. Plan B: empareja el módulo en Ajustes → Bluetooth (PIN 1234) y toca «Buscar de nuevo».</div>';
  } else if (!cercanos) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = 'No aparecieron cercanos nuevos. Si el tuyo no está: empareja primero el módulo en Ajustes → Bluetooth (PIN 1234) y vuelve a buscar.';
    list.appendChild(note);
  }
}

/* ---- Bluetooth AUTOMÁTICO (camino principal en la app) ----
   buscar → tocar el dispositivo → detectar parser+polaridad (perfil
   "auto") → conectar → guardar. El usuario jamás elige marca. */
async function btAutoScan() {
  await liveBtScan((dev) => { btAutoConnect(dev).catch(() => {}); });
}

async function btAutoConnect(dev) {
  const status = $('btAutoStatus');
  if (!dev.address) return;
  btScanSeq++; // congela el escaneo en vivo (el connect nativo cancela el discovery)
  showHexPanel(true);
  if (status) status.innerHTML = `🎧 Escuchando <b>${escapeHtml(dev.name || dev.address)}</b>… ` +
    'detecto la marca y la señal (unos segundos)';
  $('testResult').className = 'test-result';
  let r = null;
  try {
    r = await apiJson('/api/scale/detect', {
      method: 'POST',
      body: { profile_id: 'auto', transport: 'bluetooth', port: dev.address },
    });
  } catch (e) {
    showHexPanel(false);
    if (status) status.textContent = '';
    wizResult('fail', e?.message ?? 'No pude escuchar la báscula.');
    btAutoRetry(dev);
    return;
  }
  showHexPanel(false);
  if (r?.ok && r?.parser_ok && r?.parser) {
    try {
      await api('/api/scale/connect', {
        method: 'POST',
        body: {
          profile_id: 'auto', parser: r.parser, transport: 'bluetooth',
          port: dev.address, invert_bits: !!r.invert_bits,
          reverse_frame: !!r.reverse_frame,
        },
      });
    } catch {
      if (status) status.textContent = '';
      wizResult('fail', 'La detecté pero no pude dejarla conectada — intenta de nuevo.');
      btAutoRetry(dev);
      return;
    }
    APP.scaleConnected = true;
    APP.simActive = false;
    // el parser y la polaridad detectados quedan guardados: la próxima
    // vez la app conecta directo, sin volver a detectar
    saveCfg({
      method: 'bluetooth', profile_id: 'auto', parser: r.parser,
      invert_bits: !!r.invert_bits, reverse_frame: !!r.reverse_frame,
      port: dev.address, signal: 'auto',
      name: `Báscula Bluetooth (${dev.name || dev.address})`,
    });
    if (status) status.textContent = '';
    const fixes = [];
    if (r.invert_bits) fixes.push('señal invertida corregida sola');
    if (r.reverse_frame) fixes.push('números al revés corregidos solos');
    const kgTxt = r.kg != null ? `la báscula responde: ${fmt(r.kg)} kg` : 'la báscula responde';
    // aterriza en la tarjeta de estado: chip verde + Desconectar a la vista
    showBasculaHome({ cls: 'ok', text: `✓ Conectada — ${kgTxt}${fixes.length ? ` (${fixes.join(' y ')})` : ''}. ¡Ya puedes ir a Pesaje!` });
  } else {
    if (status) status.textContent = '';
    const msg = (r?.ok && !r?.parser_ok)
      ? 'Recibo datos pero no los entiendo — puede ser la velocidad del módulo (se cambia con comandos AT) o un modelo que aún no conozco.'
      : (r?.message ?? 'No reconocí la báscula.');
    wizResult('fail', msg);
    btAutoRetry(dev);
  }
}

/* tras un fallo: botón Reintentar (mismo dispositivo); "Ajustes avanzados"
   ya está en pantalla para forzar marca/señal a mano */
function btAutoRetry(dev) {
  const status = $('btAutoStatus');
  if (!status || !status.isConnected) return;
  status.innerHTML = '';
  const b = document.createElement('button');
  b.className = 'btn-primary';
  b.textContent = `↻ Reintentar con ${dev.name || dev.address}`;
  b.onclick = () => { btAutoConnect(dev).catch(() => {}); };
  status.appendChild(b);
}

/* ---- OTG AUTOMÁTICO (camino principal en la app, igual que BT) ----
   buscar dispositivos USB → tocar → detección completa (el detector barre
   todas las velocidades y, sobre CADA captura, analiza todos los parsers ×
   las 4 combinaciones — analyzeCombos) → conectar → guardar. El usuario
   jamás elige marca ni baudios. */
function renderOtgAuto() {
  $('wizQ3').textContent = 'Elige tu báscula';
  $('wizSel').textContent = '🔌 OTG — sin configurar nada: yo detecto la marca, la velocidad y la señal';
  const box = $('wizAddr');
  box.innerHTML = `
    <div class="bt-auto-status" id="otgAutoStatus">🔍 Buscando dispositivos USB…</div>
    <div class="btlist" id="usbList"></div>
    <div class="config-actions">
      <button id="bUsbScan" type="button">🔍 Buscar de nuevo</button>
    </div>
    <p class="wizhelp">🔌 Conecta el indicador al teléfono con un <b>cable OTG</b> y un
      adaptador USB-serial (FTDI, CH340, CP210x, PL2303 o CDC). Si Android pregunta
      si permites el acceso al dispositivo USB, acepta.</p>
    <details class="wizhelp-more">
      <summary>¿No aparece nada?</summary>
      <p>Prueba otro cable OTG (algunos son solo de carga), revisa que el adaptador
      esté bien puesto y toca «Buscar de nuevo».</p>
    </details>
    <button class="btn-link discreet" id="bOtgAdvanced" type="button">Ajustes avanzados — elegir marca y velocidad a mano</button>`;
  $('bUsbScan').onclick = () => { otgAutoScan().catch(() => {}); };
  $('bOtgAdvanced').onclick = () => { WIZ.advanced = true; wizGo(2); };
  otgAutoScan().catch(() => {});
}

async function otgAutoScan() {
  const list = $('usbList'), status = $('otgAutoStatus'), btn = $('bUsbScan');
  if (!list) return;
  if (btn) btn.disabled = true;
  list.innerHTML = '<div class="empty">Buscando…</div>';
  try {
    const devices = await apiJson('/api/usb/devices');
    if (!list.isConnected) return;
    const arr = Array.isArray(devices) ? devices : (devices?.devices ?? []);
    if (!arr.length) {
      if (status && status.isConnected) status.textContent = '';
      list.innerHTML = '<div class="empty">No veo nada conectado por OTG. Conecta el cable y vuelve a buscar.</div>';
      return;
    }
    if (status && status.isConnected) status.textContent = 'Toca tu báscula para conectarla:';
    list.innerHTML = '';
    for (const dev of arr) {
      const vidpid = `${Number(dev?.vid).toString(16).padStart(4, '0')}:${Number(dev?.pid).toString(16).padStart(4, '0')}`;
      const b = document.createElement('button');
      b.className = 'bt-item';
      b.innerHTML = `<span class="bt-n">${escapeHtml(dev?.name || 'Adaptador USB-serial')}</span>` +
        `<span class="bt-a mono">${escapeHtml(vidpid)} · ${escapeHtml(dev?.driver ?? '')}</span>`;
      b.onclick = () => {
        for (const x of list.querySelectorAll('.bt-item')) x.classList.toggle('sel', x === b);
        otgAutoConnect(dev).catch(() => {});
      };
      list.appendChild(b);
    }
  } catch (e) {
    if (status && status.isConnected) status.textContent = '';
    if (list.isConnected) list.innerHTML = `<div class="empty">${escapeHtml(e?.message ?? 'No pude buscar dispositivos USB.')}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function otgAutoConnect(dev) {
  const status = $('otgAutoStatus');
  if (dev?.deviceId == null) return;
  showHexPanel(true);
  if (status) status.innerHTML = `🎧 Escuchando <b>${escapeHtml(dev.name || 'el adaptador USB')}</b>… ` +
    'pruebo todas las velocidades y detecto la marca y la señal (hasta ~20 s)';
  $('testResult').className = 'test-result';
  let r = null;
  try {
    r = await apiJson('/api/scale/detect', {
      method: 'POST',
      body: {
        profile_id: 'auto', transport: 'usb',
        device_id: dev.deviceId, baudrates: BAUDRATES,
      },
    });
  } catch (e) {
    showHexPanel(false);
    if (status) status.textContent = '';
    wizResult('fail', e?.message ?? 'No pude escuchar la báscula.');
    otgAutoRetry(dev);
    return;
  }
  showHexPanel(false);
  if (r?.ok && r?.parser_ok && r?.parser) {
    const body = {
      profile_id: 'auto', parser: r.parser, transport: 'usb',
      device_id: dev.deviceId, invert_bits: !!r.invert_bits,
      reverse_frame: !!r.reverse_frame,
    };
    if (r.baudrate) body.baudrate = r.baudrate;
    try {
      await api('/api/scale/connect', { method: 'POST', body });
    } catch {
      if (status) status.textContent = '';
      wizResult('fail', 'La detecté pero no pude dejarla conectada — intenta de nuevo.');
      otgAutoRetry(dev);
      return;
    }
    APP.scaleConnected = true;
    APP.simActive = false;
    // parser, velocidad y polaridad detectados quedan guardados: la próxima
    // vez la app conecta directo (re-resolviendo el deviceId por vid:pid)
    saveCfg({
      method: 'otg', profile_id: 'auto', parser: r.parser,
      invert_bits: !!r.invert_bits, reverse_frame: !!r.reverse_frame,
      usb: { vid: dev.vid, pid: dev.pid, name: dev.name ?? '' },
      ...(r.baudrate ? { baudrate: r.baudrate } : {}),
      signal: 'auto',
      name: `Báscula USB (${dev.name || 'OTG'})`,
    });
    const fixes = [];
    if (r.invert_bits) fixes.push('señal invertida corregida sola');
    if (r.reverse_frame) fixes.push('números al revés corregidos solos');
    const kgTxt = r.kg != null ? `la báscula responde: ${fmt(r.kg)} kg` : 'la báscula responde';
    showBasculaHome({ cls: 'ok', text: `✓ Conectada — ${kgTxt}${fixes.length ? ` (${fixes.join(' y ')})` : ''}. ¡Ya puedes ir a Pesaje!` });
  } else {
    if (status) status.textContent = '';
    const msg = (r?.ok && !r?.parser_ok)
      ? 'Recibo datos pero no los entiendo — puede ser un modelo que aún no conozco. En «Ajustes avanzados» puedes elegir la marca a mano.'
      : (r?.message ?? 'No reconocí la báscula.');
    wizResult('fail', msg);
    otgAutoRetry(dev);
  }
}

/* tras un fallo: botón Reintentar (mismo dispositivo); "Ajustes avanzados"
   ya está en pantalla para forzar marca/velocidad a mano */
function otgAutoRetry(dev) {
  const status = $('otgAutoStatus');
  if (!status || !status.isConnected) return;
  status.innerHTML = '';
  const b = document.createElement('button');
  b.className = 'btn-primary';
  b.textContent = `↻ Reintentar con ${dev.name || 'el adaptador USB'}`;
  b.onclick = () => { otgAutoConnect(dev).catch(() => {}); };
  status.appendChild(b);
}

/* ---- buscador USB/OTG (app móvil, modo AVANZADO) ---- */
async function scanUsbDevices() {
  const list = $('usbList'), btn = $('bUsbScan');
  if (!list) return;
  if (btn) btn.disabled = true;
  list.innerHTML = '<div class="empty">Buscando dispositivos USB…</div>';
  try {
    const devices = await apiJson('/api/usb/devices');
    if (!list.isConnected) return;
    const arr = Array.isArray(devices) ? devices : (devices?.devices ?? []);
    if (!arr.length) {
      WIZ.usbDevice = null;
      list.innerHTML = '<div class="empty">No veo nada conectado por OTG. Conecta el cable y vuelve a buscar.</div>';
      return;
    }
    list.innerHTML = '<div class="bt-title">Toca el tuyo para elegirlo:</div>';
    const cfg = loadCfg();
    for (const dev of arr) {
      const vidpid = `${Number(dev?.vid).toString(16).padStart(4, '0')}:${Number(dev?.pid).toString(16).padStart(4, '0')}`;
      const b = document.createElement('button');
      b.className = 'bt-item';
      b.innerHTML = `<span class="bt-n">${escapeHtml(dev?.name || 'Adaptador USB-serial')}</span>` +
        `<span class="bt-a mono">${escapeHtml(vidpid)} · ${escapeHtml(dev?.driver ?? '')}</span>`;
      const select = () => {
        WIZ.usbDevice = { deviceId: dev?.deviceId, vid: dev?.vid, pid: dev?.pid, name: dev?.name ?? '' };
        for (const x of list.querySelectorAll('.bt-item')) x.classList.toggle('sel', x === b);
      };
      b.onclick = select;
      list.appendChild(b);
      // preselección: único dispositivo, o el mismo vid:pid guardado
      if (arr.length === 1 || (cfg?.usb && cfg.usb.vid === dev?.vid && cfg.usb.pid === dev?.pid)) select();
    }
  } catch (e) {
    WIZ.usbDevice = null;
    if (list.isConnected) list.innerHTML = `<div class="empty">${escapeHtml(e?.message ?? 'No pude buscar dispositivos USB.')}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---- probar + guardar ---- */
function wizAddress() {
  // → {ok, body?, cfgExtra?, msg?}
  if (WIZ.method === 'sim') return { ok: true, body: null, cfgExtra: {} };
  if (!WIZ.profileId) return { ok: false, msg: 'Primero elige la marca y el modelo de la báscula.' };
  // Escritorio · cable serial: COM/tty, o conversor de red si se llenó la IP
  if (WIZ.method === 'serial' || WIZ.method === 'red') {
    const raw = ($('wizHost')?.value ?? '').trim();
    if (raw) {
      const m = raw.match(/^([^:\s]+)(?::(\d+))?$/);
      if (!m) return { ok: false, msg: 'La dirección de red no se ve bien — usa el formato 192.168.0.50:8899.' };
      const body = { profile_id: WIZ.profileId, host: m[1], reverse_frame: WIZ.reverse };
      const cfgExtra = { host: m[1], reverse_frame: WIZ.reverse };
      if (m[2]) { body.tcp_port = parseInt(m[2], 10); cfgExtra.tcp_port = body.tcp_port; }
      return { ok: true, body, cfgExtra };
    }
    const port = ($('wizPort')?.value ?? '').trim();
    if (!port) {
      return { ok: false, msg: 'Escribe el puerto del cable (Ej: COM3) o la dirección del conversor de red.' };
    }
    return {
      ok: true,
      body: { profile_id: WIZ.profileId, port, reverse_frame: WIZ.reverse },
      cfgExtra: { port, reverse_frame: WIZ.reverse },
    };
  }
  // App móvil · OTG: dispositivo USB elegido + baudios + señal
  if (SHIM && (WIZ.method === 'otg' || WIZ.method === 'cable')) {
    if (!WIZ.usbDevice || WIZ.usbDevice.deviceId == null) {
      return { ok: false, msg: 'Conecta el cable OTG y elige el dispositivo USB de la lista.' };
    }
    const baud = parseInt($('wizBaud')?.value ?? '9600', 10) || 9600;
    const body = {
      profile_id: WIZ.profileId,
      transport: 'usb',
      device_id: WIZ.usbDevice.deviceId,
      baudrate: WIZ.detected?.baudrate ?? baud,
      reverse_frame: WIZ.detected?.reverse_frame ?? WIZ.reverse,
    };
    const inv = signalInvert();
    if (inv != null) body.invert_bits = inv;
    return {
      ok: true, body, detect: WIZ.signal === 'auto' && !WIZ.detected,
      cfgExtra: {
        usb: { vid: WIZ.usbDevice.vid, pid: WIZ.usbDevice.pid, name: WIZ.usbDevice.name },
        baudrate: body.baudrate,
        signal: WIZ.signal,
        reverse_frame: body.reverse_frame,
        ...(inv != null ? { invert_bits: inv } : {}),
      },
    };
  }
  const port = ($('wizPort')?.value ?? '').trim();
  if (!port) {
    return {
      ok: false,
      msg: WIZ.method === 'bluetooth'
        ? 'Falta la dirección: busca la báscula con 🔍 o escribe la dirección del módulo.'
        : 'Escribe el puerto donde está el cable (Ej: COM3).',
    };
  }
  // App móvil · bluetooth (avanzado): señal eléctrica + números al revés
  if (SHIM && WIZ.method === 'bluetooth') {
    const body = {
      profile_id: WIZ.profileId, port, transport: 'bluetooth',
      reverse_frame: WIZ.detected?.reverse_frame ?? WIZ.reverse,
    };
    const inv = signalInvert();
    if (inv != null) body.invert_bits = inv;
    return {
      ok: true, body, detect: WIZ.signal === 'auto' && !WIZ.detected,
      cfgExtra: {
        port, signal: WIZ.signal, reverse_frame: body.reverse_frame,
        ...(inv != null ? { invert_bits: inv } : {}),
      },
    };
  }
  return { ok: true, body: { profile_id: WIZ.profileId, port }, cfgExtra: { port } };
}

function wizResult(cls, text) {
  const res = $('testResult');
  res.className = 'test-result show' + (cls ? ' ' + cls : '');
  res.textContent = text;
}

let lastKg = null;

/* 🪄 Detector (app móvil): escucha bytes crudos, decide directa/invertida
   (y en USB barre 1200→19200 baudios) y muestra el veredicto en humano.
   El panel HEX en vivo se alimenta con los mensajes WS {"type":"detect"}. */
async function runDetect(a) {
  showHexPanel(true);
  const usb = a.body.transport === 'usb';
  wizResult('', usb
    ? 'Escuchando la báscula… pruebo cada velocidad y las dos polaridades (hasta ~20 s).'
    : 'Escuchando la báscula… primero señal directa, luego invertida (unos segundos).');
  const body = { profile_id: WIZ.profileId, transport: a.body.transport ?? 'bluetooth' };
  if (usb) { body.device_id = a.body.device_id; body.baudrates = BAUDRATES; }
  else body.port = a.body.port;
  let r;
  try {
    r = await apiJson('/api/scale/detect', { method: 'POST', body });
  } catch (e) {
    showHexPanel(false);
    wizResult('fail', e?.message ?? 'No pude escuchar la báscula.');
    return;
  }
  showHexPanel(false);
  if (r?.hex) { const el = $('hexPanel'); if (el) { el.hidden = false; el.textContent = r.hex; } }
  if (r?.ok) {
    WIZ.detected = {
      invert_bits: !!r.invert_bits,
      reverse_frame: !!r.reverse_frame,
      baudrate: r.baudrate ?? null,
    };
    if (r.baudrate && $('wizBaud')) $('wizBaud').value = String(r.baudrate);
    if ($('revToggle')) $('revToggle').checked = !!r.reverse_frame; // reflejar detección
    wizResult(r.parser_ok ? 'ok' : 'fail', r.message ?? 'Señal detectada.');
    if (r.parser_ok) {
      // dejarla conectada, igual que el "Probar conexión" clásico
      const connectBody = {
        ...a.body,
        invert_bits: !!r.invert_bits,
        reverse_frame: !!r.reverse_frame,
      };
      if (r.baudrate) connectBody.baudrate = r.baudrate;
      try { await api('/api/scale/connect', { method: 'POST', body: connectBody }); APP.scaleConnected = true; }
      catch { /* el veredicto ya se mostró */ }
    }
  } else {
    wizResult('fail', r?.message ?? 'No pude detectar la señal.');
  }
}

$('bProbar').onclick = async () => {
  const a = wizAddress();
  if (!a.ok) { wizResult('fail', a.msg); return; }
  $('bProbar').disabled = true;
  wizResult('', 'Probando…');
  const t0 = Date.now();
  try {
    if (SHIM && a.detect) {
      await runDetect(a);
      return;
    }
    if (WIZ.method === 'sim') {
      await startSim();
      wizResult('ok', 'Báscula simulada activa ✓ — guarda y ve al módulo Pesaje.');
      return;
    }
    await api('/api/scale/connect', { method: 'POST', body: a.body });
    const kg = await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (APP.lastReadingAt > t0) { clearInterval(iv); resolve(lastKg); }
        else if (Date.now() - t0 > 4000) { clearInterval(iv); resolve(null); }
      }, 200);
    });
    if (kg != null) {
      wizResult('ok', `La báscula responde: ${fmt(kg)} kg ✓`);
    } else {
      const st = await api('/api/scale/status').catch(() => null);
      if (st?.error) {
        wizResult('fail', st.error);
      } else if (st?.connected) {
        wizResult('fail', WIZ.method === 'bluetooth'
          ? 'Bluetooth conectado, pero no llegó un peso válido. Revisa el modelo elegido y que el BLU2 tenga los mismos parámetros RS-232 del indicador.'
          : 'Conectada, pero no llegó un peso válido. Revisa que la báscula esté encendida y el modelo elegido.');
      } else {
        wizResult('fail', 'La báscula no responde. Revisa la conexión, la dirección y que esté encendida.');
      }
    }
  } catch {
    wizResult('fail', 'No pude probar la conexión. Revisa la dirección y que el programa esté corriendo.');
  } finally {
    $('bProbar').disabled = false;
  }
};

$('bGuardarCfg').onclick = () => {
  const a = wizAddress();
  if (!a.ok) { wizResult('fail', a.msg); return; }
  const cfg = {
    method: WIZ.method,
    profile_id: WIZ.method === 'sim' ? 'sim' : WIZ.profileId,
    name: WIZ.method === 'sim' ? 'Báscula simulada' : (WIZ.profileName ?? WIZ.profileId),
    ...(a.cfgExtra ?? {}),
  };
  saveCfg(cfg);
  if (WIZ.method !== 'sim') APP.simActive = false;
  // aterriza en la tarjeta de estado con la config recién guardada
  showBasculaHome({ cls: 'ok', text: `Guardado: ${cfg.name} ✓ — ya puedes ir al módulo Pesaje.` });
};

/* ============================================================
   🧹 LIBERAR ESPACIO (lecturas crudas + pesajes viejos, manual)
   Mismos endpoints en escritorio (FastAPI) y en la app (shim):
   GET /api/mantenimiento/uso · POST /api/mantenimiento/limpiar
   ============================================================ */
function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n >= 1024 * 1024) return fmt(n / (1024 * 1024), 1) + ' MB';
  if (n >= 1024) return fmt(n / 1024, 0) + ' KB';
  return n + ' B';
}

async function refreshCleanBox() {
  const el = $('cleanUso');
  if (!el) return;
  try {
    const u = await apiJson('/api/mantenimiento/uso');
    const partes = [
      `La app ocupa <b>${fmtBytes(u?.db_bytes)}</b>.`,
      `Lecturas crudas: <b>${Number(u?.lecturas_total) || 0}</b> (${Number(u?.lecturas_borrables) || 0} borrables).`,
      `Pesajes cerrados: <b>${Number(u?.pesajes_cerrados) || 0}</b>${u?.pesaje_mas_viejo ? ` (el más viejo: ${escapeHtml(fechaCorta(u.pesaje_mas_viejo))})` : ''}.`,
    ];
    el.innerHTML = partes.join(' ');
    $('bCleanLecturas').disabled = !(Number(u?.lecturas_borrables) > 0);
  } catch {
    el.textContent = 'No pude calcular el uso de espacio — ¿está corriendo el programa?';
  }
}

function cleanResult(cls, text) {
  const res = $('cleanResult');
  if (!res) return;
  res.className = 'test-result show' + (cls ? ' ' + cls : '');
  res.textContent = text;
}

if ($('cleanBox')) {
  $('cleanBox').addEventListener('toggle', () => {
    if ($('cleanBox').open) refreshCleanBox().catch(() => {});
  });

  /* (a) lecturas crudas de pesajes cerrados — siempre seguro */
  $('bCleanLecturas').onclick = async () => {
    $('bCleanLecturas').disabled = true;
    try {
      const r = await apiJson('/api/mantenimiento/limpiar', { method: 'POST', body: { accion: 'lecturas' } });
      const n = Number(r?.borrado?.lecturas) || 0;
      cleanResult('ok', n
        ? `✓ Listo: borré ${n.toLocaleString('es-CO')} lecturas crudas. Tus pesajes quedaron intactos.`
        : 'No había lecturas crudas para borrar.');
    } catch (e) {
      cleanResult('fail', e?.message ?? 'No pude borrar las lecturas.');
    } finally {
      refreshCleanBox().catch(() => {});
    }
  };

  /* (b) pesajes cerrados anteriores a una fecha — confirmación DOBLE */
  $('bCleanPesajes').onclick = async () => {
    const fecha = ($('cleanFecha').value || '').trim();
    $('cleanConfirm').hidden = true;
    if (!fecha) { cleanResult('fail', 'Primero elige la fecha: se borran los pesajes cerrados ANTERIORES a ese día.'); return; }
    $('bCleanPesajes').disabled = true;
    try {
      const dry = await apiJson('/api/mantenimiento/limpiar', {
        method: 'POST', body: { accion: 'pesajes', antes: fecha, dry_run: true },
      });
      const n = Number(dry?.borrado?.pesajes) || 0;
      if (!n) { cleanResult('ok', 'No hay pesajes cerrados anteriores a esa fecha — nada que borrar.'); return; }
      const ev = Number(dry?.borrado?.eventos) || 0;
      $('cleanConfirmTxt').textContent =
        `Se borrarán ${n} pesaje${n === 1 ? '' : 's'} cerrado${n === 1 ? '' : 's'} con sus ${ev} movimientos ` +
        `y sus lecturas — esto NO se puede deshacer. Los pesajes abiertos no se tocan.`;
      $('cleanConfirm').hidden = false;
      cleanResult('', '');
      $('cleanResult').className = 'test-result';
    } catch (e) {
      cleanResult('fail', e?.message ?? 'No pude contar los pesajes.');
    } finally {
      $('bCleanPesajes').disabled = false;
    }
  };

  $('bCleanCancelar').onclick = () => { $('cleanConfirm').hidden = true; };

  $('bCleanConfirmar').onclick = async () => {
    const fecha = ($('cleanFecha').value || '').trim();
    if (!fecha) { $('cleanConfirm').hidden = true; return; }
    $('bCleanConfirmar').disabled = true;
    try {
      const r = await apiJson('/api/mantenimiento/limpiar', {
        method: 'POST', body: { accion: 'pesajes', antes: fecha },
      });
      const b = r?.borrado ?? {};
      cleanResult('ok', `✓ Borré ${Number(b.pesajes) || 0} pesajes (${Number(b.eventos) || 0} movimientos, ` +
        `${Number(b.lecturas) || 0} lecturas). Ahora la app ocupa ${fmtBytes(r?.db_bytes)}.`);
    } catch (e) {
      cleanResult('fail', e?.message ?? 'No pude borrar los pesajes.');
    } finally {
      $('bCleanConfirmar').disabled = false;
      $('cleanConfirm').hidden = true;
      refreshCleanBox().catch(() => {});
    }
  };
}

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
  else if (m.type === 'detect') onDetectHex(m);
}

/* panel HEX en vivo del detector de señal (wizard, app móvil) */
function onDetectHex(m) {
  const el = $('hexPanel');
  if (!el || el.hidden) return;
  const baud = m?.baud != null ? `@${m.baud} baudios · ` : '';
  el.textContent = baud + String(m?.hex ?? '');
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
   ☁️ NUBE — FUERA DE LA VISTA (pedido del cliente, 2026-08)
   La sección se OCULTA por defecto en móvil y escritorio, pero TODO el
   código, endpoints y datos de la nube siguen intactos (auth.js, sync,
   backend). Para volver a mostrarla:
     - abrir la app con  ?avanzado=1   en la URL, o
     - en la consola:    localStorage.setItem('porcipeso_avanzado','1')
   y recargar. Para re-activarla de fábrica: borrar este bloque.
   ============================================================ */
/* ADVANCED_UI se define arriba (junto a SHIM): el mismo flag destapa
   la Nube y el método Cable serial del wizard. */
if (!ADVANCED_UI) {
  const nb = $('nubeBox');
  if (nb) nb.hidden = true;
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

  // onboarding: solo la primera vez que se abre la app
  const onboarded = (() => { try { return localStorage.getItem('porcipeso_onboard') === '1'; } catch { return true; } })();
  if (!onboarded) {
    obShow(0);
    try { $('dlgOnboard').showModal(); } catch { /* sin dialog */ }
  }
})();
