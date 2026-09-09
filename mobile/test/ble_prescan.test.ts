/**
 * CAUSA RAÍZ de campo (módulo RS232\485 BLE): conectar por MAC sin un scan LE
 * previo hace que el plugin caiga a getRemoteDevice(mac)+connectGatt asumiendo
 * dirección PÚBLICA; con dirección ALEATORIA el GATT nunca conecta. El
 * BleTransport debe PRESENTAR el dispositivo con un scan antes del connect (lo
 * que hace Serial Bluetooth Terminal) y, si falla, decir si lo vio en el aire.
 */
import { describe, expect, it } from "vitest";
import {
  BleTransport,
  HM10_CHAR,
  HM10_SERVICE,
  type BleClientLike,
  type BleScanHit,
} from "../src/ble";

const MAC = "48:87:2D:9D:D5:71";

function fakeClient(opts: { advertises: boolean; withScan?: boolean; connectOk?: boolean }) {
  const calls: string[] = [];
  const client: BleClientLike = {
    initialize: async () => {
      calls.push("initialize");
    },
    connect: async () => {
      calls.push("connect");
      if (opts.connectOk === false) throw new Error("Connection timeout.");
    },
    disconnect: async () => {
      calls.push("disconnect");
    },
    getServices: async () => [
      {
        uuid: HM10_SERVICE,
        characteristics: [{ uuid: HM10_CHAR, properties: { notify: true, write: true } }],
      },
    ],
    startNotifications: async () => {
      calls.push("startNotifications");
    },
    stopNotifications: async () => {},
  };
  if (opts.withScan !== false) {
    client.requestLEScan = async (_o, cb: (r: BleScanHit) => void) => {
      calls.push("requestLEScan");
      if (opts.advertises) cb({ device: { deviceId: MAC.toLowerCase(), name: "RS232\\485" } });
    };
    client.stopLEScan = async () => {
      calls.push("stopLEScan");
    };
  }
  return { client, calls };
}

// sleep instantáneo: el prescan no debe esperar los 8 s reales en tests
const instant = async () => {};

