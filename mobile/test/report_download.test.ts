/**
 * Flujo de descarga del informe PDF (LocalBackend.downloadReport) con el
 * generador jsPDF MOCKEADO — así probamos el CABLEADO de entrega sin
 * depender del render real:
 *   · NATIVO: escribe/comparte un archivo .pdf (shareReport recibe bytes).
 *   · WEB: descarga con jsPDF `.save('informe_sesion_{id}.pdf')`.
 *
 * (El render REAL del PDF se valida en report_pdf.test.ts, y el flujo
 *  nativo con bytes %PDF reales en export.test.ts.)
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// Estado compartido con la fábrica del mock (vi.hoisted: se puede referenciar
// dentro de vi.mock, que se eleva al tope del módulo).
const H = vi.hoisted(() => ({
  saved: [] as string[], // filenames pasados a doc.save() (camino web)
  builds: 0, // veces que se construyó el doc
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x33]), // "%PDF-1.3"
}));

vi.mock("../src/report-pdf", () => ({
  buildReportDoc: () => {
    H.builds++;
    return {
      output: (type: string) => (type === "arraybuffer" ? H.bytes.slice().buffer : ""),
      save: (filename?: string) => {
        H.saved.push(String(filename));
      },
    };
  },
  reportPdfBytes: () => H.bytes,
}));

import { Hub, LocalBackend } from "../src/apishim";
import { createSqlJsDriver, Repo } from "../src/db";

const WASM = new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url).pathname;

async function makeBackend(deps: Partial<ConstructorParameters<typeof LocalBackend>[0]> = {}) {
  const driver = await createSqlJsDriver({ locateFile: () => WASM });
  const repo = await Repo.create(driver);
  return new LocalBackend({ repo, profiles: [], hub: new Hub(), ...deps });
}

describe("downloadReport — cableado de entrega (mock del generador)", () => {
  beforeEach(() => {
    H.saved.length = 0;
    H.builds = 0;
  });

  it("NATIVO: shareReport recibe (informe_sesion_{id}.pdf, bytes) y NO usa .save", async () => {
    const shared: Array<{ filename: string; bytes: Uint8Array }> = [];
    const backend = await makeBackend({
      shareReport: async (filename, bytes) => {
        shared.push({ filename, bytes });
      },
    });
    const sid = await backend.repo.createSession({ lote: "Nativo" });
    const ok = await backend.downloadReport(sid);
    expect(ok).toBe(true);
    expect(H.builds).toBe(1);
    expect(shared).toHaveLength(1);
    expect(shared[0].filename).toBe(`informe_sesion_${sid}.pdf`);
    // los bytes salen de doc.output('arraybuffer') → cabecera %PDF
    const b = shared[0].bytes;
    expect(String.fromCharCode(b[0], b[1], b[2], b[3])).toBe("%PDF");
    // camino nativo: nunca toca .save()
    expect(H.saved).toEqual([]);
    await backend.repo.close();
  });

  it("WEB: sin shareReport pero con document → doc.save('informe_sesion_{id}.pdf')", async () => {
    const g = globalThis as unknown as { document?: unknown };
    g.document = {}; // fuerza el camino WEB (typeof document !== "undefined")
    try {
      const backend = await makeBackend(); // sin shareReport
      const sid = await backend.repo.createSession({ lote: "Web" });
      const ok = await backend.downloadReport(sid);
      expect(ok).toBe(true);
      expect(H.builds).toBe(1);
      expect(H.saved).toEqual([`informe_sesion_${sid}.pdf`]);
      await backend.repo.close();
    } finally {
      delete g.document;
    }
  });

  it("sesión inexistente → false y no construye nada", async () => {
    const backend = await makeBackend({ shareReport: async () => {} });
    expect(await backend.downloadReport(99999)).toBe(false);
    expect(H.builds).toBe(0);
    await backend.repo.close();
  });
});
