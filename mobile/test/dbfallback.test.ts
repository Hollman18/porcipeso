/**
 * Degradación GRADUAL del driver SQLite (mobile/src/main.ts:createDriver).
 *
 * BUG que arregla: en un teléfono concreto el plugin nativo
 * (@capacitor-community/sqlite) no cargaba; como en nativo era el ÚNICO
 * driver, initBackend lanzaba, el shim no respondía /api/* y salía el banner
 * de "computador" + el Bluetooth moría. Ahora cae en cascada:
 *   1) SQLite nativo → 2) sql.js (WebAssembly) + IndexedDB → 3) sql.js asm.js
 *   EN MEMORIA (JS puro, sin WebAssembly).
 * Aquí se prueba la SELECCIÓN de nivel con fábricas inyectadas (en nativo/BT
 * reales no se puede reproducir en node/CI).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDriver, initBackend, type DbBackend } from "../src/main";
import { createSqlJsDriver, Repo, type SqlDriver } from "../src/db";
import { Hub } from "../src/apishim";

const WASM = new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url).pathname;

const open: SqlDriver[] = [];
const makeSql = async (): Promise<SqlDriver> => {
  const d = await createSqlJsDriver({ locateFile: () => WASM });
  open.push(d);
  return d;
};
const boom = (msg: string) => async (): Promise<SqlDriver> => {
  throw new Error(msg);
};

afterEach(async () => {
  while (open.length) {
    try {
      await open.pop()!.close();
    } catch {
      /* ya cerrado */
    }
  }
});

describe("createDriver — degradación en cascada", () => {
  it("nivel 1: SQLite nativo OK → dbBackend 'native'", async () => {
    let state: { db: DbBackend; err?: string } | null = null;
    const { native } = await createDriver({
      isNative: () => true,
      makeNative: makeSql,
      makeSqlJs: boom("no debería usarse"),
      makeMemory: boom("no debería usarse"),
      onState: (db, err) => (state = { db, err }),
    });
    expect(native).toBe(true);
    expect(state!.db).toBe("native");
    expect(state!.err).toBeUndefined();
  });

  it("nivel 2: el plugin nativo LANZA → cae a sql.js y devuelve un driver USABLE (native sigue true)", async () => {
    let state: { db: DbBackend; err?: string } | null = null;
    const { driver, native } = await createDriver({
      isNative: () => true,
      makeNative: boom("simulado: @capacitor-community/sqlite no cargó"),
      makeSqlJs: makeSql,
      makeMemory: boom("no debería usarse"),
      onState: (db, err) => (state = { db, err }),
    });
    // sigue "native": Bluetooth (SPP) y Filesystem/Share son plugins aparte.
    expect(native).toBe(true);
    expect(state!.db).toBe("sqljs-fallback");
    expect(state!.err).toMatch(/SQLite nativo/); // registra POR QUÉ degradó
    // el driver del respaldo funciona de verdad: Repo + una sesión.
    const repo = await Repo.create(driver);
    const id = await repo.createSession({ lote: "L1", modo: "unidades" });
    expect(await repo.getSession(id)).not.toBeNull();
  });

  it("nivel 3: WebView SIN WebAssembly → salta sql.js y cae a memoria ('memoria-degradada')", async () => {
    let state: { db: DbBackend; err?: string } | null = null;
    const sqljs = vi.fn(boom("no debería intentarse sin WASM"));
    const { native } = await createDriver({
      isNative: () => true,
      hasWebAssembly: () => false,
      makeNative: boom("simulado: sqlite nativo caído"),
      makeSqlJs: sqljs,
      makeMemory: makeSql, // en memoria en el APK; en el test basta un sql.js
      onState: (db, err) => (state = { db, err }),
    });
    expect(native).toBe(true);
    expect(sqljs).not.toHaveBeenCalled(); // se comprueba WASM ANTES de intentarlo
    expect(state!.db).toBe("memoria-degradada");
    expect(state!.err).toMatch(/WebAssembly no está disponible/);
  });

  it("nivel 3: sql.js (WASM) LANZA en runtime → cae a memoria", async () => {
    let state: { db: DbBackend } | null = null;
    await createDriver({
      isNative: () => false,
      hasWebAssembly: () => true,
      makeSqlJs: boom("simulado: WASM.instantiate falló"),
      makeMemory: makeSql,
      onState: (db) => (state = { db }),
    });
    expect(state!.db).toBe("memoria-degradada");
  });

  it("caso extremo: NI el nivel 3 levanta → propaga y reporta el detalle (banner honesto)", async () => {
    let fatal: string | null = null;
    await expect(
      createDriver({
        isNative: () => true,
        hasWebAssembly: () => false,
        makeNative: boom("nativo caído"),
        makeMemory: boom("asm.js tampoco"),
        onFatal: (msg) => (fatal = msg),
      }),
    ).rejects.toThrow();
    expect(fatal).toMatch(/SQLite nativo/);
    expect(fatal).toMatch(/asm\.js/);
  });
});

describe("initBackend — el backend LEVANTA pese al plugin nativo caído", () => {
  it("responde /api/* (Bluetooth incluido) usando el respaldo sql.js", async () => {
    vi.useFakeTimers(); // CloudSync/demoReaper usan setInterval
    try {
      const hub = new Hub();
      const backend = await initBackend(hub, {
        isNative: () => true,
        makeNative: boom("simulado: sqlite nativo no cargó"),
        makeSqlJs: makeSql,
        makeMemory: boom("no debería usarse"),
        onState: () => {},
      });
      // /api/profiles responde (el shim ya atiende peticiones)…
      const prof = await backend.handleFetch("GET", "/api/profiles", null);
      expect(prof.status).toBe(200);
      // …y /api/bt/* también resuelve (el motivo del banner + BT muerto).
      const bt = await backend.handleFetch("GET", "/api/bt/devices", null);
      expect([200, 403, 503]).toContain(bt.status); // responde, ya no cuelga
      backend.stopDemoReaper();
      await backend.repo.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
