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
  ELEIA_CHARCOAL: "#3A3A3A",
  PORCIPESO_GREEN: "#178A50",
} as const;

//: tipos de evento → texto humano (espejo de reports.TIPO_HUMANO)
const TIPO_HUMANO: Record<string, string> = {
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
      return `<tr>
        <td>${horaMs(ev["ts_ms"])}</td>
        <td>${esc(TIPO_HUMANO[String(ev["tipo"])] ?? ev["tipo"])}</td>
        <td class="num">${fmt(ev["delta_kg"], 1)} kg</td>
        <td class="num">${fmt(n, 0)}</td>
        <td>${esc(ev["motivo_bajada"] ?? "")}</td>
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
         ])}</table>`;

  const generado = new Date().toLocaleString("es");
  const B = BRAND;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(B.PRODUCT_NAME)} — Informe de pesaje</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:#fff;color:${B.ELEIA_CHARCOAL};
    font:13px/1.5 Helvetica,Arial,sans-serif}
  .sheet{max-width:760px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:flex-end;
    border-bottom:3px solid ${B.ELEIA_GREEN};padding-bottom:10px}
  header h1{margin:0;font-size:26px;letter-spacing:.02em}
  header .sub{font-size:10.5px;color:${B.ELEIA_CHARCOAL}}
  .lockup{font-size:12px;font-weight:700;color:${B.ELEIA_GREEN};text-align:right}
  .lockup small{display:block;font-weight:400;font-size:9.5px;color:${B.ELEIA_CHARCOAL}}
  h2{font-size:14px;margin:20px 0 6px;text-transform:uppercase;letter-spacing:.04em}
  table{width:100%;border-collapse:collapse;font-size:12px}
  table.kv th{width:42%;text-align:left;font-weight:700;padding:4px 8px}
  table.kv td{padding:4px 8px}
  table.kv tr:nth-child(even){background:#F4F6F2}
  .cards{display:flex;border:1.5px solid ${B.ELEIA_GREEN};background:#EFF6E6}
  .card{flex:1;text-align:center;padding:12px 6px}
  .card+.card{border-left:1px solid ${B.ELEIA_GREEN}}
  .card .v{font-size:22px;font-weight:700;color:${B.PORCIPESO_GREEN}}
  .card .k{font-size:9px;letter-spacing:.12em;margin-top:2px}
  table.data th{background:${B.ELEIA_GREEN};color:#fff;text-align:left;padding:5px 8px}
  table.data td{padding:5px 8px;border-bottom:1px solid #E2E7DE}
  table.data tr:nth-child(even) td{background:#F4F6F2}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .nota{background:#F2F7EA;border-left:3px solid ${B.ELEIA_GREEN};
    padding:8px 12px;margin-top:8px}
  footer{margin-top:26px;border-top:1px solid ${B.ELEIA_GREEN};padding-top:8px;
    font-size:9.5px;color:${B.ELEIA_CHARCOAL};display:flex;justify-content:space-between}
  @media print{
    body{padding:0}
    .sheet{max-width:none}
    h2{break-after:avoid}
    table.data tr{break-inside:avoid}
  }
</style>
</head>
<body>
<div class="sheet">
  <header>
    <div>
      <h1>${esc(B.PRODUCT_NAME)}</h1>
      <div class="sub">Informe de pesaje · ${esc(B.TAGLINE_PRODUCT)}</div>
    </div>
    <div class="lockup">una solución ${esc(B.COMPANY)}
      <small>${esc(B.TAGLINE_COMPANY)}</small></div>
  </header>

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
    ["Estado", esc(session["estado"] ?? "—")],
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
          <thead><tr><th>Hora</th><th>Movimiento</th><th>Peso (Δ)</th>
            <th>Animales</th><th>Motivo</th></tr></thead>
          <tbody>${movRows}</tbody>
        </table>`
      : "<p>Sin movimientos registrados.</p>"
  }
  ${conciliacion}

  <footer>
    <span>${esc(B.LOCKUP)} · Generado por ${esc(B.PRODUCT_NAME)} v${esc(version)} · ${esc(generado)}</span>
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
