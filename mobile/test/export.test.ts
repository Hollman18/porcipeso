/**
 * Exportación móvil — dos arreglos:
 *  1. CSV TABULAR de sesión (encabezados = campos, una fila de datos) con
 *     BOM UTF-8 correcto (sin mojibake "SesiÃ³n") y sección de movimientos
 *     en español con fechas legibles.
 *  2. "Descargar PDF": en el APK window.print() es un no-op, así que el
 *     informe se entrega como ARCHIVO real (shareReport). En web sigue el
 *     print-view + window.print() de siempre.
 */
import { describe, expect, it } from "vitest";
import {
  bytesToBase64,
  buildCsv,
  csvToUtf8Bytes,
  CSV_DEMO_WARNING,
  EVENT_COLUMNS,
  fechaCsv,
  Hub,
  LocalBackend,
} from "../src/apishim";
import { openPrintView } from "../src/reportview";
import { createSqlJsDriver, Repo } from "../src/db";

const WASM = new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url).pathname;

// -------------------------------------------------------------- parser CSV
/** Parte una línea CSV respetando comillas y comas escapadas. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** CRLF-split; el sufijo "\r\n" final deja una entrada vacía que se ignora. */
function csvLines(csv: string): string[] {
  const parts = csv.split("\r\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// ------------------------------------------------------------- fixtures
function sampleSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    uuid: "abc-123",
    granja: "El Roble",
    lote: "Lote 5",
    corral_origen: "C-4",
    destino: "Planta Norte, Km 5", // <- coma: fuerza el escape con comillas
    placa: "ABC123",
    conductor: "Juan Pérez",
    operador: "María",
    bascula_id: "Matrix-01",
    peso_ref_inicial: 100.5,
    hora_entrada: "2026-08-01T08:30:00",
    hora_salida: "2026-08-01T09:45:00",
    total_kg: 1234.5,
    total_animales: 12,
    promedio_final: 102.9,
    conteo_fisico: 12,
    diferencia_conciliacion: 0,
    estado: "cerrada",
    modo: "lote",
    es_demo: 0,
    ...overrides,
  };
}

const sampleStats: Record<string, unknown> = {
  desviacion_std: 4.21,
  cv_pct: 4.1,
  uniformidad_pct: 91.7,
  min_delta: 95,
  max_delta: 110,
};

function sampleEvents(): Array<Record<string, unknown>> {
  return [
    {
      id: 1, ts_ms: 1_722_500_000_000, tipo: "referencia", peso_antes: 0,
      peso_despues: 100, delta_kg: 100, animales_estimados: 1,
      animales_confirmados: null, estab_ms: 800, ambiguo: false, opciones: [],
      motivo_bajada: null, evento_relacionado_id: null, confirmado_por: null,
    },
    {
      id: 2, ts_ms: 1_722_500_060_000, tipo: "subida", peso_antes: 100,
      peso_despues: 300, delta_kg: 200, animales_estimados: 2,
      animales_confirmados: 2, estab_ms: 900, ambiguo: true, opciones: [1, 2],
      motivo_bajada: null, evento_relacionado_id: null, confirmado_por: "operador",
    },
  ];
}

