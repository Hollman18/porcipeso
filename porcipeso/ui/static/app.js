'use strict';
/* ============================================================
   PorciPeso — pantalla del operador
   Consume:
     WS  /ws                      → reading | event | snapshot
     GET /api/profiles            → selector de báscula
     POST /api/scale/connect      → conectar indicador
     GET /api/scale/status        → badge de estado
     POST /api/sessions           → nueva sesión
     POST /api/sessions/{id}/close→ tiquete
     GET /api/sessions/{id}/export.xlsx
     POST /api/events/{id}/confirm
     POST /api/events/{id}/motivo
   ?demo=1 → todo simulado en el navegador (sin API ni WS).
   ============================================================ */

const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const $ = id => document.getElementById(id);
const fmt = (n, d = 1) => (typeof n === 'number' && isFinite(n))
  ? n.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const hora = ts => {
  try { return new Date(ts ?? Date.now()).toLocaleTimeString('es-CO', { hour12: false }); }
  catch { return '—'; }
};

/* ---------------- estado de la UI ---------------- */
const UI = {
  session: null,        // {id, lote, corral, destino, ...}
  profile: null,        // perfil seleccionado/conectado
  pending: 0,
  lastSnapshot: null,
  lastReadingAt: 0,
  events: new Map(),    // id → {el, ev}
};

/* ---------------- banner API ---------------- */
let bannerTimer = null;
function showBanner(msg) {
  const b = $('apiBanner');
  if (!b) return;
  if (msg) $('apiBannerTxt').textContent = msg;
  b.classList.add('show');
}
function hideBanner() { $('apiBanner')?.classList.remove('show'); }

/* ---------------- capa API (fetch defensivo) ---------------- */
async function api(path, opts = {}) {
  if (DEMO) return demoApi(path, opts);
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    showBanner('Sin conexión con el servidor — verifique que PorciPeso esté corriendo');
    throw e;
  }
  hideBanner();
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.detail ?? ''; } catch { /* sin cuerpo */ }
    throw new Error(`HTTP ${res.status} ${detail}`);
  }
  try { return await res.json(); } catch { return null; }
}

/* ============================================================
   SELECTOR DE BÁSCULA + CONEXIÓN
   ============================================================ */
async function loadProfiles() {
  const sel = $('profileSel');
  try {
    const data = await api('/api/profiles');
    const profiles = Array.isArray(data) ? data : (data?.profiles ?? []);
    sel.innerHTML = '<option value="">— Seleccione báscula —</option>';
    const byBrand = {};
    for (const p of profiles) {
      const brand = p?.brand ?? 'Otros';
      (byBrand[brand] ??= []).push(p);
    }
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
  } catch {
    sel.innerHTML = '<option value="">(no se pudieron cargar las básculas)</option>';
  }
}

function setScaleBadge(cls, txt) {
  const b = $('scaleBadge');
  b.className = 'badge' + (cls ? ' ' + cls : '');
  b.textContent = txt;
}

async function connectScale() {
  const sel = $('profileSel');
  const id = sel?.value;
  if (!id) { setScaleBadge('warn', 'Elija una báscula'); return; }
  $('bConnect').disabled = true;
  setScaleBadge('warn', 'Conectando…');
  try {
    await api('/api/scale/connect', { method: 'POST', body: { profile_id: id } });
    UI.profile = (sel._profiles ?? []).find(p => p?.id === id) ?? { id, name: sel.selectedOptions?.[0]?.textContent };
    await refreshScaleStatus();
    renderSessLine();
  } catch {
    setScaleBadge('err', 'Error al conectar');
  } finally {
    $('bConnect').disabled = false;
  }
}

async function refreshScaleStatus() {
  try {
    const st = await api('/api/scale/status');
    const connected = st?.connected ?? st?.status === 'connected';
    if (connected) {
      setScaleBadge('ok', st?.profile_name ?? st?.name ?? UI.profile?.name ?? 'Conectada');
    } else {
      setScaleBadge('', 'Sin báscula');
    }
  } catch {
    setScaleBadge('err', 'API caída');
  }
}
setInterval(() => { refreshScaleStatus().catch(() => {}); }, 7000);

/* ============================================================
   SESIÓN
   ============================================================ */
