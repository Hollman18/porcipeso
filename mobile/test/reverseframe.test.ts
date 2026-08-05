/**
 * extra.reverse_frame — orden de caracteres del contenido de la trama al
 * revés ("0.4321" = 1234.0, "001" = 100). Independiente de invert_bits
 * (polaridad eléctrica) y XOR con el `reversed` legado del Matrix/XK3190.
 */
import { describe, expect, it } from "vitest";
import type { ScaleProfile } from "../src/models";
import {
  GenericRegexParser,
  MatrixParser,
  reverseFrameActive,
  stringToBytes,
  Xk3190A12eParser,
} from "../src/parsers";
import { ingressBytes, invertBytes } from "../src/signal";

function profile(parser: string, extra: Record<string, unknown> = {}): ScaleProfile {
  return { id: "t", name: "T", brand: "T", parser, transport: "serial", extra };
}

describe("reverseFrameActive — XOR con lo legado", () => {
  it("combina reverse_frame con reversed/forzado por XOR", () => {
    expect(reverseFrameActive(profile("x"))).toBe(false);
    expect(reverseFrameActive(profile("x", { reverse_frame: true }))).toBe(true);
    expect(reverseFrameActive(profile("x", { reversed: true }))).toBe(true);
    // toggle encima de un perfil que YA invierte → vuelve a normal
    expect(reverseFrameActive(profile("x", { reversed: true, reverse_frame: true }))).toBe(false);
    expect(reverseFrameActive(profile("x"), true)).toBe(true);
    expect(reverseFrameActive(profile("x", { reverse_frame: true }), true)).toBe(false);
  });
});

describe("reverse_frame en parsers", () => {
  it("matrix: '= 0.4321' con punto en otra posición → 1234.0", () => {
    const p = new MatrixParser(profile("matrix", { reverse_frame: true }));
    const [r] = p.push(stringToBytes("= 0.4321"));
    expect(r.kg).toBeCloseTo(1234.0, 3);
  });

  it("matrix: estilo Adr99 '=53.621 ' → 126.35 por el mecanismo general", () => {
    const p = new MatrixParser(profile("matrix", { reverse_frame: true }));
    const [r] = p.push(stringToBytes("=53.621 "));
    expect(r.kg).toBeCloseTo(126.35, 2);
  });

  it("xk3190 (invierte de fábrica) XOR reverse_frame → decodifica orden normal", () => {
    const p = new Xk3190A12eParser(profile("xk3190_a12e", { reverse_frame: true }));
    const [r] = p.push(stringToBytes("= 126.35"));
    expect(r.kg).toBeCloseTo(126.35, 2);
  });

  it("línea: '001' → 100 (ceros a la izquierda) y '0.4321' → 1234.0", () => {
    const p = new GenericRegexParser(profile("generic_regex", { reverse_frame: true }));
    const [a] = p.push(stringToBytes("001\r"));
    expect(a.kg).toBeCloseTo(100.0, 3);
    const [b] = p.push(stringToBytes("0.4321\r"));
    expect(b.kg).toBeCloseTo(1234.0, 3);
  });

  it("sin flag nada cambia", () => {
    const p = new GenericRegexParser(profile("generic_regex"));
    const [r] = p.push(stringToBytes(" 126.35\r"));
    expect(r.kg).toBeCloseTo(126.35, 2);
  });

  it("coexiste con invert_bits: bits al revés Y caracteres al revés", () => {
    const prof = profile("generic_regex", { invert_bits: true, reverse_frame: true });
    const cable = invertBytes(stringToBytes("0.4321\r")); // así llega del BC04
    const p = new GenericRegexParser(prof);
    const [r] = p.push(ingressBytes(prof, cable)); // ingress corrige bits; parser el orden
    expect(r.kg).toBeCloseTo(1234.0, 3);
  });
});
