/**
 * Detector de señal directa/invertida con streams simulados:
 * directo, invertido, basura y silencio — y el barrido de baudios USB.
 */
import { describe, expect, it } from "vitest";
import { detectSignal } from "../src/detector";
import type { ScaleProfile } from "../src/models";
import { stringToBytes } from "../src/parsers";
import type { ByteTransport } from "../src/serial";
import { invertBytes } from "../src/signal";

function profile(overrides: Partial<ScaleProfile> = {}): ScaleProfile {
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
    extra: {},
    ...overrides,
  };
}

/** Transporte fake: entrega `chunk` en cada read() mientras esté abierto. */
class FakeTransport implements ByteTransport {
  readonly label = "fake";
  opened = 0;
  closed = 0;
  constructor(private chunk: Uint8Array) {}
  async open(): Promise<void> {
    this.opened++;
  }
  async read(): Promise<Uint8Array> {
    return this.chunk;
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

const noWait = async () => {};
const MATRIX_FRAMES = stringToBytes("= 126.35= 126.35= 126.35");

describe("detectSignal — Bluetooth (una sola velocidad)", () => {
  it("señal directa: veredicto con peso y sin invert_bits", async () => {
    const t = new FakeTransport(MATRIX_FRAMES);
    const r = await detectSignal({
      profile: profile(),
      openTransport: async () => t,
      sleep: noWait,
    });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("directa");
    expect(r.invert_bits).toBe(false);
    expect(r.parser_ok).toBe(true);
    expect(r.kg).toBeCloseTo(126.35, 2);
    expect(r.message).toContain("La báscula responde");
    expect(r.message).toContain("126.35");
    expect(r.message).toContain("señal directa");
    expect(t.opened).toBe(1);
    expect(t.closed).toBe(1); // siempre cierra el transporte que abre
  });

  it("señal invertida (caso BC04): la corrige, reporta el peso y pide invert_bits", async () => {
    const t = new FakeTransport(invertBytes(MATRIX_FRAMES));
    const r = await detectSignal({
      profile: profile(),
      openTransport: async () => t,
      sleep: noWait,
    });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("invertida");
    expect(r.invert_bits).toBe(true);
    expect(r.parser_ok).toBe(true);
    expect(r.kg).toBeCloseTo(126.35, 2);
    expect(r.message).toContain("INVERTIDA");
    expect(r.message).toContain("126.35");
  });

  it("basura en ambas polaridades: 'no parecen peso'", async () => {
    const noise = new Uint8Array(120);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 41 + 7) & 0xff;
    const r = await detectSignal({
      profile: profile(),
      openTransport: async () => new FakeTransport(noise),
      sleep: noWait,
    });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe("sin_peso");
    expect(r.message).toContain("no parecen peso en ninguna polaridad");
    expect(r.hex.length).toBeGreaterThan(0);
  });

  it("silencio total: 'no llegan datos'", async () => {
    const r = await detectSignal({
      profile: profile(),
      openTransport: async () => new FakeTransport(new Uint8Array(0)),
      sleep: noWait,
    });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe("sin_datos");
    expect(r.message).toContain("No llegan datos");
  });

  it("emite HEX en vivo mientras escucha", async () => {
    const hexes: string[] = [];
    await detectSignal({
      profile: profile(),
      openTransport: async () => new FakeTransport(stringToBytes("= 100.00")),
      sleep: noWait,
      onHex: (hex) => hexes.push(hex),
    });
    expect(hexes.length).toBeGreaterThan(0);
    expect(hexes[0]).toMatch(/^3D 20 31 30 30/); // "= 100…"
  });
});

describe("detectSignal — USB (barrido de baudios × polaridad)", () => {
  it("encuentra la velocidad correcta aunque no sea la del perfil, con señal invertida", async () => {
    const opened: Array<number | null> = [];
    const r = await detectSignal({
      profile: profile({ baudrate: 9600 }),
      baudrates: [1200, 2400, 4800, 9600, 19200],
      openTransport: async (baud) => {
        opened.push(baud);
        // solo a 4800 llega la trama real (invertida); en el resto, basura
        if (baud === 4800) return new FakeTransport(invertBytes(MATRIX_FRAMES));
        const noise = new Uint8Array(64);
        for (let i = 0; i < noise.length; i++) noise[i] = (i * 13 + 3) & 0xff;
        return new FakeTransport(noise);
      },
      sleep: noWait,
    });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("invertida");
    expect(r.invert_bits).toBe(true);
    expect(r.baudrate).toBe(4800);
    expect(r.kg).toBeCloseTo(126.35, 2);
    expect(r.message).toContain("4800 baudios");
    // prueba primero la velocidad del perfil y para al encontrar trama válida
    expect(opened[0]).toBe(9600);
    expect(opened).toContain(4800);
    expect(opened).not.toContain(19200);
  });

  it("silencio en todas las velocidades: 'no llegan datos'", async () => {
    const r = await detectSignal({
      profile: profile(),
      baudrates: [1200, 9600],
      openTransport: async () => new FakeTransport(new Uint8Array(0)),
      sleep: noWait,
    });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe("sin_datos");
  });
});
