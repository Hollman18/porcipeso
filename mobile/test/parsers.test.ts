/**
 * Parsers TS con las MISMAS tramas de tests/drivers/test_parsers.py
 * (subset móvil: matrix, xk3190_a12e, generic_regex).
 */
import { describe, expect, it } from "vitest";
import { Reading, ScaleProfile } from "../src/models";
import { FrameParser, PARSER_REGISTRY, stringToBytes } from "../src/parsers";

function makeProfile(parser: string, extra: Record<string, unknown> = {}): ScaleProfile {
  return {
    id: "test-scale",
    name: `Test ${parser}`,
    brand: "Test",
    parser,
    transport: "serial",
    extra,
  };
}

function make(key: string, extra: Record<string, unknown> = {}): FrameParser {
  return new PARSER_REGISTRY[key](makeProfile(key, extra));
}

/** bytes: cada char del string es un byte (como b"..." en Python). */
function b(s: string): Uint8Array {
  return stringToBytes(s);
}

function feed(parser: FrameParser, ...chunks: string[]): Reading[] {
  const out: Reading[] = [];
  for (const chunk of chunks) out.push(...parser.push(b(chunk)));
  return out;
}

function kgs(readings: Reading[]): number[] {
  return readings.map((r) => r.kg);
}

describe("registro", () => {
  it("mismas claves que PARSER_REGISTRY de Python (subset móvil)", () => {
    expect(new Set(Object.keys(PARSER_REGISTRY))).toEqual(
      new Set(["matrix", "xk3190_a12e", "generic_regex"]),
    );
  });

  it("Reading con los campos del contrato", () => {
    const p = make("matrix");
    const [r] = feed(p, "= 126.35");
    expect(r.kg).toBeCloseTo(126.35, 6);
    expect(r.scale_id).toBe("test-scale");
    expect(r.stable_flag).toBeNull();
    expect(r.ts_ms).toBeGreaterThan(1_700_000_000_000);
  });
});

describe("matrix", () => {
  it("adr00 normal", () => {
    const [r] = feed(make("matrix"), "= 126.35");
    expect(r.kg).toBeCloseTo(126.35, 6);
  });

  it("adr99 invertido (extra.reversed)", () => {
    const [r] = feed(make("matrix", { reversed: true }), "=53.621 ");
    expect(r.kg).toBeCloseTo(126.35, 6);
  });

  it("fragmentado en dos chunks", () => {
    const p = make("matrix");
    expect(feed(p, "= 12")).toEqual([]);
    const [r] = feed(p, "6.35");
    expect(r.kg).toBeCloseTo(126.35, 6);
  });

  it("basura antes de la trama", () => {
    const [r] = feed(make("matrix"), "\x00\xff\x13basura= 126.35");
    expect(r.kg).toBeCloseTo(126.35, 6);
  });

  it("negativo", () => {
    const [r] = feed(make("matrix"), "= -12.50");
    expect(r.kg).toBeCloseTo(-12.5, 6);
  });

  it("negativo invertido", () => {
    const [r] = feed(make("matrix", { reversed: true }), "=05.21- ");
    expect(r.kg).toBeCloseTo(-12.5, 6);
  });

  it("stream con varias tramas", () => {
    const rs = feed(make("matrix"), "= 126.35= 130.10= 130.10");
    expect(kgs(rs).map((v) => Math.round(v * 100) / 100)).toEqual([126.35, 130.1, 130.1]);
  });

  it("resincroniza ante basura después de '='", () => {
    const [r] = feed(make("matrix"), "=XY\x01Z= 126.35");
    expect(r.kg).toBeCloseTo(126.35, 6);
  });
});

describe("xk3190_a12e", () => {
  it("7 chars invertidos", () => {
    const [r] = feed(make("xk3190_a12e"), "=53.6210"); // display 0126.35
    expect(r.kg).toBeCloseTo(126.35, 6);
  });

  it("fragmentado", () => {
    const p = make("xk3190_a12e");
    expect(feed(p, "=53.6")).toEqual([]);
    const [r] = feed(p, "210");
    expect(r.kg).toBeCloseTo(126.35, 6);
  });

  it("basura y luego stream", () => {
    const rs = feed(make("xk3190_a12e"), "\xaa\xbb=53.6210=00.0300"); // 126.35 y 0030.00
    expect(kgs(rs).map((v) => Math.round(v * 100) / 100)).toEqual([126.35, 30.0]);
  });

  it("negativo", () => {
    const [r] = feed(make("xk3190_a12e"), "=53.620-"); // display -026.35
    expect(r.kg).toBeCloseTo(-26.35, 6);
  });
});

describe("generic_regex", () => {
  it("patrón por defecto", () => {
    const [r] = feed(make("generic_regex"), "126.35\r\n");
    expect(r.kg).toBeCloseTo(126.35, 6);
  });

  it("línea con unidad (compat tuxon_ascii)", () => {
    const [r] = feed(make("generic_regex"), "  126.35 kg\r\n");
    expect(r.kg).toBeCloseTo(126.35, 6);
    expect(r.stable_flag).toBeNull();
  });

  it("patrón custom + basura", () => {
    const rs = feed(
      make("generic_regex", { pattern: "PESO:\\s*([-+]?\\d+\\.\\d+)" }),
      "RUIDO 99\r\nPESO: 126.35\r\n",
    );
    expect(kgs(rs).map((v) => Math.round(v * 100) / 100)).toEqual([126.35]);
  });

  it("terminador de línea custom", () => {
    const rs = feed(make("generic_regex", { line_terminator: ";" }), "126.35;-10.20;");
    expect(kgs(rs).map((v) => Math.round(v * 100) / 100)).toEqual([126.35, -10.2]);
  });

  it("fragmentado", () => {
    const p = make("generic_regex");
    expect(feed(p, "126")).toEqual([]);
    const [r] = feed(p, ".35\n");
    expect(r.kg).toBeCloseTo(126.35, 6);
  });

  it("línea de basura ignorada", () => {
    const rs = feed(make("generic_regex", { pattern: "P:\\s*(\\d+\\.\\d+)" }), "T: x\r\nP: 126.35\r\n");
    expect(kgs(rs).map((v) => Math.round(v * 100) / 100)).toEqual([126.35]);
  });

  it("negativo", () => {
    const [r] = feed(make("generic_regex"), " -5.20\r\n");
    expect(r.kg).toBeCloseTo(-5.2, 6);
  });
});
