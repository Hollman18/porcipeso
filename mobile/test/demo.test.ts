/**
 * Sesiones DEMO (báscula simulada) — espejo móvil de tests/api/test_demo.py:
 * migración es_demo, marcado al crear con la simulada conectada,
 * exclusión de statsGlobal y AUTODESTRUCCIÓN (60 min tras el cierre;
 * jamás toca reales ni abiertas).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalBackend } from "../src/apishim";
import { createSqlJsDriver, Repo, SqlDriver } from "../src/db";
import type { ScaleProfile } from "../src/models";

const WASM = new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url).pathname;

const PROFILES: ScaleProfile[] = [];

function isoHaceMinutos(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString().slice(0, 19) + "+00:00";
}

async function makeDriver(): Promise<SqlDriver> {
  return createSqlJsDriver({ locateFile: () => WASM });
}

async function makeBackend(): Promise<LocalBackend> {
  const repo = await Repo.create(await makeDriver());
  return new LocalBackend({ repo, profiles: PROFILES, simOptions: { seed: 42 } });
}

async function call(
  backend: LocalBackend,
  method: string,
  path: string,
  body: unknown = null,
): Promise<{ status: number; json: any }> {
  const res = await backend.handleFetch(method, path, body !== null ? JSON.stringify(body) : null);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** Demo cerrada hace `cerradaHace` minutos (backdate directo en la fila). */
async function mkDemo(repo: Repo, lote: string, cerradaHace: number | null): Promise<number> {
  const sid = await repo.createSession({ lote, es_demo: 1 });
  if (cerradaHace !== null) {
    await repo.closeSession(sid, { total_kg: 100.0, count: 1, avg_kg: 100.0 });
    await repo["drv"].run("UPDATE sesiones SET hora_salida = ? WHERE id = ?", [
      isoHaceMinutos(cerradaHace),
      sid,
    ]);
  }
  return sid;
}

describe("db.ts — migración es_demo", () => {
  it("agrega la columna a una DB vieja sin es_demo y deja las filas como reales", async () => {
    const drv = await makeDriver();
    await drv.executeScript(`
      CREATE TABLE sesiones (
        id INTEGER PRIMARY KEY, uuid TEXT UNIQUE, lote TEXT,
        hora_entrada TEXT,
        estado TEXT NOT NULL DEFAULT 'abierta'
          CHECK (estado IN ('abierta', 'cerrada', 'anulada'))
      );
      INSERT INTO sesiones (uuid, lote, estado) VALUES ('u1', 'L-1', 'abierta');
    `);
    const repo = await Repo.create(drv); // migra: agrega modo Y es_demo
    const cols = await drv.query("PRAGMA table_info(sesiones)");
    expect(cols.some((c) => c["name"] === "es_demo")).toBe(true);
    const [row] = await drv.query("SELECT es_demo, modo FROM sesiones WHERE uuid = 'u1'");
    expect(row["es_demo"]).toBe(0);
    expect(row["modo"]).toBe("lote");
    // idempotente: re-crear el Repo sobre la misma DB no falla
    await Repo.create(drv);
    await repo.close();
  });

  it("una DB nueva trae es_demo con default 0", async () => {
    const repo = await Repo.create(await makeDriver());
    const sid = await repo.createSession({ lote: "L-real" });
    const session = await repo.getSession(sid);
    expect(session?.["es_demo"]).toBe(0);
    await repo.close();
  });
});

describe("apishim — marcado es_demo por perfil simulado", () => {
  let backend: LocalBackend;

  afterEach(async () => {
    await backend.stopDriver();
    await backend.repo.close();
  });

  it("sesión creada con la simulada conectada nace es_demo=1", async () => {
    backend = await makeBackend();
    vi.useFakeTimers();
    try {
      await call(backend, "POST", "/api/sim/start", {});
      const created = await call(backend, "POST", "/api/sessions", { lote: "L-práctica" });
      expect(created.status).toBe(201);
      expect(created.json.es_demo).toBe(1);
      const closed = await call(backend, "POST", `/api/sessions/${created.json.id}/close`, {});
      expect(closed.json.es_demo).toBe(1);
      await call(backend, "POST", "/api/sim/stop", {});
    } finally {
      vi.useRealTimers();
    }
  });

  it("sesión sin simulada nace real y la UI no puede forzar el flag", async () => {
    backend = await makeBackend();
    const real = await call(backend, "POST", "/api/sessions", { lote: "L-real" });
    expect(real.json.es_demo).toBe(0);
    // es_demo lo decide el backend por el perfil conectado, no el body
    const forzada = await call(backend, "POST", "/api/sessions", { lote: "L-x", es_demo: 1 });
    expect(forzada.json.es_demo).toBe(0);
  });
});

