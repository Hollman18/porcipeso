/**
 * Flujo de sesión COMPLETO contra el backend embebido (apishim):
 * simulador vivo → engine → sqlite (sql.js) → respuestas HTTP y
 * mensajes WS con la MISMA forma que porcipeso/api/app.py.
 *
 * Los timers son falsos (la física del sim corre a 10 Hz simulados).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hub, installShim, LocalBackend, ShimWebSocket } from "../src/apishim";
import { createSqlJsDriver, Repo } from "../src/db";
import type { ScaleProfile } from "../src/models";

const WASM = new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url).pathname;

const PROFILES: ScaleProfile[] = [
  {
    id: "matrix-adr00",
    name: "Lexus / Trumax Matrix (Adr 00)",
    brand: "Lexus / Trumax",
    parser: "matrix",
    transport: "serial",
    extra: {},
  },
  {
    id: "mt-ind-sics",
    name: "Mettler-Toledo IND231 (MT-SICS)",
    brand: "Mettler-Toledo",
    parser: "sics",
    transport: "serial",
    extra: {},
  },
];

async function makeBackend(deps: Partial<ConstructorParameters<typeof LocalBackend>[0]> = {}) {
  const driver = await createSqlJsDriver({ locateFile: () => WASM });
  const repo = await Repo.create(driver);
  return new LocalBackend({
    repo,
    profiles: PROFILES,
    simOptions: { seed: 42 },
    ...deps,
  });
}

async function call(
  backend: LocalBackend,
  method: string,
  path: string,
  body: unknown = null,
): Promise<{ status: number; json: any; res: Response }> {
  const res = await backend.handleFetch(method, path, body !== null ? JSON.stringify(body) : null);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, res };
}

/** Avanza el reloj y deja drenar la cadena de escrituras del backend. */
async function run(backend: LocalBackend, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await backend.flush();
}