function renderSessLine() {
  const el = $('sessLine');
  if (!UI.session) {
    el.innerHTML = 'Sin sesión — cree una nueva sesión para empezar';
    return;
  }
  const s = UI.session;
  const b = UI.profile?.name ? ` · Báscula <b>${escapeHtml(UI.profile.name)}</b>` : '';
  el.innerHTML = `Lote <b>${escapeHtml(s.lote ?? '—')}</b> · Corral <b>${escapeHtml(s.corral ?? '—')}</b>${b}`;
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('bNewSession').onclick = () => { try { $('dlgSession').showModal(); } catch { /* ya abierto */ } };
$('bSessCancel').onclick = () => $('dlgSession').close();

$('formSession').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {};
  for (const k of ['lote', 'corral', 'destino', 'placa', 'conductor', 'operador']) {
    payload[k] = (fd.get(k) ?? '').toString().trim();
  }
  try {
    const r = await api('/api/sessions', { method: 'POST', body: payload });
    UI.session = { id: r?.id ?? r?.session_id ?? null, ...payload };
    $('dlgSession').close();
    e.target.reset();
    clearSessionUI();
    renderSessLine();
    $('bCloseSession').disabled = false;
  } catch {
    // el banner ya avisa; dejamos el diálogo abierto para reintentar
  }
});

function clearSessionUI() {
  $('log').textContent = '';
  $('queue').textContent = '';
  UI.events.clear();
  UI.pending = 0;
  UI.lastSnapshot = null;
  $('tCount').textContent = '0';
  $('tTotal').innerHTML = '0.0 <em>kg</em>';
  $('tAvg').innerHTML = '— <em>kg</em>';
  $('tRef').innerHTML = '— <em>kg</em>';
}

/* ---- cerrar lote ---- */
$('bCloseSession').onclick = () => {
  if (!UI.session?.id) return;
  if (UI.pending > 0) {
    showBanner('Hay eventos por confirmar — resuélvalos antes de cerrar el lote');
    setTimeout(hideBanner, 4000);
    return;
  }
  try { $('dlgClose').showModal(); } catch { /* ya abierto */ }
};
$('bCloseCancel').onclick = () => $('dlgClose').close();

$('formClose').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = new FormData(e.target).get('conteo_fisico');
  const body = {};
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n)) body.conteo_fisico = n;
  try {
    const r = await api(`/api/sessions/${UI.session.id}/close`, { method: 'POST', body });
    $('dlgClose').close();
    e.target.reset();
    showTicket(r ?? {});
    $('bCloseSession').disabled = true;
  } catch {
    // banner activo; el operador puede reintentar
  }
});

function showTicket(r) {
  const s = UI.session ?? {};
  const snap = UI.lastSnapshot ?? {};
  const total = r?.total_kg ?? snap?.total_kg ?? 0;
  const count = r?.total_animales ?? snap?.count ?? 0;
  const avg = r?.promedio_final ?? snap?.avg_kg ?? (count ? total / count : 0);
  $('ticketSub').textContent =
    `Lote ${s.lote ?? '—'} · Corral ${s.corral ?? '—'}${s.destino ? ' → ' + s.destino : ''}`;
  let html = `
    <div class="trow big"><span>Total</span><b>${fmt(total)} kg</b></div>
    <div class="trow big"><span>Cerdos</span><b>${Number(count) || 0}</b></div>
    <div class="trow"><span>Promedio por cerdo</span><b>${fmt(avg)} kg</b></div>`;
  if (r?.peso_ref_inicial != null)
    html += `<div class="trow"><span>Peso de referencia</span><b>${fmt(r.peso_ref_inicial)} kg</b></div>`;
  if (r?.conteo_fisico != null)
    html += `<div class="trow"><span>Conteo físico</span><b>${Number(r.conteo_fisico) || 0}</b></div>`;
  if (r?.diferencia_conciliacion != null) {
    const d = Number(r.diferencia_conciliacion) || 0;
    html += `<div class="trow ${d !== 0 ? 'warn' : ''}"><span>Diferencia conciliación</span><b>${d > 0 ? '+' : ''}${d}</b></div>`;
  }
  const h1 = r?.hora_entrada != null ? hora(r.hora_entrada) : null;
  const h2 = r?.hora_salida != null ? hora(r.hora_salida) : null;
  if (h1 || h2)
    html += `<div class="trow"><span>Horario</span><b class="mono" style="font-size:13px">${h1 ?? '—'} → ${h2 ?? '—'}</b></div>`;
  $('ticketBody').innerHTML = html;
  try { $('ticket').showModal(); } catch { /* ya abierto */ }
}

