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
function apiDown(msg, detail) {
  if (msg) $('apiBannerTxt').textContent = msg;
  const d = $('apiBannerDetail');
  if (d) {
    const has = !!detail;
    d.textContent = has ? detail : '';
    d.hidden = !has;
  }
  $('apiBanner').classList.add('show');
}
function apiOk() { $('apiBanner').classList.remove('show'); }

/* Mensaje de "backend caído" — HONESTO según dónde corremos:
   · Escritorio (sin shim): el server local FastAPI no responde → "revisa que
     el computador esté encendido" (igual que siempre).
   · App móvil (shim presente): NO hay ningún computador; el backend va
     embebido. Si no levantó suele ser un WebView viejo → pasos útiles para el
     teléfono, más el motivo técnico si el shim lo reportó (SHIM.initError). */
function backendDownMessage() {
  if (SHIM) {
    return {
      msg: 'Este teléfono no pudo iniciar la app. Actualiza «Android System WebView» y Chrome desde Play Store, reinícialo y vuelve a abrir.',
      detail: SHIM.initError ? `Detalle técnico: ${SHIM.initError}` : '',
    };
  }
  return {
    msg: 'No encuentro el programa de la báscula — revisa que el computador esté encendido',
    detail: '',
  };
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    const b = backendDownMessage();
    apiDown(b.msg, b.detail);
    throw e;
  }
  apiOk();
  if (!res.ok) {
    // conserva el cuerpo del backend en el error: el {detail} en humano y, en
    // el connect BLE, el diagnóstico GATT ({gatt, gatt_text}) para la UI.
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const e = new Error(body?.detail ? String(body.detail) : `HTTP ${res.status}`);
    e.status = res.status;
    e.body = body;
    throw e;
  }
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
  if (!res.ok) {
    const e = new Error(data?.detail ? String(data.detail) : `HTTP ${res.status}`);
    e.status = res.status;
    e.body = data; // incluye {gatt, gatt_text} en un fallo de connect BLE
    throw e;
  }
  return data;
}

/* ============================================================
   DIAGNÓSTICO DEL MOTOR DE DATOS (solo app móvil)
   El shim (main.ts) publica window.__PORCIPESO_SHIM__.dbBackend con el motor
   que quedó activo en ESTE teléfono. Sirve para saber en campo si degradó.
   ============================================================ */
const DB_BACKEND_LABEL = {
  'native': 'nativo',
  'sqljs-fallback': 'respaldo (sql.js)',
  'memoria-degradada': 'memoria — los pesajes NO se guardan al cerrar',
};

function renderDbDiag() {
  const el = $('dbDiag');
  if (!el) return;
  if (!SHIM) { el.hidden = true; return; }
  const b = SHIM.dbBackend;
  let label;
  if (b) label = DB_BACKEND_LABEL[b] ?? b;
  else label = SHIM.initError ? 'no disponible' : 'iniciando…';
  el.textContent = 'Motor de datos: ' + label;
  el.classList.toggle('warn', b === 'memoria-degradada' || (!b && !!SHIM.initError));
  el.hidden = false;
}

/* Aviso HONESTO cuando el teléfono cayó al nivel 3 (memoria): la app funciona
   para pesar pero NO persiste. Se muestra una vez que el shim eligió motor. */
function showDbWarnIfDegraded() {
  const el = $('dbWarnBanner'), txt = $('dbWarnTxt');
  if (!el || !txt) return;
  if (SHIM && SHIM.dbBackend === 'memoria-degradada') {
    txt.textContent = 'Este teléfono es muy viejo: los pesajes NO se guardarán al cerrar la app. Puedes pesar y exportar en el momento, pero considera otro equipo para guardar el historial.';
    el.classList.add('show');
  } else {
    el.classList.remove('show');
  }
}

/* El shim elige motor de forma asíncrona (init de la DB). Esperamos a que
   fije dbBackend/initError para pintar el diagnóstico y el aviso de memoria. */
function watchDbBackend() {
  if (!SHIM) return;
  renderDbDiag();
  if (SHIM.dbBackend) { showDbWarnIfDegraded(); return; }
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;
    if (SHIM.dbBackend || SHIM.initError || tries > 40) { // hasta ~10 s
      clearInterval(t);
      renderDbDiag();
      showDbWarnIfDegraded();
    }
  }, 250);
}

/* ---------------- configuración guardada (báscula real) ---------------- */
function loadCfg() {
  try {
    const cfg = JSON.parse(localStorage.getItem('porcipeso_cfg') || 'null');
    // Limpieza: una báscula guardada de pruebas antiguas ("BOLUTEK" / Bolutec /
    // Bolutex — cualquier grafía) no debe volver a aparecer como recordada ni
    // "conectada". Si el guardado la menciona, se borra solo y la app arranca
    // sin báscula recordada.
    const txt = `${cfg?.name ?? ''} ${cfg?.port ?? ''} ${cfg?.profile_id ?? ''}`.toLowerCase();
    if (cfg && txt.includes('bolute')) { clearCfg(); return null; }
    return cfg;
  }
  catch { return null; }
}
function saveCfg(cfg) {
  try { localStorage.setItem('porcipeso_cfg', JSON.stringify(cfg)); } catch { /* sin storage */ }
}
function clearCfg() {
  try { localStorage.removeItem('porcipeso_cfg'); } catch { /* sin storage */ }
}
/* ¿la config guardada es la de la báscula simulada? (la deja "Usar báscula
   simulada" SOLO cuando no había una báscula real — ver startSim). Cubre
   profile_id "sim" y "simulador". */
