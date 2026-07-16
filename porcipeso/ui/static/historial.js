'use strict';
/* ============================================================
   PorciPeso — pesajes anteriores (lenguaje humano)
   Consume:
     GET /api/sessions              → tarjetas de pesajes
     GET /api/sessions/{id}         → cabecera del detalle
     GET /api/sessions/{id}/events  → "lo que pasó, paso a paso"
     GET /api/sessions/{id}/stats   → estadística (si no existe, se calcula aquí)
     GET /api/sessions/{id}/export.xlsx
   La estadística del SPEC §6 (DE, CV%, uniformidad ±10%) se TRADUCE:
   "parejo / disparejo" con una frase que cualquiera entiende.
   ?demo=1 → pesajes de ejemplo locales.
   ============================================================ */

const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const $ = id => document.getElementById(id);
const fmt = (n, d = 1) => (typeof n === 'number' && isFinite(n))
  ? n.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const hora = ts => { try { return new Date(ts).toLocaleTimeString('es-CO', { hour12: false, hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } };
const fecha = ts => {
  try {
    return ts ? new Date(ts).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  } catch { return ''; }
};
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path) {
  if (DEMO) return demoApi(path);
  let res;
  try { res = await fetch(path); }
  catch (e) { $('apiBanner').classList.add('show'); throw e; }
  $('apiBanner').classList.remove('show');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return await res.json(); } catch { return null; }
}

/* ============================================================
   LISTA
   ============================================================ */
async function loadList() {
  const box = $('listCards');
  box.innerHTML = '<p class="empty">Cargando pesajes…</p>';
  let sessions = [];
  try {
    const data = await api('/api/sessions');
    sessions = Array.isArray(data) ? data : (data?.sessions ?? []);
  } catch {
    box.innerHTML = '<p class="empty">No pude cargar los pesajes — el programa de la báscula no contesta.</p>';
    return;
  }
  if (!sessions.length) {
    box.innerHTML = '<p class="empty">Todavía no hay pesajes. ¡El primero es el más fácil!</p>';
    return;
  }
  box.innerHTML = '';
  for (const s of sessions) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'sess-card';
    const abierta = (s?.estado ?? '') === 'abierta';
    card.innerHTML = `
      <span class="name">${escapeHtml(s?.lote ?? `Pesaje ${s?.id ?? ''}`)}</span>
      ${abierta ? '<span class="pill encurso">en curso</span>' : '<span class="pill" data-uni></span>'}
      <span class="when">${escapeHtml(fecha(s?.hora_entrada ?? s?.created_at))}${s?.hora_entrada ? ' · ' + hora(s.hora_entrada) : ''}</span>
      <span class="nums">
        <span><b>${escapeHtml(s?.total_animales ?? '—')}</b> cerdos</span>
        <span><b>${s?.total_kg != null ? fmt(s.total_kg, 0) : '—'}</b> kg</span>
        <span><b>${s?.promedio_final != null ? fmt(s.promedio_final, 0) : '—'}</b> kg de promedio</span>
      </span>`;
    card.onclick = () => { openDetail(s?.id).catch(() => {}); };
    box.appendChild(card);
    if (!abierta && s?.id != null) fillChip(card, s.id); // parejo/disparejo, sin bloquear la lista
  }
}

async function fillChip(card, id) {
  try {
    const u = await uniformityFor(id);
    const pill = card.querySelector('[data-uni]');
    if (!pill) return;
    if (u == null) { pill.remove(); return; }
    if (u >= 70) { pill.classList.add('parejo'); pill.textContent = 'parejo'; }
    else { pill.classList.add('disparejo'); pill.textContent = 'disparejo'; }
  } catch { /* sin chip */ }
}

