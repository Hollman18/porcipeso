import { describe, expect, it } from "vitest";
import type { ScaleProfile } from "../src/models";
import { stringToBytes } from "../src/parsers";
import { ingressBytes, invertBytes, toHex, weightPattern } from "../src/signal";

function profile(extra: Record<string, unknown> = {}): ScaleProfile {
  return {
    id: "matrix-adr00",
    name: "Matrix",
    brand: "Trumax",
    parser: "matrix",
    transport: "serial",
    extra,
  };
}

describe("invertBytes", () => {
  it("aplica ~b & 0xFF byte a byte", () => {
    expect(Array.from(invertBytes(new Uint8Array([0x00, 0xff, 0x30, 0x3d])))).toEqual([
      0xff, 0x00, 0xcf, 0xc2,
    ]);
  });

  it("es involutiva (invertir dos veces devuelve el original)", () => {
    const data = stringToBytes("= 126.35\r\n");
    expect(Array.from(invertBytes(invertBytes(data)))).toEqual(Array.from(data));
  });
});

describe("ingressBytes — punto único de entrada al parser", () => {
  it("sin invert_bits deja los bytes intactos", () => {
    const data = stringToBytes("= 126.35");
    expect(ingressBytes(profile(), data)).toBe(data);
  });

  it("con invert_bits corrige la polaridad (la trama del BC04 vuelve a ser ASCII)", () => {
    const original = stringToBytes("= 126.35");
    const cableInvertido = invertBytes(original);
    const corregido = ingressBytes(profile({ invert_bits: true }), cableInvertido);
    expect(Array.from(corregido)).toEqual(Array.from(original));
  });
});

describe("weightPattern — heurística de trama de peso", () => {
  it("reconoce un stream ASCII de peso", () => {
    const r = weightPattern(stringToBytes("= 126.35= 126.40= 126.35"));
    expect(r.looksLikeWeight).toBe(true);
  });

  it("rechaza ruido binario", () => {
    const noise = new Uint8Array(64);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + 101) & 0xff;
    expect(weightPattern(noise).looksLikeWeight).toBe(false);
  });

  it("rechaza capturas demasiado cortas", () => {
    expect(weightPattern(stringToBytes("1.5")).looksLikeWeight).toBe(false);
  });
});

describe("toHex", () => {
  it("vuelca la cola en HEX legible", () => {
    expect(toHex(new Uint8Array([0x3d, 0x20, 0xcf]))).toBe("3D 20 CF");
    expect(toHex(new Uint8Array(100).fill(0xab), 4)).toBe("AB AB AB AB");
  });
});