describe("BleTransport: prescan LE antes del connect (causa raíz del módulo BLE)", () => {
  it("escanea, VE el módulo (MAC sin importar mayúsculas) y luego conecta", async () => {
    const { client, calls } = fakeClient({ advertises: true });
    const t = new BleTransport(MAC, { client, sleep: instant });
    await t.open();
    expect(t.status()).toBe("connected");
    // el scan corre y se detiene ANTES del connect
    expect(calls.indexOf("requestLEScan")).toBeGreaterThan(-1);
    expect(calls.indexOf("stopLEScan")).toBeLessThan(calls.indexOf("connect"));
    expect(calls.indexOf("requestLEScan")).toBeLessThan(calls.indexOf("connect"));
    await t.close();
  });

  it("si el módulo NO aparece en el scan y el GATT falla, el error lo dice claro", async () => {
    const { client } = fakeClient({ advertises: false, connectOk: false });
    const t = new BleTransport(MAC, { client, sleep: instant });
    await expect(t.open()).rejects.toThrow(/NO apareció en el scan BLE/);
  });

  it("si SÍ aparece pero el GATT falla, distingue ese caso", async () => {
    const { client } = fakeClient({ advertises: true, connectOk: false });
    const t = new BleTransport(MAC, { client, sleep: instant });
    // el mensaje incluye la dirección BLE vista: "…en el scan BLE (AA:BB:…) pero…"
    await expect(t.open()).rejects.toThrow(/SÍ apareció en el scan BLE.*pero el GATT no conectó/);
  });

  it("dual-mode: anuncia por BLE con OTRA dirección → lo encuentra por NOMBRE y conecta a esa", async () => {
    const LE_ADDR = "C4:12:AB:00:11:22"; // dirección BLE real (≠ MAC clásica)
    const connectedTo: string[] = [];
    const client: BleClientLike = {
      initialize: async () => {},
      connect: async (id) => {
        connectedTo.push(id);
      },
      disconnect: async () => {},
      getServices: async () => [
        {
          uuid: HM10_SERVICE,
          characteristics: [{ uuid: HM10_CHAR, properties: { notify: true, write: true } }],
        },
      ],
      startNotifications: async () => {},
      stopNotifications: async () => {},
      requestLEScan: async (_o, cb: (r: BleScanHit) => void) => {
        // en el aire NO aparece la MAC clásica: aparece el NOMBRE bajo otra dirección
        cb({ device: { deviceId: LE_ADDR, name: "RS232\\485" } });
      },
      stopLEScan: async () => {},
    };
    const t = new BleTransport(MAC, { client, sleep: instant, expectName: "RS232\\485" });
    await t.open();
    expect(t.status()).toBe("connected");
    expect(connectedTo).toEqual([LE_ADDR]); // conectó a la dirección BLE vista, no a la clásica
    await t.close();
  });

  it("Android 12/13: pide Ubicación; si la niegan reintenta sin ella; scan en baja latencia", async () => {
    const initOpts: Array<boolean | undefined> = [];
    let scanMode: number | undefined;
    const client: BleClientLike = {
      initialize: async (o) => {
        initOpts.push(o?.androidNeverForLocation);
        // el usuario NIEGA la ubicación en el primer intento (androidNeverForLocation:false)
        if (o?.androidNeverForLocation === false) throw new Error("Permission denied.");
      },
      connect: async () => {},
      disconnect: async () => {},
      getServices: async () => [
        {
          uuid: HM10_SERVICE,
          characteristics: [{ uuid: HM10_CHAR, properties: { notify: true, write: true } }],
        },
      ],
      startNotifications: async () => {},
      stopNotifications: async () => {},
      requestLEScan: async (o, cb: (r: BleScanHit) => void) => {
        scanMode = o.scanMode;
        cb({ device: { deviceId: MAC, name: "RS232\\485" } });
      },
      stopLEScan: async () => {},
      isLocationEnabled: async () => false,
    };
    const t = new BleTransport(MAC, { client, sleep: instant });
    await t.open();
    expect(t.status()).toBe("connected");
    // 1º con ubicación (false) → negado → 2º sin ubicación (true): no bloquea a Android 14+
    expect(initOpts).toEqual([false, true]);
    expect(scanMode).toBe(2); // SCAN_MODE_LOW_LATENCY, como Serial Bluetooth Terminal
    await t.close();
  });

  it("si NO aparece en el scan y la Ubicación está APAGADA, el error lo dice (Android 12/13)", async () => {
    const client: BleClientLike = {
      initialize: async () => {},
      connect: async () => {
        throw new Error("Connection timeout.");
      },
      disconnect: async () => {},
      getServices: async () => [],
      startNotifications: async () => {},
      stopNotifications: async () => {},
      requestLEScan: async () => {}, // nadie anuncia
      stopLEScan: async () => {},
      isLocationEnabled: async () => false,
    };
    const t = new BleTransport(MAC, { client, sleep: instant });
    await expect(t.open()).rejects.toThrow(/UBICACIÓN del teléfono está APAGADA/);
  });

  it("alreadySeen: si la búsqueda ya vio la dirección por LE, NO vuelve a escanear y conecta directo", async () => {
    const { client, calls } = fakeClient({ advertises: true });
    const t = new BleTransport(MAC, { client, sleep: instant, alreadySeen: true });
    await t.open();
    expect(t.status()).toBe("connected");
    expect(calls).not.toContain("requestLEScan"); // sin gastar otro scan (5 cada 30 s)
    expect(calls).toContain("connect");
    await t.close();
  });

  it("cliente sin scan (fakes/legado): se salta el prescan y conecta igual", async () => {
    const { client, calls } = fakeClient({ advertises: true, withScan: false });
    const t = new BleTransport(MAC, { client, sleep: instant });
    await t.open();
    expect(calls).not.toContain("requestLEScan");
    expect(calls).toContain("connect");
    await t.close();
  });
});
