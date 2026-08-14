/**
 * Eliminar un lote (Función A) — espejo móvil de
 * tests/api/test_delete_session.py: repo.deleteSession en cascada y el
 * endpoint DELETE /api/sessions/{id} (404 · 409-abierta · borrado).
 * Backend embebido sobre sql.js.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "../src/apishim";
import { createSqlJsDriver, Repo, SqlDriver } from "../src/db";
import type { ScaleProfile, WeighEvent } from "../src/models";

const WASM = new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url).pathname;
const PROFILES: ScaleProfile[] = [];

async function makeDriver(): Promise<SqlDriver> {
  return createSqlJsDriver({ locateFile: () => WASM });
}

function ev(
  sessionId: number,
  tsMs: number,
  antes: number,
  despues: number,
  n: number,
  tipo: WeighEvent["tipo"],
): WeighEvent {
  return {
    id: null,
    session_id: sessionId,
    ts_ms: tsMs,
    peso_antes: antes,
    peso_despues: despues,
    delta_kg: Math.round((despues - antes) * 1000) / 1000,
    animales_estimados: n,
    tipo,
    ambiguo: false,
    opciones: [],
    animales_confirmados: null,
    estab_ms: 700,
    motivo_bajada: null,
    confirmado_por: null,
  };
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

// ---------------------------------------------------------------- repo (A1)

describe("db.ts — deleteSession en cascada", () => {
  it("borra la sesión + sus eventos + lecturas y retorna cuántos eventos borró", async () => {
    const repo = await Repo.create(await makeDriver());
    const sid = await repo.createSession({ lote: "L-borrar" });
    await repo.insertEvent(ev(sid, 1000, 0.0, 100.0, 1, "referencia"));
    await repo.insertEvent(ev(sid, 2000, 0.0, 210.0, 2, "subida"));
    for (let i = 0; i < 5; i++) await repo.insertReading(sid, 3000 + i, 100.0 + i);
    await repo.closeSession(sid, { total_kg: 210.0, count: 2, avg_kg: 105.0 });

    const otra = await repo.createSession({ lote: "L-queda" });
    await repo.insertEvent(ev(otra, 1000, 0.0, 99.0, 1, "subida"));

    expect(await repo.deleteSession(sid)).toBe(2); // dos eventos borrados
    expect(await repo.getSession(sid)).toBeNull(); // la sesión ya no está
    expect(await repo.listEvents(sid)).toEqual([]); // eventos en cascada
    expect(await repo.countReadings(sid)).toBe(0); // lecturas en cascada
    // la otra sesión queda intacta
    expect(await repo.getSession(otra)).not.toBeNull();
    expect((await repo.listEvents(otra)).length).toBe(1);
    await repo.close();
  });

  it("una sesión inexistente retorna 0 sin fallar", async () => {
    const repo = await Repo.create(await makeDriver());
    expect(await repo.deleteSession(9999)).toBe(0);
    await repo.close();
  });

  it("las sesiones DEMO se borran igual", async () => {
    const repo = await Repo.create(await makeDriver());
    const sid = await repo.createSession({ lote: "L-demo", es_demo: 1 });
    await repo.insertEvent(ev(sid, 1000, 0.0, 90.0, 1, "subida"));
    await repo.closeSession(sid, { total_kg: 90.0, count: 1, avg_kg: 90.0 });
    expect(await repo.deleteSession(sid)).toBe(1);
    expect(await repo.getSession(sid)).toBeNull();
    await repo.close();
  });
});

// ------------------------------------------------------------- endpoint (A2)

describe("apishim — DELETE /api/sessions/{id}", () => {
  let backend: LocalBackend;

  afterEach(async () => {
    await backend.stopDriver();
    await backend.repo.close();
  });

  it("404 si la sesión no existe", async () => {
    backend = new LocalBackend({ repo: await Repo.create(await makeDriver()), profiles: PROFILES });
    const r = await call(backend, "DELETE", "/api/sessions/9999");
    expect(r.status).toBe(404);
  });

  it("409 si el pesaje está abierto (no lo borra)", async () => {
    backend = new LocalBackend({ repo: await Repo.create(await makeDriver()), profiles: PROFILES });
    const created = await call(backend, "POST", "/api/sessions", { lote: "L-abierta" });
    const r = await call(backend, "DELETE", `/api/sessions/${created.json.id}`);
    expect(r.status).toBe(409);
    expect(String(r.json.detail).toLowerCase()).toContain("cierra el pesaje");
    // sigue existiendo
    const still = await call(backend, "GET", `/api/sessions/${created.json.id}`);
    expect(still.status).toBe(200);
  });

  it("borra un pesaje cerrado y desaparece del detalle y la lista", async () => {
    backend = new LocalBackend({ repo: await Repo.create(await makeDriver()), profiles: PROFILES });
    const created = await call(backend, "POST", "/api/sessions", { lote: "L-cerrar" });
    const sid = created.json.id;
    await backend.flush();
    await call(backend, "POST", `/api/sessions/${sid}/close`, {});
    const r = await call(backend, "DELETE", `/api/sessions/${sid}`);
    expect(r.status).toBe(200);
    expect(r.json.deleted).toBe(true);
    expect(r.json.id).toBe(sid);
    const gone = await call(backend, "GET", `/api/sessions/${sid}`);
    expect(gone.status).toBe(404);
    const list = await call(backend, "GET", "/api/sessions");
    expect((list.json as any[]).some((s) => s.id === sid)).toBe(false);
  });
});
