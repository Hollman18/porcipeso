'use strict';
/* ============================================================
   PorciPeso — app de una sola página (inicio → pesaje → resultados)
   Principio: cualquier persona pesa un lote sin que nadie le explique.

   Backend (sin cambios):
     WS  /ws → {"type":"reading","kg","ts_ms","state"} | {"type":"event",…} | {"type":"snapshot",…}
     GET /api/profiles · POST /api/scale/connect · GET /api/scale/status
     POST /api/sessions · POST /api/sessions/{id}/close · GET /api/sessions/{id}/export.xlsx
     POST /api/events/{id}/confirm · POST /api/events/{id}/motivo

   Modo práctica: ?demo=1 o botón "Practicar sin báscula" (sin recargar).
   ============================================================ */

const $ = id => document.getElementById(id);
const fmt = (n, d = 1) => (typeof n === 'number' && isFinite(n))
  ? n.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const hora = ts => { try { return new Date(ts ?? Date.now()).toLocaleTimeString('es-CO', { hour12: false, hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } };
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let practiceMode = new URLSearchParams(location.search).get('demo') === '1';

/* ---------------- estado global ---------------- */
const APP = {
  session: null,          // {id, nombre}
  snapshot: null,         // último snapshot del motor
  refKg: null,
  weights: [],            // pesos individuales estimados (para "parejo/disparejo")
  moves: [],              // movimientos en lenguaje humano
  lastReadingAt: 0,
  scaleReady: false,
  lastResult: null,
  howtoThen: null,        // qué hacer al cerrar el overlay
};

/* ============================================================
   VISTAS
   ============================================================ */
const VIEWS = ['viewInicio', 'viewSetup', 'viewPesaje', 'viewResultados', 'viewConfig'];
function showView(id) {
  for (const v of VIEWS) $(v)?.classList.toggle('active', v === id);
  window.scrollTo({ top: 0 });
}

/* ============================================================
   BANNERS
   ============================================================ */
function apiDown(msg) {
  if (msg) $('apiBannerTxt').textContent = msg;
  $('apiBanner').classList.add('show');
}
function apiOk() { $('apiBanner').classList.remove('show'); }
function refreshPracticeBanner() {
  $('practiceBanner').classList.toggle('show', practiceMode);
  $('chipPractica1').hidden = !practiceMode;
  $('chipPractica2').hidden = !practiceMode;
}

/* ============================================================
   CAPA API (práctica = todo local)
   ============================================================ */
async function api(path, opts = {}) {
  if (practiceMode) return demoApi(path, opts);
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

/* ---------------- configuración guardada ---------------- */
function loadCfg() {
  try { return JSON.parse(localStorage.getItem('porcipeso_cfg') || 'null'); }
  catch { return null; }
}
function saveCfg(cfg) {
  try { localStorage.setItem('porcipeso_cfg', JSON.stringify(cfg)); } catch { /* sin storage */ }
}

/* ============================================================
   VISTA INICIO
   ============================================================ */
async function refreshInicio() {
  refreshPracticeBanner();
  const btn = $('bStart'), note = $('startNote');
  if (practiceMode) {
    APP.scaleReady = false;
    btn.textContent = 'Empezar a practicar';
    note.textContent = 'Estás en modo práctica: una báscula imaginaria para que veas cómo funciona.';
    note.hidden = false;
    return;
  }
  const cfg = loadCfg();
  if (!cfg?.profile_id) {
    APP.scaleReady = false;
    btn.textContent = 'Practicar sin báscula';
    note.textContent = 'Todavía no hay una báscula configurada. Practica con una imaginaria — o pide al técnico que entre a ⚙ Báscula.';
    note.hidden = false;
    return;
  }
  btn.textContent = 'Empezar a pesar';
  note.hidden = true;
  APP.scaleReady = true;
  try {
    const st = await api('/api/scale/status');
    const ok = st?.connected ?? st?.status === 'connected';
    if (!ok) {
      note.textContent = `Báscula guardada: ${cfg.name ?? cfg.profile_id}. Me conecto cuando empieces.`;
      note.hidden = false;
    }
  } catch {
    APP.scaleReady = false;
    btn.textContent = 'Practicar sin báscula';
    note.textContent = 'No encuentro el programa de la báscula. Puedes practicar mientras tanto.';
    note.hidden = false;
  }
}

$('bStart').onclick = () => {
  if (!APP.scaleReady && !practiceMode) startPractice(false);
  const seen = (() => { try { return localStorage.getItem('porcipeso_howto') === '1'; } catch { return false; } })();
  if (!seen) { APP.howtoThen = gotoSetup; openHowto(); }
  else gotoSetup();
};
$('bHistorial').onclick = () => { location.href = 'historial.html' + (practiceMode ? '?demo=1' : ''); };
$('bVerTodos').onclick = () => { location.href = 'historial.html' + (practiceMode ? '?demo=1' : ''); };
$('bConfig').onclick = () => { gotoConfig(); };

function startPractice(gotoNow = true) {
  practiceMode = true;
  refreshPracticeBanner();
  if (!demoTimer) demoTimer = setInterval(demoLoop, 100);
  if (gotoNow) gotoSetup();
}

/* ---------------- overlay "¿Cómo funciona?" ---------------- */
function openHowto() { try { $('dlgHowto').showModal(); } catch { /* ya abierto */ } }
$('bHowto').onclick = () => { APP.howtoThen = null; openHowto(); };
$('bHowto2').onclick = () => { APP.howtoThen = null; openHowto(); };
$('bHowtoOk').onclick = () => {
  try { localStorage.setItem('porcipeso_howto', '1'); } catch { /* sin storage */ }
  $('dlgHowto').close();
  const next = APP.howtoThen; APP.howtoThen = null;
  if (typeof next === 'function') next();
};

/* ============================================================
   VISTA PREPARAR PESAJE
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
  showView('viewSetup');
}
$('bSetupBack').onclick = () => { showView('viewInicio'); refreshInicio().catch(() => {}); };
$('bSetupPractice').onclick = () => {
  startPractice(false);
  $('setupError').classList.remove('show');
  $('setupErrorActions').classList.remove('show');
};
$('bSetupConfig').onclick = () => gotoConfig();

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

  // 1) conectar la báscula (invisible para quien pesa)
  if (!practiceMode) {
    const cfg = loadCfg();
    try {
      if (!cfg?.profile_id) throw new Error('sin config');
      const body = { profile_id: cfg.profile_id };
      if (cfg.port) body.port = cfg.port;
      await api('/api/scale/connect', { method: 'POST', body });
    } catch {
      $('setupError').textContent = 'No pude hablar con la báscula. ¿Quieres practicar sin ella, o revisar la conexión?';
      $('setupError').classList.add('show');
      $('setupErrorActions').classList.add('show');
      $('bComenzar').disabled = false;
      return;
    }
  }

  // 2) crear el pesaje
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
   VISTA PESAJE
   ============================================================ */
function startWeighing(nombre) {
  APP.snapshot = null; APP.refKg = null;
  APP.weights = []; APP.moves = [];
  hist.length = 0;
  questions.length = 0; activeQuestion = null;
  $('pesajeTitle').textContent = nombre;
  $('nCerdos').textContent = '0';
  $('nTotal').innerHTML = '0 <em>kg</em>';
  $('nProm').innerHTML = '— <em>kg</em>';
  renderMoves();
  narrLockUntil = 0;
  say('Esperando el primer cerdo… súbelo solo, sin compañía', 'calm');
  showView('viewPesaje');
}

/* ---------------- LA NARRACIÓN (la firma del producto) ---------------- */
let narrLockUntil = 0;
let activeQuestion = null;      // {eventId, delta, options}
const questions = [];           // cola de preguntas pendientes

function say(text, tone = '', stickyMs = 0) {
  if (activeQuestion) return;   // una pregunta manda hasta que se responda
  const n = $('narration');
  n.className = 'narration' + (tone ? ' ' + tone : '');
  $('narrTxt').textContent = text;
  $('narrBtns').hidden = true;
  if (stickyMs) narrLockUntil = Date.now() + stickyMs;
}
/* mensajes de ambiente: solo si no hay un mensaje importante fijado */
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
  const n = $('narration');
  n.className = 'narration ask';
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

/* ---------------- llegan lecturas ---------------- */
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

/* vigilante: sin lecturas 3 s → aviso */
setInterval(() => {
  if (!$('viewPesaje').classList.contains('active')) return;
  if (APP.lastReadingAt && Date.now() - APP.lastReadingAt > 3000) {
    ambient('⚠ Perdí la señal de la báscula — revisa el cable', 'alert');
    $('led').classList.remove('pulse');
  }
}, 1500);

/* ---------------- llegan totales ---------------- */
function onSnapshot(s) {
  if (!s) return;
  APP.snapshot = s;
  if (s.ref_kg != null) APP.refKg = s.ref_kg;
  $('nCerdos').textContent = s.count ?? 0;
  $('nTotal').innerHTML = `${fmt(s.total_kg ?? 0, 0)} <em>kg</em>`;
  $('nProm').innerHTML = `${s.avg_kg != null ? fmt(s.avg_kg, 0) : '—'} <em>kg</em>`;
}

/* ---------------- llegan movimientos ---------------- */
function onEvent(ev) {
  if (!ev) return;
  const tipo = ev.tipo ?? 'subida';
  const delta = Number(ev.delta_kg ?? 0);
  const pendiente = !!ev.ambiguo && ev.animales_confirmados == null;
  const n = Math.abs(ev.animales_confirmados ?? ev.animales_estimados ?? 1);

  if (tipo === 'referencia') {
    APP.refKg = delta;
    APP.weights.push(delta);
    say(`Calibrado: el primer cerdo pesa ${fmt(delta, 0)} kg. Ya puedes subir los demás`, 'calm', 6000);
    addMove('up', '✓', `Primer cerdo: ${fmt(delta)} kg — quedé calibrado`);
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
  // subida normal
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

/* ---------------- lista de movimientos ---------------- */
function addMove(cls, ico, text, eventId = null) {
  APP.moves.unshift({ t: hora(), cls, ico, text, eventId, motivo: null });
  renderMoves();
}
function renderMoves() {
  for (const [boxId, interactive] of [['movesList', true], ['movesListDone', true]]) {
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
        } else if (interactive) {
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

/* ---- ¿por qué se bajó? ---- */
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

/* ---------------- terminar pesaje ---------------- */
$('bTerminar').onclick = async () => {
  if (!APP.session?.id) { showView('viewInicio'); return; }
  if (activeQuestion || questions.length) {
    $('narration').classList.add('ask');
    $('narrTxt').textContent = 'Primero respóndeme la pregunta ☝ y luego terminamos';
    return;
  }
  $('bTerminar').disabled = true;
  try {
    const r = await api(`/api/sessions/${APP.session.id}/close`, { method: 'POST', body: {} });
    showResults(r ?? {});
  } catch {
    // banner activo; se puede reintentar
  } finally {
    $('bTerminar').disabled = false;
  }
};

/* ============================================================
   VISTA RESULTADOS
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

  // uniformidad traducida a lenguaje humano
  const v = $('verdict');
  const u = uniformity(APP.weights);
  if (u == null) { v.hidden = true; }
  else {
    v.hidden = false;
    const de10 = Math.max(1, Math.round(u / 10));
    if (u >= 70) {
      v.className = 'verdict parejo';
      v.textContent = `Lote parejo: ${de10} de cada 10 cerdos están cerca del promedio.`;
    } else {
      v.className = 'verdict disparejo';
      v.textContent = 'Lote disparejo: hay cerdos muy distintos entre sí — mira el detalle.';
    }
  }

  $('inpConteo').value = '';
  $('countMsg').className = 'count-msg';
  renderMoves();
  showView('viewResultados');
}

function uniformity(ws) {
  if (!Array.isArray(ws) || ws.length < 4) return null;
  const m = ws.reduce((a, b) => a + b, 0) / ws.length;
  if (!m) return null;
  return (ws.filter(w => Math.abs(w - m) <= 0.10 * m).length / ws.length) * 100;
}

$('bComparar').onclick = () => {
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
  if (!APP.session?.id) return;
  if (practiceMode) { alert('En modo práctica no hay Excel — era una báscula imaginaria.'); return; }
  window.open(`/api/sessions/${APP.session.id}/export.xlsx`, '_blank');
};
$('bOtroLote').onclick = () => { APP.session = null; gotoSetup(); };

/* ============================================================
   VISTA CONFIG (el técnico, una sola vez)
   ============================================================ */
function gotoConfig() {
  showView('viewConfig');
  $('testResult').className = 'test-result';
  loadProfilesInto($('cfgProfile')).catch(() => {});
  const cfg = loadCfg();
  if (cfg?.port) $('cfgPort').value = cfg.port;
}
$('bConfigBack').onclick = () => { showView('viewInicio'); refreshInicio().catch(() => {}); };

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
    sel._profiles = profiles;
    const cfg = loadCfg();
    if (cfg?.profile_id) sel.value = cfg.profile_id;
  } catch {
    sel.innerHTML = '<option value="">(no pude cargar el catálogo — ¿está corriendo el programa?)</option>';
  }
}

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
    // esperar hasta 4 s a que llegue un peso por el WebSocket
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
  res.className = 'test-result show ok';
  res.textContent = `Guardado: ${name} ✓`;
  setTimeout(() => { showView('viewInicio'); refreshInicio().catch(() => {}); }, 900);
};

/* ============================================================
   WEBSOCKET (con reconexión suave)
   ============================================================ */
let ws = null, wsAttempts = 0, wsTimer = null, lastKg = null;

function wsConnect() {
  if (practiceMode) return;
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
  if (wsTimer || practiceMode) return;
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

/* ---------------- curva pequeña bajo el peso ---------------- */
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
   MODO PRÁCTICA — báscula imaginaria (mismo motor del SPEC §4)
   ============================================================ */
const D = {
  sessionOpen: false, trueW: 0, target: 0, shaking: 0,
  readings: [], lastStable: 0, moving: false,
  ref: null, avg: null, count: 0, total: 0, pending: 0,
  pigs: [], nextEventId: 1, ambiguous: new Map(), script: 0, t0: null,
  awaiting: false, actionAt: 0, nextActionAt: 0,
};
let demoTimer = null;

function demoApi(path, opts = {}) {
  const method = (opts.method ?? 'GET').toUpperCase();
  const body = opts.body ?? {};
  return new Promise((resolve) => setTimeout(() => {
    if (path === '/api/profiles') {
      resolve([
        { id: 'matrix-normal', name: 'Matrix RS-232 (Adr 00)', brand: 'Lexus / Trumax' },
        { id: 'xk3190-a12e', name: 'XK3190-A12E ASCII continuo', brand: 'Yaohua' },
        { id: 'tuxon-ascii', name: 'Tuxon S ASCII', brand: 'GMT' },
        { id: 'sics', name: 'MT-SICS (SI/SIR)', brand: 'Mettler-Toledo' },
        { id: 'generic-tcp', name: 'Genérico TCP (regex)', brand: 'Genérico' },
      ]);
    } else if (path === '/api/scale/connect') {
      resolve({ ok: true });
    } else if (path === '/api/scale/status') {
      resolve({ connected: true, profile_name: 'Báscula imaginaria' });
    } else if (path === '/api/sessions' && method === 'POST') {
      Object.assign(D, {
        sessionOpen: true, trueW: 0, target: 0, shaking: 0, readings: [],
        lastStable: 0, moving: false, ref: null, avg: null, count: 0, total: 0,
        pending: 0, pigs: [], script: 0, t0: Date.now(),
        awaiting: false, actionAt: 0, nextActionAt: Date.now() + 1500,
      });
      D.ambiguous.clear();
      resolve({ id: 1, ...body });
    } else if (/^\/api\/sessions\/\d+\/close$/.test(path)) {
      D.sessionOpen = false;
      resolve({
        total_kg: D.total, total_animales: D.count,
        promedio_final: D.count ? D.total / D.count : 0,
        hora_entrada: D.t0, hora_salida: Date.now(),
      });
    } else if (/^\/api\/events\/\d+\/confirm$/.test(path)) {
      const id = parseInt(path.split('/')[3], 10);
      const amb = D.ambiguous.get(id);
      if (amb) {
        D.ambiguous.delete(id); D.pending--;
        demoApply(amb.delta, Math.abs(body.n ?? 1));
        D.nextActionAt = Date.now() + 3000; // pausa tras responder, para leer
      }
      resolve({ ok: true });
    } else {
      resolve({ ok: true });
    }
  }, 120));
}

function demoApply(delta, n) {
  const sign = delta > 0 ? 1 : -1;
  D.count += sign * n; D.total += delta;
  if (D.count > 0) D.avg = D.total / D.count;
  demoSnapshot();
}
function demoSnapshot() {
  onSnapshot({ kg_now: D.trueW, ref_kg: D.ref, avg_kg: D.avg, count: D.count, total_kg: D.total, pending: D.pending });
}
function demoAddPigs(nn, shake = 16) {
  let kg = 0;
  for (let i = 0; i < nn; i++) { const w = 88 + Math.random() * 30; D.pigs.push(w); kg += w; }
  D.target += kg; D.shaking = shake;
}
function demoRemovePig() {
  if (!D.pigs.length) return;
  const w = D.pigs.splice(Math.floor(Math.random() * D.pigs.length), 1)[0];
  D.target -= w; D.shaking = 18;
}
/* el guion hace de corral: actúa UNA vez y espera a que el motor detecte
   el escalón (evento) antes del siguiente paso — como una cuadrilla real.
   Sin esto el peso nunca se queda quieto los 2 s que pide la ventana. */
function demoScript() {
  if (!D.sessionOpen || D.pending > 0) return;          // si te pregunta, el corral espera
  if (D.shaking > 0 || Math.abs(D.target - D.trueW) > 0.1) return; // plataforma aún moviéndose
  if (D.awaiting) {                                     // el motor no ha reportado el paso anterior
    if (Date.now() - D.actionAt > 15000) D.awaiting = false; // red de seguridad
    return;
  }
  if (Date.now() < D.nextActionAt) return;              // pausa para leer la narración
  const steps = [
    () => demoAddPigs(1),        // referencia
    () => demoAddPigs(1),
    () => demoAddPigs(2),
    () => demoAddPigs(3),
    () => demoRemovePig(),       // uno se baja
    () => demoAddPigs(1, 45),    // cerdo inquieto (tarda más en calmarse)
    () => demoAddPigs(2),
  ];
  let acted = true;
  if (D.script < steps.length) steps[D.script++]();
  else if (Math.random() < 0.5) demoAddPigs(1 + Math.floor(Math.random() * 2));
  else acted = false;
  if (acted) { D.awaiting = true; D.actionAt = Date.now(); }
  else D.nextActionAt = Date.now() + 4000;
}
const D_WIN = 20, D_STAB = 2.0, D_MIN = 40, D_TOL = 0.20;
function demoEngine(reading) {
  D.readings.push(reading);
  if (D.readings.length > D_WIN) D.readings.shift();
  if (D.readings.length < D_WIN) return 'movimiento';
  const mx = Math.max(...D.readings), mn = Math.min(...D.readings);
  if (mx - mn > D_STAB) { D.moving = true; return 'movimiento'; }
  const level = D.readings.reduce((a, b) => a + b, 0) / D.readings.length;
  if (D.moving) {
    D.moving = false;
    const delta = level - D.lastStable;
    if (Math.abs(delta) >= D_MIN && D.sessionOpen) demoStep(delta);
    D.lastStable = level;
  }
  return 'estable';
}
function demoStep(delta) {
  D.awaiting = false;                        // el motor detectó el paso: guion liberado
  D.nextActionAt = Date.now() + 3000;        // deja leer la narración antes del siguiente
  const id = D.nextEventId++;
  const base = { id, session_id: 1, ts_ms: Date.now(), delta_kg: delta };
  if (D.ref === null) {
    D.ref = delta; D.avg = delta; D.count = 1; D.total = delta;
    onEvent({ ...base, tipo: 'referencia', animales_estimados: 1 });
    demoSnapshot();
    return;
  }
  const nRaw = delta / D.avg;
  const n = Math.round(nRaw);
  if (n === 0 && Math.abs(nRaw) < 0.5) return;
  const residuo = Math.abs(Math.abs(nRaw) - Math.abs(n || 1));
  if (residuo > D_TOL) {
    D.pending++;
    D.ambiguous.set(id, { delta });
    const lo = Math.max(1, Math.floor(Math.abs(nRaw))), hi = Math.ceil(Math.abs(nRaw));
    onEvent({ ...base, tipo: delta > 0 ? 'subida' : 'bajada', ambiguo: true, opciones: lo === hi ? [lo, lo + 1] : [lo, hi], animales_estimados: n || 1 });
    demoSnapshot();
    return;
  }
  const nn = Math.max(1, Math.abs(n));
  demoApply(delta, nn);
  onEvent({ ...base, tipo: delta > 0 ? 'subida' : 'bajada', animales_estimados: nn, animales_confirmados: nn });
}
function demoLoop() {
  const diff = D.target - D.trueW;
  D.trueW += diff * 0.18;
  if (D.shaking > 0) { D.trueW += (Math.random() * 2 - 1) * Math.min(D.shaking, 14); D.shaking -= 0.55; }
  if (Math.abs(diff) < 0.05 && D.shaking <= 0) D.trueW = D.target;
  const reading = Math.max(0, D.trueW + (Math.random() * 0.5 - 0.25));
  const state = demoEngine(reading);
  lastKg = reading;
  onReading({ kg: reading, ts_ms: Date.now(), state: D.sessionOpen ? state : 'estable' });
  demoScript();
}

/* ============================================================
   ARRANQUE
   ============================================================ */
(function init() {
  refreshPracticeBanner();
  if (practiceMode && !demoTimer) demoTimer = setInterval(demoLoop, 100);
  else wsConnect();
  showView('viewInicio');
  refreshInicio().catch(() => {});
  drawSpark();
})();
