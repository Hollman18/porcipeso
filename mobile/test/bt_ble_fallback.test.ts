/**
 * AUTO-FALLBACK A BLE POR MAC del connect CLÁSICO (bug de campo: el módulo
 * "RS232/485" aparece como clásico pero el SPP no conecta — "read ret: -1" /
 * bond fallido — porque en realidad es BLE).
 *
 *   · POST /api/scale/connect: si el transporte CLÁSICO falla POR LO QUE SEA,
 *     SIEMPRE reintenta por BLE GATT a la MISMA MAC antes de rendirse — un
 *     connect BLE funciona por MAC aunque el scan no lo etiquetara como BLE, así
 *     que NO se exige hint `also_ble` ni que la MAC esté en el cache del scan.
 *     Al lograrlo responde transport:'ble' + fell_back:true.
 *   · Si BLE TAMBIÉN falla, responde 400 con AMBOS motivos (clásico + BLE) y,
 *     si el módulo BLE no tenía UART usable, adjunta el diagnóstico GATT.
 *   · mergeBtDevices sigue marcando `alsoBle` en dual-mode (informativo/UI).
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

  it("clásico falla SIN hint NI cache → cae a BLE IGUAL (por MAC)", async () => {
    // NUEVO comportamiento: el fallback ya no depende de alsoBle ni del cache
    // del scan — un módulo etiquetado "clásico" que en realidad es BLE conecta.
    let seenKind: string | null = null;
    let bleTried = false;
    const bt = await makeBackend({
      createBtDriver: async () => {
        throw new Error("SPP no conectó (read ret: -1)");
      },
      serial: {
        makeTransport: async (kind) => {
          bleTried = true;
          seenKind = kind;
          return makeFakeBle();
        },
      },
    });
    try {
      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "matrix-adr00",
        transport: "bluetooth",
        port: RS232,
        // sin also_ble, sin discovery previo: NADA marca esta MAC como BLE
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ transport: "ble", fell_back: true });
      expect(res.json.classic_error).toContain("read ret: -1");
      expect(bleTried).toBe(true); // SIEMPRE se intenta BLE
      expect(seenKind).toBe("ble");
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("clásico falla y BLE TAMBIÉN falla → 400 con AMBOS motivos (clásico + BLE)", async () => {
    const bt = await makeBackend({
      createBtDriver: async () => {
        throw new Error("SPP no conectó (read ret: -1)");
      },
      serial: {
        makeTransport: async () => ({
          label: "fake-ble",
          open: async () => {
            throw new Error("bluetooth_off: el BLE está apagado");
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
      });
      expect(res.status).toBe(400);
      // dilo CLARO: ni clásico ni BLE, con ambos motivos
      expect(res.json.detail).toContain("ni por Bluetooth clásico ni por BLE");
      expect(res.json.detail).toContain("read ret: -1");
      expect(res.json.classic_error).toContain("read ret: -1");
      expect(res.json.ble_error).toBeTruthy();
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });

  it("clásico falla y BLE no halla UART → 400 con el DIAGNÓSTICO GATT adjunto", async () => {
    const { BleNoUartError } = await import("../src/serial");
    // un módulo BLE que expone servicios pero ninguna característica NOTIFY
    const exotic = [
      {
        uuid: "0000180a-0000-1000-8000-00805f9b34fb",
        characteristics: [
          { uuid: "00002a29-0000-1000-8000-00805f9b34fb", properties: { read: true } },
        ],
      },
      {
        uuid: "abcd0000-1234-5678-1234-56789abcdef0",
        characteristics: [
          { uuid: "abcd0001-1234-5678-1234-56789abcdef0", properties: { write: true } },
        ],
      },
    ];
    const bt = await makeBackend({
      createBtDriver: async () => {
        throw new Error("SPP no conectó (read ret: -1)");
      },
      serial: {
        makeTransport: async () => ({
          label: "fake-ble",
          open: async () => {
            throw new BleNoUartError(exotic);
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
      });
      expect(res.status).toBe(400);
      // el diagnóstico GATT viaja para mostrarlo copiable en la UI
      expect(Array.isArray(res.json.gatt)).toBe(true);
      expect(res.json.gatt).toHaveLength(2);
      expect(res.json.gatt_text).toContain("abcd0001-1234-5678-1234-56789abcdef0");
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });
});

// ---------------------------- diagnóstico GATT en connect BLE directo

describe("scale/connect transport:'ble' — diagnóstico GATT cuando no hay UART", () => {
  it("devuelve la lista de servicios/características (UUID + props) del módulo", async () => {
    const { BleNoUartError } = await import("../src/serial");
    const exotic = [
      {
        uuid: "aaaa0000-1111-2222-3333-444455556666",
        characteristics: [
          { uuid: "aaaa0001-1111-2222-3333-444455556666", properties: { read: true, write: true } },
        ],
      },
    ];
    const bt = await makeBackend({
      serial: {
        makeTransport: async () => ({
          label: "fake-ble",
          open: async () => {
            throw new BleNoUartError(exotic);
          },
          read: async () => new Uint8Array(0),
          close: async () => {},
        }),
      },
    });
    try {
      const res = await call(bt, "POST", "/api/scale/connect", {
        profile_id: "matrix-adr00",
        transport: "ble",
        port: RS232,
      });
      expect(res.status).toBe(400);
      expect(res.json.gatt).toHaveLength(1);
      expect(res.json.gatt[0].uuid).toBe("aaaa0000-1111-2222-3333-444455556666");
      expect(res.json.gatt[0].characteristics[0].properties).toEqual(["read", "write"]);
      expect(res.json.gatt_text).toContain("aaaa0001-1111-2222-3333-444455556666");
    } finally {
      await bt.stopDriver();
      await bt.repo.close();
    }
  });
});