describe("db.ts — statsGlobal excluye demo (la lista sí las muestra)", () => {
  it("los totales solo suman sesiones reales", async () => {
    const repo = await Repo.create(await makeDriver());
    const real = await repo.createSession({ lote: "L-real" });
    await repo.closeSession(real, { total_kg: 500.0, count: 5, avg_kg: 100.0 });
    const demo = await repo.createSession({ lote: "L-demo", es_demo: 1 });
    await repo.closeSession(demo, { total_kg: 300.0, count: 3, avg_kg: 100.0 });

    const g = await repo.statsGlobal();
    expect(g["sesiones"]).toBe(1);
    expect(g["total_animales"]).toBe(5);
    expect(g["total_kg"]).toBeCloseTo(500.0);
    expect((g["por_lote"] as any[]).map((r) => r.lote)).toEqual(["L-real"]);

    // …pero listSessions la muestra con su flag (chip DEMO en la tabla)
    const list = await repo.listSessions();
    const porId = new Map(list.map((s) => [s["id"], s]));
    expect(porId.get(demo)?.["es_demo"]).toBe(1);
    expect(porId.get(real)?.["es_demo"]).toBe(0);
    await repo.close();
  });
});

describe("db.ts — autodestrucción de sesiones DEMO", () => {
  it("borra solo demo cerradas hace más de 60 min (respeta abiertas y reales)", async () => {
    const repo = await Repo.create(await makeDriver());
    const vieja = await mkDemo(repo, "D-vieja", 61);
    const reciente = await mkDemo(repo, "D-reciente", 30);
    const abierta = await repo.createSession({ lote: "D-abierta", es_demo: 1 });
    const real = await repo.createSession({ lote: "R-vieja" });
    await repo.closeSession(real, { total_kg: 200.0, count: 2, avg_kg: 100.0 });
    await repo["drv"].run("UPDATE sesiones SET hora_salida = ? WHERE id = ?", [
      isoHaceMinutos(600),
      real,
    ]);
    // eventos y lecturas de la demo vieja también deben irse
    await repo.insertEvent({
      id: null, session_id: vieja, ts_ms: 1000, peso_antes: 0, peso_despues: 100,
      delta_kg: 100, animales_estimados: 1, animales_confirmados: null,
      estab_ms: 0, tipo: "subida", ambiguo: false, opciones: [],
      motivo_bajada: null, confirmado_por: null,
    });
    await repo.insertReading(vieja, 1000, 100.0);

    expect(await repo.cleanupDemoSessions()).toBe(1);

    expect(await repo.getSession(vieja)).toBeNull();
    expect(await repo.listEvents(vieja)).toHaveLength(0);
    expect(await repo.countReadings(vieja)).toBe(0);
    expect(await repo.getSession(reciente)).not.toBeNull(); // aún no cumple 60 min
    expect(await repo.getSession(abierta)).not.toBeNull();  // abierta: intocable
    expect(await repo.getSession(real)).not.toBeNull();     // real: intocable
    expect(await repo.cleanupDemoSessions()).toBe(0);       // segunda pasada: nada
    await repo.close();
  });

  it("respeta el umbral exacto (59 min se queda, 61 se va)", async () => {
    const repo = await Repo.create(await makeDriver());
    const justo = await mkDemo(repo, "D-59", 59);
    const pasada = await mkDemo(repo, "D-61", 61);
    expect(await repo.cleanupDemoSessions(60)).toBe(1);
    expect(await repo.getSession(justo)).not.toBeNull();
    expect(await repo.getSession(pasada)).toBeNull();
    await repo.close();
  });

  it("startDemoReaper barre al arrancar y de nuevo cada hora", async () => {
    const backend = await makeBackend();
    const repo = backend.repo;
    const vencida = await mkDemo(repo, "D-vencida", 120);
    try {
      vi.useFakeTimers();
      backend.startDemoReaper();
      await backend.flush();
      expect(await repo.getSession(vencida)).toBeNull(); // barrida al abrir

      // una demo que VENCE dentro de la próxima hora: el tick horario la barre
      const proxima = await mkDemo(repo, "D-próxima", 30);
      await vi.advanceTimersByTimeAsync(3_600_000);
      await backend.flush();
      expect(await repo.getSession(proxima)).toBeNull();
    } finally {
      backend.stopDemoReaper();
      vi.useRealTimers();
      await backend.repo.close();
    }
  });
});
