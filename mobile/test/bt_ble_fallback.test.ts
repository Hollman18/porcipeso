/**
 * FALLBACK BLE dual-mode del connect CLÁSICO (bug de campo: el módulo
 * "RS232/485" aparece como clásico pero el SPP no conecta — "read ret: -1").
 *
 *   · mergeBtDevices marca `alsoBle:true` en un clásico cuya MISMA MAC también
 *     se anuncia por BLE (dual-mode) → habilita el fallback.
 *   · POST /api/scale/connect: si el transporte CLÁSICO falla y hay BLE para esa
 *     MAC (hint body.also_ble o el cache de MACs BLE del discovery), reintenta
 *     por BLE y responde con transport:'ble' + fell_back:true.
 *   · Sin BLE disponible, el connect clásico fallido responde 400 con su error.
 */
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../src/apishim";
import { createSqlJsDriver, Repo } from "../src/db";
import type { ScaleProfile } from "../src/models";
import { mergeBtDevices } from "../src/serial";

const WASM = new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url).pathname;

const PROFILES: ScaleProfile[] = [
  { id: "matrix-adr00", name: "Matrix", brand: "T", parser: "matrix", transport: "serial", extra: {} },
];

type Deps = ConstructorParameters<typeof LocalBackend>[0];

async function makeBackend(extra: Partial<Deps> = {}) {
  const driver = await createSqlJsDriver({ locateFile: () => WASM });
  const repo = await Repo.create(driver);
  return new LocalBackend({ repo, profiles: PROFILES, ...extra });
}

async function call(backend: LocalBackend, method: string, path: string, body: unknown = null) {
  const res = await backend.handleFetch(method, path, body !== null ? JSON.stringify(body) : null);
  return { status: res.status, json: JSON.parse(await res.text()) };
}

/** Transporte BLE falso que entrega una trama matrix y luego calla. */
async function makeFakeBle() {
  const { stringToBytes } = await import("../src/parsers");
  const chunk = stringToBytes("= 126.35");
  let reads = 0;
  return {
    label: "fake-ble",
    open: async () => {},
    read: async () => (reads++ === 0 ? chunk : new Uint8Array(0)),
    close: async () => {},
    status: () => "connected" as const,
  };
}

const RS232 = "48:87:2D:9D:D5:71"; // el módulo real del cliente

// -------------------------------------------------- merge dual-mode con alsoBle

describe("mergeBtDevices — dual-mode marca alsoBle en el clásico", () => {
  it("un clásico cuya MAC también sale por BLE queda kind 'classic' + alsoBle:true", () => {
    const merged = mergeBtDevices([], [{ name: "RS232/485", address: RS232 }], [{ name: "RS232/485", address: RS232 }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ address: RS232, kind: "classic", alsoBle: true });
  });

  it("un emparejado que también aparece por BLE también queda alsoBle:true", () => {
    const merged = mergeBtDevices([{ name: "BC04", address: RS232 }], [], [{ name: "BC04", address: RS232 }]);
    expect(merged[0]).toMatchObject({ paired: true, kind: "classic", alsoBle: true });
  });

  it("un clásico SIN gemelo BLE NO lleva alsoBle", () => {
    const merged = mergeBtDevices([], [{ name: "HC-05", address: "98:D3:31:F0:12:34" }], []);
    expect(merged[0].kind).toBe("classic");
    expect(merged[0].alsoBle).toBeUndefined();
  });
});

// --------------------------------------------- fallback en /api/scale/connect

describe("scale/connect — fallback CLÁSICO→BLE dual-mode", () => {
  it("clásico falla + also_ble hint → conecta por BLE y responde fell_back", async () => {
    let seenKind: string | null = null;
    let seenAddr: string | undefined;
    const bt = await makeBackend({
      createBtDriver: async () => {
        throw new Error("SPP no conectó (UUID: read failed... read ret: -1 · canal 1: read failed... read ret: -1)");
      },
      serial: {
        makeTransport: async (kind, opts) => {
          seenKind = kind;
          seenAddr = opts.address;
          return makeFakeBle();
        },
      },
    });
    try {
      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "matrix-adr00",
        transport: "bluetooth",
        port: RS232,
        also_ble: true,
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ connected: true, transport: "ble", fell_back: true });
      expect(res.json.classic_error).toContain("read ret: -1");
      expect(seenKind).toBe("ble"); // el fallback abrió el BleTransport
      expect(seenAddr).toBe(RS232); // a la MISMA MAC
      // el enlace BLE quedó activo (el motor recibe la trama)
      await bt.flush();
      const status = await call(bt, "GET", "/api/scale/status");
      expect(status.json.connected).toBe(true);
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("clásico falla + MAC en el cache BLE del discovery → cae a BLE sin hint", async () => {
    let seenKind: string | null = null;
    const bt = await makeBackend({
      createBtDriver: async () => {
        throw new Error("read ret: -1");
      },
      serial: {
        listBt: async () => [],
        startDiscovery: async () => {},
        pollDiscovery: async () => ({ devices: [{ name: "RS232/485", address: RS232 }], finished: true }),
        startBleScan: async () => {},
        // el mismo módulo se anuncia por BLE → el cache recuerda su MAC
        pollBleScan: async () => ({ devices: [{ name: "RS232/485", address: RS232 }] }),
        stopBleScan: async () => {},
        makeTransport: async (kind) => {
          seenKind = kind;
          return makeFakeBle();
        },
      },
    });
    try {
      // corre el discovery: puebla el cache de MACs BLE
      await call(bt, "POST", "/api/bt/discovery/start", {});
      await call(bt, "GET", "/api/bt/discovery");
      // connect clásico SIN also_ble: el cache habilita el fallback igual
      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "matrix-adr00",
        transport: "bluetooth",
        port: RS232,
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ transport: "ble", fell_back: true });
      expect(seenKind).toBe("ble");
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("clásico falla SIN BLE disponible → 400 con el error clásico (sin fallback)", async () => {
    let bleTried = false;
    const bt = await makeBackend({
      createBtDriver: async () => {
        throw new Error("SPP no conectó (read ret: -1)");
      },
      serial: {
        makeTransport: async () => {
          bleTried = true;
          return makeFakeBle();
        },
      },
    });
    try {
      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "matrix-adr00",
        transport: "bluetooth",
        port: RS232,
      });
      expect(res.status).toBe(400);
      expect(res.json.detail).toContain("read ret: -1");
      expect(bleTried).toBe(false); // no dual-mode → no se intentó BLE
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("clásico falla + also_ble pero BLE TAMBIÉN falla → 400 con el error clásico original", async () => {
    const bt = await makeBackend({
      createBtDriver: async () => {
        throw new Error("SPP no conectó (read ret: -1)");
      },
      serial: {
        makeTransport: async () => ({
          label: "fake-ble",
          open: async () => {
            throw new Error("no_uart: el dispositivo BLE no notifica");
          },
          read: async () => new Uint8Array(0),
          close: async () => {},
        }),
      },
    });
    try {
      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "matrix-adr00",
        transport: "bluetooth",
        port: RS232,
        also_ble: true,
      });
      expect(res.status).toBe(400);
      // el error CLÁSICO original es el más informativo cuando ambos fallan
      expect(res.json.detail).toContain("read ret: -1");
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });
});
