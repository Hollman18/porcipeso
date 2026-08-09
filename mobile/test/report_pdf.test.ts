/**
 * Generador de PDF REAL del informe de sesión (jsPDF + jspdf-autotable,
 * ver src/report-pdf.ts). Verifica que produce bytes %PDF válidos, incluye
 * las secciones del informe y marca el aviso DEMO solo cuando corresponde.
 *
 * Los textos se buscan en el stream del PDF decodificado como latin1 (jsPDF
 * escribe el contenido sin comprimir: `compress:false`). Se usan marcadores
 * ASCII (sin acentos) porque las tildes se codifican en WinAnsi y no
 * coinciden byte a byte con el UTF-8 del test.
 */
import { describe, expect, it } from "vitest";
import { buildReportDoc, reportPdfBytes } from "../src/report-pdf";

type Dict = Record<string, unknown>;

function sampleSession(overrides: Dict = {}): Dict {
  return {
    id: 42,
    uuid: "sess-42",
    granja: "Granja El Roble",
    lote: "Lote 2026-08 Norte",
    corral_origen: "C-7",
    destino: "Planta Km 12, Vereda La Esperanza",
    placa: "XKT-482",
    conductor: "Juan Carlos Pérez",
    operador: "María Fernanda",
    bascula_id: "Trumax-01",
    hora_entrada: "2026-08-08T07:15:00",
    hora_salida: "2026-08-08T09:42:00",
    total_kg: 4287.5,
    total_animales: 38,
    promedio_final: 112.8,
    conteo_fisico: 38,
    diferencia_conciliacion: 0,
    estado: "cerrada",
    modo: "lote",
    es_demo: 0,
    ...overrides,
  };
}

const sampleStats: Dict = {
  mediana: 111.5,
  desviacion_std: 8.42,
  varianza: 70.9,
  cv_pct: 7.46,
  uniformidad_pct: 82.3,
  tipo_muestra: "estimada",
  n_muestras: 12,
  promedio: 112.8,
  total_kg: 4287.5,
  total_animales: 38,
};

// referencia + subidas + un devuelto (AJUSTE) + un ambiguo confirmado
function sampleEvents(): Dict[] {
  return [
    {
      id: 1, ts_ms: 1_754_637_300_000, tipo: "referencia", peso_antes: 0,
      peso_despues: 108.5, delta_kg: 108.5, animales_estimados: 1,
      animales_confirmados: null, estab_ms: 850, ambiguo: false, opciones: [],
      motivo_bajada: null, evento_relacionado_id: null, confirmado_por: null,
    },
    {
      id: 2, ts_ms: 1_754_637_900_000, tipo: "subida", peso_antes: 108.5,
      peso_despues: 1245.0, delta_kg: 1136.5, animales_estimados: 6,
      animales_confirmados: 2, estab_ms: 1100, ambiguo: true, opciones: [6, 7],
      motivo_bajada: null, evento_relacionado_id: null, confirmado_por: "María Fernanda",
    },
    {
      id: 3, ts_ms: 1_754_638_500_000, tipo: "ajuste", peso_antes: 1245.0,
      peso_despues: 1132.2, delta_kg: -112.8, animales_estimados: -1,
      animales_confirmados: -1, estab_ms: 820, ambiguo: false, opciones: [],
      motivo_bajada: "cerdo devuelto al corral (no apto)", evento_relacionado_id: 2,
      confirmado_por: "operador",
    },
  ];
}

/** Decodifica los bytes del PDF como latin1 para poder buscar el texto. */
function pdfText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

describe("report-pdf — genera un PDF real", () => {
  const bytes = reportPdfBytes(sampleSession(), sampleEvents(), sampleStats, "2.4.2");

  it("cabecera %PDF y tamaño > 5 KB", () => {
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe("%PDF");
    expect(bytes.length).toBeGreaterThan(5000);
    // termina como un PDF válido (marcador EOF)
    expect(pdfText(bytes)).toContain("%%EOF");
  });

  it("incluye las secciones del informe", () => {
    const t = pdfText(bytes);
    for (const marker of [
      "PorciPeso",
      "Informe de pesaje",
      "DATOS DEL LOTE",
      "TOTALES",
      "CERDOS",
      "MOVIMIENTOS",
      "En cristiano",
    ]) {
      expect(t, `falta la sección/marcador: ${marker}`).toContain(marker);
    }
  });

  it("movimientos: tipos en español (Cerdo de prueba / Subida / Ajuste)", () => {
    const t = pdfText(bytes);
    expect(t).toContain("Cerdo de prueba"); // referencia → humano
    expect(t).toContain("Subida");
    expect(t).toContain("Ajuste");
  });

  it("aviso DEMO condicional: presente solo si es_demo", () => {
    // marcador ASCII (la Á/í se codifican en WinAnsi, no coinciden en UTF-8)
    const MARK = "PESAJE DE PR";
    const real = pdfText(reportPdfBytes(sampleSession({ es_demo: 0 }), sampleEvents(), sampleStats, "2.4.2"));
    const demo = pdfText(reportPdfBytes(sampleSession({ es_demo: 1 }), sampleEvents(), sampleStats, "2.4.2"));
    expect(real).not.toContain(MARK);
    expect(demo).toContain(MARK);
  });

  it("buildReportDoc devuelve un jsPDF con al menos una página", () => {
    const doc = buildReportDoc(sampleSession(), sampleEvents(), sampleStats, "2.4.2");
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });
});
