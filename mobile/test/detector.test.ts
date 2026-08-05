/**
 * Detector de señal directa/invertida con streams simulados:
 * directo, invertido, basura y silencio — y el barrido de baudios USB.
 */
import { describe, expect, it } from "vitest";
import { detectSignal, tokenFormScore } from "../src/detector";
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
    expect(r.parser).toBe("matrix"); // reporta QUÉ parser entendió la trama
    expect(t.opened).toBe(1);
    expect(t.closed).toBe(1); // siempre cierra el transporte que abre
  });

  it("perfil 'auto' (parser desconocido): prueba todos los parsers y reporta el que matcheó", async () => {
    // sin marca elegida: profile.parser = 'auto' no existe en el registro
    const r = await detectSignal({
      profile: profile({ id: "auto", parser: "auto" }),
      openTransport: async () => new FakeTransport(invertBytes(MATRIX_FRAMES)),
      sleep: noWait,
    });
    expect(r.ok).toBe(true);
    expect(r.parser_ok).toBe(true);
    expect(r.parser).toBe("matrix"); // lo que el flujo BT guarda en cfg.parser
    expect(r.verdict).toBe("invertida");
    expect(r.invert_bits).toBe(true);
    expect(r.kg).toBeCloseTo(126.35, 2);
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

describe("tokenFormScore — heurística del punto decimal", () => {
  it("puntúa la forma natural y castiga las formas al revés", () => {
    expect(tokenFormScore("1234.0")).toBe(1); // natural, 1 decimal
    expect(tokenFormScore("100")).toBe(1);
    expect(tokenFormScore("0")).toBe(1);
    expect(tokenFormScore("0.5")).toBe(1);
    expect(tokenFormScore("0.4321")).toBe(-2); // 4 decimales: peso al revés
    expect(tokenFormScore("001")).toBe(-2); // ceros a la IZQUIERDA sin punto
    expect(tokenFormScore("1.2.3")).toBe(-2); // no numérico bien formado
    expect(tokenFormScore("25000")).toBe(-2); // fuera de rango verosímil
    expect(tokenFormScore("07.5")).toBe(0); // raro pero no descarte
  });
});

describe("detectSignal — 4 combinaciones (normal/reversa/bits/ambas) por plausibilidad", () => {
  it("números al revés por línea: '001' → 100 con reverse_frame", async () => {
    const r = await detectSignal({
      profile: profile({ id: "auto", parser: "auto" }),
      openTransport: async () => new FakeTransport(stringToBytes("001\r\n001\r\n001\r\n")),
      sleep: noWait,
    });
    expect(r.ok).toBe(true);
    expect(r.parser_ok).toBe(true);
    expect(r.reverse_frame).toBe(true);
    expect(r.invert_bits).toBe(false);
    expect(r.kg).toBeCloseTo(100, 3);
    expect(r.message).toContain("Los números venían al revés");
    expect(r.message).toContain("100 kg");
  });

  it("AMBAS correcciones: bits invertidos + caracteres al revés", async () => {
    const r = await detectSignal({
      profile: profile({ id: "auto", parser: "auto" }),
      openTransport: async () =>
        new FakeTransport(invertBytes(stringToBytes("0.4321\r\n0.4321\r\n"))),
      sleep: noWait,
    });
    expect(r.ok).toBe(true);
    expect(r.invert_bits).toBe(true);
    expect(r.reverse_frame).toBe(true);
    expect(r.kg).toBeCloseTo(1234.0, 3);
    expect(r.message).toContain("Señal eléctrica invertida y números al revés");
  });

  it("desempate vs parsers auto-invertidos: stream NORMAL no se lee al revés", async () => {
    // "= 126.35" también "matchea" con el XK3190 (leería 53.621): la
    // heurística del punto decimal debe elegir la interpretación natural.
    const r = await detectSignal({
      profile: profile({ id: "auto", parser: "auto" }),
      openTransport: async () => new FakeTransport(MATRIX_FRAMES),
      sleep: noWait,
    });
    expect(r.kg).toBeCloseTo(126.35, 2);
    expect(r.parser).toBe("matrix");
    expect(r.reverse_frame).toBe(false);
    expect(r.invert_bits).toBe(false);
  });

  it("stream estilo Adr99 ('=53.621 '): el valor reportado es el real 126.35", async () => {
    const r = await detectSignal({
      profile: profile({ id: "auto", parser: "auto" }),
      openTransport: async () =>
        new FakeTransport(stringToBytes("=53.621 =53.621 =53.621 ")),
      sleep: noWait,
    });
    expect(r.ok).toBe(true);
    expect(r.parser_ok).toBe(true);
    expect(r.kg).toBeCloseTo(126.35, 2); // jamás 53.621
    expect(r.invert_bits).toBe(false);
  });

  it("perfil de marca elegido ('matrix') + '= 0.4321': gana matrix con números al revés", async () => {
    const r = await detectSignal({
      profile: profile(), // matrix-adr00
      openTransport: async () =>
        new FakeTransport(stringToBytes("= 0.4321= 0.4321= 0.4321")),
      sleep: noWait,
    });
    expect(r.parser).toBe("matrix"); // el bonus del perfil elegido desempata
    expect(r.reverse_frame).toBe(true);
    expect(r.kg).toBeCloseTo(1234.0, 3);
    expect(r.message).toContain("Los números venían al revés");
    expect(r.message).toContain("1234 kg");
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