$('bTicketClose').onclick = () => $('ticket').close();
$('bExport').onclick = () => {
  if (!UI.session?.id) return;
  if (DEMO) { alert('Exportar Excel no está disponible en modo demo.'); return; }
  window.open(`/api/sessions/${UI.session.id}/export.xlsx`, '_blank');
};

/* ============================================================
   WEBSOCKET (reconexión con backoff)
   ============================================================ */
let ws = null, wsAttempts = 0, wsTimer = null;

function wsConnect() {
  if (DEMO) return; // en demo el generador local alimenta los handlers
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try { ws = new WebSocket(`${proto}://${location.host}/ws`); }
  catch { scheduleReconnect(); return; }

  ws.onopen = () => { wsAttempts = 0; hideBanner(); };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    routeMessage(m);
  };
  ws.onclose = () => { setState('sin_senal'); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch { /* ya cerrado */ } };
}

function scheduleReconnect() {
  if (wsTimer) return;
  const delay = Math.min(15000, 1000 * 2 ** wsAttempts);
  wsAttempts++;
  showBanner(`Conexión en vivo perdida — reintentando en ${Math.round(delay / 1000)} s…`);
  wsTimer = setTimeout(() => { wsTimer = null; wsConnect(); }, delay);
}

function routeMessage(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'reading': handleReading(m); break;
    case 'event': handleEvent(m.event ?? m.data ?? m); break;
    case 'snapshot': handleSnapshot(m.snapshot ?? m.data ?? m); break;
    default: break;
  }
}

/* ---------------- reading → LED + curva + chip ---------------- */
const hist = [];
function handleReading(m) {
  const kg = Number(m?.kg ?? 0);
  UI.lastReadingAt = Date.now();
  $('led').innerHTML = `${fmt(kg)} <small>kg</small>`;
  const frame = '=' + fmt(kg).replace(/\./g, '').replace(',', '.') + '␠';
  $('ticker').textContent = `${(frame + '  ').repeat(6)}— ${hora(m?.ts_ms)} · en vivo`;
  hist.push(kg);
  if (hist.length > 300) hist.shift();
  drawChart();
  if (m?.state) setState(m.state);
}

function setState(s) {
  const el = $('state');
  const map = {
    estable: ['estable', 'ESTABLE'],
    movimiento: ['movimiento', 'MOVIMIENTO'],
    sin_senal: ['senal', 'SIN SEÑAL'],
    idle: ['idle', 'EN ESPERA'],
  };
  const [cls, txt] = map[s] ?? ['senal', 'SIN SEÑAL'];
  el.className = 'state ' + cls;
  el.textContent = txt;
}

/* watchdog visual: si no llegan lecturas en 3 s → SIN SEÑAL */
setInterval(() => {
  if (UI.lastReadingAt && Date.now() - UI.lastReadingAt > 3000) setState('sin_senal');
}, 1500);

/* ---------------- snapshot → tarjetas ---------------- */
function handleSnapshot(s) {
  if (!s) return;
  UI.lastSnapshot = s;
  UI.pending = Number(s.pending ?? 0);
  $('tCount').textContent = s.count ?? 0;
  $('tTotal').innerHTML = `${fmt(s.total_kg ?? 0)} <em>kg</em>`;
  $('tAvg').innerHTML = `${s.avg_kg != null ? fmt(s.avg_kg) : '—'} <em>kg</em>`;
  $('tRef').innerHTML = `${s.ref_kg != null ? fmt(s.ref_kg) : '—'} <em>kg</em>`;
  if (s.state) setState(s.state);
}

