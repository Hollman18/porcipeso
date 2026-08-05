/**
 * Señal directa/invertida — corrección de polaridad UART/TTL.
 *
 * Caso de campo: un módulo Bluetooth HC-05/BC04 soldado a una línea TTL
 * del indicador con la polaridad al revés entrega TODOS los bits
 * invertidos ('0' 0x30 → 0xCF, '=' 0x3D → 0xC2…). La corrección es
 * byte a byte: ~b & 0xFF (involutiva).
 *
 * `ingressBytes()` es el PUNTO ÚNICO por donde entran los bytes de
 * cualquier transporte (Bluetooth y USB) al pipeline de parsers.
 * Equivalente escritorio: porcipeso/drivers/runner.py:ingress().
 */
import type { ScaleProfile } from "./models";

export function invertBytes(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = ~data[i] & 0xff;
  return out;
}

/** Punto único de entrada de bytes al parser (BT y USB). */
export function ingressBytes(profile: ScaleProfile, data: Uint8Array): Uint8Array {
  return profile.extra["invert_bits"] ? invertBytes(data) : data;
}

/** Bytes "con pinta de peso": dígitos, punto, signo, espacio, CR/LF, '='. */
const WEIGHTY = new Set<number>([
  0x2e, 0x20, 0x0d, 0x0a, 0x3d, 0x2b, 0x2d, 0x09,
  0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
]);

export interface WeightPatternResult {
  looksLikeWeight: boolean;
  digitRatio: number; // proporción de bytes 0x30-0x39 / 0x2E
  weightyRatio: number; // proporción de bytes del set completo
}

/**
 * Heurística del detector: ¿el stream parece una trama ASCII de peso?
 * (bytes 0x30-0x39 y 0x2E recurrentes). No exige parser válido: sirve
 * para distinguir "polaridad correcta pero modelo equivocado" de basura.
 */
export function weightPattern(data: Uint8Array): WeightPatternResult {
  if (data.length < 8) return { looksLikeWeight: false, digitRatio: 0, weightyRatio: 0 };
  let digits = 0;
  let weighty = 0;
  for (const b of data) {
    if ((b >= 0x30 && b <= 0x39) || b === 0x2e) digits++;
    if (WEIGHTY.has(b)) weighty++;
  }
  const digitRatio = digits / data.length;
  const weightyRatio = weighty / data.length;
  return {
    looksLikeWeight: digitRatio >= 0.3 && weightyRatio >= 0.85,
    digitRatio,
    weightyRatio,
  };
}

/** Vuelca bytes a HEX legible ("3D 20 31 32 36 2E 33 35"). */
export function toHex(data: Uint8Array, maxBytes = 64): string {
  const tail = data.length > maxBytes ? data.slice(data.length - maxBytes) : data;
  return Array.from(tail)
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}
