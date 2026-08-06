/**
 * Print-view del informe de pesaje — co-branding "PorciPeso · una solución ELEIA".
 *
 * DIFERENCIA DOCUMENTADA con el escritorio: en el servidor Python,
 * GET /api/sessions/{id}/report.pdf genera un PDF real con reportlab
 * (porcipeso/api/reports.py). reportlab NO corre dentro del APK, así
 * que el shim responde la MISMA ruta con este HTML imprimible (misma
 * estructura y misma marca, @media print limpio) y la UI móvil abre la
 * vista y llama window.print(): en Android el diálogo del sistema
 * genera el PDF nativo ("Guardar como PDF").
 *
 * Las constantes de marca REPLICAN porcipeso/branding/__init__.py
 * (fuente de verdad Python); si cambian allá, cambian aquí.
 */

// ------------------------------------------------- marca (espejo de branding)

export const BRAND = {
  PRODUCT_NAME: "PorciPeso",
  COMPANY: "ELEIA",
  TAGLINE_PRODUCT: "la báscula que te habla claro",
  TAGLINE_COMPANY: "Soluciones robustas en Industria 4.0",
  LOCKUP: "PorciPeso · una solución ELEIA",
  ELEIA_GREEN: "#76B82A",
  ELEIA_GREEN_DARK: "#5C9321",
  ELEIA_CHARCOAL: "#3A3A3A",
  PORCIPESO_GREEN: "#178A50",
  CARD_BG: "#EFF6E6",
  CARD_BORDER: "#C9E0A3",
  NOTE_BG: "#F2F7EA",
  ZEBRA: "#F4F6F2",
  BORDER: "#D8DED2",
} as const;

//: tipos de evento → texto humano (espejo de reports.TIPO_HUMANO).
// Exportado para que el CSV tabular use la MISMA traducción (sin drift).
export const TIPO_HUMANO: Record<string, string> = {
  referencia: "Cerdo de prueba",
  subida: "Subida",
  bajada: "Bajada",
  reingreso: "Reingreso",
  ajuste: "Ajuste",
};

type Dict = Record<string, unknown>;

// ------------------------------------------------------------------ helpers

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function fmt(v: unknown, decimals = 1): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return esc(v);
  return n.toFixed(decimals);
}

function fecha(iso: unknown): string {
  if (!iso) return "—";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString("es", { dateStyle: "short", timeStyle: "short" });
}

function horaMs(tsMs: unknown): string {
  const n = Number(tsMs);
  if (!Number.isFinite(n)) return "—";
  return new Date(n).toLocaleTimeString("es");
}

function notaHumana(stats: Dict): string {
  const u = stats["uniformidad_pct"];
  if (u === null || u === undefined) {
    return "Sin muestras individuales suficientes para medir qué tan parejo está el lote.";
  }
  const pct = Math.round(Number(u));
  return Number(u) >= 70
    ? `Lote parejo: ${pct}% de los cerdos pesados uno a uno están cerca del promedio.`
    : `Lote disparejo: solo ${pct}% está cerca del promedio — hay cerdos muy distintos entre sí.`;
}