function isSimCfg(cfg) {
  if (!cfg) return false;
  return cfg.method === 'sim' || /^sim/i.test(String(cfg.profile_id ?? ''));
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
  // Sin báscula real configurada: la simulada queda como config guardada,
  // para que ⚙ Báscula muestre la tarjeta de estado (chip vivo, Desconectar,
  // reconectar con un toque) en vez de "Todavía no has conectado…".
  // JAMÁS pisa la config de una báscula real ya guardada.
  if (!loadCfg()?.profile_id) {
    saveCfg({ method: 'sim', profile_id: 'sim', name: 'Báscula simulada' });
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
      // TIPO de enlace guardado: 'ble' → transporte BLE, si no SPP clásico.
      body.transport = cfg.transport === 'ble' ? 'ble' : 'bluetooth';
      // dual-mode: si el SPP clásico no conecta, el backend cae a BLE solo
      if (cfg.alsoBle) body.also_ble = true;
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
  const chip = $('scaleChip'), btn = $('bStart'), note = $('startNote');
  const simBtn = $('bUseSim'), backBtn = $('bBackReal');
  const st = await scaleStatus();
  refreshSimUi();
  // los dos enlaces son EXCLUYENTES: en práctica se ofrece SALIR ("↩ Volver
  // a báscula real"); fuera de práctica se ofrece ENTRAR ("🎛 Usar báscula
  // simulada"). Nunca se ven los dos a la vez.
  backBtn.hidden = !APP.simActive;
  simBtn.hidden = APP.simActive;
  // la política DEMO acompaña a cualquiera de los dos enlaces
  const syncSimNote = () => { $('simNote').hidden = simBtn.hidden && backBtn.hidden; };
  if (APP.scaleConnected) {
    chip.className = 'chip ' + (APP.simActive ? 'sim' : 'ok');
    chip.textContent = APP.simActive ? 'Báscula simulada' : (st?.profile_name ?? st?.name ?? 'Báscula conectada');
    btn.textContent = 'Empezar a pesar';
    note.hidden = true;
    syncSimNote();
    return;
  }
  const cfg = loadCfg();
  if (cfg?.profile_id) {
    chip.className = 'chip';
    chip.textContent = cfg.name ?? 'Báscula guardada';
    btn.textContent = 'Empezar a pesar';
    note.textContent = 'Me conecto a la báscula cuando empieces.';
    note.hidden = false;
  } else {
    chip.className = 'chip err';
    chip.textContent = st === null ? 'Programa apagado' : 'Sin báscula';
    btn.textContent = 'Empezar a pesar';
    note.textContent = 'No hay báscula configurada. Puedes practicar con la báscula simulada.';
    note.hidden = false;
  }
  syncSimNote();
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
/* Salir de la práctica: desconecta la simulada y vuelve a báscula real.
   Reusa el mismo /api/scale/disconnect + limpieza de cfg que la tarjeta de
   ⚙ Báscula (no duplica lógica). Si "Usar báscula simulada" había dejado la
   config demo (no había báscula real), la borra → "Sin báscula". Si había
   una báscula REAL guardada, startSim NUNCA la pisó → se conserva y el home
   vuelve a ella. */
$('bBackReal').onclick = async () => {
  const b = $('bBackReal');
  b.disabled = true;
  try { await apiJson('/api/scale/disconnect', { method: 'POST', body: {} }); }
  catch { /* seguimos: limpiamos el estado local de todos modos */ }
  APP.scaleConnected = false;
  APP.simActive = false;
  APP.lastReadingAt = 0;
  if (isSimCfg(loadCfg())) clearCfg();   // no quedar pegados en práctica
  refreshSimUi();
  try { await refreshPesajeHome(); }
  finally { b.disabled = false; }
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

/* Campos extra según el modo: en UNIDADES (muestreo/control de
   crecimiento) no hay despacho — destino/placa/conductor no aplican y
   solo queda Corral (de cuál corral sale la muestra). En LOTE (despacho
   con camión) se muestran todos. */
const EXTRA_FIELDS_BY_MODE = {
  lote: ['corral', 'destino', 'placa', 'conductor'],
  unidades: ['corral'],
};
function extraFieldsFor(mode) {
  return EXTRA_FIELDS_BY_MODE[mode] ?? EXTRA_FIELDS_BY_MODE.lote;
}
function applyModeFields() {
  const visibles = extraFieldsFor(APP.mode);
  for (const lb of document.querySelectorAll('#formSetup [data-extra]')) {
    const show = visibles.includes(lb.dataset.extra);
    lb.style.display = show ? '' : 'none';
    if (!show) { const inp = lb.querySelector('input'); if (inp) inp.value = ''; }
  }
}

function gotoSetup() {
  $('inpNombre').value = '';               // limpio: la fecha va aparte, fija
  updateSaveWhen();
  applyModeFields();
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
  for (const k of extraFieldsFor(APP.mode)) {   // unidades: solo corral
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
    APP.session = {
      id: r?.id ?? r?.session_id ?? null,
      nombre,
      esDemo: !!(r?.es_demo), // báscula simulada: el backend lo decide
    };
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
  else setGuide(`<b>PASO 2</b> · Sube los demás como quieras (de a 1, 2, 3…); yo cuento${ref ? ` — cerdo de prueba: ${fmt(ref)} kg` : ''}`);
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
    showManualRef(false);
  } else {
    setStep(1);
    say('Esperando el cerdo de prueba… súbelo solo, sin compañía', 'calm');
    showManualRef(true);  // peso a mano disponible durante la calibración
  }
  // Descuento de devueltos: unidades = por peso real (elige el cerdo);
  // lote = por cantidad (promedio, peso individual desconocido).
  const uni = APP.mode === 'unidades';
  if ($('returnedUnidades')) $('returnedUnidades').hidden = !uni;
  if ($('returnedUnidadesHint')) $('returnedUnidadesHint').hidden = !uni;
  if ($('returnedLote')) $('returnedLote').hidden = uni;
  refreshReturnedPigs();
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
  // durante bajar_prueba el backend aún no confirma ref_kg: el motor manda
  // su candidato (cand_kg, el mismo valor que será la referencia); kg_now
  // queda de respaldo para backends viejos que no lo mandan
  const ref = src?.ref_kg ?? APP.refKg ?? src?.cand_kg ?? APP.candKg ?? src?.kg_now;
  if (fase === 'bajar_prueba' && ref != null) APP.candKg = ref;
  if (fase === 'calibracion') {
    setStep(1);
    say('Esperando el cerdo de prueba… súbelo solo, sin compañía', 'calm');
    showManualRef(true);
  } else if (fase === 'bajar_prueba') {
    setGuide(`✓ Cerdo de prueba: <b>${fmt(ref)} kg</b> — ahora bájalo de la báscula`);
    say(`✓ Cerdo de prueba: ${fmt(ref)} kg — ahora bájalo de la báscula`, 'calm', 4000);
    showManualRef(true);
  } else if (fase === 'lote') {
    setStep(2, ref);
    showManualRef(false);
    if (!APP.loteAnnounced) {
      APP.loteAnnounced = true;
      say('¡Listo! Ya puedes subir TODO el lote 🎉', 'calm', 6000);
    }
  } else if (fase === 'unidades') {
    setGuide('🐷 De a <b>UN</b> cerdo a la vez — yo llevo la cuenta');
    showManualRef(false);
  }
}

/* ---------------- referencia a mano (peso del cerdo de prueba) ----------------
   Si la báscula no toma sola el peso de calibración, el operario lo escribe
   y POST /api/session/reference lo fija. La app pasa a fase "lote". */
function showManualRef(show) {
  const box = $('manualRef');
  if (!box) return;
  box.hidden = !show;
  if (!show) {
    if ($('manualRefForm')) $('manualRefForm').hidden = true;
    if ($('inpManualRef')) $('inpManualRef').value = '';
  }
}

async function usarPesoManual() {
  const raw = ($('inpManualRef')?.value || '').replace(',', '.').trim();
  const kg = Number(raw);
  if (!Number.isFinite(kg) || kg <= 0) {
    say('Escribe un peso mayor que 0 (por ejemplo 1.5)', 'alert', 3500);
    try { $('inpManualRef')?.focus(); } catch { /* ok */ }
    return;
  }
  try {
    const r = await apiJson('/api/session/reference', { method: 'POST', body: { kg } });
    APP.refKg = r?.ref_kg ?? kg;
    APP.candKg = APP.refKg;
    showManualRef(false);
    // el backend ya pasó a fase lote; forzamos la narración/guía localmente
    // (los mensajes de WS que lleguen después ya no la pisan: fase === APP.fase)
    applyFase('lote', { ref_kg: APP.refKg, fase: 'lote' });
    say(`Referencia: ${fmt(APP.refKg, 1)} kg (manual) — ya puedes subir el lote`, 'calm', 6000);
  } catch (e) {
    say('No pude fijar la referencia — revisa que haya un pesaje abierto', 'alert', 4000);
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
        refreshReturnedPigs();
        askNext();
      } catch {
        b.disabled = false;
      }
    };
    box.appendChild(b);
  }
  // Campo MANUAL: si ninguna opción aplica, el operario escribe el número
  const wrap = document.createElement('span');
  wrap.className = 'q-manual';
  const inp = document.createElement('input');
  inp.type = 'number'; inp.min = '1'; inp.inputMode = 'numeric';
  inp.placeholder = 'otro';
  const ok = document.createElement('button');
  ok.textContent = 'Confirmar';
  ok.onclick = async () => {
    const o = parseInt(inp.value, 10);
    if (!Number.isInteger(o) || o < 1) { inp.focus(); return; }
    ok.disabled = true;
    try {
      await api(`/api/events/${q.eventId}/confirm`, { method: 'POST', body: { n: o } });
      addMove('up', '✓', `Me dijiste que subieron ${o} (+${fmt(q.delta)} kg)`);
      activeQuestion = null;
      say(`✓ Anotado: subieron ${o}`, 'calm', 4000);
      if (q.delta > 0) for (let i = 0; i < o; i++) APP.weights.push(q.delta / o);
      refreshReturnedPigs();
      askNext();
    } catch { ok.disabled = false; }
  };
  wrap.appendChild(inp); wrap.appendChild(ok);
  box.appendChild(wrap);
  box.hidden = false;
}

/* ---------------- LED: texto crudo + fit-to-width ---------------- */
/* El LED muestra EXACTAMENTE lo que transmite el indicador (campo "raw" del
   WS, ej. "-7143.0"): sin locale, sin separador de miles, sin coma decimal.
   Fallback (sim / protocolos binarios sin token): número plano con punto. */
function ledText(m, kg) {
  const raw = typeof m?.raw === 'string' ? m.raw.trim() : '';
  if (raw) return raw;
  return kg.toFixed(1); // 1 decimal SIEMPRE (igual que la división de escala)
}

/* Fit-to-width: mide el ancho renderizado al tamaño natural (CSS) y, si se
   sale del recuadro, escala el font-size en proporción exacta. Segundo pase
   por redondeo/kerning. El número JAMÁS se corta ni desborda el ledbox. */
function fitLed() {
  const led = $('led');
  const box = led && led.parentElement;
  if (!box) return;
  led.style.fontSize = '';                 // medir al tamaño natural (clamp CSS)
  const cs = getComputedStyle(box);
  const avail = box.clientWidth
    - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  if (avail <= 0) return;                  // panel oculto: nada que ajustar
  let w = led.scrollWidth;
  if (w <= avail) return;
  const base = parseFloat(getComputedStyle(led).fontSize) || 88;
  led.style.fontSize = Math.max(8, Math.floor(base * avail / w)) + 'px';
  w = led.scrollWidth;
  if (w > avail) {
    const cur = parseFloat(led.style.fontSize);
    led.style.fontSize = Math.max(8, Math.floor(cur * avail / w)) + 'px';
  }
}
window.addEventListener('resize', fitLed);

function setLed(text) {
  const led = $('led');
  led.textContent = text + ' ';
  const small = document.createElement('small');
  small.textContent = 'kg';
  led.appendChild(small);
  fitLed();
}

/* ---------------- lecturas (WS) ---------------- */
const hist = [];
function onReading(m) {
  const kg = Number(m?.kg ?? 0);
  APP.lastReadingAt = Date.now();
  connCardLive(kg); // chip vivo de la tarjeta ⚙ Báscula (si está a la vista)
  rmLiveReading(m, kg); // LED crudo del monitor de datos (si está abierto)
  // peso del cerdo de prueba que el motor ya tiene (antes de ref_kg)
  if (m?.cand_kg != null && APP.refKg == null) APP.candKg = Number(m.cand_kg);
  if (m?.fase) { APP.faseSupported = true; if (APP.session) applyFase(m.fase, m); }
  setLed(ledText(m, kg));
  $('led').classList.add('pulse');
  hist.push(kg); if (hist.length > 300) hist.shift();
  drawSpark();
  const st = m?.state;
  if (st === 'movimiento') ambient('Se están moviendo… espero a que se calmen', 'busy');
  else if (st === 'sin_senal') ambient('⚠ Perdí la señal de la báscula — revisa el cable', 'alert');
  else if (st === 'estable') {
    if (!APP.session) return;
    if (APP.fase === 'bajar_prueba') {
      const cand = APP.refKg ?? APP.candKg;
      if (cand != null) setGuide(`✓ Cerdo de prueba: <b>${fmt(cand)} kg</b> — ahora bájalo de la báscula`);
      ambient(`✓ Cerdo de prueba: ${fmt(cand)} kg — ahora bájalo de la báscula`, 'calm');
    } else if (APP.mode === 'unidades') {
      ambient(APP.unitCount
        ? 'Yo llevo la cuenta — bájalo y sube el siguiente cuando quieras'
        : 'Sube un cerdo a la báscula', 'calm');
    } else if (APP.refKg == null) {
      // el motor pasa a bajar_prueba sin re-emitir snapshot: si hay un peso
      // estable considerable durante la calibración, ES el cerdo de prueba
      if (APP.fase === 'calibracion' && kg >= 40) {
        APP.candKg = kg;
        setGuide(`✓ Cerdo de prueba: <b>${fmt(kg)} kg</b> — ahora bájalo de la báscula`);
        ambient(`✓ Cerdo de prueba: ${fmt(kg)} kg — ahora bájalo de la báscula`, 'calm');
      } else {
        ambient('Esperando el cerdo de prueba… súbelo solo, sin compañía', 'calm');
      }
    } else {
      ambient('Todo tranquilo. Puedes subir más cerdos: de a 1, 2 o 3', '');
    }
  }
}

setInterval(async () => {
  if (!$('pvWeigh').classList.contains('active')) return;
  if (APP.lastReadingAt && Date.now() - APP.lastReadingAt > 3000) {
    $('led').classList.remove('pulse');
    // Estado HONESTO: si el enlace se cayó y el driver reconecta, dilo en ámbar
    // ("Reconectando…") en vez de "Perdí la señal". El pesaje NO se pierde: el
    // motor conserva su estado y al volver los datos sigue contando.
    let reconnecting = false;
    try { const st = await api('/api/scale/status'); reconnecting = !!st?.reconnecting; } catch { /* sin backend */ }
    if (reconnecting) {
      ambient('🔄 Reconectando con la báscula… el pesaje se mantiene', 'busy');
    } else {
      ambient('⚠ Perdí la señal de la báscula — revisa el cable', 'alert');
    }
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
  $('nTotal').innerHTML = `${fmt(s.total_kg ?? 0)} <em>kg</em>`;
  $('nProm').innerHTML = `${s.avg_kg != null ? fmt(s.avg_kg) : '—'} <em>kg</em>`;
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
      say(`✓ Cerdo #1: ${fmt(delta)} kg — bájalo y sube el siguiente`, 'calm', 5000);
      addMove('up', '✓', `Cerdo #1: ${fmt(delta)} kg`);
      refreshReturnedPigs();
    } else if (APP.faseSupported) {
      // motor con fases: la narración la llevan las fases (bajar_prueba → lote);
      // la referencia se emite al BAJAR el cerdo de prueba — aquí solo registro
      addMove('up', '✓', `Cerdo de prueba: ${fmt(delta)} kg — quedé calibrado`);
    } else {
      setStep(2, delta);
      say(`Calibrado: el cerdo de prueba pesa ${fmt(delta)} kg. Ya puedes subir los demás`, 'calm', 6000);
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
    say(`✓ Cerdo #${APP.unitCount}: ${fmt(each)} kg — bájalo y sube el siguiente`, 'calm', 5000);
    addMove('up', '✓', `Cerdo #${APP.unitCount}: ${fmt(each)} kg`);
    for (let i = 0; i < n; i++) APP.weights.push(each);
    refreshReturnedPigs();
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

/* ---------------- devueltos manual ---------------- */
/* LOTE: por cantidad (peso individual desconocido → promedio). */
$('bReturned').onclick = async () => {
  const inp = $('inpReturned');
  const n = parseInt(inp.value, 10);
  if (!Number.isInteger(n) || n < 1) { inp.focus(); return; }
  $('bReturned').disabled = true;
  try {
    const r = await api('/api/session/returned', { method: 'POST', body: { n } });
    inp.value = '';
    // quita n del promedio local para que la estadística de cierre cuadre
    for (let i = 0; i < n && APP.weights.length; i++) APP.weights.pop();
    addMove('down', '↩', `${n} devuelto${n > 1 ? 's' : ''} — descontados para no contar doble`);
    say(`↩ Descontados ${n} devuelto${n > 1 ? 's' : ''}`, 'calm', 4000);
  } catch (e) {
    say('No pude descontar — ¿hay un pesaje activo con cerdos?', 'alert', 4000);
  } finally { $('bReturned').disabled = false; }
};

/* UNIDADES: elige el cerdo por su PESO REAL (ya pesado). Descuenta ese peso
   exacto; cuando el cerdo re-pase por la báscula, el total cierra al gramo. */
function refreshReturnedPigs() {
  const sel = $('selReturnedPig');
  if (!sel) return;
  const ws = Array.isArray(APP.weights) ? APP.weights : [];
  const prev = sel.value;
  sel.innerHTML = '';
  ws.forEach((kg, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `Cerdo #${i + 1} — ${fmt(kg)} kg`;
    sel.appendChild(o);
  });
  // por defecto sugiere el ÚLTIMO (el rebote más común); conserva la selección
  if (ws.length) sel.value = (prev && Number(prev) < ws.length) ? prev : String(ws.length - 1);
  const empty = ws.length === 0;
  sel.disabled = empty;
  const btn = $('bReturnedPig');
  if (btn) btn.disabled = empty;
}

if ($('bReturnedPig')) $('bReturnedPig').onclick = async () => {
  const sel = $('selReturnedPig');
  const idx = sel ? parseInt(sel.value, 10) : -1;
  const ws = Array.isArray(APP.weights) ? APP.weights : [];
  if (!Number.isInteger(idx) || idx < 0 || idx >= ws.length) return;
  const kg = ws[idx];
  $('bReturnedPig').disabled = true;
  try {
    await api('/api/session/returned', { method: 'POST', body: { n: 1, kg } });
    APP.weights.splice(idx, 1);          // ese cerdo sale del censo local
    refreshReturnedPigs();
    addMove('down', '↩', `Devuelto: cerdo de ${fmt(kg)} kg — descontado con su peso real`);
    say(`↩ Descontado 1 devuelto (${fmt(kg)} kg)`, 'calm', 4000);
  } catch (e) {
    say('No pude descontar — ¿hay un pesaje activo con cerdos?', 'alert', 4000);
  } finally { refreshReturnedPigs(); }
};

/* ---------------- referencia a mano (wiring) ---------------- */
if ($('bManualRefToggle')) {
  $('bManualRefToggle').onclick = () => {
    const f = $('manualRefForm');
    if (!f) return;
    f.hidden = !f.hidden;
    if (!f.hidden) { try { $('inpManualRef').focus(); } catch { /* ok */ } }
  };
}
if ($('bManualRef')) $('bManualRef').onclick = usarPesoManual;
if ($('inpManualRef')) {
  $('inpManualRef').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); usarPesoManual(); }
  });
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
  const esDemo = !!(r?.es_demo ?? APP.session?.esDemo);
  $('doneDemo').hidden = !esDemo;
  $('doneDemoNote').hidden = !esDemo;
  $('rCards').innerHTML = `
    <div class="rcard"><div class="rv">${Number(count) || 0}</div><div class="rk">cerdos</div></div>
    <div class="rcard"><div class="rv">${fmt(total)}</div><div class="rk">kg en total</div></div>
    <div class="rcard"><div class="rv">${fmt(avg)}</div><div class="rk">kg de promedio</div></div>`;

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
      ['Kg totales', fmt(Number(s?.total_kg ?? 0)), 'kg'],
      ['Promedio global', s?.promedio_global != null ? fmt(Number(s.promedio_global)) : '—', 'kg'],
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
        if (kg != null) parts.push(`<b>${fmt(Number(kg))}</b> kg`);
        const pr = l?.promedio ?? l?.promedio_final ?? l?.promedio_global;
        if (pr != null) parts.push(`<b>${fmt(Number(pr))}</b> kg prom.`);
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
      <td><b>${escapeHtml(s?.lote ?? `Pesaje ${s?.id ?? ''}`)}</b>${s?.es_demo ? '<span class="chip demo">DEMO</span>' : ''}</td>
      <td class="mono">${escapeHtml(s?.total_animales ?? '—')}</td>
      <td class="mono">${s?.total_kg != null ? fmt(Number(s.total_kg)) : '—'}</td>
      <td class="mono">${s?.promedio_final != null ? fmt(Number(s.promedio_final)) : '—'}</td>
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
  const esDemo = !!s?.es_demo;
  $('dDemo').hidden = !esDemo;
  $('dDemoNote').hidden = !esDemo;
  const cuando = [fechaLarga(s?.hora_entrada), s?.hora_entrada ? `${hora(s.hora_entrada)}${s?.hora_salida ? ' – ' + hora(s.hora_salida) : ''}` : '']
    .filter(Boolean).join(' · ');
  $('dCuando').textContent = cuando || 'Sin fecha registrada';

  const total = s?.total_kg, count = s?.total_animales, avg = s?.promedio_final;
  $('dCards').innerHTML = `
    <div class="rcard"><div class="rv">${count != null ? Number(count) || 0 : '—'}</div><div class="rk">cerdos</div></div>
    <div class="rcard"><div class="rv">${total != null ? fmt(Number(total)) : '—'}</div><div class="rk">kg en total</div></div>
    <div class="rcard"><div class="rv">${avg != null ? fmt(Number(avg)) : '—'}</div><div class="rk">kg de promedio</div></div>`;

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

/* ---------------- eliminar lote (borrado en cascada) ----------------
   Botón rojo discreto en el detalle → confirmación doble clara (nombre del
   lote + cuántos movimientos se pierden) → DELETE /api/sessions/{id} →
   vuelve a la lista de Datos y refresca. Las sesiones DEMO se borran igual;
   un pesaje ABIERTO responde 409 (hay que cerrarlo antes). */
if ($('bDeleteLote')) {
  $('bDeleteLote').onclick = () => {
    if (APP.datosDetailId == null) return;
    const nombre = $('dNombre').textContent || `Pesaje ${APP.datosDetailId}`;
    const n = $('dMoves').querySelectorAll('.mv').length;
    $('delLoteMsg').innerHTML =
      `Vas a borrar el lote <b>«${escapeHtml(nombre)}»</b> con sus ${n} ` +
      `movimiento${n === 1 ? '' : 's'}. <b>Esto no se puede deshacer.</b>`;
    $('bDelLoteConfirm').disabled = false;
    try { $('dlgDelLote').showModal(); } catch { /* ya abierto */ }
  };
}
if ($('bDelLoteCancel')) $('bDelLoteCancel').onclick = () => $('dlgDelLote').close();
if ($('bDelLoteConfirm')) {
  $('bDelLoteConfirm').onclick = async () => {
    const id = APP.datosDetailId;
    if (id == null) { $('dlgDelLote').close(); return; }
    $('bDelLoteConfirm').disabled = true;
    try {
      await apiJson(`/api/sessions/${id}`, { method: 'DELETE' });
      uniCache.delete(id);
      APP.datosDetailId = null;
      $('dlgDelLote').close();
      setSubview('modDatos', 'dvList');
      await refreshDatos();
    } catch (e) {
      // conserva el diálogo abierto y explica el motivo (ej. 409 abierta)
      $('delLoteMsg').innerHTML =
        `No pude borrar el lote: ${escapeHtml(e?.message ?? 'error')}`;
      $('bDelLoteConfirm').disabled = false;
    }
  };
}

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

function initBascula() { showBasculaHome(); renderDbDiag(); initSecUI(); initMinKg(); initTuning(); }

/* ⚖ Peso mínimo por cerdo: carga el valor actual y permite ajustarlo. */
function initMinKg() {
  const inp = $('minKgInput'), btn = $('bMinKgSave'), res = $('minKgResult');
  if (!inp || !btn || inp.dataset.wired) return;
  inp.dataset.wired = '1';
  apiJson('/api/config/min-kg').then((r) => {
    if (r && r.kg != null && !inp.value) inp.value = r.kg;
  }).catch(() => {});
  btn.onclick = async () => {
    const kg = Number(inp.value);
    if (!(kg > 0)) { if (res) res.textContent = 'Escribe un peso mayor a 0.'; return; }
    btn.disabled = true;
    try {
      const r = await apiJson('/api/config/min-kg', { method: 'POST', body: { kg } });
      if (res) res.textContent = '✓ Listo: se contarán cerdos desde ' + (r?.kg ?? kg) + ' kg.';
    } catch (e) {
      if (res) res.textContent = 'No se pudo guardar. Intenta de nuevo.';
    } finally {
      btn.disabled = false;
    }
  };
}

/* 🎚 Ajustes finos de pesaje: tiempo estable, sin repesaje, banda de tolerancia.
   El motor guarda min_stable_ms (ms) y la banda como fracción; la UI la muestra
   en segundos y en porcentaje para que sea fácil de entender. */
function initTuning() {
  const stableS = $('tuneStableS'), retZero = $('tuneReturnZero');
  const bLow = $('tuneBandLow'), bHigh = $('tuneBandHigh');
  const btn = $('bTuneSave'), res = $('tuneResult');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  apiJson('/api/config/engine').then((r) => {
    if (!r) return;
    if (stableS && r.min_stable_ms != null) stableS.value = (r.min_stable_ms / 1000);
    if (retZero && r.unit_return_to_zero != null) retZero.checked = !!r.unit_return_to_zero;
    if (bLow && r.band_low != null) bLow.value = Math.round(r.band_low * 100);
    if (bHigh && r.band_high != null) bHigh.value = Math.round(r.band_high * 100);
  }).catch(() => {});
  btn.onclick = async () => {
    const body = {};
    const s = Number(stableS?.value);
    if (isFinite(s) && s >= 0) body.min_stable_ms = Math.round(s * 1000);
    if (retZero) body.unit_return_to_zero = !!retZero.checked;
    const lo = Number(bLow?.value);
    if (isFinite(lo) && lo > 0 && lo <= 100) body.band_low = lo / 100;
    const hi = Number(bHigh?.value);
    if (isFinite(hi) && hi >= 100) body.band_high = hi / 100;
    btn.disabled = true;
    try {
      await apiJson('/api/config/engine', { method: 'POST', body });
      if (res) res.textContent = '✓ Ajustes guardados.';
    } catch (e) {
      if (res) res.textContent = 'No se pudo guardar. Revisa los valores.';
    } finally {
      btn.disabled = false;
    }
  };
}

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
  // el panel de recuperación (emparejar / BLE) solo lo puebla bccConnect tras
  // un fallo; cualquier re-render limpio de la tarjeta lo oculta.
  const rec = $('ccRecover');
  if (rec && !msg?.keepRecover) { rec.hidden = true; rec.innerHTML = ''; }
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
  // El enlace se cayó y el driver reintenta (SPP intermitente en campo): estado
  // HONESTO en ámbar. Tiene PRECEDENCIA sobre "fresh" para NUNCA quedar en
  // verde mintiendo mientras no lleguen datos de verdad.
  const reconnecting = !!st?.reconnecting;
  const ts = st?.last_ts_ms != null ? parseTs(st.last_ts_ms) : null;
  const fresh = (APP.lastReadingAt && Date.now() - APP.lastReadingAt < CC_FRESH_MS)
    || (ts != null && Date.now() - ts < CC_FRESH_MS);
  if (connected && reconnecting) {
    chip.className = 'chip warn';
    chip.textContent = 'Reconectando…';
  } else if (connected && fresh && st?.last_kg != null) {
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
  // "Ver datos crudos" solo tiene sentido con la báscula conectada
  const mon = $('bccMonitor');
  if (mon) mon.hidden = !connected;
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
// "Cambiar de báscula" = OLVIDAR la guardada de verdad (antes solo abría el
// asistente y la anterior —p. ej. una "BOLUTEK" de pruebas— seguía apareciendo
// como recordada). Se corta el enlace y se borra la config guardada.
$('bccChange').onclick = async () => {
  try { await apiJson('/api/scale/disconnect', { method: 'POST', body: {} }); } catch { /* sin enlace */ }
  APP.scaleConnected = false;
  APP.simActive = false;
  clearCfg();
  openWizard();
};

$('bccDisconnect').onclick = async () => {
  const b = $('bccDisconnect');
  b.disabled = true;
  try {
    await apiJson('/api/scale/disconnect', { method: 'POST', body: {} });
    APP.scaleConnected = false;
    APP.simActive = false;
    APP.lastReadingAt = 0;
    closeRawMon(); // el monitor de datos crudos ya no aplica sin enlace
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
  } catch (e) {
    showBasculaHome({
      cls: 'fail', keepRecover: true,
      text: e?.message || 'No pude conectar. Revisa que la báscula esté encendida, o toca «Emparejar e intentar de nuevo».',
    });
    renderCardRecover(loadCfg(), gattTextFrom(e));
  } finally {
    b.disabled = false;
  }
};

/* 🔎 DIAGNÓSTICO GATT: cuando un connect BLE no encuentra una característica
   UART usable, el backend devuelve la lista de servicios/características del
   módulo (UUID + propiedades). La mostramos en un bloque COPIABLE para que, si
   el módulo usa un perfil raro, el técnico nos envíe el UUID exacto. */
function renderGattDiag(container, gattText) {
  if (!container || !gattText) return false;
  const box = document.createElement('div');
  box.className = 'gatt-diag';
  const title = document.createElement('div');
  title.className = 'gatt-diag-title';
  title.textContent = '🔎 Detalle técnico del módulo — envíaselo a soporte';
  const pre = document.createElement('pre');
  pre.className = 'gatt-diag-pre mono';
  pre.textContent = gattText;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn-link gatt-diag-copy';
  copy.textContent = '📋 Copiar';
  copy.onclick = async () => {
    let done = false;
    try { await navigator.clipboard.writeText(gattText); done = true; } catch { done = false; }
    if (!done) {
      // respaldo sin permiso de portapapeles: selecciona el texto para copiar a mano
      try {
        const r = document.createRange(); r.selectNodeContents(pre);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      } catch { /* nada más que hacer */ }
    }
    copy.textContent = done ? '✓ Copiado' : 'Selecciona y copia';
    setTimeout(() => { copy.textContent = '📋 Copiar'; }, 2500);
  };
  box.appendChild(title);
  box.appendChild(pre);
  box.appendChild(copy);
  container.appendChild(box);
  return true;
}

/* extrae el texto de diagnóstico GATT de un error de connect (api()/apiJson()
   adjuntan el cuerpo del backend a e.body) o de una respuesta ya parseada */
function gattTextFrom(x) {
  const b = x?.body ?? x;
  return b?.gatt_text ?? null;
}

/* botones de RECUPERACIÓN en la tarjeta ⚙ Báscula tras un fallo de reconexión:
   - 🔗 Emparejar e intentar de nuevo: re-dispara connectFromCfg; el nativo
     AUTO-EMPAREJA el módulo clásico antes del SPP (fallo típico "read ret: -1").
   - Probar como BLE: SIEMPRE (en la app), porque un módulo "clásico/cercano"
     que en realidad es BLE debe poder forzarse — reconecta por el transporte
     BLE (GATT-notify) a la MISMA MAC.
   - Si el intento BLE devolvió el diagnóstico GATT, se muestra copiable. */
function renderCardRecover(cfg, gattText) {
  const rec = $('ccRecover');
  if (!rec) return;
  rec.innerHTML = '';
  rec.hidden = false;

  const bPair = document.createElement('button');
  bPair.className = 'btn-primary';
  bPair.textContent = cfg?.transport === 'ble'
    ? '↻ Intentar de nuevo'
    : '🔗 Emparejar e intentar de nuevo';
  bPair.onclick = () => { $('bccConnect').click(); };
  rec.appendChild(bPair);

  // "Probar como BLE" disponible para CUALQUIER dispositivo en la app (no solo
  // dual-mode): el módulo RS232-BLE de campo llega etiquetado "clásico".
  if (SHIM && cfg?.transport !== 'ble') {
    const bBle = document.createElement('button');
    bBle.textContent = 'Probar como BLE';
    bBle.onclick = async () => {
      bBle.disabled = true;
      try {
        await connectFromCfg({ ...cfg, transport: 'ble', kind: 'ble' });
        showBasculaHome({ cls: 'ok', text: '✓ Conectada por BLE — esperando la primera lectura…' });
      } catch (e) {
        showBasculaHome({
          cls: 'fail', keepRecover: true,
          text: e?.message || 'Tampoco pude por BLE. Acerca y enciende el módulo, o toca «Cambiar de báscula».',
        });
        renderCardRecover(cfg, gattTextFrom(e));
      } finally {
        bBle.disabled = false;
      }
    };
    rec.appendChild(bBle);
  }

  renderGattDiag(rec, gattText);
}

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
      <p class="wizhelp">¿No aparece? Si el módulo es <b>Clásico</b>, empáralo primero en
        <b>Ajustes → Bluetooth</b> (PIN <b>1234</b>). Si es <b>BLE</b> no se empareja: basta
        <b>acercarlo</b> y encenderlo. Luego vuelve a buscar.</p>
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
      <label class="revtoggle bletoggle">
        <input type="checkbox" id="bleToggle"${WIZ.btKind === 'ble' ? ' checked' : ''}>
        <span>📡 Conectar por BLE (GATT) <small>(módulos BLE / RS232-BLE que no se emparejan; escribe o elige la MAC arriba)</small></span>
      </label>
      <p class="wizhelp">¿No aparece? Empareja primero el módulo en <b>Ajustes → Bluetooth</b>
        (PIN <b>1234</b>) y vuelve a buscar. Si es un módulo <b>BLE</b> (no se empareja),
        marca <b>«Conectar por BLE (GATT)»</b>.</p>
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
    bindBleToggle();
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

/* ---- 📡 Conectar por BLE (GATT) (Ajustes avanzados): fuerza el transporte
   BLE a la MAC escrita/elegida, aunque el scan etiquetara el módulo "clásico".
   Un módulo RS232-BLE que no se empareja SOLO conecta por aquí. ---- */
function bindBleToggle() {
  const t = $('bleToggle');
  if (!t) return;
  t.onchange = () => { WIZ.btKind = t.checked ? 'ble' : 'classic'; };
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
    // recordar el TIPO para enrutar el transporte del connect avanzado
    WIZ.btKind = dev.kind === 'ble' ? 'ble' : 'classic';
    WIZ.alsoBle = !!dev.alsoBle; // dual-mode → habilita el fallback a BLE
    // refleja el TIPO en la casilla "Conectar por BLE (GATT)" (override manual)
    const bleT = $('bleToggle');
    if (bleT) bleT.checked = WIZ.btKind === 'ble';
    // BLE no se empareja (se acerca); el aviso de emparejar es solo para clásico
    if (!dev.paired && dev.kind !== 'ble') {
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
    // TIPO de enlace: 'ble' (GATT-notify) o 'classic' (SPP). El badge se lo
    // dice al usuario y el kind viaja al backend para enrutar el transporte.
    const kind = dev?.kind === 'ble' ? 'ble' : 'classic';
    const kindLabel = kind === 'ble' ? 'BLE' : 'Clásico';
    const b = document.createElement('button');
    b.className = 'bt-item';
    b.innerHTML = `<span class="bt-n">${escapeHtml(dev?.name || `Dispositivo BT (${dev?.address ?? ''})`)}</span>` +
      `<span class="bt-a mono">${escapeHtml(dev?.address ?? '')}</span>` +
      `<span class="bt-kind ${kind}">${kindLabel}</span>` +
      `<span class="bt-badge ${dev?.paired ? 'paired' : ''}">${dev?.paired ? 'emparejado' : 'cercano'}</span>`;
    b.onclick = () => {
      for (const x of list.querySelectorAll('.bt-item')) x.classList.toggle('sel', x === b);
      // alsoBle (dual-mode): habilita el fallback y el botón "Probar como BLE"
      onPick({ name: dev?.name || '', address: dev?.address ?? '', paired: !!dev?.paired, kind, alsoBle: !!dev?.alsoBle });
    };
    list.appendChild(b);
  }
}

/* aviso accionable: Ubicación del sistema apagada y/o permiso de Ubicación
   sin conceder. En Android 6–11 son OBLIGATORIOS para ver cualquier
   dispositivo Bluetooth; `diag` (de /api/bt/diagnose) afina el texto. */
function btLocationWarning(list, diag) {
  const warn = document.createElement('div');
  warn.className = 'empty';
  const old = diag && diag.android_sdk < 31;
  const noPerm = diag && diag.location_permission === false;
  const off = !diag || diag.location_enabled === false;
  let txt = old
    ? `📍 Este teléfono es <b>Android antiguo</b> (nivel ${diag.android_sdk}): para ver dispositivos Bluetooth Android exige `
    : '📍 En <b>Xiaomi/MIUI (Android 12/13)</b> la búsqueda BLE llega <b>vacía y sin aviso</b> si falta ';
  const partes = [];
  if (off) partes.push('la <b>Ubicación encendida</b>');
  if (noPerm) partes.push('el <b>permiso de Ubicación</b> para PorciPeso');
  txt += (partes.length ? partes.join(' y ') : 'la <b>Ubicación encendida</b>') + ' — arréglalo y vuelve a buscar. ';
  warn.innerHTML = txt;
  warn.appendChild(document.createElement('br'));
  if (off) {
    const b = document.createElement('button');
    b.className = 'btn-primary';
    b.textContent = '📍 Activar ubicación';
    b.onclick = () => { apiJson('/api/bt/location/open', { method: 'POST', body: {} }).catch(() => {}); };
    warn.appendChild(b);
  }
  if (noPerm) {
    const p = document.createElement('button');
    p.className = 'btn-link';
    p.textContent = '⚙ Dar permiso de Ubicación';
    p.onclick = () => { apiJson('/api/bt/app-settings/open', { method: 'POST', body: {} }).catch(() => {}); };
    warn.appendChild(p);
  }
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

  // 0) Android < 12 (teléfonos viejos): el sistema NO entrega NINGÚN dispositivo
  // (clásico ni BLE) sin Ubicación ENCENDIDA + permiso de Ubicación. Avisar
  // ANTES de que la lista salga vacía, con los botones para arreglarlo.
  let diag = null;
  try { diag = (await apiJson('/api/bt/diagnose'))?.diagnosis ?? null; } catch { diag = null; }
  if (dead()) return;
  // En Android 12/13 (Xiaomi/MIUI) el scan BLE llega VACÍO y SIN ERROR si la app
  // no tiene Ubicación → hay que avisar igual, no solo en Android < 12.
  if (diag && (diag.location_enabled === false || diag.location_permission === false)) {
    btLocationWarning(list, diag);
  }

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
  let lastBleError = null; // motivo del fallo del scan BLE (Android 6–11: Ubicación)
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
    if (d?.ble_error) lastBleError = d.ble_error;
    if (d?.finished) break;
  }
  if (dead()) return;
  spin.remove();
  finishBtScan(list, merged, btn, lastBleError);
}

function finishBtScan(list, devices, btn, bleError) {
  if (btn) btn.disabled = false;
  const cercanos = devices.filter(d => !d.paired).length;
  if (!devices.length) {
    list.innerHTML = '<div class="empty">No encontré dispositivos. Si es <b>Clásico</b>: empárejalo en Ajustes → Bluetooth (PIN 1234). Si es <b>BLE</b>: no se empareja — basta acercarlo y encenderlo. Luego toca «Buscar de nuevo».</div>';
  } else if (!cercanos) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.innerHTML = 'No aparecieron cercanos nuevos. Si el tuyo no está: empareja el módulo <b>Clásico</b> en Ajustes → Bluetooth (PIN 1234), o acerca y enciende el módulo <b>BLE</b>, y vuelve a buscar.';
    list.appendChild(note);
  }
  // El scan BLE FALLÓ (antes se tragaba en silencio): como el módulo de la
  // báscula es BLE, sin este scan nunca aparece. Di el motivo y da los botones.
  if (bleError && !devices.some(d => d.kind === 'ble')) {
    const w = document.createElement('div');
    w.className = 'empty';
    const t = document.createElement('div');
    t.textContent = '📡 No pude escanear por BLE (así se ve la báscula): ' + bleError;
    w.appendChild(t);
    const row = document.createElement('div');
    row.style.marginTop = '8px';
    for (const a of btFailActions()) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn-link'; b.textContent = a.label; b.onclick = a.onclick;
      row.appendChild(b);
    }
    w.appendChild(row);
    list.appendChild(w);
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
  // TIPO de enlace del dispositivo tocado: 'ble' → transporte BLE (GATT-notify),
  // 'classic' → SPP clásico. El detector y el connect corren IGUAL encima.
  const transport = dev.kind === 'ble' ? 'ble' : 'bluetooth';
  const tipoTxt = dev.kind === 'ble' ? 'BLE' : 'Bluetooth';
  // ORDEN de intentos: un módulo NO emparejado ("cercano") casi siempre es BLE
  // (un clásico que funciona aparece "emparejado") → BLE primero y el clásico
  // lento de respaldo. Emparejado → clásico primero, BLE de respaldo.
  const prefer = (dev.kind === 'ble' || !dev.paired) ? 'ble' : 'bluetooth';
  btScanSeq++; // congela el escaneo en vivo (el connect nativo cancela el discovery)
  showHexPanel(true);
  if (status) status.innerHTML = `🎧 Escuchando <b>${escapeHtml(dev.name || dev.address)}</b>… ` +
    'detecto la marca y la señal (unos segundos)';
  $('testResult').className = 'test-result';
  let r = null;
  try {
    r = await apiJson('/api/scale/detect', {
      method: 'POST',
      body: {
        profile_id: 'auto', transport, port: dev.address, prefer,
        // nombre anunciado: el módulo BLE dual-mode puede anunciar con OTRA
        // dirección; el backend lo busca por nombre y conecta a esa.
        name: dev.name || '',
        // módulo BLE / no emparejado: sin el minuto inútil de clásico —
        // si BLE falla, que diga el motivo de inmediato.
        no_fallback: prefer === 'ble',
      },
    });
  } catch (e) {
    showHexPanel(false);
    if (status) status.textContent = '';
    wizResult('fail', e?.message ?? 'No pude escuchar la báscula.', btFailActions());
    btAutoRetry(dev);
    return;
  }
  showHexPanel(false);
  if (r?.ok && r?.parser_ok && r?.parser) {
    // El detector pudo caer a BLE (módulo BLE listado como "clásico"): conecta
    // directo por BLE, sin repetir el intento clásico lento.
    const connectTransport = r?.used_transport || (r?.fell_back_ble ? 'ble' : transport);
    let cr = null;
    try {
      cr = await api('/api/scale/connect', {
        method: 'POST',
        body: {
          profile_id: 'auto', parser: r.parser, transport: connectTransport,
          port: dev.address, invert_bits: !!r.invert_bits,
          reverse_frame: !!r.reverse_frame,
          // dual-mode: si el SPP clásico no conecta, el backend cae a BLE solo
          also_ble: true,
        },
      });
    } catch (e) {
      if (status) status.textContent = '';
      wizResult('fail', e?.message || 'La detecté pero no pude dejarla conectada — intenta de nuevo.', btFailActions());
      btAutoRetry(dev, gattTextFrom(e));
      return;
    }
    APP.scaleConnected = true;
    APP.simActive = false;
    // el backend pudo caer a BLE (dual-mode) si el clásico no respondió: se
    // guarda el transporte que REALMENTE quedó, para reconectar directo a él.
    const finalTransport = cr?.transport === 'ble' ? 'ble' : (cr?.transport === 'usb' ? 'usb' : transport);
    const finalKind = finalTransport === 'ble' ? 'ble' : 'classic';
    const finalTipo = finalTransport === 'ble' ? 'BLE' : 'Bluetooth';
    // el parser, la polaridad y el TIPO de enlace quedan guardados: la próxima
    // vez la app conecta directo, sin volver a detectar (transport enruta BLE/SPP)
    saveCfg({
      method: 'bluetooth', transport: finalTransport, kind: finalKind,
      alsoBle: !!dev.alsoBle,
      profile_id: 'auto', parser: r.parser,
      invert_bits: !!r.invert_bits, reverse_frame: !!r.reverse_frame,
      port: dev.address, signal: 'auto',
      name: `Báscula ${finalTipo} (${dev.name || dev.address})`,
    });
    if (status) status.textContent = '';
    const fixes = [];
    if (cr?.fell_back) fixes.push('conecté por BLE porque el clásico no respondió');
    if (r.invert_bits) fixes.push('señal invertida corregida sola');
    if (r.reverse_frame) fixes.push('números al revés corregidos solos');
    const kgTxt = r.kg != null ? `la báscula responde: ${fmt(r.kg)} kg` : 'la báscula responde';
    // aterriza en la tarjeta de estado: chip verde + Desconectar a la vista
    showBasculaHome({ cls: 'ok', text: `✓ Conectada — ${kgTxt}${fixes.length ? ` (${fixes.join(' y ')})` : ''}. ¡Ya puedes ir a Pesaje!` });
  } else {
    if (status) status.textContent = '';
    // ¿Llegaron bytes aunque el detector no clasifique? → deja de adivinar:
    // ofrece VER los datos crudos y conectar igual (RS232/485 de campo).
    const hasBytes = (r?.bytes_recibidos ?? 0) > 0 || !!(r?.hex && r.hex.length);
    const msg = hasBytes
      ? 'Recibo datos del módulo pero no reconozco la marca. Puedes verlos y conectar igual — luego ajustas 🔁 / ⚡ o la marca.'
      : (r?.ok && !r?.parser_ok)
        ? 'Recibo datos pero no los entiendo — puede ser la velocidad del módulo (se cambia con comandos AT) o un modelo que aún no conozco.'
        : (r?.message ?? 'No reconocí la báscula.');
    wizResult(hasBytes ? '' : 'fail', msg);
    btAutoRetry(dev, null, { canConnectAnyway: hasBytes });
  }
}