describe("apishim — flujo de sesión completa con la báscula simulada", () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    backend = await makeBackend();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await backend.stopDriver();
    vi.useRealTimers();
    await backend.repo.close();
  });

  it("ciclo completo: sim → sesión → referencia/subida/bajada/reingreso → cierre + export CSV", async () => {
    // WS conectado desde el arranque (como app.js)
    const ws = new ShimWebSocket(backend.hub, "/ws");
    const messages: any[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));

    // 1) conectar la báscula simulada
    const start = await call(backend, "POST", "/api/sim/start", {});
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ connected: true, profile_id: "simulador", transport: "sim" });

    // báscula vacía y estable (ventana de 20 lecturas a 10 Hz)
    await run(backend, 2500);

    const status = await call(backend, "GET", "/api/scale/status");
    expect(status.json.connected).toBe(true);
    expect(status.json.profile_id).toBe("simulador");
    expect(status.json.last_kg).not.toBeNull();

    // 2) crear la sesión (queda 'abierta' en la DB, misma forma que FastAPI)
    const created = await call(backend, "POST", "/api/sessions", {
      lote: "Lote test",
      corral: "C-4",
      destino: "Planta",
      operador: "",
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ lote: "Lote test", corral_origen: "C-4", estado: "abierta" });
    expect(created.json.uuid).toBeTruthy();
    const sid = created.json.id as number;

    // 3) cerdo de prueba: 100 kg exactos → REFERENCIA
    const on1 = await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 1, kg_each: 100 });
    expect(on1.status).toBe(200);
    expect(on1.json).toMatchObject({ action: "pigs_on", pigs_fisicos: 1 });
    await run(backend, 4000);

    // 4) suben 2 de golpe (+200) → SUBIDA n=2
    await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 2, kg_each: 100 });
    await run(backend, 4000);

    // 5) se baja 1 (-100) → BAJADA; vuelve a subir → REINGRESO
    await call(backend, "POST", "/api/sim/action", { action: "pig_off" });
    await run(backend, 4000);
    await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 1, kg_each: 100 });
    await run(backend, 4000);

    const events = await call(backend, "GET", `/api/sessions/${sid}/events`);
    expect(events.status).toBe(200);
    expect(events.json.map((e: any) => e.tipo)).toEqual(["referencia", "subida", "bajada", "reingreso"]);
    const [ref, subida, bajada] = events.json;
    expect(ref.animales_estimados).toBe(1);
    expect(Math.abs(ref.delta_kg - 100)).toBeLessThan(3);
    expect(subida.animales_estimados).toBe(2);
    expect(bajada.delta_kg).toBeLessThan(0);
    for (const ev of events.json) {
      // misma fila que la DB del backend Python
      expect(ev).toHaveProperty("sesion_id", sid);
      expect(ev).toHaveProperty("peso_antes");
      expect(ev).toHaveProperty("peso_despues");
      expect(ev).toHaveProperty("estab_ms");
      expect(ev.ambiguo).toBe(false);
      expect(ev.opciones).toEqual([]);
    }

    // motivo de la bajada (igual que /api/events/{id}/motivo del backend)
    const motivo = await call(backend, "POST", `/api/events/${bajada.id}/motivo`, { motivo: "estres" });
    expect(motivo.json.motivo_bajada).toBe("estres");

    // lecturas crudas persistidas para la sesión
    expect(await backend.repo.countReadings(sid)).toBeGreaterThan(50);

    // 6) cerrar con conteo físico
    const closed = await call(backend, "POST", `/api/sessions/${sid}/close`, { conteo_fisico: 3 });
    expect(closed.status).toBe(200);
    expect(closed.json.estado).toBe("cerrada");
    expect(closed.json.total_animales).toBe(3);
    expect(closed.json.conteo_fisico).toBe(3);
    expect(closed.json.diferencia_conciliacion).toBe(0);
    expect(closed.json.hora_salida).toBeTruthy();
    expect(Math.abs(closed.json.total_kg - 300)).toBeLessThan(6);

    // 7) estadística de sesión y global (SQL local)
    const stats = await call(backend, "GET", `/api/sessions/${sid}/stats`);
    expect(stats.json.total_animales).toBe(3);
    expect(stats.json.n_eventos).toBe(4);

    const globalStats = await call(backend, "GET", "/api/stats/global");
    expect(globalStats.json.sesiones).toBe(1);
    expect(globalStats.json.total_animales).toBe(3);
    expect(globalStats.json.por_lote[0].lote).toBe("Lote test");

    const list = await call(backend, "GET", "/api/sessions?q=Lote");
    expect(list.json).toHaveLength(1);
    const miss = await call(backend, "GET", "/api/sessions?q=NoExiste");
    expect(miss.json).toHaveLength(0);

    // 8) export: CSV en lugar de xlsx (diferencia documentada del móvil)
    const exp = await call(backend, "GET", `/api/sessions/${sid}/export.xlsx`);
    expect(exp.status).toBe(200);
    expect(exp.res.headers.get("Content-Type")).toContain("text/csv");
    expect(exp.res.headers.get("Content-Disposition")).toContain(`sesion_${sid}.csv`);
    expect(exp.json).toContain("Lote test");
    expect(exp.json).toContain("referencia");

    // 9) mensajes WS con el contrato de app.py
    await run(backend, 10);
    const types = new Set(messages.map((m) => m.type));
    expect(types).toContain("reading");
    expect(types).toContain("event");
    expect(types).toContain("snapshot");
    const reading = messages.find((m) => m.type === "reading");
    expect(reading).toHaveProperty("kg");
    expect(reading).toHaveProperty("ts_ms");
    expect(reading).toHaveProperty("state");
    const snap = messages.find((m) => m.type === "snapshot");
    for (const k of ["state", "kg_now", "ref_kg", "avg_kg", "count", "total_kg", "pending"]) {
      expect(snap).toHaveProperty(k);
    }
    const evMsg = messages.find((m) => m.type === "event");
    expect(evMsg).toHaveProperty("tipo");
    expect(evMsg).toHaveProperty("delta_kg");
    // el último snapshot tras cerrar es idle con los totales
    const lastSnap = [...messages].reverse().find((m) => m.type === "snapshot");
    expect(lastSnap.state).toBe("idle");
    expect(lastSnap.count).toBe(3);

    // 10) sim/stop
    const stop = await call(backend, "POST", "/api/sim/stop", {});
    expect(stop.json).toEqual({ connected: false, stopped: true });
    ws.close();
  });

  it("evento ambiguo → pregunta con opciones → confirm actualiza engine + DB", async () => {
    const start = await call(backend, "POST", "/api/sim/start", {});
    expect(start.status).toBe(200);
    await run(backend, 2500);
    const created = await call(backend, "POST", "/api/sessions", { lote: "Ambiguo" });
    const sid = created.json.id as number;

    await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 1, kg_each: 100 });
    await run(backend, 4000); // referencia 100

    // +150 sobre promedio 100 → n_raw 1.5 → AMBIGUO opciones [1,2]
    await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 1, kg_each: 150 });
    await run(backend, 4000);

    const events = await call(backend, "GET", `/api/sessions/${sid}/events`);
    const amb = events.json.find((e: any) => e.ambiguo);
    expect(amb).toBeTruthy();
    expect(amb.opciones).toEqual([1, 2]);
    expect(amb.animales_confirmados).toBeNull();

    let snap = await call(backend, "GET", "/api/scale/status");
    expect(snap.json.state).toBe("estable");

    const confirmed = await call(backend, "POST", `/api/events/${amb.id}/confirm`, { n: 1 });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.ambiguo).toBe(false);
    expect(confirmed.json.animales_confirmados).toBe(1);

    const closed = await call(backend, "POST", `/api/sessions/${sid}/close`, {});
    expect(closed.json.total_animales).toBe(2); // 1 ref + 1 confirmado
    expect(Math.abs(closed.json.total_kg - 250)).toBeLessThan(6);
    expect(Math.abs(closed.json.promedio_final - 125)).toBeLessThan(3);
  });

  it("silence del sim dispara SIN_SENAL en el estado", async () => {
    await call(backend, "POST", "/api/sim/start", {});
    await run(backend, 2500);
    await call(backend, "POST", "/api/sessions", { lote: "Silencio" });
    await call(backend, "POST", "/api/sim/action", { action: "silence", seconds: 4 });
    await run(backend, 3600); // > no_signal_after_s sin lecturas
    const status = await call(backend, "GET", "/api/scale/status");
    expect(status.json.state).toBe("sin_senal");
  });

  it("contrato de errores: 409 sin sim, 404 perfiles/sesiones, 400 parser no portado", async () => {
    const noSim = await call(backend, "POST", "/api/sim/action", { action: "pigs_on" });
    expect(noSim.status).toBe(409);

    const noProfile = await call(backend, "POST", "/api/scale/connect", { profile_id: "nope" });
    expect(noProfile.status).toBe(404);

    const noParser = await call(backend, "POST", "/api/scale/connect", {
      profile_id: "mt-ind-sics",
      port: "00:11:22:33:44:55",
    });
    expect(noParser.status).toBe(400);
    expect(noParser.json.detail).toContain("no está soportado");

    const noPort = await call(backend, "POST", "/api/scale/connect", { profile_id: "matrix-adr00" });
    expect(noPort.status).toBe(400);
    expect(noPort.json.detail).toContain("Bluetooth");

    const noSession = await call(backend, "GET", "/api/sessions/999");
    expect(noSession.status).toBe(404);
    const noEvent = await call(backend, "POST", "/api/events/999/confirm", { n: 1 });
    expect(noEvent.status).toBe(404);
  });

  it("scale/connect con driver BT inyectado alimenta el engine con tramas matrix", async () => {
    let feedBytes: ((s: string) => void) | null = null;
    const bt = await makeBackend({
      createBtDriver: async (profile, address, onReading) => {
        const { PARSER_REGISTRY } = await import("../src/parsers");
        const { stringToBytes } = await import("../src/parsers");
        const parser = new PARSER_REGISTRY[profile.parser](profile);
        feedBytes = (s: string) => {
          for (const r of parser.push(stringToBytes(s))) onReading(r);
        };
        return {
          profile,
          address,
          disconnect: async () => {},
          isConnected: async () => true,
        } as any;
      },
    });

    const res = await call(bt, "POST", "/api/scale/connect", {
      profile_id: "matrix-adr00",
      port: "00:14:03:05:59:02",
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ connected: true, profile_id: "matrix-adr00", transport: "bluetooth" });

    feedBytes!("= 126.35");
    const status = await call(bt, "GET", "/api/scale/status");
    expect(status.json.connected).toBe(true);
    expect(status.json.last_kg).toBeCloseTo(126.35, 2);
    await bt.stopDriver();
    await bt.repo.close();
  });

  it("profiles marca los parsers aún no portados", async () => {
    const res = await call(backend, "GET", "/api/profiles");
    const matrix = res.json.find((p: any) => p.id === "matrix-adr00");
    const sics = res.json.find((p: any) => p.id === "mt-ind-sics");
    expect(matrix.name).toBe("Lexus / Trumax Matrix (Adr 00)");
    expect(sics.name).toContain("próximamente en móvil");
  });
});