function kvRows(rows: Array<[string, string]>): string {
  return rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`)
    .join("");
}

// -------------------------------------------------------------------- HTML

/**
 * Informe de UNA sesión: misma estructura que build_session_pdf
 * (encabezado con lockup, datos del lote, totales, estadística con nota
 * en humano, movimientos, conciliación y pie de marca).
 */
export function buildReportHtml(
  session: Dict,
  events: Dict[],
  stats: Dict,
  version: string,
): string {
  const modo = String(session["modo"] ?? "lote");
  const totalKg = Number(session["total_kg"] ?? stats["total_kg"] ?? 0);
  const animales = Number(session["total_animales"] ?? stats["total_animales"] ?? 0);
  const promedioRaw = session["promedio_final"] ?? stats["promedio"];
  const promedio = promedioRaw === null || promedioRaw === undefined ? null : Number(promedioRaw);

  const tipoMuestra =
    String(stats["tipo_muestra"] ?? "") === "completa"
      ? "Completa (cada cerdo pesado individualmente)"
      : "Estimada (muestra de subidas de a un cerdo)";

  const movRows = events
    .map((ev) => {
      const n = ev["animales_confirmados"] ?? ev["animales_estimados"];
      let detalle = String(ev["motivo_bajada"] ?? "");
      if (ev["animales_confirmados"] !== null && ev["animales_confirmados"] !== undefined) {
        const por = String(ev["confirmado_por"] ?? "").trim();
        const extra = por ? `confirmado por ${por}` : "confirmado por el operador";
        detalle = detalle ? `${detalle} · ${extra}` : extra;
      } else if (ev["ambiguo"]) {
        const extra = "peso ambiguo (sin confirmar)";
        detalle = detalle ? `${detalle} · ${extra}` : extra;
      }
      return `<tr>
        <td>${horaMs(ev["ts_ms"])}</td>
        <td>${esc(TIPO_HUMANO[String(ev["tipo"])] ?? ev["tipo"])}</td>
        <td class="num">${fmt(ev["delta_kg"], 1)} kg</td>
        <td class="num">${fmt(n, 0)}</td>
        <td>${esc(detalle)}</td>
      </tr>`;
    })
    .join("");

  const conciliacion =
    session["conteo_fisico"] === null || session["conteo_fisico"] === undefined
      ? ""
      : `<h2>Conciliación</h2>
         <table class="kv">${kvRows([
           ["Conteo físico (contado a mano)", fmt(session["conteo_fisico"], 0)],
           ["Conteo de la báscula", fmt(animales, 0)],
           ["Diferencia", fmt(session["diferencia_conciliacion"], 0)],
         ])}</table>` +
        (Number(session["diferencia_conciliacion"]) === 0
          ? `<div class="nota"><b>En cristiano:</b> el conteo cuadró perfecto.</div>`
          : "");

  const generado = new Date().toLocaleString("es");
  const B = BRAND;
  // Sesión de PRÁCTICA (báscula simulada): el informe lo DICE — chip DEMO
  // en la banda + callout arriba (espejo de reports.py). Jamás debe
  // circular como pesaje real.
  const esDemo = Boolean(session["es_demo"]);

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(B.PRODUCT_NAME)} — Informe de pesaje</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{margin:0;padding:24px;background:#fff;color:${B.ELEIA_CHARCOAL};
    font:13px/1.5 Helvetica,Arial,sans-serif}
  .sheet{max-width:760px;margin:0 auto}
  .band{background:${B.ELEIA_GREEN};border-radius:8px;padding:16px 18px 14px;
    color:#fff;border-bottom:4px solid ${B.ELEIA_GREEN_DARK}}
  .band-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
  .band h1{margin:0;font-size:24px;letter-spacing:.01em;color:#fff}
  .band h1 small{font-weight:400;font-size:15px}
  .band .sub{font-size:10.5px;color:#EAF5DA;margin-top:2px}
  .lockup{text-align:right;font-weight:700;font-size:14px;color:#fff;white-space:nowrap}
  .lockup small{display:block;font-weight:400;font-size:9px;color:#EAF5DA}
  .band-chips{display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}
  .chip{background:${B.ELEIA_GREEN_DARK};color:#fff;font-weight:700;font-size:11px;
    border-radius:99px;padding:4px 12px}
  .chip-demo{background:#B45309;letter-spacing:.08em}
  .nota.demo-nota{margin-top:10px;border-left-color:#B45309}
  .band-dates{font-size:10.5px;color:#EAF5DA}
  h2{font-size:13px;margin:22px 0 7px;text-transform:uppercase;letter-spacing:.05em;
    border-left:4px solid ${B.ELEIA_GREEN};padding-left:8px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  table.kv th{width:42%;text-align:left;font-weight:700;padding:5px 9px;
    border:1px solid ${B.BORDER}}
  table.kv td{padding:5px 9px;border:1px solid ${B.BORDER}}
  table.kv tr:nth-child(even){background:${B.ZEBRA}}
  .cards{display:flex;gap:10px}
  .card{flex:1;text-align:center;padding:14px 6px 10px;background:${B.CARD_BG};
    border:1px solid ${B.CARD_BORDER};border-radius:10px;position:relative}
  .card::before{content:"";position:absolute;top:6px;left:50%;width:34px;height:3px;
    margin-left:-17px;background:${B.ELEIA_GREEN};border-radius:2px}
  .card .v{font-size:22px;font-weight:700;color:${B.PORCIPESO_GREEN};margin-top:4px}
  .card .k{font-size:8.5px;font-weight:700;letter-spacing:.12em;margin-top:3px}
  table.data th{background:${B.ELEIA_GREEN};color:#fff;text-align:left;padding:6px 9px;
    border:1px solid ${B.ELEIA_GREEN_DARK};border-bottom:2px solid ${B.ELEIA_GREEN_DARK}}
  table.data th.num{text-align:right}
  table.data td{padding:6px 9px;border:1px solid ${B.BORDER}}
  table.data tr:nth-child(even) td{background:${B.ZEBRA}}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .nota{background:${B.NOTE_BG};border-left:4px solid ${B.ELEIA_GREEN};
    padding:9px 12px;margin-top:8px;border-radius:0 6px 6px 0}
  footer{margin-top:28px;border-top:2px solid ${B.ELEIA_GREEN};padding-top:8px;
    font-size:9.5px;color:${B.ELEIA_CHARCOAL};display:flex;justify-content:space-between}
  footer b{color:${B.ELEIA_GREEN_DARK}}
  @media print{
    body{padding:0}
    .sheet{max-width:none}
    .band{border-radius:6px}
    h2{break-after:avoid}
    .cards,.nota,table.kv tr,table.data tr{break-inside:avoid}
    table.data thead{display:table-header-group}
  }
</style>
</head>
<body>
<div class="sheet">
  <header class="band">
    <div class="band-top">
      <div>
        <h1>${esc(B.PRODUCT_NAME)} <small>— Informe de pesaje</small></h1>
        <div class="sub">una solución ${esc(B.COMPANY)} · ${esc(B.TAGLINE_COMPANY)}</div>
      </div>
      <div class="lockup">${esc(B.COMPANY)}</div>
    </div>
    <div class="band-chips">
      ${esDemo ? `<span class="chip chip-demo">DEMO</span>` : ""}
      <span class="chip">${esc(session["lote"] ?? "Sin lote")}</span>
      <span class="band-dates">Entrada ${fecha(session["hora_entrada"])} · Salida ${fecha(
        session["hora_salida"],
      )}</span>
    </div>
  </header>
  ${
    esDemo
      ? `<div class="nota demo-nota"><b>PESAJE DE PRÁCTICA (DEMO):</b> hecho con la
        báscula simulada. No es un pesaje real, no cuenta en las estadísticas y se
        borra solo una hora después de cerrado.</div>`
      : ""
  }

  <h2>Datos del lote</h2>
  <table class="kv">${kvRows([
    ["Lote", esc(session["lote"] ?? "—")],
    ["Entrada", fecha(session["hora_entrada"])],
    ["Salida", fecha(session["hora_salida"])],
    ["Corral de origen", esc(session["corral_origen"] ?? "—")],
    ["Destino", esc(session["destino"] ?? "—")],
    ["Placa del camión", esc(session["placa"] ?? "—")],
    ["Conductor", esc(session["conductor"] ?? "—")],
    ["Operador", esc(session["operador"] ?? "—")],
    ["Modo de pesaje", modo === "unidades"
      ? "Por unidades (un cerdo a la vez)"
      : "Por lote (cerdo de prueba + grupos)"],
    ["Estado", esc(cap(String(session["estado"] ?? "—")))],
  ])}</table>

  <h2>Totales</h2>
  <div class="cards">
    <div class="card"><div class="v">${Math.trunc(animales)}</div><div class="k">CERDOS</div></div>
    <div class="card"><div class="v">${fmt(totalKg, 1)} kg</div><div class="k">PESO TOTAL</div></div>
    <div class="card"><div class="v">${promedio === null ? "—" : fmt(promedio, 1) + " kg"}</div>
      <div class="k">PROMEDIO POR CERDO</div></div>
  </div>

  <h2>Estadística del lote</h2>
  <table class="kv">${kvRows([
    ["Mediana (kg)", fmt(stats["mediana"], 2)],
    ["Desviación estándar muestral (kg)", fmt(stats["desviacion_std"], 2)],
    ["Varianza muestral (kg²)", fmt(stats["varianza"], 2)],
    ["CV %", fmt(stats["cv_pct"], 2)],
    ["Uniformidad ±10% (%)", fmt(stats["uniformidad_pct"], 2)],
    ["Tipo de muestra", tipoMuestra],
    ["Muestras individuales (n)", fmt(stats["n_muestras"], 0)],
  ])}</table>
  <div class="nota"><b>En cristiano:</b> ${esc(notaHumana(stats))}</div>

  <h2>Movimientos</h2>
  ${
    movRows
      ? `<table class="data">
          <thead><tr><th>Hora</th><th>Movimiento</th><th class="num">Peso (kg)</th>
            <th class="num">Animales</th><th>Motivo / detalle</th></tr></thead>
          <tbody>${movRows}</tbody>
        </table>`
      : "<p>Sin movimientos registrados.</p>"
  }
  ${conciliacion}

  <footer>
    <span><b>${esc(B.LOCKUP)}</b> · Generado por ${esc(B.PRODUCT_NAME)} v${esc(version)} · ${esc(generado)}</span>
    <span>${esc(B.COMPANY)}</span>
  </footer>
</div>
</body>
</html>`;
}

// ------------------------------------------------------------ impresión

/**
 * Abre el print-view en un iframe oculto y lanza window.print():
 * en Android WebView el diálogo del sistema ofrece "Guardar como PDF"
 * (PDF nativo, sin reportlab). En web dev hace lo mismo con el diálogo
 * de impresión del navegador.
 */
export function openPrintView(html: string, doc: Document = document): void {
  const frame = doc.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.setAttribute("aria-hidden", "true");
  frame.srcdoc = html;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      // se limpia después de que el diálogo tomó el documento
      setTimeout(() => frame.remove(), 60_000);
    }
  };
  doc.body.appendChild(frame);
}