/* tras un fallo: botones de RECUPERACIÓN accionables (mismo dispositivo).
   - 🔗 Emparejar e intentar de nuevo: re-dispara el connect; el nativo
     AUTO-EMPAREJA (createBond) antes del SPP — el fallo típico de campo
     ("read ret: -1") es justo un módulo clásico sin emparejar.
   - Probar como BLE: SIEMPRE (en la app), aunque el scan lo etiquetara
     "clásico"/"cercano" — el módulo RS232-BLE de campo llega así y debe poder
     forzarse por el transporte BLE (GATT-notify) a la misma MAC.
   - Si el intento BLE devolvió el diagnóstico GATT, se muestra copiable.
   "Ajustes avanzados" ya está en pantalla para forzar marca/señal a mano. */
function btAutoRetry(dev, gattText, opts) {
  const status = $('btAutoStatus');
  if (!status || !status.isConnected) return;
  status.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'bt-recover';

  // 👁 acción PRIMARIA cuando llegan bytes pero el detector no clasifica:
  // conecta igual, muestra el dato crudo y deja voltear/ajustar en vivo.
  if (opts?.canConnectAnyway) {
    const bSee = document.createElement('button');
    bSee.className = 'btn-primary bt-connect-anyway';
    bSee.textContent = '👁 Ver datos y conectar igual';
    bSee.onclick = () => { btAutoConnectAnyway(dev).catch(() => {}); };
    wrap.appendChild(bSee);
  }

  const bPair = document.createElement('button');
  bPair.className = 'btn-primary';
  // BLE no se empareja (se acerca); para el clásico ofrecemos re-emparejar.
  bPair.textContent = dev.kind === 'ble'
    ? `↻ Reintentar con ${dev.name || dev.address}`
    : '🔗 Emparejar e intentar de nuevo';
  bPair.onclick = () => { btAutoConnect(dev).catch(() => {}); };
  wrap.appendChild(bPair);

  // Probar como BLE disponible para CUALQUIER dispositivo en la app.
  if (SHIM && dev.kind !== 'ble') {
    const bBle = document.createElement('button');
    bBle.textContent = 'Probar como BLE';
    bBle.onclick = () => { btAutoConnect({ ...dev, kind: 'ble' }).catch(() => {}); };
    wrap.appendChild(bBle);
  }

  status.appendChild(wrap);
  renderGattDiag(status, gattText);
}

