import { afterEach, describe, expect, it, vi } from "vitest";
import { BluetoothScaleDriver, BluetoothSerialLike, delimiterFor } from "../src/bluetooth";
import type { ScaleProfile } from "../src/models";

function profile(extra: Record<string, unknown> = {}): ScaleProfile {
  return {
    id: "matrix-adr00",
    name: "Matrix",
    brand: "Trumax",
    parser: "matrix",
    transport: "serial",
    baudrate: 9600,
    bytesize: 8,
    parity: "N",
    stopbits: 1,
    extra,
  };
}

function fakeBluetooth(chunks: string[]): BluetoothSerialLike {
  return {
    isEnabled: async () => ({ enabled: true }),
    enable: async () => ({ enabled: true }),
    scan: async () => ({ devices: [] }),
    connect: async () => {},
    disconnect: async () => {},
    isConnected: async () => ({ connected: true }),
    read: async () => ({ value: chunks.shift() ?? "" }),
  };
}

afterEach(() => vi.useRealTimers());

describe("BluetoothScaleDriver", () => {
  it("lee el buffer aunque la trama no tenga salto de línea", async () => {
    vi.useFakeTimers();
    const readings: number[] = [];
    const bt = fakeBluetooth(["= 12", "6.35"]);
    const driver = new BluetoothScaleDriver(
      profile(),
      "00:11:22:33:44:55",
      (r) => readings.push(r.kg),
      () => {},
      async () => bt,
    );

    await driver.connect();
    await vi.advanceTimersByTimeAsync(100);
    expect(readings).toEqual([126.35]);
    await driver.disconnect();
  });

  it("reporta datos corruptos como configuración RS-232, no charset", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const bt = fakeBluetooth(["a\ufffd\ufffd\ufffd", "a\ufffd\ufffd"]);
    const driver = new BluetoothScaleDriver(
      profile(),
      "00:11:22:33:44:55",
      () => {},
      (message) => errors.push(message),
      async () => bt,
    );

    await driver.connect();
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("9600 baudios, 8N1");
    expect(errors[0]).toContain("Charset no corrige");
    await driver.disconnect();
  });
});

describe("delimiterFor", () => {
  it("conserva compatibilidad con perfiles existentes", () => {
    expect(delimiterFor(profile())).toBe("=");
    expect(delimiterFor(profile({ bt_delimiter: ";" }))).toBe(";");
  });
});