/* ---------------- event → log + cola de ambiguos ---------------- */
function handleEvent(ev) {
  if (!ev) return;
  const tipo = ev.tipo ?? 'subida';
  const delta = Number(ev.delta_kg ?? 0);
  const esBajada = tipo === 'bajada' || delta < 0;
  const ambiguo = !!ev.ambiguo && ev.animales_confirmados == null;

  let txt;
  const n = ev.animales_confirmados ?? ev.animales_estimados;
  if (tipo === 'referencia') {
    txt = `Referencia seteada: ${fmt(Math.abs(delta))} kg`;
  } else if (ambiguo) {
    txt = `${delta > 0 ? 'Subida' : 'Bajada'} de ${fmt(Math.abs(delta))} kg — AMBIGUO, esperando confirmación`;
  } else if (esBajada) {
    txt = `Se devolvió ${Math.abs(n ?? 1)} cerdo${Math.abs(n ?? 1) > 1 ? 's' : ''} (${fmt(delta)} kg) — conteo descontado`;
  } else if (tipo === 'reingreso') {
    txt = `Reingreso: ${n ?? 1} cerdo${(n ?? 1) > 1 ? 's' : ''} (+${fmt(delta)} kg)`;
  } else {
    txt = `Subieron ${n ?? '?'} cerdo${(n ?? 1) > 1 ? 's' : ''} (+${fmt(delta)} kg)`;
  }

  const div = document.createElement('div');
  div.className = 'ev ' + (ambiguo ? 'amb-ev' : esBajada ? 'down' : 'up');
  div.innerHTML =
    `<span class="t mono">${hora(ev.ts_ms)}</span>` +
    `<span class="badge-ev">${ambiguo ? '⚠' : esBajada ? '⬇' : '⬆'}</span>` +
    `<span class="d">${escapeHtml(txt)}</span>`;

  if (esBajada && !ambiguo && ev.id != null) {
    if (ev.motivo_bajada) {
      const s = document.createElement('span');
      s.className = 'motivo-set';
      s.textContent = `motivo: ${ev.motivo_bajada}`;
      div.appendChild(s);
    } else {
      const b = document.createElement('button');
      b.className = 'motivo-btn';
      b.textContent = 'motivo';
      b.onclick = () => openMotivo(ev.id, div, b);
      div.appendChild(b);
    }
  }

  $('log').prepend(div);
  if (ev.id != null) UI.events.set(ev.id, { el: div, ev });
  if (ambiguo) queueConfirm(ev, div);
}

/* ---- cola ámbar "Por confirmar" ---- */
function queueConfirm(ev, logEl) {
  const delta = Number(ev.delta_kg ?? 0);
  const opciones = (Array.isArray(ev.opciones) && ev.opciones.length)
    ? ev.opciones
    : guessOptions(delta);
  const div = document.createElement('div');
  div.className = 'amb';
  const avgTxt = UI.lastSnapshot?.avg_kg != null ? ` (promedio ${fmt(UI.lastSnapshot.avg_kg)} kg)` : '';
  div.innerHTML = `<b>${delta > 0 ? 'Subida' : 'Bajada'} de ${fmt(Math.abs(delta))} kg</b> — el residuo no cuadra con el promedio${avgTxt}. ¿Cuántos fueron?`;
  const btns = document.createElement('div');
  btns.className = 'abtns';
  for (const o of opciones) {
    const b = document.createElement('button');
    b.textContent = `${o} cerdo${o > 1 ? 's' : ''}`;
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api(`/api/events/${ev.id}/confirm`, { method: 'POST', body: { n: o } });
        div.remove();
        if (logEl) {
          logEl.classList.remove('amb-ev');
          logEl.classList.add(delta < 0 ? 'down' : 'up');
          const d = logEl.querySelector('.d');
          if (d) d.textContent = `${delta > 0 ? 'Subieron' : 'Se devolvieron'} ${o} cerdo${o > 1 ? 's' : ''} (${delta > 0 ? '+' : ''}${fmt(delta)} kg) · confirmado por operador`;
          const badge = logEl.querySelector('.badge-ev');
          if (badge) badge.textContent = delta < 0 ? '⬇' : '⬆';
        }
      } catch {
        b.disabled = false;
      }
    };
    btns.appendChild(b);
  }
  div.appendChild(btns);
  $('queue').appendChild(div);
}

function guessOptions(delta) {
  const avg = UI.lastSnapshot?.avg_kg;
  if (!avg) return [1, 2];
  const nRaw = Math.abs(delta) / avg;
  const lo = Math.max(1, Math.floor(nRaw)), hi = Math.ceil(nRaw);
  return lo === hi ? [lo] : [lo, hi];
}

/* ---- motivo de bajada ---- */
let motivoTarget = null; // {id, el, btn}
function openMotivo(eventId, evEl, btn) {
  motivoTarget = { id: eventId, el: evEl, btn };
  try { $('dlgMotivo').showModal(); } catch { /* ya abierto */ }
}
$('bMotivoCancel').onclick = () => $('dlgMotivo').close();
for (const b of document.querySelectorAll('#dlgMotivo [data-motivo]')) {
  b.onclick = async () => {
    if (!motivoTarget) return;
    const motivo = b.dataset.motivo;
    try {
      await api(`/api/events/${motivoTarget.id}/motivo`, { method: 'POST', body: { motivo } });
      motivoTarget.btn?.remove();
      const s = document.createElement('span');
      s.className = 'motivo-set';
      s.textContent = `motivo: ${motivo}`;
      motivoTarget.el?.appendChild(s);
      $('dlgMotivo').close();
    } catch { /* banner activo */ }
    motivoTarget = null;
  };
}