/* 👁 "Ver datos y conectar igual" (Bluetooth): el detector no clasificó la
   trama pero llegan bytes. Conecta en MODO MANUAL con el parser de mejor
   esfuerzo (el backend elige matrix → generic_regex), aterriza en el monitor
   de datos crudos y va a la pantalla de Pesaje. Ahí el usuario ve el dato,
   lo voltea (🔁), invierte la señal (⚡) o cambia la marca — todo EN VIVO. */
async function btAutoConnectAnyway(dev) {
  const status = $('btAutoStatus');
  const transport = dev.kind === 'ble' ? 'ble' : 'bluetooth';
  if (status && status.isConnected) { status.innerHTML = ''; status.textContent = 'Conectando para ver los datos…'; }
  let cr = null;
  try {
    cr = await apiJson('/api/scale/connect', {
      method: 'POST',
      body: {
        profile_id: 'auto', manual: true, transport, port: dev.address,
        also_ble: !!dev.alsoBle, reverse_frame: false, invert_bits: false,
      },
    });
  } catch (e) {
    if (status && status.isConnected) status.textContent = '';
    wizResult('fail', e?.message || 'No pude conectar para ver los datos.');
    btAutoRetry(dev, gattTextFrom(e));
    return;
  }
  APP.scaleConnected = true;
  APP.simActive = false;
  const finalTransport = cr?.transport === 'ble' ? 'ble' : (cr?.transport === 'usb' ? 'usb' : transport);
  const finalKind = finalTransport === 'ble' ? 'ble' : 'classic';
  const parser = cr?.parser || 'matrix';
  // arranque manual guardado (se refina solo al ver el valor con los toggles)
  saveCfg({
    method: 'bluetooth', transport: finalTransport, kind: finalKind, alsoBle: !!dev.alsoBle,
    profile_id: 'auto', parser, reverse_frame: false, invert_bits: false,
    port: dev.address, signal: 'auto', manual: true,
    name: `Báscula ${finalTransport === 'ble' ? 'BLE' : 'Bluetooth'} (${dev.name || dev.address})`,
  });
  if (status && status.isConnected) status.textContent = '';
  openRawMon({
    transport: finalTransport, kind: finalKind, port: dev.address, alsoBle: !!dev.alsoBle,
    parser, reverse: false, invert: false,
  });
  setModule('pesaje'); // "va a la pantalla de pesaje"
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
    const hasBytes = (r?.bytes_recibidos ?? 0) > 0 || !!(r?.hex && r.hex.length);
    const msg = hasBytes
      ? 'Recibo datos del adaptador pero no reconozco la marca. Puedes verlos y conectar igual — luego ajustas 🔁 / ⚡ o la marca.'
      : (r?.ok && !r?.parser_ok)
        ? 'Recibo datos pero no los entiendo — puede ser un modelo que aún no conozco. En «Ajustes avanzados» puedes elegir la marca a mano.'
        : (r?.message ?? 'No reconocí la báscula.');
    wizResult(hasBytes ? '' : 'fail', msg);
    otgAutoRetry(dev, { canConnectAnyway: hasBytes, baud: r?.baudrate ?? null });
  }
}

