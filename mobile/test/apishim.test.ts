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

  it("ciclo lote v2: calibración → bajar_prueba → REFERENCIA al vaciar → lote → cierre + export CSV", async () => {
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

    // 2) crear la sesión (modo default 'lote', persistido en la fila)
    const created = await call(backend, "POST", "/api/sessions", {
      lote: "Lote test",
      corral: "C-4",
      destino: "Planta",
      operador: "",
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      lote: "Lote test",
      corral_origen: "C-4",
      estado: "abierta",
      modo: "lote",
    });
    expect(created.json.uuid).toBeTruthy();
    const sid = created.json.id as number;
    await run(backend, 3000); // base de calibración: la sesión limpia la ventana, necesita 2 s de lecturas frescas

    // 3) cerdo de prueba: 100 kg → candidato (fase bajar_prueba), SIN evento aún
    const on1 = await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 1, kg_each: 100 });
    expect(on1.status).toBe(200);
    expect(on1.json).toMatchObject({ action: "pigs_on", pigs_fisicos: 1 });
    await run(backend, 4000);
    let events = await call(backend, "GET", `/api/sessions/${sid}/events`);
    expect(events.json).toHaveLength(0); // peak hold: todavía NO hay REFERENCIA
    // la fase viva viaja en los mensajes reading (los snapshot se emiten
    // en el cambio de estado, ANTES de que la fase avance — igual que app.py)
    const bajarReading = [...messages].reverse().find((m) => m.type === "reading");
    expect(bajarReading.fase).toBe("bajar_prueba");

    // 4) se baja el de prueba → al vaciar se emite REFERENCIA (count sigue 0)
    await call(backend, "POST", "/api/sim/action", { action: "pig_off" });
    await run(backend, 4000);
    events = await call(backend, "GET", `/api/sessions/${sid}/events`);
    expect(events.json.map((e: any) => e.tipo)).toEqual(["referencia"]);
    const refSnap = [...messages].reverse().find((m) => m.type === "snapshot");
    expect(refSnap.fase).toBe("lote");
    expect(refSnap.count).toBe(0); // la REFERENCIA no suma al conteo
    expect(refSnap.total_kg).toBe(0);
    expect(Math.abs(refSnap.ref_kg - 100)).toBeLessThan(3);

    // 5) fase lote clásica: suben 2 de golpe (+200) → SUBIDA n=2
    await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 2, kg_each: 100 });
    await run(backend, 4000);

    // 6) báscula de PASO: el grupo baja (avanza al camión) → NO descuenta,
    //    NO emite evento. Luego un cerdo REBOTA (sube otra vez) → SUBIDA n=1,
    //    doble contado. count pasa 2 → 3.
    await call(backend, "POST", "/api/sim/action", { action: "pig_off" });
    await run(backend, 4000);
    await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 1, kg_each: 100 });
    await run(backend, 4000);

    events = await call(backend, "GET", `/api/sessions/${sid}/events`);
    expect(events.status).toBe(200);
    // sin evento BAJADA/REINGRESO: la bajada se ignora
    expect(events.json.map((e: any) => e.tipo)).toEqual(["referencia", "subida", "subida"]);
    const [ref, subida] = events.json;
    expect(ref.animales_estimados).toBe(1);
    expect(Math.abs(ref.delta_kg - 100)).toBeLessThan(3);
    expect(subida.animales_estimados).toBe(2);
    for (const ev of events.json) {
      expect(ev).toHaveProperty("sesion_id", sid);
      expect(ev).toHaveProperty("peso_antes");
      expect(ev).toHaveProperty("peso_despues");
      expect(ev.ambiguo).toBe(false);
    }

    // 6b) DEVUELTOS MANUAL: el operario vio el rebote → registra 1 devuelto.
    //     Descuenta 1×promedio: count 3 → 2, total ~300 → ~200.
    const ret = await call(backend, "POST", "/api/session/returned", { n: 1 });
    expect(ret.status).toBe(200);
    expect(ret.json.descontados).toBe(1);
    expect(ret.json.count).toBe(2);
    events = await call(backend, "GET", `/api/sessions/${sid}/events`);
    const ajuste = events.json.find((e: any) => e.tipo === "ajuste");
    expect(ajuste).toBeTruthy();
    expect(ajuste.motivo_bajada).toBe("devuelto_manual");

    // lecturas crudas persistidas para la sesión
    expect(await backend.repo.countReadings(sid)).toBeGreaterThan(50);

    // 7) cerrar con conteo físico: 2 en plataforma (la ref NO cuenta)
    const closed = await call(backend, "POST", `/api/sessions/${sid}/close`, { conteo_fisico: 2 });
    expect(closed.status).toBe(200);
    expect(closed.json.estado).toBe("cerrada");
    expect(closed.json.total_animales).toBe(2);
    expect(closed.json.conteo_fisico).toBe(2);
    expect(closed.json.diferencia_conciliacion).toBe(0);
    expect(closed.json.hora_salida).toBeTruthy();
    expect(Math.abs(closed.json.total_kg - 200)).toBeLessThan(6);

    // 8) estadística de sesión (métricas muestrales v2) y global
    const stats = await call(backend, "GET", `/api/sessions/${sid}/stats`);
    expect(stats.json.total_animales).toBe(2);
    expect(stats.json.modo).toBe("lote");
    expect(stats.json.tipo_muestra).toBe("estimada");
    // muestras individuales: la REFERENCIA (~100) + el reingreso n=1 (~100)
    expect(stats.json.n_muestras).toBe(2);
    expect(stats.json.n_muestras_individuales).toBe(2);
    expect(stats.json.mediana).not.toBeNull();
    expect(Math.abs(stats.json.mediana - 100)).toBeLessThan(3);
    expect(typeof stats.json.varianza).toBe("number");
    expect(typeof stats.json.desviacion_std).toBe("number");

    // la sesión nació con la SIMULADA conectada → es DEMO: se ve en la
    // lista (con su flag) pero queda EXCLUIDA del agregado global
    expect(closed.json.es_demo).toBe(1);
    const globalStats = await call(backend, "GET", "/api/stats/global");
    expect(globalStats.json.sesiones).toBe(0);
    expect(globalStats.json.total_animales).toBe(0);
    expect(globalStats.json.por_lote).toHaveLength(0);

    const list = await call(backend, "GET", "/api/sessions?q=Lote");
    expect(list.json).toHaveLength(1);
    expect(list.json[0].es_demo).toBe(1);
    const miss = await call(backend, "GET", "/api/sessions?q=NoExiste");
    expect(miss.json).toHaveLength(0);

    // 9) export: CSV en lugar de xlsx (diferencia documentada del móvil)
    const exp = await call(backend, "GET", `/api/sessions/${sid}/export.xlsx`);
    expect(exp.status).toBe(200);
    expect(exp.res.headers.get("Content-Type")).toContain("text/csv");
    expect(exp.res.headers.get("Content-Disposition")).toContain(`sesion_${sid}.csv`);
    expect(exp.json).toContain("Lote test");
    // CSV tabular: encabezado de RESUMEN + tipo de movimiento en español
    expect(exp.json).toContain("Sesión");
    expect(exp.json).toContain("Cerdo de prueba"); // "referencia" → humano

    // 10) mensajes WS con el contrato de app.py (v2: fase incluida)
    await run(backend, 10);
    const types = new Set(messages.map((m) => m.type));
    expect(types).toContain("reading");
    expect(types).toContain("event");
    expect(types).toContain("snapshot");
    const reading = messages.find((m) => m.type === "reading");
    expect(reading).toHaveProperty("kg");
    expect(reading).toHaveProperty("ts_ms");
    expect(reading).toHaveProperty("state");
    expect(reading).toHaveProperty("fase");
    const snap = messages.find((m) => m.type === "snapshot");
    for (const k of ["state", "kg_now", "ref_kg", "avg_kg", "count", "total_kg", "pending", "fase"]) {
      expect(snap).toHaveProperty(k);
    }
    // el stream de readings atraviesa las fases del flujo v2
    const fasesVistas = new Set(
      messages.filter((m) => m.type === "reading").map((m) => m.fase),
    );
    expect(fasesVistas).toContain("calibracion");
    expect(fasesVistas).toContain("bajar_prueba");
    expect(fasesVistas).toContain("lote");
    const evMsg = messages.find((m) => m.type === "event");
    expect(evMsg).toHaveProperty("tipo");
    expect(evMsg).toHaveProperty("delta_kg");
    // el último snapshot tras cerrar es idle con los totales (fase lote)
    const lastSnap = [...messages].reverse().find((m) => m.type === "snapshot");
    expect(lastSnap.state).toBe("idle");
    expect(lastSnap.count).toBe(2);
    expect(lastSnap.fase).toBe("lote");

    // 11) sim/stop
    const stop = await call(backend, "POST", "/api/sim/stop", {});
    expect(stop.json).toEqual({ connected: false, stopped: true });
    ws.close();
  });

  it("modo unidades: SUBIDA n=1; vacío sin evento; SIN REPESAJE (montado sin vaciar no cuenta)", async () => {
    const ws = new ShimWebSocket(backend.hub, "/ws");
    const messages: any[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));

    await call(backend, "POST", "/api/sim/start", {});
    await run(backend, 2500);

    const created = await call(backend, "POST", "/api/sessions", {
      lote: "Unidades",
      modo: "unidades",
    });
    expect(created.status).toBe(201);
    expect(created.json.modo).toBe("unidades");
    const sid = created.json.id as number;
    await run(backend, 3000); // base (ventana fresca de la sesión: 2 s de lecturas)

    // animal 1: sube 100 → SUBIDA n=1 con su peso
    await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 1, kg_each: 100 });
    await run(backend, 4000);
    // baja → SIN evento
    await call(backend, "POST", "/api/sim/action", { action: "pig_off" });
    await run(backend, 4000);
    // animal 2: sube 95 → SUBIDA
    await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 1, kg_each: 95 });
    await run(backend, 4000);
    // SIN REPESAJE: otro cerdo encima SIN vaciar (110) → NO cuenta
    await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 1, kg_each: 110 });
    await run(backend, 4000);
    // se bajan ambos hasta vaciar (pig_off saca el último de la pila)
    await call(backend, "POST", "/api/sim/action", { action: "pig_off" });
    await run(backend, 2500);
    await call(backend, "POST", "/api/sim/action", { action: "pig_off" });
    await run(backend, 4000);
    // animal 3: ya vació → sube 105 → SUBIDA
    await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 1, kg_each: 105 });
    await run(backend, 4000);

    const events = await call(backend, "GET", `/api/sessions/${sid}/events`);
    expect(events.json.map((e: any) => e.tipo)).toEqual(["subida", "subida", "subida"]);
    expect(events.json.every((e: any) => e.animales_estimados === 1)).toBe(true);
    expect(events.json.every((e: any) => e.ambiguo === false)).toBe(true);
    expect(Math.abs(events.json[0].delta_kg - 100)).toBeLessThan(3);
    expect(Math.abs(events.json[1].delta_kg - 95)).toBeLessThan(3);
    expect(Math.abs(events.json[2].delta_kg - 105)).toBeLessThan(4);

    // fase 'unidades' en readings y snapshots
    const fases = new Set(messages.filter((m) => m.type === "reading").map((m) => m.fase));
    expect(fases).toContain("unidades");
    const snap = [...messages].reverse().find((m) => m.type === "snapshot");
    expect(snap.fase).toBe("unidades");
    expect(snap.count).toBe(3);

    const closed = await call(backend, "POST", `/api/sessions/${sid}/close`, { conteo_fisico: 3 });
    expect(closed.json.total_animales).toBe(3);
    expect(Math.abs(closed.json.total_kg - 300)).toBeLessThan(8);

    // stats v2: muestra COMPLETA (censo), desviación muestral n-1
    const stats = await call(backend, "GET", `/api/sessions/${sid}/stats`);
    expect(stats.json.modo).toBe("unidades");
    expect(stats.json.tipo_muestra).toBe("completa");
    expect(stats.json.n_muestras).toBe(3);
    expect(stats.json.total_animales).toBe(3);
    expect(stats.json.mediana).not.toBeNull();
    expect(stats.json.varianza).toBeGreaterThan(0);
    expect(stats.json.desviacion_std).toBeGreaterThan(0);
    // paridad con statistics.stdev: sqrt(varianza) == desviacion_std (±redondeo)
    expect(Math.abs(Math.sqrt(stats.json.varianza) - stats.json.desviacion_std)).toBeLessThan(0.05);
    ws.close();
  });

  it("POST /api/sessions rechaza modo desconocido con 400 (sin fila huérfana)", async () => {
    const bad = await call(backend, "POST", "/api/sessions", { lote: "X", modo: "turbo" });
    expect(bad.status).toBe(400);
    expect(bad.json.detail).toContain("modo desconocido");
    const list = await call(backend, "GET", "/api/sessions");
    expect(list.json).toHaveLength(0);
  });

  it("evento ambiguo → pregunta con opciones → confirm actualiza engine + DB", async () => {
    const start = await call(backend, "POST", "/api/sim/start", {});
    expect(start.status).toBe(200);
    await run(backend, 2500);
    const created = await call(backend, "POST", "/api/sessions", { lote: "Ambiguo" });
    const sid = created.json.id as number;
    await run(backend, 3000); // base de calibración (ventana fresca)

    // calibración v2: cerdo de prueba sube y SE BAJA → REFERENCIA 100
    await call(backend, "POST", "/api/sim/action", { action: "pigs_on", n: 1, kg_each: 100 });
    await run(backend, 4000);
    await call(backend, "POST", "/api/sim/action", { action: "pig_off" });
    await run(backend, 4000);

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
    expect(closed.json.total_animales).toBe(1); // la REFERENCIA no suma (v2)
    expect(Math.abs(closed.json.total_kg - 150)).toBeLessThan(6);
    expect(Math.abs(closed.json.promedio_final - 150)).toBeLessThan(4);
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

  it("scale/status expone reconnecting cuando el enlace SPP se cayó y reintenta", async () => {
    let link: "connected" | "reconnecting" | "closed" = "connected";
    const bt = await makeBackend({
      createBtDriver: async (profile, address) =>
        ({
          profile,
          address,
          disconnect: async () => {},
          isConnected: async () => true, // el driver NO se desconecta durante la reconexión
          linkStatus: () => link,
        }) as any,
    });
    await call(bt, "POST", "/api/scale/connect", {
      profile_id: "matrix-adr00",
      port: "00:14:03:05:59:02",
    });

    // enlace vivo → conectado, sin reconexión (verde honesto)
    let status = await call(bt, "GET", "/api/scale/status");
    expect(status.json.connected).toBe(true);
    expect(status.json.reconnecting).toBe(false);

    // el SPP se cae y el driver reintenta transparente → connected sigue true
    // (el motor conserva el pesaje) PERO reconnecting=true (UI en ámbar)
    link = "reconnecting";
    status = await call(bt, "GET", "/api/scale/status");
    expect(status.json.connected).toBe(true);
    expect(status.json.reconnecting).toBe(true);

    await bt.stopDriver();
    await bt.repo.close();
  });

  it("GET /api/bt/devices responde {name,address,paired} (forma de scanBtDevices() en app.js)", async () => {
    const bt = await makeBackend({
      serial: {
        listBt: async () => [
          { name: "BC04-BT", address: "00:14:03:05:59:02", paired: true },
          { name: "HC-05", address: "98:D3:31:F0:12:34", paired: false },
        ],
      },
    });
    try {
      const res = await call(bt, "GET", "/api/bt/devices");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
      expect(res.json[0]).toEqual({ name: "BC04-BT", address: "00:14:03:05:59:02", paired: true });
      expect(res.json[1].paired).toBe(false);
    } finally {
      await bt.repo.close();
    }
  });

  it("GET /api/bt/devices sin plugins nativos responde 503 (web: la UI degrada)", async () => {
    // sin inyección: en node/web no hay PorciSerial y el scan() de @e-is
    // lanza "Method not implemented." → 503 con mensaje en humano
    const res = await call(backend, "GET", "/api/bt/devices");
    expect(res.status).toBe(503);
    expect(res.json.detail).toContain("Bluetooth no disponible");
    expect(res.json.detail).toContain("app Android");
  });

  it("GET /api/bt/devices con permiso denegado responde 403 con mensaje en humano", async () => {
    const bt = await makeBackend({
      serial: {
        listBt: async () => {
          throw new Error("permission_denied: Bluetooth");
        },
      },
    });
    try {
      const res = await call(bt, "GET", "/api/bt/devices");
      expect(res.status).toBe(403);
      expect(res.json.detail).toContain("Permiso de Bluetooth denegado");
      expect(res.json.detail).toContain("Dispositivos cercanos");
    } finally {
      await bt.repo.close();
    }
  });

  it("GET /api/usb/devices responde {deviceId,vid,pid,name,driver} y 503 sin plugin", async () => {
    const usb = await makeBackend({
      serial: {
        listUsb: async () => [
          { deviceId: 1002, vid: 0x1a86, pid: 0x7523, name: "USB Serial", driver: "Ch34xSerialDriver" },
        ],
      },
    });
    try {
      const res = await call(usb, "GET", "/api/usb/devices");
      expect(res.status).toBe(200);
      expect(res.json).toEqual([
        { deviceId: 1002, vid: 0x1a86, pid: 0x7523, name: "USB Serial", driver: "Ch34xSerialDriver" },
      ]);
    } finally {
      await usb.repo.close();
    }
    // sin plugin nativo (web) → 503 degradable
    const res503 = await call(backend, "GET", "/api/usb/devices");
    expect(res503.status).toBe(503);
    expect(res503.json.detail).toContain("USB no disponible");
  });

  it("POST /api/scale/detect (BT) detecta señal INVERTIDA, reporta el peso y emite HEX por WS", async () => {
    const { stringToBytes } = await import("../src/parsers");
    const { invertBytes } = await import("../src/signal");
    await import("../src/detector"); // precarga: el import dinámico del shim
    await import("../src/serial"); //   no debe caer en medio de los fake timers
    const chunk = invertBytes(stringToBytes("= 126.35= 126.35= 126.35"));
    const transport = {
      label: "fake-bt",
      open: async () => {},
      read: async () => chunk,
      close: async () => {},
    };
    const bt = await makeBackend({ serial: { makeTransport: async () => transport } });
    const ws = new ShimWebSocket(bt.hub, "/ws");
    const detects: any[] = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "detect") detects.push(m);
    };
    try {
      const p = call(bt, "POST", "/api/scale/detect", {
        profile_id: "matrix-adr00",
        transport: "bluetooth",
        port: "00:14:03:05:59:02",
      });
      let settled: Awaited<typeof p> | null = null;
      void p.then((r) => (settled = r));
      for (let i = 0; i < 100 && settled === null; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
      const res = await p;
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.verdict).toBe("invertida");
      expect(res.json.invert_bits).toBe(true);
      expect(res.json.parser_ok).toBe(true);
      expect(res.json.parser).toBe("matrix");
      expect(res.json.kg).toBeCloseTo(126.35, 2);
      expect(res.json.message).toContain("INVERTIDA");
      await vi.advanceTimersByTimeAsync(10); // microtasks del hub
      expect(detects.length).toBeGreaterThan(0);
      expect(detects[0].hex).toMatch(/^[0-9A-F]{2}( [0-9A-F]{2})*$/);
    } finally {
      ws.close();
      await bt.repo.close();
    }
  });

  it("POST /api/scale/detect cae a BLE solo cuando el clásico no abre (fell_back_ble)", async () => {
    const { stringToBytes } = await import("../src/parsers");
    await import("../src/detector");
    await import("../src/serial");
    const FRAMES = stringToBytes("= 126.35= 126.35= 126.35= 126.35");
    // El clásico (SPP) falla al abrir (read ret -1 de campo); el módulo es BLE.
    const bt = await makeBackend({
      serial: {
        makeTransport: async (kind: string) => {
          if (kind === "bluetooth") {
            return {
              label: "fake-classic",
              open: async () => {
                throw new Error("SPP no conectó: read failed, socket might closed or timeout, read ret: -1");
              },
              read: async () => new Uint8Array(0),
              close: async () => {},
            };
          }
          return { label: "fake-ble", open: async () => {}, read: async () => FRAMES, close: async () => {} };
        },
      },
    });
    try {
      const p = call(bt, "POST", "/api/scale/detect", {
        profile_id: "auto",
        transport: "bluetooth",
        port: "48:87:2D:9D:D5:71",
      });
      let settled: Awaited<typeof p> | null = null;
      void p.then((r) => (settled = r));
      for (let i = 0; i < 100 && settled === null; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
      const res = await p;
      expect(res.status).toBe(200);
      expect(res.json.parser_ok).toBe(true);
      expect(res.json.parser).toBe("matrix");
      expect(res.json.fell_back_ble).toBe(true); // conectó por BLE aunque se tocó "clásico"
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("POST /api/scale/detect con prefer:'ble' prueba BLE PRIMERO (módulo 'cercano' no emparejado)", async () => {
    const { stringToBytes } = await import("../src/parsers");
    await import("../src/detector");
    await import("../src/serial");
    const FRAMES = stringToBytes("= 126.35= 126.35= 126.35= 126.35");
    const kinds: string[] = [];
    const bt = await makeBackend({
      serial: {
        makeTransport: async (kind: string) => {
          kinds.push(kind);
          if (kind === "bluetooth") {
            // si se intentara el clásico fallaría (lento en campo); aquí NO debe llamarse
            return {
              label: "fake-classic",
              open: async () => {
                throw new Error("read ret: -1");
              },
              read: async () => new Uint8Array(0),
              close: async () => {},
            };
          }
          return { label: "fake-ble", open: async () => {}, read: async () => FRAMES, close: async () => {} };
        },
      },
    });
    try {
      const p = call(bt, "POST", "/api/scale/detect", {
        profile_id: "auto",
        transport: "bluetooth",
        port: "48:87:2D:9D:D5:71",
        prefer: "ble",
      });
      let settled: Awaited<typeof p> | null = null;
      void p.then((r) => (settled = r));
      for (let i = 0; i < 100 && settled === null; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
      const res = await p;
      expect(res.status).toBe(200);
      expect(res.json.parser_ok).toBe(true);
      expect(res.json.used_transport).toBe("ble");
      expect(res.json.fell_back).toBe(false);
      expect(kinds).toEqual(["ble"]); // el clásico lento NUNCA se abrió
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("POST /api/scale/detect con no_fallback: si BLE falla NO corre el clásico y devuelve el motivo BLE ya", async () => {
    await import("../src/detector");
    await import("../src/serial");
    const kinds: string[] = [];
    const bt = await makeBackend({
      serial: {
        makeTransport: async (kind: string) => {
          kinds.push(kind);
          return {
            label: `fake-${kind}`,
            open: async () => {
              throw new Error("ble_connect: el módulo NO apareció en el scan BLE · detalle: Connection timeout.");
            },
            read: async () => new Uint8Array(0),
            close: async () => {},
          };
        },
      },
    });
    try {
      const p = call(bt, "POST", "/api/scale/detect", {
        profile_id: "auto",
        transport: "bluetooth",
        port: "48:87:2D:9D:D5:71",
        prefer: "ble",
        no_fallback: true,
      });
      let settled: Awaited<typeof p> | null = null;
      void p.then((r) => (settled = r));
      for (let i = 0; i < 100 && settled === null; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
      const res = await p;
      expect(res.status).toBe(502);
      expect(kinds).toEqual(["ble"]); // el clásico lento NUNCA se intentó
      expect(String(res.json.detail)).toMatch(/BLE/);
      expect(String(res.json.detail)).toMatch(/NO apareció en el scan BLE/);
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("discovery: si el scan BLE falla (Android 6–11 sin Ubicación) el motivo viaja en ble_error y no se traga", async () => {
    const bt = await makeBackend({
      serial: {
        listBt: async () => [],
        startDiscovery: async () => {},
        pollDiscovery: async () => ({ devices: [], finished: true }),
        // el plugin BLE rechaza porque falta el permiso de Ubicación (Android ≤11)
        startBleScan: async () => {
          throw new Error("Permission denied.");
        },
        pollBleScan: async () => ({ devices: [] }),
        stopBleScan: async () => {},
      },
    });
    try {
      const start = await call(bt, "POST", "/api/bt/discovery/start", {});
      expect(start.status).toBe(200); // el clásico sigue; el fallo BLE NO tumba el discovery
      expect(start.json).toEqual({ started: true }); // contrato de start intacto
      const poll = await call(bt, "GET", "/api/bt/discovery");
      expect(poll.status).toBe(200);
      expect(poll.json.finished).toBe(true);
      expect(String(poll.json.ble_error)).toMatch(/denegado|denied/i); // la UI lo muestra con botones
    } finally {
      await bt.repo.close();
    }
  });

  it("POST /api/scale/detect con profile_id 'auto' detecta parser sin marca elegida", async () => {
    const { stringToBytes } = await import("../src/parsers");
    await import("../src/detector");
    await import("../src/serial");
    const chunk = stringToBytes("= 102.50= 102.50= 102.50");
    const transport = {
      label: "fake-bt",
      open: async () => {},
      read: async () => chunk,
      close: async () => {},
    };
    const bt = await makeBackend({ serial: { makeTransport: async () => transport } });
    try {
      const p = call(bt, "POST", "/api/scale/detect", {
        profile_id: "auto",
        transport: "bluetooth",
        port: "98:D3:31:F0:12:34",
      });
      let settled: Awaited<typeof p> | null = null;
      void p.then((r) => (settled = r));
      for (let i = 0; i < 100 && settled === null; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
      const res = await p;
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.parser_ok).toBe(true);
      expect(res.json.parser).toBe("matrix"); // detectado SIN elegir marca
      expect(res.json.verdict).toBe("directa");
      expect(res.json.kg).toBeCloseTo(102.5, 2);
    } finally {
      await bt.repo.close();
    }
  });

  it("scale/connect perfil 'auto': exige body.parser y conecta con el detectado", async () => {
    let got: any = null;
    const bt = await makeBackend({
      createBtDriver: async (profile, address) => {
        got = { profile, address };
        return { disconnect: async () => {}, isConnected: async () => true };
      },
    });
    try {
      // sin parser → instrucción clara de correr la detección primero
      const bad = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "auto",
        transport: "bluetooth",
        port: "98:D3:31:F0:12:34",
      });
      expect(bad.status).toBe(400);
      expect(bad.json.detail).toContain("detect");

      // con el parser detectado + polaridad: conecta y arma el perfil auto
      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "auto",
        parser: "matrix",
        transport: "bluetooth",
        port: "98:D3:31:F0:12:34",
        invert_bits: true,
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        connected: true, profile_id: "auto", transport: "bluetooth",
      });
      expect(got.profile.id).toBe("auto");
      expect(got.profile.parser).toBe("matrix");
      expect(got.profile.extra.invert_bits).toBe(true);
      expect(got.address).toBe("98:D3:31:F0:12:34");

      const status = await call(bt, "GET", "/api/scale/status");
      expect(status.json.connected).toBe(true);
      expect(status.json.profile_id).toBe("auto");
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("POST /api/scale/detect valida perfil y dirección", async () => {
    const noProfile = await call(backend, "POST", "/api/scale/detect", {
      profile_id: "no-existe",
      port: "00:11:22:33:44:55",
    });
    expect(noProfile.status).toBe(404);
    const noPort = await call(backend, "POST", "/api/scale/detect", {
      profile_id: "matrix-adr00",
    });
    expect(noPort.status).toBe(400);
    expect(noPort.json.detail).toContain("MAC");
    const noDev = await call(backend, "POST", "/api/scale/detect", {
      profile_id: "matrix-adr00",
      transport: "usb",
    });
    expect(noDev.status).toBe(400);
    expect(noDev.json.detail).toContain("device_id");
  });

  it("scale/connect transporte USB con invert_bits alimenta el MISMO pipeline de parsers", async () => {
    const { stringToBytes } = await import("../src/parsers");
    const { invertBytes } = await import("../src/signal");
    // el "cable" entrega la trama con la polaridad al revés
    const chunk = invertBytes(stringToBytes("= 126.35"));
    let reads = 0;
    let openedBaud: number | null = null;
    const usb = await makeBackend({
      serial: {
        makeTransport: async (kind, opts) => {
          expect(kind).toBe("usb");
          openedBaud = opts.baud;
          return {
            label: "fake-usb",
            open: async () => {},
            read: async () => (reads++ === 0 ? chunk : new Uint8Array(0)),
            close: async () => {},
          };
        },
      },
    });
    try {
      const res = await call(usb, "POST", "/api/scale/connect", {
        profile_id: "matrix-adr00",
        transport: "usb",
        device_id: 1002,
        baudrate: 4800,
        invert_bits: true,
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ connected: true, transport: "usb" });
      expect(openedBaud).toBe(4800);
      await vi.advanceTimersByTimeAsync(200); // poll del SerialScaleDriver
      const status = await call(usb, "GET", "/api/scale/status");
      expect(status.json.connected).toBe(true);
      expect(status.json.last_kg).toBeCloseTo(126.35, 2);
    } finally {
      await usb.stopDriver();
      await usb.repo.close();
    }
  });

  // ---- monitor de bytes CRUDOS + "conectar de todos modos" (RS232/485) ----

  const framesTransport = (bytes: Uint8Array) => ({
    label: "fake-bt",
    open: async () => {},
    read: async () => bytes,
    close: async () => {},
  });

  it("GET /api/scale/raw expone hex/text/bytes_recibidos/muestra_frames del transporte activo", async () => {
    const { stringToBytes } = await import("../src/parsers");
    const FRAMES = stringToBytes("= 126.35= 126.35= 126.35");
    const bt = await makeBackend({
      serial: { makeTransport: async () => framesTransport(FRAMES) },
    });
    try {
      // sin transporte todavía: monitor en cero
      const empty = await call(bt, "GET", "/api/scale/raw");
      expect(empty.json).toMatchObject({ hex: "", text: "", bytes_recibidos: 0, muestra_frames: [] });

      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "matrix-adr00", transport: "bluetooth", port: "48:87:2D:9D:D5:71",
      });
      expect(res.status).toBe(200);
      await run(bt, 200); // deja que el SerialScaleDriver lea unos ciclos

      const raw = await call(bt, "GET", "/api/scale/raw");
      expect(raw.status).toBe(200);
      expect(raw.json.bytes_recibidos).toBeGreaterThan(0);
      expect(raw.json.hex).toMatch(/^[0-9A-F]{2}( [0-9A-F]{2})*$/);
      expect(raw.json.hex).toContain("3D"); // '='
      expect(raw.json.text).toContain("= 126.35");
      expect(Array.isArray(raw.json.muestra_frames)).toBe(true);
      expect(raw.json.muestra_frames.join(" ")).toContain("126.35");
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("conectar de todos modos (manual): frames reversed '=53.621' → conecta matrix y el toggle 🔁 reverse corrige el valor EN VIVO", async () => {
    const { stringToBytes } = await import("../src/parsers");
    // El módulo transmite el peso al revés: "=53.621 " es 126.35 leído en orden.
    const FRAMES = stringToBytes("=53.621 =53.621 =53.621 ");
    const bt = await makeBackend({
      serial: { makeTransport: async () => framesTransport(FRAMES) },
    });
    try {
      // "👁 Ver datos y conectar igual": perfil auto + manual, SIN parser elegido.
      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "auto", manual: true, transport: "bluetooth", port: "48:87:2D:9D:D5:71",
      });
      expect(res.status).toBe(200);
      // conecta en MODO MANUAL con el parser de mejor esfuerzo (matrix)
      expect(res.json).toMatchObject({ connected: true, transport: "bluetooth", manual: true, parser: "matrix" });
      await run(bt, 200);

      // sin corregir, matrix lee el valor tal cual llega (al revés)
      let status = await call(bt, "GET", "/api/scale/status");
      expect(status.json.connected).toBe(true);
      expect(status.json.last_kg).toBeCloseTo(53.621, 2);

      // y el monitor muestra el stream crudo
      const raw = await call(bt, "GET", "/api/scale/raw");
      expect(raw.json.bytes_recibidos).toBeGreaterThan(0);
      expect(raw.json.text).toContain("=53.621");

      // 🔁 el usuario voltea "Números al revés": reconecta EN VIVO con reverse_frame
      const flip = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "auto", parser: "matrix", transport: "bluetooth",
        port: "48:87:2D:9D:D5:71", reverse_frame: true,
      });
      expect(flip.status).toBe(200);
      await run(bt, 200);

      // ahora el valor sale corregido: 126.35
      status = await call(bt, "GET", "/api/scale/status");
      expect(status.json.last_kg).toBeCloseTo(126.35, 2);
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("conecté pero el módulo no envía: /api/scale/raw reporta bytes_recibidos 0 (la UI dice 'no envía datos')", async () => {
    const bt = await makeBackend({
      serial: { makeTransport: async () => framesTransport(new Uint8Array(0)) },
    });
    try {
      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "auto", manual: true, transport: "bluetooth", port: "48:87:2D:9D:D5:71",
      });
      expect(res.status).toBe(200);
      expect(res.json.connected).toBe(true);
      await run(bt, 300);

      const raw = await call(bt, "GET", "/api/scale/raw");
      expect(raw.json.bytes_recibidos).toBe(0); // enlace vivo pero SIN datos
      expect(raw.json.hex).toBe("");
      const status = await call(bt, "GET", "/api/scale/status");
      expect(status.json.last_kg).toBeNull();
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("scale/connect USB sin device_id responde 400 con instrucción clara", async () => {
    const res = await call(backend, "POST", "/api/scale/connect", {
      profile_id: "matrix-adr00",
      transport: "usb",
    });
    expect(res.status).toBe(400);
    expect(res.json.detail).toContain("device_id");
  });

  it("🧹 /api/mantenimiento: uso + limpiar lecturas + limpiar pesajes con dry_run", async () => {
    // sesión CERRADA vieja con lecturas + sesión ABIERTA con lecturas
    const rVieja = await call(backend, "POST", "/api/sessions", { lote: "L-vieja" });
    const vieja = rVieja.json.id as number;
    await call(backend, "POST", `/api/sessions/${vieja}/close`, {});
    const rAbierta = await call(backend, "POST", "/api/sessions", { lote: "L-abierta" });
    const abierta = rAbierta.json.id as number;
    for (let i = 0; i < 5; i++) {
      await backend.repo.insertReading(vieja, 1000 + i, 80);
      await backend.repo.insertReading(abierta, 2000 + i, 50);
    }
    // la cerrada queda con fecha vieja
    await backend.repo["drv"].run(
      "UPDATE sesiones SET hora_entrada = '2020-01-15T10:00:00Z' WHERE id = ?",
      [vieja],
    );

    const uso = await call(backend, "GET", "/api/mantenimiento/uso");
    expect(uso.status).toBe(200);
    expect(uso.json.db_bytes).toBeGreaterThan(0);
    expect(uso.json.lecturas_total).toBe(10);
    expect(uso.json.lecturas_borrables).toBe(5);
    expect(uso.json.pesajes_cerrados).toBe(1);
    expect(uso.json.pesajes_abiertos).toBe(1);

    // (a) lecturas: borra SOLO las de la cerrada
    const limpiar = await call(backend, "POST", "/api/mantenimiento/limpiar", {
      accion: "lecturas",
    });
    expect(limpiar.json.borrado.lecturas).toBe(5);
    expect(limpiar.json.lecturas_total).toBe(5); // las de la abierta sobreviven

    // (b) pesajes: dry_run cuenta sin borrar…
    for (let i = 0; i < 3; i++) await backend.repo.insertReading(vieja, 5000 + i, 80);
    const dry = await call(backend, "POST", "/api/mantenimiento/limpiar", {
      accion: "pesajes", antes: "2021-01-01", dry_run: true,
    });
    expect(dry.json.borrado).toMatchObject({ pesajes: 1, lecturas: 3, dry_run: true });
    expect((await call(backend, "GET", `/api/sessions/${vieja}`)).status).toBe(200);

    // …y el borrado real elimina la cerrada vieja pero JAMÁS la abierta
    const real = await call(backend, "POST", "/api/mantenimiento/limpiar", {
      accion: "pesajes", antes: "2021-01-01",
    });
    expect(real.json.borrado.pesajes).toBe(1);
    expect((await call(backend, "GET", `/api/sessions/${vieja}`)).status).toBe(404);
    expect((await call(backend, "GET", `/api/sessions/${abierta}`)).status).toBe(200);
    expect(real.json.pesajes_abiertos).toBe(1);

    // validaciones
    const sinFecha = await call(backend, "POST", "/api/mantenimiento/limpiar", {
      accion: "pesajes",
    });
    expect(sinFecha.status).toBe(422);
    expect(sinFecha.json.detail).toContain("YYYY-MM-DD");
    const mala = await call(backend, "POST", "/api/mantenimiento/limpiar", { accion: "todo" });
    expect(mala.status).toBe(422);
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
    const reports: Array<{ filename: string; bytes: Uint8Array }> = [];
    const backend = await makeBackend({
      shareCsv: async (filename) => {
        shared.push(filename);
      },
      shareReport: async (filename, bytes) => {
        reports.push({ filename, bytes });
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

    // window.open del informe (report.pdf) → PDF REAL compartido como
    // archivo .pdf (nativo), NO window.print() (que en el APK sería un
    // no-op silencioso). El generador jsPDF corre tras un import dinámico,
    // así que esperamos activamente a que el archivo se comparta.
    fakeWindow.open(`/api/sessions/${sid}/report.pdf`);
    for (let i = 0; i < 200 && reports.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(reports).toHaveLength(1);
    expect(reports[0].filename).toBe(`informe_sesion_${sid}.pdf`);
    const b = reports[0].bytes;
    expect(String.fromCharCode(b[0], b[1], b[2], b[3])).toBe("%PDF");
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