/* ---------------- curva canvas ---------------- */
const cv = $('chart'), cx = cv.getContext('2d');
function drawChart() {
  const css = getComputedStyle(document.documentElement);
  const grid = css.getPropertyValue('--panel-edge').trim() || '#39443C';
  const line = css.getPropertyValue('--led').trim() || '#FF4A2E';
  cx.clearRect(0, 0, cv.width, cv.height);
  const maxY = Math.max(400, ...hist) * 1.15;
  cx.strokeStyle = grid; cx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = cv.height * i / 4;
    cx.beginPath(); cx.moveTo(0, y); cx.lineTo(cv.width, y); cx.stroke();
  }
  cx.strokeStyle = line; cx.lineWidth = 2.5; cx.beginPath();
  hist.forEach((v, i) => {
    const x = i / (hist.length - 1 || 1) * cv.width;
    const y = cv.height - (v / maxY) * cv.height;
    i ? cx.lineTo(x, y) : cx.moveTo(x, y);
  });
  cx.stroke();
}

/* ---------------- botones de barra ---------------- */
$('bConnect').onclick = connectScale;

/* ============================================================
   MODO DEMO (?demo=1) — todo local, mismo diseño
   ============================================================ */
const D = DEMO ? {
  connected: false, sessionOpen: false,
  trueW: 0, target: 0, shaking: 0,
  readings: [], lastStable: 0, moving: false,
  ref: null, avg: null, count: 0, total: 0, pending: 0,
  pigs: [], nextEventId: 1, ambiguous: new Map(), // id → {delta}
  script: 0, t0: null,
} : null;

function demoApi(path, opts = {}) {
  const method = (opts.method ?? 'GET').toUpperCase();
  const body = opts.body ?? {};
  return new Promise((resolve) => setTimeout(() => {
    if (path === '/api/profiles') {
      resolve([
        { id: 'matrix-normal', name: 'Matrix RS-232 (Adr 00)', brand: 'Lexus / Trumax' },
        { id: 'matrix-invertido', name: 'Matrix RS-232 (Adr 99)', brand: 'Lexus / Trumax' },
        { id: 'xk3190-a12e', name: 'XK3190-A12E ASCII continuo', brand: 'Yaohua' },
        { id: 'tuxon-ascii', name: 'Tuxon S ASCII', brand: 'GMT' },
        { id: 'sics', name: 'MT-SICS (SI/SIR)', brand: 'Mettler-Toledo' },
        { id: 'generic-tcp', name: 'Genérico TCP (regex)', brand: 'Genérico' },
      ]);
    } else if (path === '/api/scale/connect') {
      D.connected = true; resolve({ ok: true });
    } else if (path === '/api/scale/status') {
      resolve({ connected: D.connected, profile_name: UI.profile?.name });
    } else if (path === '/api/sessions' && method === 'POST') {
      D.sessionOpen = true; D.script = 0; D.t0 = Date.now();
      Object.assign(D, { trueW: 0, target: 0, shaking: 0, readings: [], lastStable: 0, moving: false, ref: null, avg: null, count: 0, total: 0, pending: 0, pigs: [] });
      resolve({ id: 1, ...body });
    } else if (/^\/api\/sessions\/\d+\/close$/.test(path)) {
      D.sessionOpen = false;
      const r = {
        total_kg: D.total, total_animales: D.count,
        promedio_final: D.count ? D.total / D.count : 0,
        peso_ref_inicial: D.ref, hora_entrada: D.t0, hora_salida: Date.now(),
      };
      if (body.conteo_fisico != null) {
        r.conteo_fisico = body.conteo_fisico;
        r.diferencia_conciliacion = body.conteo_fisico - D.count;
      }
      resolve(r);
    } else if (/^\/api\/events\/\d+\/confirm$/.test(path)) {
      const id = parseInt(path.split('/')[3], 10);
      const amb = D.ambiguous.get(id);
      if (amb) {
        D.ambiguous.delete(id); D.pending--;
        demoApply(amb.delta, Math.abs(body.n ?? 1));
      }
      resolve({ ok: true });
    } else if (/^\/api\/events\/\d+\/motivo$/.test(path)) {
      resolve({ ok: true });
    } else {
      resolve({});
    }
  }, 120));
}

