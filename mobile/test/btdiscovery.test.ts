/**
 * Discovery Bluetooth EN VIVO (bug de campo Xiaomi/MIUI: los cercanos no
 * emparejados no aparecían): merge emparejados+cercanos sin duplicados,
 * hallazgos progresivos vía /api/bt/discovery y aviso accionable cuando
 * la Ubicación del sistema está apagada.
 */
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../src/apishim";
import { createSqlJsDriver, Repo } from "../src/db";
import type { ScaleProfile } from "../src/models";
import { LOCATION_OFF_MSG, mergeBtDevices } from "../src/serial";

const WASM = new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url).pathname;

const PROFILES: ScaleProfile[] = [
  { id: "matrix-adr00", name: "Matrix", brand: "T", parser: "matrix", transport: "serial", extra: {} },
];

async function makeBackend(serial: NonNullable<ConstructorParameters<typeof LocalBackend>[0]["serial"]>) {
  const driver = await createSqlJsDriver({ locateFile: () => WASM });
  const repo = await Repo.create(driver);
  return new LocalBackend({ repo, profiles: PROFILES, serial });
}

async function call(backend: LocalBackend, method: string, path: string, body: unknown = null) {
  const res = await backend.handleFetch(method, path, body !== null ? JSON.stringify(body) : null);
  return { status: res.status, json: JSON.parse(await res.text()) };
}

describe("mergeBtDevices — merge en vivo sin duplicados", () => {
  const paired = [
    { name: "BC04-BT", address: "00:14:03:05:59:02" },
    { name: "", address: "11:22:33:44:55:66" },
  ];

  it("emparejados primero, cercanos después, dedupe por MAC", () => {
    const found = [
      { name: "MODULO-BT", address: "98:D3:31:F0:12:34" },
      { name: "BC04-BT", address: "00:14:03:05:59:02" }, // duplicado: ya emparejado
      { name: "MODULO-BT", address: "98:D3:31:F0:12:34" }, // duplicado exacto
    ];
    const merged = mergeBtDevices(paired, found);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ address: "00:14:03:05:59:02", paired: true });
    expect(merged[2]).toMatchObject({ name: "MODULO-BT", paired: false });
  });

  it("los sin nombre salen como 'Dispositivo BT (MAC)'", () => {
    const merged = mergeBtDevices(paired, [{ name: "", address: "AA:BB:CC:DD:EE:FF" }]);
    expect(merged[1].name).toBe("Dispositivo BT (11:22:33:44:55:66)");
    expect(merged[2].name).toBe("Dispositivo BT (AA:BB:CC:DD:EE:FF)");
  });
});

describe("endpoints de discovery en vivo", () => {
  const polls = [
    { devices: [] as Array<{ name: string; address: string }>, finished: false },
    { devices: [{ name: "MODULO-BT", address: "98:D3:31:F0:12:34" }], finished: false },
    {
      devices: [
        { name: "MODULO-BT", address: "98:D3:31:F0:12:34" },
        { name: "", address: "AA:BB:CC:DD:EE:FF" },
      ],
      finished: true,
    },
  ];

  it("hallazgos PROGRESIVOS: el merge crece en cada poll y reporta finished", async () => {
    let i = 0;
    const bt = await makeBackend({
      listBt: async () => [{ name: "BC04-BT", address: "00:14:03:05:59:02", paired: true }],
      startDiscovery: async () => {},
      pollDiscovery: async () => polls[Math.min(i++, polls.length - 1)],
    });
    try {
      // los emparejados se cachean al pedirlos (la UI los pinta al instante)
      const paired = await call(bt, "GET", "/api/bt/devices");
      expect(paired.json).toEqual([
        { name: "BC04-BT", address: "00:14:03:05:59:02", paired: true },
      ]);
      expect((await call(bt, "POST", "/api/bt/discovery/start", {})).json).toEqual({ started: true });

      const p1 = await call(bt, "GET", "/api/bt/discovery");
      expect(p1.json.finished).toBe(false);
      expect(p1.json.devices).toHaveLength(1); // solo el emparejado

      const p2 = await call(bt, "GET", "/api/bt/discovery");
      expect(p2.json.devices).toHaveLength(2); // llegó MODULO-BT en vivo
      expect(p2.json.devices[1]).toMatchObject({ name: "MODULO-BT", paired: false });

      const p3 = await call(bt, "GET", "/api/bt/discovery");
      expect(p3.json.finished).toBe(true);
      expect(p3.json.devices).toHaveLength(3);
      expect(p3.json.devices[2].name).toBe("Dispositivo BT (AA:BB:CC:DD:EE:FF)");
      // sin duplicados aunque el nativo repita hallazgos
      const macs = p3.json.devices.map((d: any) => d.address);
      expect(new Set(macs).size).toBe(macs.length);
    } finally {
      await bt.repo.close();
    }
  });

  it("Ubicación del sistema apagada → 409 con aviso accionable", async () => {
    const bt = await makeBackend({
      listBt: async () => [],
      startDiscovery: async () => {
        throw new Error("location_off");
      },
    });
    try {
      const res = await call(bt, "POST", "/api/bt/discovery/start", {});
      expect(res.status).toBe(409);
      expect(res.json.detail).toBe(LOCATION_OFF_MSG);
      expect(res.json.detail).toContain("Ubicación encendida");
    } finally {
      await bt.repo.close();
    }
  });

  it("permiso de búsqueda denegado → 403 en humano", async () => {
    const bt = await makeBackend({
      listBt: async () => [],
      startDiscovery: async () => {
        throw new Error("permission_denied: búsqueda Bluetooth");
      },
    });
    try {
      const res = await call(bt, "POST", "/api/bt/discovery/start", {});
      expect(res.status).toBe(403);
      expect(res.json.detail).toContain("Dispositivos cercanos");
    } finally {
      await bt.repo.close();
    }
  });

  it("web (sin plugin): start y poll degradan con 503 'app Android'", async () => {
    const driver = await createSqlJsDriver({ locateFile: () => WASM });
    const repo = await Repo.create(driver);
    const bt = new LocalBackend({ repo, profiles: PROFILES });
    try {
      const start = await call(bt, "POST", "/api/bt/discovery/start", {});
      expect(start.status).toBe(503);
      expect(start.json.detail).toContain("app Android");
      const poll = await call(bt, "GET", "/api/bt/discovery");
      expect(poll.status).toBe(503);
    } finally {
      await bt.repo.close();
    }
  });

  it("POST /api/bt/location/open llega al plugin", async () => {
    let opened = 0;
    const bt = await makeBackend({
      listBt: async () => [],
      openLocationSettings: async () => {
        opened++;
      },
    });
    try {
      const res = await call(bt, "POST", "/api/bt/location/open", {});
      expect(res.status).toBe(200);
      expect(opened).toBe(1);
    } finally {
      await bt.repo.close();
    }
  });
});