const uniCache = new Map();
async function uniformityFor(id) {
  if (uniCache.has(id)) return uniCache.get(id);
  let st = null;
  try { st = await api(`/api/sessions/${id}/stats`); } catch { st = null; }
  let u = st?.uniformidad ?? st?.uniformity ?? null;
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
function uniformity(ws) {
  if (!Array.isArray(ws) || ws.length < 4) return null;
  const m = ws.reduce((a, b) => a + b, 0) / ws.length;
  if (!m) return null;
  return (ws.filter(w => Math.abs(w - m) <= 0.10 * m).length / ws.length) * 100;
}

/* ============================================================
   DETALLE
   ============================================================ */
let currentId = null;

async function openDetail(id) {
  if (id == null) return;
  currentId = id;
  let s = null, events = [];
  try { s = await api(`/api/sessions/${id}`); } catch { return; }
  try {
    const d = await api(`/api/sessions/${id}/events`);
    events = Array.isArray(d) ? d : (d?.events ?? []);
  } catch { events = []; }

  $('dNombre').textContent = s?.lote ?? `Pesaje ${id}`;
  const cuando = [fecha(s?.hora_entrada), s?.hora_entrada ? `${hora(s.hora_entrada)}${s?.hora_salida ? ' – ' + hora(s.hora_salida) : ''}` : '']
    .filter(Boolean).join(' · ');
  $('dCuando').textContent = cuando || 'Sin fecha registrada';

  const total = s?.total_kg, count = s?.total_animales, avg = s?.promedio_final;
  $('dCards').innerHTML = `
    <div class="rcard"><div class="rv">${count != null ? Number(count) || 0 : '—'}</div><div class="rk">cerdos</div></div>
    <div class="rcard"><div class="rv">${total != null ? fmt(total, 0) : '—'}</div><div class="rk">kg en total</div></div>
    <div class="rcard"><div class="rv">${avg != null ? fmt(avg, 0) : '—'}</div><div class="rk">kg de promedio</div></div>`;

  const v = $('dVerdict');
  const u = await uniformityFor(id).catch(() => null);
  if (u == null) v.hidden = true;
  else {
    v.hidden = false;
    if (u >= 70) {
      v.className = 'verdict parejo';
      v.textContent = `Lote parejo: ${Math.max(1, Math.round(u / 10))} de cada 10 cerdos están cerca del promedio.`;
    } else {
      v.className = 'verdict disparejo';
      v.textContent = 'Lote disparejo: hay cerdos muy distintos entre sí — mira el paso a paso.';
    }
  }

  const extras = [
    s?.corral ?? s?.corral_origen ? `Corral: ${s.corral ?? s.corral_origen}` : null,
    s?.destino ? `Destino: ${s.destino}` : null,
    s?.placa ?? s?.placa_vehiculo ? `Camión: ${s.placa ?? s.placa_vehiculo}` : null,
    s?.conductor ? `Conductor: ${s.conductor}` : null,
    s?.conteo_fisico != null ? `Conteo a mano: ${Number(s.conteo_fisico) || 0}` : null,
  ].filter(Boolean);
  $('dExtra').textContent = extras.join(' · ');
  $('dExtra').hidden = !extras.length;

  renderMoves(events);
  $('viewLista').classList.remove('active');
  $('viewDetalle').classList.add('active');
  window.scrollTo({ top: 0 });
}

function renderMoves(events) {
  const box = $('dMoves');
  box.innerHTML = '';
  const sorted = [...events].sort((a, b) => (a?.ts_ms ?? 0) - (b?.ts_ms ?? 0));
  for (const ev of sorted) {
    const tipo = ev?.tipo ?? 'subida';
    const delta = Number(ev?.delta_kg ?? 0);
    const down = tipo === 'bajada' || delta < 0;
    const pendiente = !!ev?.ambiguo && ev?.animales_confirmados == null;
    const n = Math.abs(ev?.animales_confirmados ?? ev?.animales_estimados ?? 1);
    let cls = 'up', ico = '✓', txt;
    if (tipo === 'referencia') {
      txt = `Primer cerdo: ${fmt(Math.abs(delta))} kg — la báscula quedó calibrada`;
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
    const div = document.createElement('div');
    div.className = 'mv ' + cls;
    div.innerHTML = `<span class="t mono">${escapeHtml(hora(ev?.ts_ms))}</span>` +
      `<span class="ico">${escapeHtml(ico)}</span>` +
      `<span class="d">${escapeHtml(txt)}</span>`;
    box.appendChild(div);
  }
  if (!sorted.length) box.innerHTML = '<p class="empty">No quedó registro del paso a paso.</p>';
}

$('bBack').onclick = () => {
  $('viewDetalle').classList.remove('active');
  $('viewLista').classList.add('active');
  currentId = null;
};
$('bExport').onclick = () => {
  if (currentId == null) return;
  if (DEMO) { alert('En modo práctica no hay Excel — son pesajes de ejemplo.'); return; }
  window.open(`/api/sessions/${currentId}/export.xlsx`, '_blank');
};
$('bRefresh').onclick = () => { loadList().catch(() => {}); };

/* ============================================================
   MODO PRÁCTICA — pesajes de ejemplo
   ============================================================ */
let DDATA = null;
function demoData() {
  const base = Date.now() - 86400000;
  const mk = (sid, grupos) => {
    let id = sid * 100, t = base + sid * 3600000;
    const evs = [];
    grupos.forEach((g, i) => {
      t += 45000 + Math.random() * 60000;
      evs.push({
        id: ++id, session_id: sid, ts_ms: t,
        delta_kg: g.reduce((a, b) => a + b, 0),
        tipo: i === 0 ? 'referencia' : 'subida',
        animales_estimados: g.length, animales_confirmados: g.length,
      });
    });
    t += 60000;
    evs.push({ id: ++id, session_id: sid, ts_ms: t, delta_kg: -grupos[1][0], tipo: 'bajada', animales_estimados: -1, animales_confirmados: -1, motivo_bajada: 'estres' });
    return evs;
  };
  const g1 = [[104.2], [98.7], [101.3, 109.9], [95.2, 103.1, 111.4], [99.8], [106.5, 97.2]];
  const g2 = [[92.1], [60.4], [118.2], [95.7], [131.2], [64.3]]; // lote DISPAREJO a propósito
  const ev1 = mk(1, g1), ev2 = mk(2, g2);
  const sum = e => e.reduce((a, x) => a + x.delta_kg, 0);
  const cnt = e => e.reduce((a, x) => a + (x.animales_confirmados ?? 0), 0);
  return {
    sessions: [
      { id: 2, lote: 'Lote 15 jul, 2:00 p. m.', estado: 'cerrada', corral: 'C-03', destino: 'Planta Sur',
        hora_entrada: base + 2 * 3600000, hora_salida: base + 2 * 3600000 + 35 * 60000,
        total_kg: sum(ev2), total_animales: cnt(ev2), promedio_final: sum(ev2) / cnt(ev2) },
      { id: 1, lote: 'Lote 15 jul, 8:00 a. m.', estado: 'cerrada', corral: 'C-14', destino: 'Planta Norte',
        placa: 'ABC-123', conductor: 'J. Pérez', conteo_fisico: cnt(ev1) + 1,
        hora_entrada: base + 3600000, hora_salida: base + 3600000 + 42 * 60000,
        total_kg: sum(ev1), total_animales: cnt(ev1), promedio_final: sum(ev1) / cnt(ev1) },
    ],
    events: { 1: ev1, 2: ev2 },
  };
}
function demoApi(path) {
  DDATA ??= demoData();
  return new Promise((resolve, reject) => setTimeout(() => {
    if (path === '/api/sessions') return resolve(DDATA.sessions);
    let m = path.match(/^\/api\/sessions\/(\d+)$/);
    if (m) return resolve(DDATA.sessions.find(s => s.id === +m[1]) ?? {});
    m = path.match(/^\/api\/sessions\/(\d+)\/events$/);
    if (m) return resolve(DDATA.events[+m[1]] ?? []);
    m = path.match(/^\/api\/sessions\/(\d+)\/stats$/);
    if (m) return reject(new Error('sin stats en práctica — se calcula aquí'));
    resolve({});
  }, 120));
}

/* ============================================================
   ARRANQUE
   ============================================================ */
(function init() {
  if (DEMO) {
    $('practiceBanner').classList.add('show');
    $('linkVolver').href = 'index.html?demo=1';
  }
  loadList().catch(() => {});
})();
