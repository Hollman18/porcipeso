/**
 * Detector de señal (y barrido de baudios en USB) — 4 COMBINACIONES:
 * normal / números al revés (reverse_frame) / bits invertidos
 * (invert_bits) / ambas. Por velocidad:
 *
 *   1. Escucha `windowMs` y captura los bytes crudos (HEX en vivo vía
 *      onHex para el panel del wizard).
 *   2. Sobre la MISMA captura prueba polaridad × orden-de-caracteres ×
 *      todos los parsers registrados (ambas transformaciones son
 *      deterministas, así que no hace falta re-escuchar por combo).
 *   3. Elige por PLAUSIBILIDAD (ver tokenFormScore): parser válido con
 *      ≥2 tramas + heurística del punto decimal — un peso real no tiene
 *      forma "0.4321" (punto y 4 decimales) ni "001" (ceros a la
 *      izquierda). La forma se evalúa EN LA INTERPRETACIÓN EFECTIVA de
 *      cada candidato, así los parsers que ya invierten solos (XK3190 /
 *      Matrix Adr99) compiten en igualdad y el punto decimal desempata.
 *   4. En USB se repite por cada velocidad (2 s c/u); en Bluetooth la
 *      velocidad la fija el módulo HC-05 y solo hay una ventana de 3 s.
 *
 * Veredictos → mensajes en humano (ver buildMessage / DETECT_MESSAGES).
 */
import type { Reading, ScaleProfile } from "./models";
import {
  asciiDecode,
  PARSER_REGISTRY,
  reverseFrameActive,
  reverseString,
} from "./parsers";
import type { ByteTransport } from "./serial";
import { invertBytes, toHex, weightPattern } from "./signal";

export type DetectVerdict = "directa" | "invertida" | "sin_peso" | "sin_datos";

export interface DetectResult {
  ok: boolean;
  /** Polaridad eléctrica elegida (compat: "invertida" = invert_bits). */
  verdict: DetectVerdict;
  kg: number | null;
  baudrate: number | null;
  invert_bits: boolean;
  /** Orden de caracteres al revés detectado ("001" = 100). */
  reverse_frame: boolean;
  parser_ok: boolean; // true si un parser registrado entendió la trama
  /** QUÉ parser entendió la trama (clave de PARSER_REGISTRY) — es lo que
   *  el perfil "auto" del flujo Bluetooth guarda para reconectar. */
  parser: string | null;
  message: string;
  hex: string; // últimos bytes crudos capturados
}

export interface DetectOptions {
  profile: ScaleProfile;
  /** Fábrica del transporte; recibe el baudrate (null = fijo, Bluetooth). */
  openTransport: (baud: number | null) => Promise<ByteTransport>;
  /** Velocidades a barrer (USB). null/[] = una sola ventana (Bluetooth). */
  baudrates?: number[] | null;
  /** Ventana de escucha por velocidad (default: 3000 sin barrido, 2000 con). */
  windowMs?: number;
  /** HEX en vivo para el panel del wizard. */
  onHex?: (hex: string, baud: number | null) => void;
  /** Inyectable en tests (fake timers). */
  sleep?: (ms: number) => Promise<void>;
}

const POLL_MS = 50;