/* tras un fallo: botón Reintentar (mismo dispositivo); "Ajustes avanzados"
   ya está en pantalla para forzar marca/velocidad a mano. Si llegaron bytes,
   ofrece además "👁 Ver datos y conectar igual" como acción primaria. */
function otgAutoRetry(dev, opts) {
  const status = $('otgAutoStatus');
  if (!status || !status.isConnected) return;
  status.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'bt-recover';
  if (opts?.canConnectAnyway) {
    const bSee = document.createElement('button');
    bSee.className = 'btn-primary bt-connect-anyway';
    bSee.textContent = '👁 Ver datos y conectar igual';
    bSee.onclick = () => { otgAutoConnectAnyway(dev, opts.baud).catch(() => {}); };
    wrap.appendChild(bSee);
  }
  const b = document.createElement('button');
  b.className = 'btn-primary';
  b.textContent = `↻ Reintentar con ${dev.name || 'el adaptador USB'}`;
  b.onclick = () => { otgAutoConnect(dev).catch(() => {}); };
  wrap.appendChild(b);
  status.appendChild(wrap);
}

/* 👁 "Ver datos y conectar igual" (OTG): igual que en Bluetooth pero por USB. */
async function otgAutoConnectAnyway(dev, baud) {
  const status = $('otgAutoStatus');
  if (dev?.deviceId == null) return;
  if (status && status.isConnected) { status.innerHTML = ''; status.textContent = 'Conectando para ver los datos…'; }
  const baudrate = baud || 9600;
  let cr = null;
  try {
    cr = await apiJson('/api/scale/connect', {
      method: 'POST',
      body: {
        profile_id: 'auto', manual: true, transport: 'usb',
        device_id: dev.deviceId, baudrate, reverse_frame: false, invert_bits: false,
      },
    });
  } catch (e) {
    if (status && status.isConnected) status.textContent = '';
    wizResult('fail', e?.message || 'No pude conectar para ver los datos.');
    otgAutoRetry(dev, { canConnectAnyway: true, baud: baudrate });
    return;
  }
  APP.scaleConnected = true;
  APP.simActive = false;
  const parser = cr?.parser || 'matrix';
  saveCfg({
    method: 'otg', profile_id: 'auto', parser, reverse_frame: false, invert_bits: false,
    usb: { vid: dev.vid, pid: dev.pid, name: dev.name ?? '' }, baudrate, signal: 'auto', manual: true,
    name: `Báscula USB (${dev.name || 'OTG'})`,
  });
  if (status && status.isConnected) status.textContent = '';
  openRawMon({
    transport: 'usb', kind: 'usb', usb: { vid: dev.vid, pid: dev.pid, name: dev.name ?? '' },
    deviceId: dev.deviceId, baudrate, parser, reverse: false, invert: false,
  });
  setModule('pesaje');
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
    // TIPO de enlace del dispositivo elegido de la lista (BLE o SPP clásico).
    const transport = WIZ.btKind === 'ble' ? 'ble' : 'bluetooth';
    const body = {
      profile_id: WIZ.profileId, port, transport,
      reverse_frame: WIZ.detected?.reverse_frame ?? WIZ.reverse,
      // dual-mode: habilita el fallback nativo a BLE si el SPP no conecta
      also_ble: !!WIZ.alsoBle,
    };
    const inv = signalInvert();
    if (inv != null) body.invert_bits = inv;
    return {
      ok: true, body, detect: WIZ.signal === 'auto' && !WIZ.detected,
      cfgExtra: {
        port, transport, kind: WIZ.btKind === 'ble' ? 'ble' : 'classic',
        alsoBle: !!WIZ.alsoBle,
        signal: WIZ.signal, reverse_frame: body.reverse_frame,
        ...(inv != null ? { invert_bits: inv } : {}),
      },
    };
  }
  return { ok: true, body: { profile_id: WIZ.profileId, port }, cfgExtra: { port } };
}

function wizResult(cls, text, actions) {
  const res = $('testResult');
  res.className = 'test-result show' + (cls ? ' ' + cls : '');
  res.innerHTML = '';
  const p = document.createElement('div');
  p.style.whiteSpace = 'pre-line';   // respeta los saltos de línea de los avisos
  p.textContent = text;              // texto plano (sin HTML): seguro
  res.appendChild(p);
  if (Array.isArray(actions) && actions.length) {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexWrap = 'wrap';
    row.style.gap = '8px';
    row.style.marginTop = '10px';
    for (const a of actions) {
      if (!a) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-link';
      b.textContent = a.label;
      b.onclick = a.onclick;
      row.appendChild(b);
    }
    res.appendChild(row);
  }
}

/* Acciones de un toque para fallos de Bluetooth (Android 12+): abrir permisos,
   abrir ajustes de Bluetooth y diagnóstico. En desktop degradan sin romper. */
function btFailActions() {
  return [
    { label: '📶 Abrir Bluetooth', onclick: () => openBtDeepLink('/api/bt/settings/open') },
    { label: '⚙ Permisos de la app', onclick: () => openBtDeepLink('/api/bt/app-settings/open') },
    { label: '🔍 Diagnóstico', onclick: runBtDiagnose },
    // Xiaomi/MIUI: el scan BLE puede venir vacío con la Ubicación apagada
    { label: '📍 Encender Ubicación', onclick: () => openBtDeepLink('/api/bt/location/open') },
    // prueba LIMPIA del scan BLE del teléfono: ¿ve el módulo o no? (dato decisivo)
    { label: '🔬 ¿El teléfono ve el módulo?', onclick: runBleProbe },
  ];
}

async function openBtDeepLink(path) {
  try { await api(path, { method: 'POST', body: {} }); }
  catch { say('Eso se abre desde la app del teléfono.', 'alert', 4000); }
}

async function runBtDiagnose() {
  let d = null;
  try { d = (await apiJson('/api/bt/diagnose'))?.diagnosis; }
  catch { /* sin plugin (desktop/web) */ }
  if (!d) { say('El diagnóstico solo está en la app del teléfono.', 'calm', 4000); return; }
  const problems = [];
  if (d.needs_nearby_permission && !d.permission_granted) {
    problems.push('❌ Falta el permiso «Dispositivos cercanos» (tócalo abajo).');
  }
  if (!d.bluetooth_on) problems.push('❌ El Bluetooth está apagado.');
  // Ubicación: OBLIGATORIA en Android 6–11 (nivel < 31) para ver cualquier
  // dispositivo; en 12/13 (Xiaomi) recomendada para el scan BLE.
  const old = d.android_sdk < 31;
  if (d.location_enabled === false) {
    problems.push(old
      ? `❌ La Ubicación del teléfono está APAGADA — en este Android (nivel ${d.android_sdk}) es OBLIGATORIA para ver dispositivos Bluetooth.`
      : '⚠ La Ubicación del teléfono está apagada — en Xiaomi 12/13 el scan BLE puede venir vacío sin ella.');
  }
  if (d.location_permission === false) {
    problems.push(old
      ? '❌ Falta el permiso de Ubicación para PorciPeso (obligatorio en este Android) — tócalo abajo en «Permisos de la app».'
      : '⚠ PorciPeso no tiene permiso de Ubicación — en Xiaomi 12/13 ayuda a que el scan BLE vea el módulo.');
  }
  if (d.paired_count === 0) problems.push('ℹ Ningún módulo emparejado (normal si tu módulo es BLE: no se empareja).');
  const msg = problems.length
    ? 'Diagnóstico Bluetooth:\n' + problems.join('\n')
    : `✓ Bluetooth OK (Android nivel ${d.android_sdk}, permisos concedidos, Ubicación encendida).\n` +
      'Si aún no conecta, el módulo puede estar TOMADO por otro teléfono: apágale el Bluetooth a ese teléfono, o reinicia el módulo (quítale la corriente 5 s).';
  wizResult(problems.length ? 'fail' : 'ok', msg, btFailActions());
}

