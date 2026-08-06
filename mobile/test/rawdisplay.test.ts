/**
 * Reading.raw — string CRUDO del peso, fiel a lo que MUESTRA el indicador.
 * Espejo de tests/drivers/test_raw_display.py (subset móvil: matrix,
 * xk3190_a12e, generic_regex).
 *
 * Regla (evidencia de campo): si el indicador transmite "-7143.0" el LED
 * muestra "-7143.0" — sin locale ni separador de miles. Con reverse_frame,
 * raw es el CORREGIDO legible (lo que el display muestra), no los bytes
 * al revés.
 */
import { describe, expect, it } from "vitest";
import { Reading, ScaleProfile, mkReading } from "../src/models";
import { FrameParser, PARSER_REGISTRY, stringToBytes } from "../src/parsers";

function makeProfile(parser: string, extra: Record<string, unknown> = {}): ScaleProfile {
  return { id: "test-scale", name: `Test ${parser}`, brand: "Test", parser, transport: "serial", extra };
}

function make(key: string, extra: Record<string, unknown> = {}): FrameParser {
  return new PARSER_REGISTRY[key](makeProfile(key, extra));
}

function feed(parser: FrameParser, ...chunks: string[]): Reading[] {
  const out: Reading[] = [];
  for (const chunk of chunks) out.push(...parser.push(stringToBytes(chunk)));
  return out;
}

describe("Reading.raw (contrato)", () => {
  it("mkReading sigue funcionando sin raw (campo opcional)", () => {
    const r = mkReading(0, 1.0);
    expect(r.raw).toBeUndefined();
  });
});

describe("matrix raw", () => {
  it("caso de campo: '=-7143.0' → raw '-7143.0' idéntico al indicador", () => {
    const [r] = feed(make("matrix"), "=-7143.0");
    expect(r.kg).toBeCloseTo(-7143.0, 6);
    expect(r.raw).toBe("-7143.0");
  });

  it("normal: '= 126.35' → raw '126.35'", () => {
    const [r] = feed(make("matrix"), "= 126.35");
    expect(r.raw).toBe("126.35");
  });

  it("adr99 (extra.reversed): raw es el CORREGIDO legible", () => {
    const [r] = feed(make("matrix", { reversed: true }), "=53.621 ");
    expect(r.kg).toBeCloseTo(126.35, 6);
    expect(r.raw).toBe("126.35");
  });

  it("reverse_frame: manda '0.4321', raw es '1234.0' (lo que muestra el display)", () => {
    const [r] = feed(make("matrix", { reverse_frame: true }), "= 0.4321");
    expect(r.kg).toBeCloseTo(1234.0, 6);
    expect(r.raw).toBe("1234.0");
  });
});

describe("xk3190_a12e raw", () => {
  it("stream invertido de fábrica: raw corregido tal cual el display", () => {
    const [r] = feed(make("xk3190_a12e"), "=53.6210");
    expect(r.kg).toBeCloseTo(126.35, 6);
    expect(r.raw).toBe("0126.35");
  });
});

describe("generic_regex raw", () => {
  it("token del peso sin tocar: '-7143.0'", () => {
    const [r] = feed(make("generic_regex"), "-7143.0\r\n");
    expect(r.raw).toBe("-7143.0");
  });

  it("reverse_frame '001' → raw '100'", () => {
    const [r] = feed(make("generic_regex", { reverse_frame: true }), "001\r\n");
    expect(r.kg).toBeCloseTo(100.0, 6);
    expect(r.raw).toBe("100");
  });

  it("patrón custom: raw = grupo 1", () => {
    const [r] = feed(make("generic_regex", { pattern: "PESO:\\s*([-+]?\\d+\\.\\d+)" }), "PESO: 126.35\r\n");
    expect(r.raw).toBe("126.35");
  });
});