function demoApply(delta, n) {
  const sign = delta > 0 ? 1 : -1;
  D.count += sign * n; D.total += delta;
  if (D.count > 0) D.avg = D.total / D.count;
  demoSnapshot();
}
function demoSnapshot(state) {
  handleSnapshot({
    state: state ?? null, kg_now: D.trueW, ref_kg: D.ref, avg_kg: D.avg,
    count: D.count, total_kg: D.total, pending: D.pending,
  });
}
function demoPig() { return 88 + Math.random() * 30; }
function demoAddPigs(nn, shake = 22) {
  let kg = 0;
  for (let i = 0; i < nn; i++) { const w = demoPig(); D.pigs.push(w); kg += w; }
  D.target += kg; D.shaking = shake;
}
function demoRemovePig() {
  if (!D.pigs.length) return;
  const w = D.pigs.splice(Math.floor(Math.random() * D.pigs.length), 1)[0];
  D.target -= w; D.shaking = 18;
}

/* guion demo: sube ref, luego 1, 2, ambiguo, se devuelve 1, inquieto… */
function demoScript() {
  if (!D.sessionOpen || D.shaking > 0.5 || Math.abs(D.target - D.trueW) > 1) return;
  const steps = [
    () => demoAddPigs(1),          // referencia
    () => demoAddPigs(1),
    () => demoAddPigs(2),
    () => demoAddPigs(3),
    () => demoRemovePig(),         // se devuelve 1
    () => demoAddPigs(1, 55),      // cerdo inquieto
    () => demoAddPigs(2),
    () => demoAddPigs(1),
  ];
  if (D.script < steps.length) { steps[D.script++](); }
  else if (Math.random() < 0.5) { demoAddPigs(1 + Math.floor(Math.random() * 2)); }
}

/* motor demo (idéntico al spec §4, versión compacta) */
const D_WIN = 20, D_STAB = 2.0, D_MIN = 40, D_TOL = 0.20;
function demoEngine(reading) {
  D.readings.push(reading);
  if (D.readings.length > D_WIN) D.readings.shift();
  if (D.readings.length < D_WIN) return 'movimiento';
  const mx = Math.max(...D.readings), mn = Math.min(...D.readings);
  const stable = (mx - mn) <= D_STAB;
  if (!stable) { D.moving = true; return 'movimiento'; }
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
  const id = D.nextEventId++;
  const base = { id, session_id: 1, ts_ms: Date.now(), delta_kg: delta };
  if (D.ref === null) {
    D.ref = delta; D.avg = delta; D.count = 1; D.total = delta;
    handleEvent({ ...base, tipo: 'referencia', animales_estimados: 1 });
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
    handleEvent({
      ...base, tipo: delta > 0 ? 'subida' : 'bajada', ambiguo: true,
      opciones: lo === hi ? [lo] : [lo, hi], animales_estimados: n || 1,
    });
    demoSnapshot();
    return;
  }
  const nn = Math.max(1, Math.abs(n));
  demoApply(delta, nn);
  handleEvent({
    ...base, tipo: delta > 0 ? 'subida' : 'bajada',
    animales_estimados: delta > 0 ? nn : -nn, animales_confirmados: delta > 0 ? nn : -nn,
  });
}

function demoLoop() {
  // física
  const diff = D.target - D.trueW;
  D.trueW += diff * 0.18;
  if (D.shaking > 0) { D.trueW += (Math.random() * 2 - 1) * Math.min(D.shaking, 14); D.shaking -= 0.55; }
  if (Math.abs(diff) < 0.05 && D.shaking <= 0) D.trueW = D.target;
  const reading = Math.max(0, D.trueW + (Math.random() * 0.5 - 0.25));
  const state = D.connected ? demoEngine(reading) : 'sin_senal';
  if (D.connected) handleReading({ kg: reading, ts_ms: Date.now(), state });
  demoScript();
}

/* ============================================================
   ARRANQUE
   ============================================================ */
(function init() {
  if (DEMO) {
    $('demoBanner').classList.add('show');
    setInterval(demoLoop, 100);
  } else {
    wsConnect();
  }
  loadProfiles();
  refreshScaleStatus().catch(() => {});
  drawChart();
})();