/* 🔬 Prueba LIMPIA del scan BLE: cancela el clásico y el scan anterior, espera
   y escanea 8 s en baja latencia. Muestra TODO lo que el teléfono ve por BLE.
   Si el módulo NO sale aquí, no es la app: está apagado, tomado por otro
   (la Terminal abierta) o Android bloqueó los scans (5 cada 30 s). */
async function runBleProbe() {
  wizResult('', '🔬 Escaneando por BLE 8 segundos… (deja el módulo encendido y la Terminal CERRADA)');
  let r = null;
  try { r = await apiJson('/api/bt/ble-probe'); }
  catch (e) { wizResult('fail', 'No pude escanear: ' + (e?.message || 'sin plugin BLE (¿desktop?)'), btFailActions()); return; }
  const devs = Array.isArray(r?.devices) ? r.devices : [];
  if (!devs.length) {
    wizResult('fail',
      'El teléfono NO vio ningún dispositivo BLE en 8 s.\n' +
      'Causas reales: módulo apagado/lejos · módulo TOMADO por otro (cierra la Terminal, apaga el BT del otro teléfono, quítale corriente 5 s) · ' +
      'Android bloqueó los scans por reintentos seguidos (espera 30 s) · Ubicación apagada/sin permiso.',
      btFailActions());
    return;
  }
  const lines = devs.map(d => {
    const n = d.name || 'Dispositivo BT';
    const hit = /rs232|485|bt24|ble|hm|uart|serial/i.test(n) ? ' ⬅ parece el módulo' : '';
    return `• ${n}  (${d.address})${hit}`;
  });
  const found = devs.some(d => /rs232|485|bt24/i.test(d.name || ''));
  wizResult(found ? 'ok' : '',
    `El teléfono SÍ ve ${devs.length} dispositivo(s) por BLE:\n` + lines.join('\n') +
    (found ? '\n\n✓ El módulo se ve. Toca "Reintentar": ahora conecto directo sin volver a escanear.' :
             '\n\n⚠ El módulo NO está entre ellos: apagado, lejos, o tomado por otro (Terminal/otro teléfono).'),
    btFailActions());
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
  else if (m.type === 'detect_phase') onDetectPhase(m);
}

/* Fases del detector (backend → UI) para que "Escuchando…" NUNCA quede
   congelado: el usuario ve en qué va (clásico / scan BLE / conectando /
   escuchando). Antes el intento clásico podía bloquear ~1 min en silencio. */
const DETECT_PHASE_TXT = {
  classic: '🎧 Probando Bluetooth clásico…',
  ble: '📡 Buscando el módulo por BLE…',
  usb: '🔌 Escuchando por USB…',
  ble_prescan: '📡 Buscando el módulo por BLE (scan)…',
  ble_connect: '🔗 Conectando por BLE…',
  ble_subscribed: '✅ Conectado por BLE — escuchando datos…',
};
function onDetectPhase(m) {
  const status = $('btAutoStatus');
  if (!status || !status.isConnected) return;
  const base = DETECT_PHASE_TXT[m?.phase] || 'Conectando…';
  status.textContent = m?.detail ? `${base} (${m.detail})` : base;
}

/* panel HEX en vivo del detector de señal (wizard, app móvil) */
function onDetectHex(m) {
  const el = $('hexPanel');
  if (!el || el.hidden) return;
  const baud = m?.baud != null ? `@${m.baud} baudios · ` : '';
  el.textContent = baud + String(m?.hex ?? '');
}

/* ============================================================
   👁 MONITOR DE DATOS CRUDOS — deja de adivinar: muestra el stream tal cual
   llega y permite conectar/ajustar aunque el detector no clasifique. Fuente:
   GET /api/scale/raw (hex+texto+bytes_recibidos+muestra_frames). Los toggles
   🔁/⚡ y el selector de marca se aplican EN VIVO reconectando: el usuario ve
   el valor corregirse en el LED de mejor esfuerzo.
   ============================================================ */
const RM = {
  transport: 'bluetooth', kind: 'classic', port: '', alsoBle: false,
  usb: null, deviceId: null, baudrate: null,
  parser: 'matrix', reverse: false, invert: false, poll: null,
};

function openRawMon(opts) {
  Object.assign(RM, opts || {});
  const box = $('rawMon');
  if (!box) return;
  box.hidden = false;
  $('rmReverse').checked = !!RM.reverse;
  $('rmInvert').checked = !!RM.invert;
  $('rmParser').value = RM.parser || 'matrix';
  const led = $('rmLed'); if (led) led.textContent = '—';
  const st = $('rmStatus'); if (st) { st.className = 'rm-status'; st.textContent = 'Escuchando el módulo…'; }
  rmTick().catch(() => {});
  if (RM.poll) clearInterval(RM.poll);
  RM.poll = setInterval(() => { rmTick().catch(() => {}); }, 600);
}

function closeRawMon() {
  const box = $('rawMon');
  if (box) box.hidden = true;
  if (RM.poll) { clearInterval(RM.poll); RM.poll = null; }
}

async function rmTick() {
  if ($('rawMon').hidden) { if (RM.poll) { clearInterval(RM.poll); RM.poll = null; } return; }
  let raw = null, st = null;
  try { raw = await apiJson('/api/scale/raw'); } catch { /* sin backend */ }
  try { st = await api('/api/scale/status'); } catch { /* sin backend */ }
  renderRawMon(raw, st);
}

function renderRawMon(raw, st) {
  const bytes = raw?.bytes_recibidos ?? 0;
  $('rmBytes').textContent = String(bytes);
  $('rmText').textContent = (raw?.text && raw.text.length) ? raw.text : '—';
  $('rmHex').textContent = (raw?.hex && raw.hex.length) ? raw.hex : '—';
  const frames = Array.isArray(raw?.muestra_frames) ? raw.muestra_frames : [];
  $('rmFrames').textContent = frames.length ? frames.join('   ·   ') : '—';
  const kg = st?.last_kg;
  // LED de mejor esfuerzo: si acaba de llegar una lectura por WS, esa manda
  // (trae el string crudo); si no, pinto el último kg del estado.
  const wsFresh = APP.lastReadingAt && Date.now() - APP.lastReadingAt < 1500;
  if (kg != null && !wsFresh) rmSetLed(fmt(kg));
  else if (kg == null && !wsFresh) rmSetLed('—');
  rmUpdateStatus(bytes, kg);
}

function rmSetLed(text) {
  const led = $('rmLed');
  if (!led) return;
  led.textContent = (text == null || text === '') ? '—' : String(text);
  const s = document.createElement('small');
  s.textContent = 'kg';
  led.appendChild(s);
}

function rmUpdateStatus(bytes, kg) {
  const s = $('rmStatus');
  if (!s) return;
  if (!bytes) {
    // enlace vivo pero SIN datos: distinto de "no reconozco la trama"
    s.className = 'rm-status warn';
    s.textContent = '⚠ Conecté al módulo pero no está enviando datos — enciende el indicador o revisa el cable RS232 del módulo.';
    return;
  }
  if (kg == null) {
    s.className = 'rm-status';
    s.textContent = '📡 Llegan datos, pero el modelo no los entiende todavía — prueba 🔁, ⚡ o cambia la marca abajo.';
    return;
  }
  s.className = 'rm-status ok';
  s.textContent = `✓ Leo: ${fmt(kg)} kg — ¿se ve bien? Si está al revés o cambia raro, usa 🔁 / ⚡. Se guarda solo.`;
  rmSaveWorking();
}

/* lectura por WS mientras el monitor está abierto: LED crudo instantáneo */
function rmLiveReading(m, kg) {
  if ($('rawMon').hidden) return;
  rmSetLed(ledText(m, kg));
}

/* aplica 🔁 / ⚡ / marca EN VIVO: reconecta en modo manual con lo elegido */
async function rmReconnect() {
  RM.reverse = $('rmReverse').checked;
  RM.invert = $('rmInvert').checked;
  RM.parser = $('rmParser').value || 'matrix';
  const s = $('rmStatus');
  if (s) { s.className = 'rm-status'; s.textContent = 'Aplicando…'; }
  const body = {
    profile_id: 'auto', parser: RM.parser, manual: true, transport: RM.transport,
    reverse_frame: RM.reverse, invert_bits: RM.invert,
  };
  if (RM.transport === 'usb') {
    let deviceId = RM.deviceId;
    if (deviceId == null && RM.usb) {
      try {
        const devs = await apiJson('/api/usb/devices');
        const arr = Array.isArray(devs) ? devs : (devs?.devices ?? []);
        const match = arr.find(d => d?.vid === RM.usb.vid && d?.pid === RM.usb.pid) ?? arr[0];
        deviceId = match?.deviceId;
      } catch { /* se reporta abajo */ }
    }
    RM.deviceId = deviceId;
    body.device_id = deviceId;
    if (RM.baudrate) body.baudrate = RM.baudrate;
  } else {
    body.port = RM.port;
    if (RM.alsoBle) body.also_ble = true;
  }
  try {
    const cr = await apiJson('/api/scale/connect', { method: 'POST', body });
    APP.scaleConnected = true;
    // el backend pudo caer a BLE: recuerda el transporte que quedó
    if (cr?.transport) RM.transport = cr.transport === 'ble' ? 'ble' : (cr.transport === 'usb' ? 'usb' : 'bluetooth');
    if (cr?.transport === 'ble') RM.kind = 'ble';
    rmTick().catch(() => {});
  } catch (e) {
    if (s) { s.className = 'rm-status fail'; s.textContent = e?.message || 'No pude aplicar el cambio — revisa el módulo.'; }
  }
}

/* guarda lo que quedó FUNCIONANDO (parser + reverse + invert + transporte)
   para reconectar directo la próxima vez, sin volver a detectar. */
function rmSaveWorking() {
  const base = loadCfg() || {};
  const cfg = {
    ...base,
    profile_id: 'auto', parser: RM.parser,
    reverse_frame: RM.reverse, invert_bits: RM.invert,
    signal: RM.invert ? 'inverted' : 'direct', manual: true,
  };
  if (RM.transport === 'usb') {
    cfg.method = 'otg';
    if (RM.usb) cfg.usb = RM.usb;
    if (RM.baudrate) cfg.baudrate = RM.baudrate;
  } else {
    cfg.method = 'bluetooth';
    cfg.transport = RM.transport;
    cfg.kind = RM.transport === 'ble' ? 'ble' : 'classic';
    cfg.port = RM.port;
    cfg.alsoBle = !!RM.alsoBle;
  }
  cfg.name = base.name || (RM.transport === 'usb' ? 'Báscula USB' : 'Báscula Bluetooth');
  saveCfg(cfg);
}

if ($('rmClose')) $('rmClose').onclick = () => closeRawMon();
if ($('rmGoPesaje')) $('rmGoPesaje').onclick = () => { closeRawMon(); setModule('pesaje'); };
if ($('rmReverse')) $('rmReverse').onchange = () => { rmReconnect().catch(() => {}); };
if ($('rmInvert')) $('rmInvert').onchange = () => { rmReconnect().catch(() => {}); };
if ($('rmParser')) $('rmParser').onchange = () => { rmReconnect().catch(() => {}); };

/* ⚙ Báscula → "👁 Ver datos crudos del Bluetooth": abre el monitor para
   diagnosticar CUALQUIER módulo ya conectado (con lo guardado en cfg). */