function fmtKg(kg: number): string {
  return kg.toFixed(2).replace(/\.?0+$/, "") || "0";
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ------------------------------------------------------- plausibilidad

/**
 * Puntúa la FORMA de un token numérico tal como quedaría interpretado.
 * Heurística del punto decimal del cliente: un peso real casi nunca es
 * "0.4321" (4 decimales) ni "001" (ceros a la izquierda sin punto).
 *
 *   +1  forma natural: (0|[1-9]…)(.dd)? — 0-2 decimales, sin ceros raros
 *    0  numérico pero raro sin ser descarte (ej. "07.5")
 *   −2  no-numérico bien formado ("1.2.3"), > 20000, > 2 decimales,
 *       o ceros a la IZQUIERDA sin punto ("001")
 */
export function tokenFormScore(token: string): number {
  if (!/^\d+(\.\d+)?$/.test(token)) return -2;
  const value = Number(token);
  if (!Number.isFinite(value) || value > 20000) return -2;
  const dot = token.indexOf(".");
  const decimals = dot < 0 ? 0 : token.length - dot - 1;
  if (decimals > 2) return -2;
  if (dot < 0 && /^0\d/.test(token)) return -2;
  return /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(token) ? 1 : 0;
}

function numericTokens(text: string): string[] {
  return (text.match(/[0-9.]{2,}/g) ?? []).slice(0, 40);
}

/** Promedio de tokenFormScore, con los tokens leídos en la reversa dada. */
function comboFormScore(tokens: string[], reversed: boolean): number {
  if (!tokens.length) return 0;
  let sum = 0;
  for (const t of tokens) sum += tokenFormScore(reversed ? reverseString(t) : t);
  return sum / tokens.length;
}

export interface Candidate {
  parser: string;
  kg: number;
  invert: boolean; // invert_bits aplicado
  reverse: boolean; // reverse_frame aplicado
  score: number;
}

/**
 * Prueba las 4 combinaciones (normal / reverse_frame / invert_bits /
 * ambas) × todos los parsers registrados y puntúa cada candidato:
 *
 *   score = 3 (parser válido: ≥2 tramas finitas, kg ∈ [0, 20000])
 *         + formScore promedio de la INTERPRETACIÓN EFECTIVA
 *           (reverse del combo XOR lo que el parser invierte solo)
 *         + 0.5 si es el parser del perfil elegido (no-auto)
 *         − 0.25 por corrección aplicada (reverse, invert) → a igual
 *           plausibilidad gana la interpretación más simple
 */
export function analyzeCombos(
  profile: ScaleProfile,
  data: Uint8Array,
): { best: Candidate | null; weightLikeInvert: boolean | null } {
  const keys = Object.keys(PARSER_REGISTRY);
  const ordered = keys.includes(profile.parser)
    ? [profile.parser, ...keys.filter((k) => k !== profile.parser)]
    : keys;
  const baseExtra: Record<string, unknown> = { ...profile.extra };
  delete baseExtra["invert_bits"]; // las transformaciones las pone el combo
  delete baseExtra["reverse_frame"];

  let best: Candidate | null = null;
  let weightLikeInvert: boolean | null = null;

  for (const invert of [false, true]) {
    const bytes = invert ? invertBytes(data) : data;
    const looksLikeWeight = weightPattern(bytes).looksLikeWeight;
    if (looksLikeWeight && weightLikeInvert === null) weightLikeInvert = invert;
    const tokens = numericTokens(asciiDecode(bytes));

    for (const reverse of [false, true]) {
      for (const key of ordered) {
        // El regex genérico acepta cualquier "línea" con un dígito: sobre
        // ruido binario da falsos positivos, así que solo cuenta si la
        // captura además pasa la heurística de trama ASCII de peso.
        if (key === "generic_regex" && !looksLikeWeight) continue;
        const variant: ScaleProfile = {
          ...profile,
          parser: key,
          extra: { ...baseExtra, reverse_frame: reverse },
        };
        let readings: Reading[];
        try {
          readings = new PARSER_REGISTRY[key](variant)
            .push(bytes)
            .filter((r) => Number.isFinite(r.kg));
        } catch {
          continue; // un parser que no aplica no corta el análisis
        }
        // ≥2 tramas válidas: una coincidencia casual sobre ruido no cuenta
        if (readings.length < 2) continue;
        const kg = readings[readings.length - 1].kg;
        if (kg < 0 || kg > 20000) continue;
        // La forma se evalúa como el parser LEE los dígitos: XOR entre la
        // reversa del combo y la que el parser aplica de fábrica (XK3190 /
        // extra.reversed legado). Así "= 126.35" leído por xk3190 puntúa
        // como "53.621" (mal) y por matrix como "126.35" (bien) — el punto
        // decimal desempata a los parsers auto-invertidos.
        const effectiveReverse = reverseFrameActive(variant, key === "xk3190_a12e");
        const score =
          3 +
          comboFormScore(tokens, effectiveReverse) +
          (key === profile.parser ? 0.5 : 0) -
          0.25 * (Number(reverse) + Number(invert));
        if (best === null || score > best.score) {
          best = { parser: key, kg, invert, reverse, score };
        }
      }
    }
  }
  return { best, weightLikeInvert };
}

/** Mensaje en humano según las correcciones aplicadas. */
function buildMessage(c: Candidate, baudTxt: string): string {
  const kg = fmtKg(c.kg);
  if (c.invert && c.reverse) {
    return `✓ Señal eléctrica invertida y números al revés — corregido: la báscula responde ${kg} kg${baudTxt}`;
  }
  if (c.invert) {
    return `✓ Señal INVERTIDA detectada y corregida — báscula responde: ${kg} kg${baudTxt}`;
  }
  if (c.reverse) {
    return `✓ Los números venían al revés — corregido: la báscula responde ${kg} kg${baudTxt}`;
  }
  return `✓ La báscula responde: ${kg} kg (señal directa${baudTxt})`;
}

function candidateResult(
  c: Candidate,
  baud: number | null,
  sweep: boolean,
  hex: string,
): DetectResult {
  const baudTxt = sweep && baud != null ? ` a ${baud} baudios` : "";
  return {
    ok: true,
    verdict: c.invert ? "invertida" : "directa",
    kg: c.kg,
    baudrate: baud,
    invert_bits: c.invert,
    reverse_frame: c.reverse,
    parser_ok: true,
    parser: c.parser,
    message: buildMessage(c, baudTxt),
    hex,
  };
}

function weightLikeResult(
  invert: boolean,
  baud: number | null,
  sweep: boolean,
  hex: string,
): DetectResult {
  const baudTxt = sweep && baud != null ? ` a ${baud} baudios` : "";
  return {
    ok: true,
    verdict: invert ? "invertida" : "directa",
    kg: null,
    baudrate: baud,
    invert_bits: invert,
    reverse_frame: false,
    parser_ok: false,
    parser: null,
    message:
      `✓ Llegan datos de peso (señal ${invert ? "invertida" : "directa"}${baudTxt}), ` +
      "pero el modelo elegido no entiende la trama — revisa la marca y el modelo en el paso 2.",
    hex,
  };
}

export const DETECT_MESSAGES = {
  sin_peso:
    "✗ Llegan datos pero no parecen peso en ninguna polaridad — puede ser " +
    "velocidad equivocada del módulo o una línea que no es UART.",
  sin_datos:
    "✗ No llegan datos. Revisa que el indicador esté encendido, la salida " +
    "serial activada y el módulo o cable bien conectado.",
} as const;

async function capture(
  transport: ByteTransport,
  windowMs: number,
  baud: number | null,
  onHex: DetectOptions["onHex"],
  sleep: (ms: number) => Promise<void>,
): Promise<Uint8Array> {
  let buf: Uint8Array = new Uint8Array(0);
  const rounds = Math.max(1, Math.round(windowMs / POLL_MS));
  for (let i = 0; i < rounds; i++) {
    await sleep(POLL_MS);
    const chunk = await transport.read();
    if (chunk.length) {
      buf = concat(buf, chunk);
      onHex?.(toHex(buf), baud);
    }
  }
  return buf;
}

/** Corre la detección completa. Cierra siempre los transportes que abre. */
export async function detectSignal(opts: DetectOptions): Promise<DetectResult> {
  const sweep = Array.isArray(opts.baudrates) && opts.baudrates.length > 0;
  const windowMs = opts.windowMs ?? (sweep ? 2000 : 3000);
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  // el baudrate del perfil primero: es el caso más probable
  let bauds: Array<number | null> = [null];
  if (sweep) {
    const list = [...(opts.baudrates as number[])];
    const preferred = opts.profile.baudrate ?? 9600;
    bauds = [preferred, ...list.filter((b) => b !== preferred)];
  }

  let best: DetectResult | null = null;
  const rank = (r: DetectResult): number =>
    r.parser_ok ? 3 : r.ok ? 2 : r.verdict === "sin_peso" ? 1 : 0;

  for (const baud of bauds) {
    const transport = await opts.openTransport(baud);
    let data: Uint8Array = new Uint8Array(0);
    try {
      await transport.open();
      data = await capture(transport, windowMs, baud, opts.onHex, sleep);
    } finally {
      await transport.close();
    }
    const hex = toHex(data);

    let result: DetectResult;
    if (data.length === 0) {
      result = {
        ok: false, verdict: "sin_datos", kg: null, baudrate: baud,
        invert_bits: false, reverse_frame: false, parser_ok: false,
        parser: null, message: DETECT_MESSAGES.sin_datos, hex,
      };
    } else {
      const { best: candidate, weightLikeInvert } = analyzeCombos(opts.profile, data);
      if (candidate !== null) {
        result = candidateResult(candidate, baud, sweep, hex);
      } else if (weightLikeInvert !== null) {
        result = weightLikeResult(weightLikeInvert, baud, sweep, hex);
      } else {
        result = {
          ok: false, verdict: "sin_peso", kg: null, baudrate: baud,
          invert_bits: false, reverse_frame: false, parser_ok: false,
          parser: null, message: DETECT_MESSAGES.sin_peso, hex,
        };
      }
    }

    if (result.parser_ok) return result; // veredicto fuerte: no seguir barriendo
    if (best === null || rank(result) > rank(best)) best = result;
  }
  return best as DetectResult;
}
