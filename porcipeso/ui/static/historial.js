'use strict';
/* ============================================================
   PorciPeso — historial y analítica de sesiones
   Consume:
     GET /api/sessions              → tabla
     GET /api/sessions/{id}         → cabecera del detalle
     GET /api/sessions/{id}/stats   → estadística (si existe; si no, se calcula)
     GET /api/sessions/{id}/events  → lista de eventos
     GET /api/sessions/{id}/export.xlsx
   Analítica SPEC §6: total kg, nº animales, promedio, DE, CV%,
   uniformidad (% dentro de ±10% del promedio).
   ?demo=1 → datos falsos locales.
   ============================================================ */

const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const $ = id => document.getElementById(id);
const fmt = (n, d = 1) => (typeof n === 'number' && isFinite(n))
  ? n.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const hora = ts => { try { return new Date(ts).toLocaleTimeString('es-CO', { hour12: false }); } catch { return '—'; } };
const fecha = ts => {
  try { return ts ? new Date(ts).toLocaleString('es-CO', { hour12: false, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
  catch { return '—'; }
};
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showBanner() { $('apiBanner')?.classList.add('show'); }
function hideBanner() { $('apiBanner')?.classList.remove('show'); }

async function api(path) {
  if (DEMO) return demoApi(path);
  let res;
  try { res = await fetch(path); }
  catch (e) { showBanner(); throw e; }
  hideBanner();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return await res.json(); } catch { return null; }
}

/* ============================================================
   LISTA DE SESIONES
   ============================================================ */
async function loadSessions() {
  const tb = $('sessRows');
  tb.innerHTML = '<tr><td colspan="9" class="empty">Cargando sesiones…</td></tr>';
  let sessions = [];
  try {
    const data = await api('/api/sessions');
    sessions = Array.isArray(data) ? data : (data?.sessions ?? []);
  } catch {
    tb.innerHTML = '<tr><td colspan="9" class="empty">No se pudo cargar el historial — servidor no disponible.</td></tr>';
    return;
  }
  if (!sessions.length) {
    tb.innerHTML = '<tr><td colspan="9" class="empty">Aún no hay sesiones registradas.</td></tr>';
    return;
  }
  tb.innerHTML = '';
  for (const s of sessions) {
    const tr = document.createElement('tr');
    const estado = s?.estado ?? 'abierta';
    tr.innerHTML = `
      <td class="mono">${escapeHtml(s?.id ?? '—')}</td>
      <td><b>${escapeHtml(s?.lote)}</b></td>
      <td>${escapeHtml(s?.corral ?? s?.corral_origen)}</td>
      <td>${escapeHtml(s?.destino)}</td>
      <td><span class="pill ${escapeHtml(estado)}">${escapeHtml(estado)}</span></td>
      <td class="mono">${escapeHtml(s?.total_animales ?? '—')}</td>
      <td class="mono">${s?.total_kg != null ? fmt(s.total_kg) : '—'}</td>
      <td class="mono">${s?.promedio_final != null ? fmt(s.promedio_final) : '—'}</td>
      <td class="mono">${fecha(s?.hora_entrada ?? s?.created_at)}</td>`;
    tr.onclick = () => { openDetail(s?.id).catch(() => {}); };
    tb.appendChild(tr);
  }
}

/* ============================================================
   DETALLE + ESTADÍSTICA (SPEC §6)
   ============================================================ */
let currentId = null;

async function openDetail(id) {
  if (id == null) return;
  currentId = id;
  let session = null, events = [], stats = null;
  try { session = await api(`/api/sessions/${id}`); } catch { return; }
  try {
    const evData = await api(`/api/sessions/${id}/events`);
    events = Array.isArray(evData) ? evData : (evData?.events ?? []);
  } catch { events = []; }
  try { stats = await api(`/api/sessions/${id}/stats`); } catch { stats = null; }

  renderDetail(session ?? {}, events, stats ?? computeStats(session ?? {}, events));
  $('listCard').hidden = true;
  $('detailCard').hidden = false;
  window.scrollTo({ top: 0 });
}

/* estadística calculada en cliente si la API no trae /stats:
   pesos individuales ≈ delta/n de cada subida (incl. referencia) */
function computeStats(session, events) {
  const weights = [];
  for (const ev of events) {
    const tipo = ev?.tipo;
    const n = Math.abs(ev?.animales_confirmados ?? ev?.animales_estimados ?? 0);
    const delta = Number(ev?.delta_kg ?? 0);
    if ((tipo === 'referencia' || tipo === 'subida' || tipo === 'reingreso') && delta > 0 && n >= 1) {
      const per = delta / n;
      for (let i = 0; i < n; i++) weights.push(per);
    }
  }
  const total = session?.total_kg ?? weights.reduce((a, b) => a + b, 0);
  const count = session?.total_animales ?? weights.length;
  const avg = session?.promedio_final ?? (count ? total / count : null);
  let de = null, cv = null, unif = null, min = null, max = null;
  if (weights.length >= 2 && avg) {
    const m = weights.reduce((a, b) => a + b, 0) / weights.length;
    de = Math.sqrt(weights.reduce((a, w) => a + (w - m) ** 2, 0) / (weights.length - 1));
    cv = m ? (de / m) * 100 : null;
    unif = (weights.filter(w => Math.abs(w - m) <= 0.10 * m).length / weights.length) * 100;
    min = Math.min(...weights);
    max = Math.max(...weights);
  }
  return { total_kg: total, total_animales: count, promedio: avg, de, cv, uniformidad: unif, min_kg: min, max_kg: max };
}

function renderDetail(s, events, st) {
  $('dTitle').textContent = `Sesión #${s?.id ?? currentId} — Lote ${s?.lote ?? '—'}`;
  const partes = [
    s?.corral ?? s?.corral_origen ? `Corral ${s.corral ?? s.corral_origen}` : null,
    s?.destino ? `→ ${s.destino}` : null,
    s?.placa ?? s?.placa_vehiculo ? `Placa ${s.placa ?? s.placa_vehiculo}` : null,
    s?.conductor ? `Conductor: ${s.conductor}` : null,
    s?.operador ? `Operador: ${s.operador}` : null,
    s?.hora_entrada ? `Inicio ${fecha(s.hora_entrada)}` : null,
    s?.hora_salida ? `Cierre ${fecha(s.hora_salida)}` : null,
  ].filter(Boolean);
  $('dMeta').textContent = partes.join(' · ') || 'Sin datos de cabecera';

  const cards = [
    ['Total', st?.total_kg != null ? `${fmt(st.total_kg)} <em>kg</em>` : '—'],
    ['Cerdos', st?.total_animales != null ? Number(st.total_animales) || 0 : '—'],
    ['Promedio', (st?.promedio ?? st?.promedio_final) != null ? `${fmt(st.promedio ?? st.promedio_final)} <em>kg</em>` : '—'],
    ['Desv. estándar', st?.de != null ? `${fmt(st.de)} <em>kg</em>` : '—'],
    ['CV%', st?.cv != null ? `${fmt(st.cv)} <em>%</em>` : '—'],
    ['Uniformidad ±10%', st?.uniformidad != null ? `${fmt(st.uniformidad, 0)} <em>%</em>` : '—'],
  ];
  if (st?.min_kg != null && st?.max_kg != null) {
    cards.push(['Mín / Máx est.', `${fmt(st.min_kg)}–${fmt(st.max_kg)} <em>kg</em>`]);
  }
  if (s?.conteo_fisico != null) cards.push(['Conteo físico', Number(s.conteo_fisico) || 0]);
  if (s?.diferencia_conciliacion != null) cards.push(['Dif. conciliación', Number(s.diferencia_conciliacion) || 0]);
  $('dStats').innerHTML = cards.map(([k, v]) =>
    `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  const log = $('dLog');
  log.innerHTML = '';
  const sorted = [...events].sort((a, b) => (b?.ts_ms ?? 0) - (a?.ts_ms ?? 0));
  for (const ev of sorted) {
    const tipo = ev?.tipo ?? 'subida';
    const delta = Number(ev?.delta_kg ?? 0);
    const down = tipo === 'bajada' || delta < 0;
    const amb = !!ev?.ambiguo && ev?.animales_confirmados == null;
    const n = ev?.animales_confirmados ?? ev?.animales_estimados;
    let txt;
    if (tipo === 'referencia') txt = `Referencia: ${fmt(Math.abs(delta))} kg`;
    else if (amb) txt = `${delta > 0 ? 'Subida' : 'Bajada'} de ${fmt(Math.abs(delta))} kg — sin confirmar`;
    else if (down) txt = `Bajada de ${Math.abs(n ?? 1)} (${fmt(delta)} kg)${ev?.motivo_bajada ? ` · motivo: ${ev.motivo_bajada}` : ''}`;
    else txt = `${tipo === 'reingreso' ? 'Reingreso' : 'Subida'} de ${Math.abs(n ?? 1)} (+${fmt(delta)} kg)`;
    if (ev?.confirmado_por) txt += ` · confirmado por ${ev.confirmado_por}`;
    const div = document.createElement('div');
    div.className = 'ev ' + (amb ? 'amb-ev' : down ? 'down' : 'up');
    div.innerHTML =
      `<span class="t mono">${hora(ev?.ts_ms)}</span>` +
      `<span class="badge-ev">${amb ? '⚠' : down ? '⬇' : '⬆'}</span>` +
      `<span class="d">${escapeHtml(txt)}</span>`;
    log.appendChild(div);
  }
  if (!sorted.length) log.innerHTML = '<div class="empty">Sin eventos registrados.</div>';
}

$('dBack').onclick = () => {
  $('detailCard').hidden = true;
  $('listCard').hidden = false;
  currentId = null;
};
$('dExport').onclick = () => {
  if (currentId == null) return;
  if (DEMO) { alert('Exportar Excel no está disponible en modo demo.'); return; }
  window.open(`/api/sessions/${currentId}/export.xlsx`, '_blank');
};
$('bRefresh').onclick = () => { loadSessions().catch(() => {}); };

/* ============================================================
   MODO DEMO
   ============================================================ */
function demoData() {
  const base = Date.now() - 86400000;
  const mkEvents = (sid, pesos) => {
    let id = sid * 100, t = base + sid * 3600000;
    const evs = [];
    pesos.forEach((grupo, i) => {
      const delta = grupo.reduce((a, b) => a + b, 0);
      t += 45000 + Math.random() * 60000;
      evs.push({
        id: ++id, session_id: sid, ts_ms: t, delta_kg: delta,
        tipo: i === 0 ? 'referencia' : 'subida',
        animales_estimados: grupo.length, animales_confirmados: grupo.length,
      });
    });
    // una bajada con motivo
    t += 60000;
    evs.push({
      id: ++id, session_id: sid, ts_ms: t, delta_kg: -pesos[1][0],
      tipo: 'bajada', animales_estimados: -1, animales_confirmados: -1, motivo_bajada: 'estres',
    });
    return evs;
  };
  const grupos1 = [[104.2], [98.7], [101.3, 109.9], [95.2, 103.1, 111.4], [99.8], [106.5, 97.2]];
  const grupos2 = [[92.1], [88.4, 90.2], [95.7], [101.2, 84.3], [93.8]];
  const ev1 = mkEvents(1, grupos1), ev2 = mkEvents(2, grupos2);
  const sum = evs => evs.reduce((a, e) => a + e.delta_kg, 0);
  const cnt = evs => evs.reduce((a, e) => a + (e.animales_confirmados ?? 0), 0);
  return {
    sessions: [
      {
        id: 2, lote: 'L-2408', corral: 'C-03', destino: 'Planta Sur', estado: 'abierta',
        operador: 'M. Rojas', hora_entrada: base + 2 * 3600000,
        total_kg: sum(ev2), total_animales: cnt(ev2),
        promedio_final: sum(ev2) / cnt(ev2),
      },
      {
        id: 1, lote: 'L-2407', corral: 'C-14', destino: 'Planta Norte', estado: 'cerrada',
        placa: 'ABC-123', conductor: 'J. Pérez', operador: 'M. Rojas',
        hora_entrada: base + 3600000, hora_salida: base + 3600000 + 42 * 60000,
        total_kg: sum(ev1), total_animales: cnt(ev1),
        promedio_final: sum(ev1) / cnt(ev1),
        conteo_fisico: cnt(ev1) + 1, diferencia_conciliacion: 1,
      },
    ],
    events: { 1: ev1, 2: ev2 },
  };
}
let DDATA = null;
function demoApi(path) {
  DDATA ??= demoData();
  return new Promise((resolve, reject) => setTimeout(() => {
    if (path === '/api/sessions') return resolve(DDATA.sessions);
    let m = path.match(/^\/api\/sessions\/(\d+)$/);
    if (m) return resolve(DDATA.sessions.find(s => s.id === +m[1]) ?? {});
    m = path.match(/^\/api\/sessions\/(\d+)\/events$/);
    if (m) return resolve(DDATA.events[+m[1]] ?? []);
    m = path.match(/^\/api\/sessions\/(\d+)\/stats$/);
    if (m) return reject(new Error('sin stats en demo — se calcula en cliente'));
    resolve({});
  }, 120));
}

/* ============================================================
   ARRANQUE
   ============================================================ */
(function init() {
  if (DEMO) $('demoBanner').classList.add('show');
  loadSessions().catch(() => {});
})();
