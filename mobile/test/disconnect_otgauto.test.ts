/**
 * Conexión de báscula — POST /api/scale/disconnect (tarjeta de estado)
 * y flujo OTG AUTOMÁTICO sin marcas (detect auto + usb → connect auto).
 *
 * Mismo contrato que porcipeso/api/app.py: desconectar corta el driver
 * pero NO toca la config guardada (que vive en el cliente); reconectar
 * es POST /api/scale/connect de nuevo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalBackend } from "../src/apishim";
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

/** Espera una promesa que corre bajo fake timers. */
async function settle<T>(p: Promise<T>, steps = 200): Promise<T> {
  let done = false;
  void p.then(() => (done = true)).catch(() => (done = true));
  for (let i = 0; i < steps && !done; i++) {
    await vi.advanceTimersByTimeAsync(100);
  }
  return p;
}

describe("POST /api/scale/disconnect — corta el driver, conserva la reconexión", () => {
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

  it("idempotente: sin driver activo responde connected:false / disconnected:false", async () => {
    const res = await call(backend, "POST", "/api/scale/disconnect", {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ connected: false, disconnected: false });
  });

  it("sim: conectada → desconectar → estado suelto → reconectar con sim/start", async () => {
    await call(backend, "POST", "/api/sim/start", {});
    await vi.advanceTimersByTimeAsync(500);
    let status = await call(backend, "GET", "/api/scale/status");
    expect(status.json.connected).toBe(true);

    const res = await call(backend, "POST", "/api/scale/disconnect", {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ connected: false, disconnected: true });
    expect(backend.sim).toBeNull(); // el driver simulado quedó detenido

    status = await call(backend, "GET", "/api/scale/status");
    expect(status.json.connected).toBe(false);
    expect(status.json.profile_id).toBeNull();
    expect(status.json.error).toBeNull();

    // reconectar: un toque (la config guardada vive en el cliente)
    const again = await call(backend, "POST", "/api/sim/start", {});
    expect(again.json.connected).toBe(true);
    status = await call(backend, "GET", "/api/scale/status");
    expect(status.json.connected).toBe(true);
  });

  it("driver real (BT mock): disconnect() del driver se invoca y se limpia el error", async () => {
    let disconnects = 0;
    const bt = await makeBackend({
      createBtDriver: async () => ({
        disconnect: async () => {
          disconnects += 1;
        },
        isConnected: async () => true,
      }),
    });
    try {
      const conn = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "matrix-adr00",
        transport: "bluetooth",
        port: "00:14:03:05:59:02",
      });
      expect(conn.status).toBe(200);
      bt.driverError = "ruido transitorio"; // el disconnect debe limpiarlo

      const res = await call(bt, "POST", "/api/scale/disconnect", {});
      expect(res.json).toEqual({ connected: false, disconnected: true });
      expect(disconnects).toBe(1);
      expect(bt.btDriver).toBeNull();
      expect(bt.driverProfile).toBeNull();

      const status = await call(bt, "GET", "/api/scale/status");
      expect(status.json.connected).toBe(false);
      expect(status.json.error).toBeNull();
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });
});

describe("OTG AUTOMÁTICO sin marcas — detect auto+usb barre velocidades, connect auto+usb", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detect profile_id 'auto' + usb: encuentra parser y velocidad sin elegir marca", async () => {
    const { stringToBytes } = await import("../src/parsers");
    await import("../src/detector"); // precarga fuera de los fake timers
    await import("../src/serial");
    const frames = stringToBytes("= 102.50= 102.50= 102.50");
    const opened: Array<number | null> = [];
    const usb = await makeBackend({
      serial: {
        listUsb: async () => [
          { deviceId: 1002, vid: 0x1a86, pid: 0x7523, name: "USB Serial", driver: "Ch34xSerialDriver" },
        ],
        makeTransport: async (kind, opts) => {
          expect(kind).toBe("usb");
          opened.push(opts.baud);
          const good = opts.baud === 4800; // la báscula SOLO habla a 4800
          let reads = 0;
          return {
            label: `fake-usb@${opts.baud}`,
            open: async () => {},
            read: async () => (good && reads++ < 3 ? frames : new Uint8Array(0)),
            close: async () => {},
          };
        },
      },
    });
    try {
      // 1) lista USB (lo que ve la pantalla "Elige tu báscula")
      const devices = await call(usb, "GET", "/api/usb/devices");
      expect(devices.status).toBe(200);
      expect(devices.json[0].deviceId).toBe(1002);

      // 2) detección automática completa: velocidades × combos × parsers
      const res = await settle(
        call(usb, "POST", "/api/scale/detect", {
          profile_id: "auto",
          transport: "usb",
          device_id: 1002,
          baudrates: [9600, 4800],
        }),
      );
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.parser_ok).toBe(true);
      expect(res.json.parser).toBe("matrix"); // SIN marca elegida
      expect(res.json.baudrate).toBe(4800); // barrió y encontró la velocidad
      expect(res.json.kg).toBeCloseTo(102.5, 2);
      expect(opened).toEqual([9600, 4800]); // preferida primero, luego el resto

      // 3) conectar con lo detectado (lo que guarda la config del cliente)
      const conn = await settle(
        call(usb, "POST", "/api/scale/connect", {
          profile_id: "auto",
          parser: res.json.parser,
          transport: "usb",
          device_id: 1002,
          baudrate: res.json.baudrate,
          invert_bits: res.json.invert_bits,
          reverse_frame: res.json.reverse_frame,
        }),
      );
      expect(conn.status).toBe(200);
      expect(conn.json).toMatchObject({ connected: true, profile_id: "auto", transport: "usb" });
      expect(opened[opened.length - 1]).toBe(4800); // conecta a la velocidad detectada

      await vi.advanceTimersByTimeAsync(300); // poll del SerialScaleDriver
      const status = await call(usb, "GET", "/api/scale/status");
      expect(status.json.connected).toBe(true);
      expect(status.json.profile_id).toBe("auto");
      expect(status.json.last_kg).toBeCloseTo(102.5, 2);

      // 4) desconectar deja todo suelto (la config sigue en el cliente)
      const off = await call(usb, "POST", "/api/scale/disconnect", {});
      expect(off.json).toEqual({ connected: false, disconnected: true });
    } finally {
      await usb.stopDriver();
      await usb.repo.close();
    }
  });

  it("connect 'auto' + usb sin parser detectado exige correr la detección primero", async () => {
    const usb = await makeBackend({});
    try {
      const res = await call(usb, "POST", "/api/scale/connect", {
        profile_id: "auto",
        transport: "usb",
        device_id: 1002,
      });
      expect(res.status).toBe(400);
      expect(res.json.detail).toContain("detect");
    } finally {
      await usb.repo.close();
    }
  });
});