// =================================================================== CSV
describe("CSV tabular — estructura y contenido", () => {
  const csv = buildCsv(sampleSession(), sampleEvents(), sampleStats);
  const lines = csvLines(csv);

  it("primera fila = encabezados de RESUMEN, en el orden esperado", () => {
    const header = parseCsvLine(lines[0]);
    expect(header.slice(0, 6)).toEqual([
      "Sesión", "UUID", "Granja", "Lote", "Corral origen", "Destino",
    ]);
    // últimas columnas = estadística
    expect(header.slice(-5)).toEqual([
      "Desviación estándar kg", "CV %", "Uniformidad ±10%",
      "Delta mínimo kg", "Delta máximo kg",
    ]);
    expect(header).toContain("DEMO");
    expect(header).toContain("Modo");
    expect(header).toContain("Báscula");
  });

  it("segunda fila = valores, con la MISMA cantidad de columnas (round-trip)", () => {
    const header = parseCsvLine(lines[0]);
    const row = parseCsvLine(lines[1]);
    expect(row.length).toBe(header.length);
    // mapea encabezado→valor y verifica algunos campos
    const map = Object.fromEntries(header.map((h, i) => [h, row[i]]));
    expect(map["Sesión"]).toBe("7");
    expect(map["Lote"]).toBe("Lote 5");
    expect(map["Báscula"]).toBe("Matrix-01");
    expect(map["Estado"]).toBe("cerrada");
    expect(map["Modo"]).toBe("lote");
    expect(map["DEMO"]).toBe("No");
    expect(map["Uniformidad ±10%"]).toBe("91.7");
    // fecha legible YYYY-MM-DD HH:MM (misma que fechaCsv)
    expect(map["Hora entrada"]).toBe(fechaCsv("2026-08-01T08:30:00"));
    expect(map["Hora entrada"]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("escapa con comillas los valores con coma (Destino)", () => {
    // la línea cruda debe llevar el campo entre comillas
    expect(lines[1]).toContain('"Planta Norte, Km 5"');
    // y al re-parsear vuelve intacto
    const header = parseCsvLine(lines[0]);
    const row = parseCsvLine(lines[1]);
    const map = Object.fromEntries(header.map((h, i) => [h, row[i]]));
    expect(map["Destino"]).toBe("Planta Norte, Km 5");
  });

  it("fila en blanco separa RESUMEN de MOVIMIENTOS", () => {
    expect(lines[2]).toBe("");
    expect(parseCsvLine(lines[3])).toEqual([...EVENT_COLUMNS]);
  });

  it("MOVIMIENTOS: tipo en español, ambiguo Sí/No, fechas legibles, opciones limpias", () => {
    const movHeader = parseCsvLine(lines[3]);
    const idx = (name: string): number => movHeader.indexOf(name);
    const mov1 = parseCsvLine(lines[4]);
    const mov2 = parseCsvLine(lines[5]);

    expect(mov1[idx("tipo")]).toBe("Cerdo de prueba"); // referencia → humano
    expect(mov2[idx("tipo")]).toBe("Subida");
    expect(mov1[idx("ambiguo")]).toBe("No");
    expect(mov2[idx("ambiguo")]).toBe("Sí");
    expect(mov1[idx("opciones")]).toBe(""); // [] → vacío (sin basura)
    expect(mov2[idx("opciones")]).toBe("[1,2]");
    expect(mov1[idx("ts_ms")]).toBe(fechaCsv(1_722_500_000_000));
    expect(mov1[idx("ts_ms")]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(mov2[idx("confirmado_por")]).toBe("operador");
  });

  it("sesión DEMO: primera fila lleva el aviso de práctica", () => {
    const demoCsv = buildCsv(sampleSession({ es_demo: 1 }), sampleEvents(), sampleStats);
    const demoLines = csvLines(demoCsv);
    expect(demoLines[0]).toBe(CSV_DEMO_WARNING);
    // los encabezados de RESUMEN pasan a la fila 2
    expect(parseCsvLine(demoLines[1])[0]).toBe("Sesión");
    const header = parseCsvLine(demoLines[1]);
    const row = parseCsvLine(demoLines[2]);
    expect(Object.fromEntries(header.map((h, i) => [h, row[i]]))["DEMO"]).toBe("Sí");
  });
});

describe("CSV — bytes UTF-8 con BOM (sin mojibake)", () => {
  it("csvToUtf8Bytes antepone el BOM EF BB BF UNA sola vez", () => {
    const bytes = csvToUtf8Bytes("Sesión,Báscula\r\n1,±10%\r\n");
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    // el resto NO empieza con otro BOM
    expect([bytes[3], bytes[4], bytes[5]]).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it("round-trip: decodificar UTF-8 recupera tildes y símbolos", () => {
    const csv = buildCsv(sampleSession(), sampleEvents(), sampleStats);
    const bytes = csvToUtf8Bytes(csv);
    // ignoreBOM: conserva el U+FEFF para poder verificarlo (por defecto se
    // consume). Excel hace lo mismo: ve el BOM y lee el resto como UTF-8.
    const decoded = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(decoded.charCodeAt(0)).toBe(0xfeff); // BOM presente, una sola vez
    const body = decoded.slice(1);
    expect(body).toBe(csv); // exacto, sin doble codificación
    expect(body).toContain("Sesión");
    expect(body).toContain("Báscula");
    expect(body).toContain("Uniformidad ±10%");
    expect(body).toContain("Juan Pérez");
    // jamás debe aparecer la firma del mojibake
    expect(body).not.toContain("SesiÃ³n");
  });

  it("bytesToBase64 → base64 decodable a los mismos bytes", () => {
    const bytes = csvToUtf8Bytes("áé,í\r\n");
    const b64 = bytesToBase64(bytes);
    const back = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });
});

// ============================================================== informe
describe("Descargar informe (report) — flujo de descarga", () => {
  async function makeBackend(deps: Partial<ConstructorParameters<typeof LocalBackend>[0]> = {}) {
    const driver = await createSqlJsDriver({ locateFile: () => WASM });
    const repo = await Repo.create(driver);
    return new LocalBackend({ repo, profiles: [], hub: new Hub(), ...deps });
  }

  it("nativo: escribe/comparte un ARCHIVO (shareReport), no window.print()", async () => {
    const reports: Array<{ filename: string; html: string }> = [];
    const backend = await makeBackend({
      shareReport: async (filename, html) => {
        reports.push({ filename, html });
      },
    });
    const sid = await backend.repo.createSession({ lote: "Informe" });
    const okReport = await backend.reportAndPrint(sid);
    expect(okReport).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0].filename).toBe(`informe_sesion_${sid}.html`);
    expect(reports[0].html).toContain("PorciPeso");
    expect(reports[0].html).toContain("Informe"); // el lote sale en el informe
    await backend.repo.close();
  });

  it("web: sin shareReport y sin DOM → no revienta (devuelve false)", async () => {
    const backend = await makeBackend(); // sin shareReport
    const sid = await backend.repo.createSession({ lote: "Web" });
    // en Node no hay `document`: el camino web queda inerte, sin lanzar
    expect(typeof document).toBe("undefined");
    expect(await backend.reportAndPrint(sid)).toBe(false);
    await backend.repo.close();
  });
});

describe("openPrintView (fallback web) — imprime en un iframe oculto", () => {
  it("crea el iframe, inyecta el HTML y dispara print()", async () => {
    const state = { srcdoc: "", printed: false, appended: 0, focused: false };
    const el: Record<string, unknown> = {
      style: {},
      setAttribute: () => {},
      onload: null,
      remove: () => {},
      contentWindow: {
        focus: () => {
          state.focused = true;
        },
        print: () => {
          state.printed = true;
        },
      },
    };
    Object.defineProperty(el, "srcdoc", {
      set(v: string) {
        state.srcdoc = v;
        // el navegador dispara onload tras asignar srcdoc (async)
        queueMicrotask(() => (el.onload as (() => void) | null)?.());
      },
      get() {
        return state.srcdoc;
      },
    });
    const fakeDoc = {
      createElement: () => el,
      body: { appendChild: () => (state.appended += 1) },
    } as unknown as Document;

    openPrintView("<html><body>Informe</body></html>", fakeDoc);
    await new Promise((r) => setTimeout(r, 0));

    expect(state.appended).toBe(1);
    expect(state.srcdoc).toContain("Informe");
    expect(state.focused).toBe(true);
    expect(state.printed).toBe(true);
  });
});