if ($('bccMonitor')) $('bccMonitor').onclick = () => {
  const cfg = loadCfg() || {};
  const method = migrateMethod(cfg.method);
  const isUsb = method === 'otg' || method === 'cable';
  openRawMon({
    transport: isUsb ? 'usb' : (cfg.transport === 'ble' ? 'ble' : 'bluetooth'),
    kind: cfg.kind || (cfg.transport === 'ble' ? 'ble' : 'classic'),
    port: cfg.port || '', alsoBle: !!cfg.alsoBle,
    usb: cfg.usb || null, deviceId: null, baudrate: cfg.baudrate || null,
    parser: cfg.parser || 'matrix', reverse: !!cfg.reverse_frame, invert: !!cfg.invert_bits,
  });
};

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
   🔑 ACTIVACIÓN POR DISPOSITIVO — licencia offline atada a este equipo
   ------------------------------------------------------------
   Es la protección PRINCIPAL: sin una llave válida la app está bloqueada.
   Funciona sin servidor. El cliente ve un CÓDIGO DE DISPOSITIVO ("PORCI-XXXX-
   XXXX"), se lo dicta al proveedor (Hollman) y este le devuelve una LLAVE DE
   ACTIVACIÓN ("XXXX-XXXX-XXXX-XXXX") que SOLO funciona en este teléfono. La
   llave = base32(HMAC-SHA256(secreto, código)); la app recomputa el HMAC con su
   propio deviceId + el secreto embebido y compara. En otro teléfono el deviceId
   cambia → el código cambia → esa llave no valida.

   MODELO DE SEGURIDAD: candado de CONVENIENCIA, NO DRM militar. El secreto
   maestro (LIC_SECRET) va EMBEBIDO en esta app, así que un experto con el APK
   podría extraerlo y fabricarse llaves. Es suficiente para el mercado objetivo
   (evita la copia casual entre teléfonos y ata la venta a un equipo). Fuente de
   verdad del secreto: ~/porcipeso_secrets/README.md. Si se filtra, se rota ahí
   y aquí (LIC_SECRET) + packaging/emitir_llave.html y se publica versión nueva.
   ============================================================ */

/* ===== INICIO NÚCLEO DE LICENCIA (idéntico a porcipeso/licensing/reference.js
   y a packaging/emitir_llave.html) — SHA-256 + HMAC-SHA256 propios (sin
   crypto.subtle) para funcionar en cualquier contexto, incluido file://. ===== */
const LIC_SECRET = 'fc437ab3333024f51ca8cbb1d323882d3e7d43dcabbe7252748bb4a161b9d40b';
const LIC_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford (sin I,L,O,U)
const LIC_ALPHASET = new Set(LIC_ALPHABET.split(''));
const LIC_AMBIG = { O: '0', I: '1', L: '1' };
const _LIC_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
function _licRotr(x, n) { return (x >>> n) | (x << (32 - n)); }
function _licSha256(msg) {
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
      h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const l = msg.length, withOne = l + 1;
  const k = ((56 - (withOne % 64)) + 64) % 64;
  const total = withOne + k + 8;
  const buf = new Uint8Array(total);
  buf.set(msg, 0); buf[l] = 0x80;
  const bitLen = l * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, bitLen >>> 0, false);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
  const w = new Uint32Array(64);
  let i;
  for (let off = 0; off < total; off += 64) {
    for (i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (i = 16; i < 64; i++) {
      const s0 = _licRotr(w[i-15],7) ^ _licRotr(w[i-15],18) ^ (w[i-15] >>> 3);
      const s1 = _licRotr(w[i-2],17) ^ _licRotr(w[i-2],19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (i = 0; i < 64; i++) {
      const S1 = _licRotr(e,6) ^ _licRotr(e,11) ^ _licRotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + _LIC_K[i] + w[i]) >>> 0;
      const S0 = _licRotr(a,2) ^ _licRotr(a,13) ^ _licRotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h=g; g=f; f=e; e=(d + t1) >>> 0; d=c; c=b; b=a; a=(t1 + t2) >>> 0;
    }
    h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
    h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
  }
  const outb = new Uint8Array(32), ov = new DataView(outb.buffer), hs = [h0,h1,h2,h3,h4,h5,h6,h7];
  for (i = 0; i < 8; i++) ov.setUint32(i*4, hs[i] >>> 0, false);
  return outb;
}
function _licUtf8(str) { return new Uint8Array(new TextEncoder().encode(str)); }
function _licHmac(keyStr, msgStr) {
  let key = _licUtf8(keyStr);
  if (key.length > 64) key = _licSha256(key);
  const kpad = new Uint8Array(64); kpad.set(key, 0);
  const ipad = new Uint8Array(64), opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { ipad[i] = kpad[i] ^ 0x36; opad[i] = kpad[i] ^ 0x5c; }
  const msg = _licUtf8(msgStr);
  const inner = new Uint8Array(64 + msg.length); inner.set(ipad, 0); inner.set(msg, 64);
  const ih = _licSha256(inner);
  const outer = new Uint8Array(96); outer.set(opad, 0); outer.set(ih, 64);
  return _licSha256(outer);
}
function _licB32(bytes, length) {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += LIC_ALPHABET[(value >>> bits) & 31];
      if (out.length >= length) return out;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0 && out.length < length) out += LIC_ALPHABET[(value << (5 - bits)) & 31];
  return out.slice(0, length);
}
function licDeviceCode(deviceId) {
  const p = _licB32(_licSha256(_licUtf8(deviceId || '')), 8);
  return 'PORCI-' + p.slice(0, 4) + '-' + p.slice(4, 8);
}
function licNormalizeDeviceCode(code) {
  let s = (code || '').toUpperCase().replace(/^\s*PORCI[\s-]*/, '');
  s = Array.from(s).map((c) => LIC_AMBIG[c] || c).join('');
  const payload = Array.from(s).filter((c) => LIC_ALPHASET.has(c)).join('').slice(0, 8);
  return 'PORCI-' + payload.slice(0, 4) + '-' + payload.slice(4, 8);
}
function licActivationKeyFromCode(code) {
  const canon = licNormalizeDeviceCode(code);
  const p = _licB32(_licHmac(LIC_SECRET, canon), 16);
  return p.slice(0,4) + '-' + p.slice(4,8) + '-' + p.slice(8,12) + '-' + p.slice(12,16);
}
function licActivationKey(deviceId) { return licActivationKeyFromCode(licDeviceCode(deviceId)); }
function licNormalizeKey(key) {
  let s = (key || '').toUpperCase();
  s = Array.from(s).map((c) => LIC_AMBIG[c] || c).join('');
  return Array.from(s).filter((c) => LIC_ALPHASET.has(c)).join('');
}
/* ===== FIN NÚCLEO DE LICENCIA ===== */

/* expuestas para pruebas (paridad con keygen.py); inofensivo (candado de
   conveniencia). */
try {
  globalThis.PorciLicense = {
    deviceCode: licDeviceCode, activationKey: licActivationKey,
    activationKeyFromCode: licActivationKeyFromCode,
    normalizeDeviceCode: licNormalizeDeviceCode, normalizeKey: licNormalizeKey,
  };
} catch { /* sin globalThis */ }

/* ---------------- estado + almacenamiento de la licencia ---------------- */
const LIC_DEVICE_KEY = 'porcipeso_device';    // deviceId estable (UUID) persistido
const LIC_LICENSE_KEY = 'porcipeso_license';  // {deviceId, key, activated_at}
const LIC_BLOCK_KEY = 'porcipeso_act_block';  // enfriamiento por intentos fallidos
const LIC_MAX_FAILS = 5;
const LIC_COOLDOWN_MS = 15000;

/* FLAG — activación por dispositivo APAGADA por defecto.
   El cliente quiere que la app abra directo (se descarga, se instala y abre
   sin contraseña ni activación). El NÚCLEO de licencia (HMAC, keygen,
   emitir_llave.html) se conserva íntegro para reactivarlo cuando se venda con
   la nube: pon REQUIERE_ACTIVACION=true, o enciéndelo en runtime con
   localStorage.setItem('porcipeso_requiere_activacion','1'). Con el gate
   apagado la pantalla #activationScreen NO aparece y la app arranca normal. */
const REQUIERE_ACTIVACION = false;
const LIC_REQUIRE_KEY = 'porcipeso_requiere_activacion';
function licActivationRequired() {
  try {
    const v = localStorage.getItem(LIC_REQUIRE_KEY);
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
  } catch { /* sin storage: usa la constante */ }
  return REQUIERE_ACTIVACION;
}

let _licDeviceId = null;
let _licCode = null;
let _actFails = 0;
let _actBlockedUntil = 0;
let _actTimer = null;

function _licNewUuid() {
  try { if (globalThis.crypto?.randomUUID) return crypto.randomUUID(); } catch { /* sigue */ }
  const a = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(a);
  else for (let i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
  a[6] = (a[6] & 0x0f) | 0x40; a[8] = (a[8] & 0x3f) | 0x80;
  const h = [...a].map((b) => b.toString(16).padStart(2, '0'));
  return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10,16).join('')}`;
}
function licGetDeviceId() {
  let id = null;
  try { id = localStorage.getItem(LIC_DEVICE_KEY); } catch { id = null; }
  if (!id) {
    id = _licNewUuid();
    try { localStorage.setItem(LIC_DEVICE_KEY, id); } catch { /* sin storage: id efímero */ }
  }
  return id;
}
function licReadLicense() { try { return JSON.parse(localStorage.getItem(LIC_LICENSE_KEY) || 'null'); } catch { return null; } }
function licSaveLicense(obj) { try { localStorage.setItem(LIC_LICENSE_KEY, JSON.stringify(obj)); } catch { /* sin storage */ } }
function licIsActivated(deviceId) {
  const rec = licReadLicense();
  if (!rec || !rec.key || rec.deviceId !== deviceId) return false;
  // re-verifica el HMAC: una licencia manipulada o de otro equipo no pasa
  return licNormalizeKey(rec.key) === licNormalizeKey(licActivationKey(deviceId));
}

/* ---------------- pantalla de activación (#activationScreen) ---------------- */
function _actErr(msg) {
  const el = $('actError');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('show', !!msg);
}
function _actSetBlocked(on) {
  if ($('actKey')) $('actKey').disabled = on;
  if ($('actSubmit')) $('actSubmit').disabled = on;
}
function _actTick() {
  const left = Math.ceil((_actBlockedUntil - Date.now()) / 1000);
  if (left > 0) { _actErr(`Demasiados intentos, espera un momento (${left}s)…`); _actSetBlocked(true); }
  else {
    if (_actTimer) { clearInterval(_actTimer); _actTimer = null; }
    _actFails = 0; _actBlockedUntil = 0;
    try { sessionStorage.removeItem(LIC_BLOCK_KEY); } catch { /* sin storage */ }
    _actSetBlocked(false); _actErr('');
    if ($('actKey')) { try { $('actKey').focus(); } catch { /* ok */ } }
  }
}
function _actRunCooldownTimer() {
  if (_actTimer) clearInterval(_actTimer);
  _actTick();
  if (_actBlockedUntil > Date.now()) _actTimer = setInterval(_actTick, 1000);
}
function _actStartCooldown() {
  _actBlockedUntil = Date.now() + LIC_COOLDOWN_MS;
  try { sessionStorage.setItem(LIC_BLOCK_KEY, String(_actBlockedUntil)); } catch { /* sin storage */ }
  _actRunCooldownTimer();
}

function showActivationScreen(code) {
  document.documentElement.classList.add('is-unactivated');
  if ($('actCode')) $('actCode').textContent = code;
  const inp = $('actKey');
  if (inp) setTimeout(() => { try { inp.focus(); } catch { /* ok */ } }, 60);
}
function hideActivationScreen() { document.documentElement.classList.remove('is-unactivated'); }

function _actCopyCode(btnId) {
  const btn = $(btnId);
  const done = () => { if (btn) { const t = btn.textContent; btn.textContent = 'Copiado ✓'; setTimeout(() => { btn.textContent = t; }, 1600); } };
  const txt = _licCode || '';
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(txt).then(done, () => _actLegacyCopy(txt, done));
  else _actLegacyCopy(txt, done);
}
function _actLegacyCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta); done();
  } catch { /* no se pudo copiar; el cliente lo puede escribir a mano */ }
}

function _actTrySubmit() {
  if (Date.now() < _actBlockedUntil) return;          // en enfriamiento
  const inp = $('actKey');
  const entered = inp ? inp.value : '';
  if (!licNormalizeKey(entered)) { _actErr('Escribe la llave que te dio tu proveedor.'); return; }
  const ok = licNormalizeKey(entered) === licNormalizeKey(licActivationKey(_licDeviceId));
  if (ok) {
    _actFails = 0;
    try { sessionStorage.removeItem(LIC_BLOCK_KEY); } catch { /* sin storage */ }
    licSaveLicense({ deviceId: _licDeviceId, key: licActivationKey(_licDeviceId), activated_at: Date.now() });
    _actErr('');
    if (inp) inp.value = '';
    hideActivationScreen();
    // tras activar, aplica el candado de contraseña OPCIONAL si el dueño lo dejó puesto
    initLock();
    try { refreshLicBox(); } catch { /* la sección puede no estar montada aún */ }
  } else {
    _actFails++;
    if (inp) { inp.value = ''; try { inp.focus(); } catch { /* ok */ } }
    if (_actFails >= LIC_MAX_FAILS) _actStartCooldown();
    else {
      const left = LIC_MAX_FAILS - _actFails;
      _actErr(`Esa llave no es válida para este equipo. Te queda${left === 1 ? '' : 'n'} ${left} intento${left === 1 ? '' : 's'}.`);
    }
  }
}

function initActivation() {
  _licDeviceId = licGetDeviceId();
  _licCode = licDeviceCode(_licDeviceId);
  if ($('actCode')) $('actCode').textContent = _licCode;

  const form = $('actForm');
  if (form && !form.dataset.wired) {
    form.dataset.wired = '1';
    form.addEventListener('submit', (e) => { e.preventDefault(); _actTrySubmit(); });
  }
  if ($('actCopy') && !$('actCopy').dataset.wired) {
    $('actCopy').dataset.wired = '1';
    $('actCopy').addEventListener('click', () => _actCopyCode('actCopy'));
  }

  // GATE APAGADO por defecto: la app abre directo, sin pantalla de activación.
  // (El formulario ya quedó cableado arriba por si se reactiva con la nube.)
  if (!licActivationRequired()) { hideActivationScreen(); return true; }

  const activated = licIsActivated(_licDeviceId);
  if (activated) { hideActivationScreen(); return true; }

  // reanudar enfriamiento si veníamos bloqueados (recarga durante el bloqueo)
  let until = 0; try { until = Number(sessionStorage.getItem(LIC_BLOCK_KEY)) || 0; } catch { until = 0; }
  if (until > Date.now()) { _actFails = LIC_MAX_FAILS; _actBlockedUntil = until; _actRunCooldownTimer(); }
  showActivationScreen(_licCode);
  return false;
}

/* estado de licencia dentro de ⚙ Báscula → 🔒 Seguridad */
function refreshLicBox() {
  if ($('licDeviceCode')) $('licDeviceCode').textContent = _licCode || licDeviceCode(licGetDeviceId());
  if ($('licEstado')) {
    $('licEstado').innerHTML = licIsActivated(_licDeviceId || licGetDeviceId())
      ? '✅ <b>Activado</b> en este dispositivo (licencia permanente).'
      : '⚠️ <b>Sin activar.</b>';
  }
  if ($('bLicCopy') && !$('bLicCopy').dataset.wired) {
    $('bLicCopy').dataset.wired = '1';
    $('bLicCopy').addEventListener('click', () => _actCopyCode('bLicCopy'));
  }
}

/* ============================================================
   🔒 CANDADO DE ACCESO — candado LOCAL de conveniencia
   ------------------------------------------------------------
   Opcional y APAGADO por defecto: sin contraseña la app abre normal.
   Cuando el dueño configura una (⚙ Báscula → 🔒 Seguridad), la app pide
   la contraseña al abrir (pantalla de bloqueo #lockScreen).

   MODELO DE SEGURIDAD: es un candado de CONVENIENCIA local, NO cifra los
   datos guardados. Guardamos SOLO {salt, hash} en localStorage (clave
   'porcipeso_lock'); nunca la contraseña en claro. hash = SHA-256(salt+':'+pw)
   vía Web Crypto (crypto.subtle); si no hay contexto seguro para Web Crypto,
   degrada a un hash no-criptográfico (basta para este propósito). La sesión
   desbloqueada se marca en sessionStorage ('porcipeso_unlocked') para no
   re-pedir en cada navegación, pero SÍ al reabrir la app. Sirve para evitar
   el uso no autorizado del dispositivo del cliente, no para proteger datos
   frente a un atacante con acceso al almacenamiento.
   ============================================================ */
const LOCK_KEY = 'porcipeso_lock';
const LOCK_SESSION_KEY = 'porcipeso_unlocked';
const LOCK_BLOCK_KEY = 'porcipeso_lock_block';
const LOCK_MAX_FAILS = 5;
const LOCK_COOLDOWN_MS = 15000;

function lockRead() { try { return JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); } catch { return null; } }
function lockConfigured() { return !!lockRead(); }
function lockIsUnlocked() { try { return sessionStorage.getItem(LOCK_SESSION_KEY) === '1'; } catch { return false; } }
function lockMarkUnlocked() { try { sessionStorage.setItem(LOCK_SESSION_KEY, '1'); } catch { /* sin storage */ } }
function lockClear() { try { localStorage.removeItem(LOCK_KEY); } catch { /* sin storage */ } }

function _lockRandHex(nBytes) {
  const a = new Uint8Array(nBytes);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(a);
  else for (let i = 0; i < nBytes; i++) a[i] = Math.floor(Math.random() * 256);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
const _lockAlg = () => (globalThis.crypto?.subtle?.digest ? 'sha256' : 'fallback');

async function _lockDigest(str, alg) {
  if (alg === 'sha256' && globalThis.crypto?.subtle?.digest) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback SIN Web Crypto (contexto no seguro): hash no criptográfico
  // (xxhash-ish). Suficiente para un candado de conveniencia local.
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

async function lockSetPassword(pw) {
  const salt = _lockRandHex(16);
  const alg = _lockAlg();
  const hash = await _lockDigest(salt + ':' + pw, alg);
  try { localStorage.setItem(LOCK_KEY, JSON.stringify({ v: 1, alg, salt, hash })); } catch { /* sin storage */ }
}
async function lockVerify(pw) {
  const rec = lockRead();
  if (!rec) return false;
  const hash = await _lockDigest((rec.salt || '') + ':' + pw, rec.alg || 'sha256');
  return hash === rec.hash;
}

/* ---------------- pantalla de bloqueo (#lockScreen) ---------------- */
let _lockFails = 0;
let _lockBlockedUntil = 0;
let _lockTimer = null;

function _lockErr(msg) {
  const el = $('lockError');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('show', !!msg);
}
function _lockSetBlocked(on) {
  if ($('lockPass')) $('lockPass').disabled = on;
  if ($('lockSubmit')) $('lockSubmit').disabled = on;
}
function _lockTick() {
  const left = Math.ceil((_lockBlockedUntil - Date.now()) / 1000);
  if (left > 0) {
    _lockErr(`Demasiados intentos, espera un momento (${left}s)…`);
    _lockSetBlocked(true);
  } else {
    if (_lockTimer) { clearInterval(_lockTimer); _lockTimer = null; }
    _lockFails = 0; _lockBlockedUntil = 0;
    try { sessionStorage.removeItem(LOCK_BLOCK_KEY); } catch { /* sin storage */ }
    _lockSetBlocked(false); _lockErr('');
    if ($('lockPass')) $('lockPass').focus();
  }
}
function _lockRunCooldownTimer() {
  if (_lockTimer) clearInterval(_lockTimer);
  _lockTick();
  if (_lockBlockedUntil > Date.now()) _lockTimer = setInterval(_lockTick, 1000);
}
function _lockStartCooldown() {
  _lockBlockedUntil = Date.now() + LOCK_COOLDOWN_MS;
  try { sessionStorage.setItem(LOCK_BLOCK_KEY, String(_lockBlockedUntil)); } catch { /* sin storage */ }
  _lockRunCooldownTimer();
}

function showLockScreen() {
  document.documentElement.classList.add('is-locked');
  const inp = $('lockPass');
  if (inp) { inp.value = ''; setTimeout(() => { try { inp.focus(); } catch { /* ok */ } }, 60); }
}
function hideLockScreen() { document.documentElement.classList.remove('is-locked'); }

async function _lockTrySubmit() {
  if (Date.now() < _lockBlockedUntil) return;          // en enfriamiento
  const inp = $('lockPass');
  const pw = inp ? inp.value : '';
  if (!pw) { _lockErr('Escribe tu contraseña.'); return; }
  let ok = false;
  try { ok = await lockVerify(pw); } catch { ok = false; }
  if (ok) {
    _lockFails = 0;
    try { sessionStorage.removeItem(LOCK_BLOCK_KEY); } catch { /* sin storage */ }
    lockMarkUnlocked();
    _lockErr('');
    if (inp) inp.value = '';
    hideLockScreen();
  } else {
    _lockFails++;
    if (inp) { inp.value = ''; inp.focus(); }
    if (_lockFails >= LOCK_MAX_FAILS) _lockStartCooldown();
    else {
      const left = LOCK_MAX_FAILS - _lockFails;
      _lockErr(`Contraseña incorrecta. Te queda${left === 1 ? '' : 'n'} ${left} intento${left === 1 ? '' : 's'}.`);
    }
  }
}

function initLock() {
  const form = $('lockForm');
  if (form && !form.dataset.wired) {
    form.dataset.wired = '1';
    form.addEventListener('submit', (e) => { e.preventDefault(); _lockTrySubmit(); });
  }
  if (lockConfigured() && !lockIsUnlocked()) {
    // reanudar el enfriamiento si veníamos bloqueados (recarga durante el bloqueo)
    let until = 0; try { until = Number(sessionStorage.getItem(LOCK_BLOCK_KEY)) || 0; } catch { until = 0; }
    if (until > Date.now()) { _lockFails = LOCK_MAX_FAILS; _lockBlockedUntil = until; _lockRunCooldownTimer(); }
    showLockScreen();
  } else {
    hideLockScreen();
  }
}

/* ---------------- ⚙ Báscula → 🔒 Seguridad (ajustes) ---------------- */
function secResult(cls, text) {
  const res = $('secResult');
  if (!res) return;
  res.className = 'test-result show' + (cls ? ' ' + cls : '');
  res.textContent = text;
}
function _secHideForms() {
  for (const id of ['secSetup', 'secChange', 'secRemove']) { if ($(id)) $(id).hidden = true; }
}
function _secClearInputs() {
  for (const id of ['secNew1', 'secNew2', 'secCurCh', 'secNewCh1', 'secNewCh2', 'secCurRm']) {
    if ($(id)) $(id).value = '';
  }
}
function refreshSecBox() {
  try { refreshLicBox(); } catch { /* sección de licencia opcional */ }
  const has = lockConfigured();
  _secHideForms();
  _secClearInputs();
  if ($('secResult')) { $('secResult').className = 'test-result'; $('secResult').textContent = ''; }
  if ($('secProtegerRow')) $('secProtegerRow').hidden = has;
  if ($('secManage')) $('secManage').hidden = !has;
  if ($('secEstado')) {
    $('secEstado').innerHTML = has
      ? '🔒 La app <b>pide contraseña</b> al abrir en este dispositivo.'
      : 'La app abre <b>sin contraseña</b>. Puedes protegerla para que pida una clave al abrir.';
  }
}
function initSecUI() {
  const box = $('secBox');
  if (box && !box.dataset.wired) {
    box.dataset.wired = '1';
    box.addEventListener('toggle', () => { if (box.open) refreshSecBox(); });

    // proteger (crear contraseña)
    $('bSecProteger').onclick = () => { _secHideForms(); $('secSetup').hidden = false; $('secProtegerRow').hidden = true; try { $('secNew1').focus(); } catch { /* ok */ } };
    $('bSecCancel1').onclick = () => refreshSecBox();
    $('bSecGuardar').onclick = async () => {
      const p1 = $('secNew1').value, p2 = $('secNew2').value;
      if (p1.length < 4) return secResult('fail', 'La contraseña debe tener al menos 4 caracteres.');
      if (p1 !== p2) return secResult('fail', 'Las dos contraseñas no coinciden. Escríbelas igual.');
      await lockSetPassword(p1);
      lockMarkUnlocked();   // no te bloquees ahora mismo; pedirá al reabrir la app
      refreshSecBox();
      secResult('ok', '🔒 Contraseña activada. La app la pedirá la próxima vez que se abra.');
    };

    // cambiar contraseña
    $('bSecCambiar').onclick = () => { _secHideForms(); $('secChange').hidden = false; $('secManage').hidden = true; try { $('secCurCh').focus(); } catch { /* ok */ } };
    $('bSecChCancel').onclick = () => refreshSecBox();
    $('bSecChSave').onclick = async () => {
      const cur = $('secCurCh').value, n1 = $('secNewCh1').value, n2 = $('secNewCh2').value;
      if (!(await lockVerify(cur))) return secResult('fail', 'La contraseña actual no es correcta.');
      if (n1.length < 4) return secResult('fail', 'La nueva contraseña debe tener al menos 4 caracteres.');
      if (n1 !== n2) return secResult('fail', 'Las dos contraseñas nuevas no coinciden.');
      await lockSetPassword(n1);
      lockMarkUnlocked();
      refreshSecBox();
      secResult('ok', 'Contraseña actualizada ✓');
    };

    // quitar contraseña
    $('bSecQuitar').onclick = () => { _secHideForms(); $('secRemove').hidden = false; $('secManage').hidden = true; try { $('secCurRm').focus(); } catch { /* ok */ } };
    $('bSecRmCancel').onclick = () => refreshSecBox();
    $('bSecRmSave').onclick = async () => {
      const cur = $('secCurRm').value;
      if (!(await lockVerify(cur))) return secResult('fail', 'La contraseña no es correcta.');
      lockClear();
      try { sessionStorage.removeItem(LOCK_SESSION_KEY); } catch { /* sin storage */ }
      refreshSecBox();
      secResult('ok', 'Candado quitado — la app volverá a abrir sin contraseña.');
    };
  }
  refreshSecBox();
}

/* ============================================================
   ARRANQUE
   ============================================================ */
(function init() {
  initActivation();   // 🔑 activación APAGADA por defecto (flag REQUIERE_ACTIVACION): abre directo
  initLock();         // 🔒 candado de contraseña OPCIONAL, apagado por defecto
  watchDbBackend();   // 📊 diagnóstico del motor de datos + aviso si degradó a memoria
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