describe("installShim — parcheo de fetch/WebSocket/window.open", () => {
  it("desvía /api/* y /ws al backend local; lo demás sigue nativo", async () => {
    const shared: string[] = [];
    const backend = await makeBackend({
      shareCsv: async (filename) => {
        shared.push(filename);
      },
    });
    const nativeFetchCalls: string[] = [];
    const fakeWindow = {
      location: { href: "http://localhost/" },
      fetch: async (input: any) => {
        nativeFetchCalls.push(String(input));
        return new Response("nativo");
      },
      WebSocket: class {
        url: string;
        constructor(url: string) {
          this.url = String(url);
        }
      },
      open: () => null,
    } as any;

    installShim(backend.hub, async () => backend, fakeWindow);

    // fetch /api → backend local
    const res = await fakeWindow.fetch("/api/profiles");
    expect(res.status).toBe(200);
    expect((await res.json()).length).toBe(PROFILES.length);
    expect(nativeFetchCalls).toEqual([]);

    // fetch normal → nativo
    const other = await fakeWindow.fetch("/styles.css");
    expect(await other.text()).toBe("nativo");
    expect(nativeFetchCalls).toEqual(["/styles.css"]);

    // WebSocket /ws → shim conectado al hub
    const ws = new fakeWindow.WebSocket("ws://localhost/ws");
    expect(ws).toBeInstanceOf(ShimWebSocket);
    const got: string[] = [];
    ws.onmessage = (e: any) => got.push(e.data);
    backend.hub.broadcast({ type: "reading", kg: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(got.length).toBe(1);

    // WebSocket externo → clase nativa
    const other2 = new fakeWindow.WebSocket("wss://otra.parte/x");
    expect(other2).not.toBeInstanceOf(ShimWebSocket);

    // window.open del export → CSV compartido (nativo)
    const sid = await backend.repo.createSession({ lote: "X" });
    fakeWindow.open(`/api/sessions/${sid}/export.xlsx`);
    await new Promise((r) => setTimeout(r, 0));
    await backend.flush();
    expect(shared).toEqual([`sesion_${sid}.csv`]);
    await backend.repo.close();
  });
});

describe("db — retención de lecturas crudas", () => {
  it("prune borra viejas de sesiones cerradas, nunca de la abierta", async () => {
    const driver = await createSqlJsDriver({ locateFile: () => WASM });
    const repo = await Repo.create(driver, { maxRawReadings: 100, pruneCheckEvery: 10 });
    const closedId = await repo.createSession({ lote: "vieja" });
    for (let i = 0; i < 80; i++) await repo.insertReading(closedId, 1000 + i, 50);
    await repo.closeSession(closedId, { total_kg: 0, count: 0, avg_kg: null });
    const openId = await repo.createSession({ lote: "abierta" });
    for (let i = 0; i < 80; i++) await repo.insertReading(openId, 9000 + i, 60);
    await repo.pruneReadings();
    expect(await repo.countReadings(openId)).toBe(80); // intacta
    expect(await repo.countReadings(closedId)).toBeLessThan(80); // podada
    await repo.close();
  });
});
