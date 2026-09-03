/**
 * BLE junto al clásico en el backend embebido:
 *   · GET /api/bt/discovery fusiona cercanos CLÁSICOS + BLE, sin duplicados
 *     por MAC/id y con su TIPO (kind 'classic' | 'ble'); un dual-mode que
 *     aparece por ambos gana el enlace CLÁSICO (SPP probado).
 *   · POST /api/scale/connect y /api/scale/detect enrutan por transport:'ble'
 *     al BleTransport (kind 'ble' en makeTransport), alimentando el MISMO
 *     pipeline de parsers que el clásico.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalBackend } from "../src/apishim";
import { createSqlJsDriver, Repo } from "../src/db";
import type { ScaleProfile } from "../src/models";
import { mergeBtDevices } from "../src/serial";

const WASM = new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url).pathname;

const PROFILES: ScaleProfile[] = [
  { id: "matrix-adr00", name: "Matrix", brand: "T", parser: "matrix", transport: "serial", extra: {} },
];

type SerialDeps = NonNullable<ConstructorParameters<typeof LocalBackend>[0]["serial"]>;

async function makeBackend(serial?: SerialDeps) {
  const driver = await createSqlJsDriver({ locateFile: () => WASM });
  const repo = await Repo.create(driver);
  return new LocalBackend({ repo, profiles: PROFILES, serial });
}

async function call(backend: LocalBackend, method: string, path: string, body: unknown = null) {
  const res = await backend.handleFetch(method, path, body !== null ? JSON.stringify(body) : null);
  return { status: res.status, json: JSON.parse(await res.text()) };
}

// ------------------------------------------------ merge con TIPO (puro)

describe("mergeBtDevices — clásico + BLE con kind, sin duplicados", () => {
  it("empareja primero (clásico), luego clásicos cercanos, luego BLE — con kind", () => {
    const paired = [{ name: "BC04-BT", address: "00:14:03:05:59:02" }];
    const classic = [{ name: "HC-05", address: "98:D3:31:F0:12:34" }];
    const ble = [{ name: "PorciScale-BLE", address: "AB:CD:EF:00:11:22" }];
    const merged = mergeBtDevices(paired, classic, ble);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ address: "00:14:03:05:59:02", paired: true, kind: "classic" });
    expect(merged[1]).toMatchObject({ address: "98:D3:31:F0:12:34", paired: false, kind: "classic" });
    expect(merged[2]).toMatchObject({ address: "AB:CD:EF:00:11:22", paired: false, kind: "ble" });
  });

  it("dual-mode (misma MAC por clásico Y BLE) gana CLÁSICO (SPP probado)", () => {
    const dual = "11:22:33:44:55:66";
    const merged = mergeBtDevices([], [{ name: "DUAL", address: dual }], [{ name: "DUAL", address: dual }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ address: dual, kind: "classic" });
  });

  it("un id BLE sin nombre sale como 'Dispositivo BT (id)' y kind 'ble'", () => {
    const merged = mergeBtDevices([], [], [{ name: "", address: "F1:F2:F3:F4:F5:F6" }]);
    expect(merged[0].name).toBe("Dispositivo BT (F1:F2:F3:F4:F5:F6)");
    expect(merged[0].kind).toBe("ble");
  });
});

// ------------------------------------------ discovery combinado en el backend

describe("GET /api/bt/discovery — clásico + BLE fusionados con kind", () => {
  it("empareja (clásico) + cercano clásico + cercano BLE, dedupe, kind correcto", async () => {
    const bleStops: number[] = [];
    const bt = await makeBackend({
      listBt: async () => [{ name: "BC04-BT", address: "00:14:03:05:59:02", paired: true }],
      startDiscovery: async () => {},
      pollDiscovery: async () => ({
        devices: [{ name: "HC-05", address: "98:D3:31:F0:12:34" }],
        finished: true,
      }),
      startBleScan: async () => {},
      pollBleScan: async () => ({ devices: [{ name: "PorciScale-BLE", address: "AB:CD:EF:00:11:22" }] }),
      stopBleScan: async () => {
        bleStops.push(1);
      },
    });
    try {
      // los emparejados se cachean al pedirlos (la UI los pinta al instante)
      await call(bt, "GET", "/api/bt/devices");
      expect((await call(bt, "POST", "/api/bt/discovery/start", {})).json).toEqual({ started: true });

      const poll = await call(bt, "GET", "/api/bt/discovery");
      expect(poll.json.finished).toBe(true);
      expect(poll.json.devices).toHaveLength(3);
      const byAddr = Object.fromEntries(poll.json.devices.map((d: any) => [d.address, d]));
      expect(byAddr["00:14:03:05:59:02"]).toMatchObject({ kind: "classic", paired: true });
      expect(byAddr["98:D3:31:F0:12:34"]).toMatchObject({ kind: "classic", paired: false });
      expect(byAddr["AB:CD:EF:00:11:22"]).toMatchObject({ kind: "ble", paired: false });
      // al terminar el ciclo clásico se detiene también el scan BLE
      expect(bleStops.length).toBe(1);
    } finally {
      await bt.repo.close();
    }
  });

  it("un fallo del scan BLE NO tumba el discovery clásico", async () => {
    const bt = await makeBackend({
      listBt: async () => [],
      startDiscovery: async () => {},
      pollDiscovery: async () => ({ devices: [{ name: "HC-05", address: "98:D3:31:F0:12:34" }], finished: false }),
      startBleScan: async () => {
        throw new Error("este equipo no soporta BLE");
      },
      pollBleScan: async () => {
        throw new Error("scan BLE caído");
      },
    });
    try {
      // start NO falla aunque el BLE lance (best-effort)
      expect((await call(bt, "POST", "/api/bt/discovery/start", {})).json).toEqual({ started: true });
      const poll = await call(bt, "GET", "/api/bt/discovery");
      expect(poll.status).toBe(200);
      // los clásicos siguen apareciendo, con kind
      expect(poll.json.devices).toHaveLength(1);
      expect(poll.json.devices[0]).toMatchObject({ address: "98:D3:31:F0:12:34", kind: "classic" });
    } finally {
      await bt.repo.close();
    }
  });
});

// --------------------------------------- connect / detect enrutados por kind

describe("scale/connect · scale/detect — enrutado a BLE por transport:'ble'", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connect transport:'ble' abre el BleTransport y alimenta el pipeline de parsers", async () => {
    const { stringToBytes } = await import("../src/parsers");
    await import("../src/serialdriver"); // precarga los imports dinámicos del shim
    await import("../src/serial"); //       antes de activar los fake timers
    const chunk = stringToBytes("= 126.35");
    let reads = 0;
    let seenKind: string | null = null;
    let seenAddress: string | undefined;
    const bt = await makeBackend({
      makeTransport: async (kind, opts) => {
        seenKind = kind;
        seenAddress = opts.address;
        return {
          label: "fake-ble",
          open: async () => {},
          read: async () => (reads++ === 0 ? chunk : new Uint8Array(0)),
          close: async () => {},
          status: () => "connected",
        };
      },
    });
    vi.useFakeTimers();
    try {
      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "matrix-adr00",
        transport: "ble",
        port: "AB:CD:EF:00:11:22",
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ connected: true, transport: "ble" });
      expect(seenKind).toBe("ble");
      expect(seenAddress).toBe("AB:CD:EF:00:11:22");
      await vi.advanceTimersByTimeAsync(200); // poll del SerialScaleDriver
      await bt.flush();
      const status = await call(bt, "GET", "/api/scale/status");
      expect(status.json.connected).toBe(true);
      expect(status.json.last_kg).toBeCloseTo(126.35, 2);
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("connect BLE sin 'port' responde 400 con instrucción clara", async () => {
    const bt = await makeBackend();
    try {
      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "matrix-adr00",
        transport: "ble",
      });
      expect(res.status).toBe(400);
      expect(res.json.detail).toContain("id del dispositivo BLE");
    } finally {
      await bt.repo.close();
    }
  });

  it("detect transport:'ble' escucha por el BleTransport (kind 'ble', sin baudios)", async () => {
    const { stringToBytes } = await import("../src/parsers");
    await import("../src/detector"); // precarga: el import dinámico del shim no
    await import("../src/serial"); //   debe caer en medio de los fake timers
    const chunk = stringToBytes("= 126.35= 126.35= 126.35");
    let seenKind: string | null = null;
    const bt = await makeBackend({
      makeTransport: async (kind) => {
        seenKind = kind;
        return { label: "fake-ble", open: async () => {}, read: async () => chunk, close: async () => {} };
      },
    });
    vi.useFakeTimers();
    try {
      const p = call(bt, "POST", "/api/scale/detect", {
        profile_id: "auto",
        transport: "ble",
        port: "AB:CD:EF:00:11:22",
      });
      // el detector de Bluetooth/BLE corre una sola ventana (sin barrido de baudios)
      let settled: Awaited<typeof p> | null = null;
      void p.then((r) => (settled = r));
      for (let i = 0; i < 100 && settled === null; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
      const res = await p;
      expect(res.status).toBe(200);
      expect(seenKind).toBe("ble");
      expect(res.json.parser_ok).toBe(true);
      expect(res.json.parser).toBe("matrix");
    } finally {
      vi.useRealTimers();
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("detect BLE sin 'port' responde 400 pidiendo el id del dispositivo", async () => {
    const bt = await makeBackend();
    try {
      const res = await call(bt, "POST", "/api/scale/detect", {
        profile_id: "auto",
        transport: "ble",
      });
      expect(res.status).toBe(400);
      expect(res.json.detail).toContain("id del dispositivo BLE");
    } finally {
      await bt.repo.close();
    }
  });
});
