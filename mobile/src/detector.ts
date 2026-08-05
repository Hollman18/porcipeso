/**
 * Detector de señal directa/invertida (y barrido de baudios en USB).
 *
 * Algoritmo por velocidad:
 *   1. Escucha `windowMs` y captura los bytes crudos (emitiendo HEX en
 *      vivo vía onHex para el panel del wizard).
 *   2. Analiza la captura en DIRECTA: ¿algún parser registrado saca una
 *      lectura válida? ¿o al menos hay patrón de peso (0x30-0x39/0x2E
 *      recurrentes)?
 *   3. Si no, aplica ~b & 0xFF (INVERTIDA) sobre la misma captura y
 *      repite el análisis. La inversión es determinista byte a byte, así
 *      que analizar la misma ventana equivale a escuchar otra ventana —
 *      y responde en la mitad del tiempo.
 *   4. En USB se repite por cada velocidad (2 s c/u); en Bluetooth la
 *      velocidad la fija el módulo HC-05 y solo hay una ventana de 3 s.
 *
 * Veredictos → mensajes en humano (ver DETECT_MESSAGES).
 */
import type { ScaleProfile } from "./models";
import { PARSER_REGISTRY } from "./parsers";
import type { ByteTransport } from "./serial";
import { invertBytes, toHex, weightPattern } from "./signal";

export type DetectVerdict = "directa" | "invertida" | "sin_peso" | "sin_datos";

export interface DetectResult {
  ok: boolean;
  verdict: DetectVerdict;
  kg: number | null;
  baudrate: number | null;
  invert_bits: boolean;
  parser_ok: boolean; // true si un parser registrado entendió la trama
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

interface PolarityAnalysis {
  parserOk: boolean;
  kg: number | null;
  weightLike: boolean;
}

/** Analiza UNA polaridad: parser del perfil → cualquier parser → heurística. */
export function analyzeBytes(profile: ScaleProfile, data: Uint8Array): PolarityAnalysis {
  const keys = Object.keys(PARSER_REGISTRY);
  // el parser del perfil elegido primero: su lectura es la que se reporta
  const ordered = keys.includes(profile.parser)
    ? [profile.parser, ...keys.filter((k) => k !== profile.parser)]
    : keys;
  const looksLikeWeight = weightPattern(data).looksLikeWeight;
  for (const key of ordered) {
    // El regex genérico acepta cualquier "línea" con un dígito: sobre ruido
    // binario da falsos positivos, así que solo cuenta si la captura además
    // pasa la heurística de trama ASCII de peso.
    if (key === "generic_regex" && !looksLikeWeight) continue;
    try {
      const parser = new PARSER_REGISTRY[key]({ ...profile, parser: key });
      const readings = parser.push(data).filter((r) => Number.isFinite(r.kg));
      // Se exigen >= 2 tramas válidas: una sola coincidencia sobre ruido
      // (p. ej. el regex genérico ante una "línea" casual con dígitos) no
      // debe declarar la polaridad como correcta.
      if (readings.length >= 2) {
        return { parserOk: true, kg: readings[readings.length - 1].kg, weightLike: true };
      }
    } catch {
      /* un parser que no aplica no corta el análisis */
    }
  }
  return { parserOk: false, kg: null, weightLike: looksLikeWeight };
}

function verdictFor(
  polarity: "directa" | "invertida",
  a: PolarityAnalysis,
  baud: number | null,
  sweep: boolean,
  hex: string,
): DetectResult {
  const baudTxt = sweep && baud != null ? ` a ${baud} baudios` : "";
  const inverted = polarity === "invertida";
  let message: string;
  if (a.parserOk && a.kg !== null) {
    message = inverted
      ? `✓ Señal INVERTIDA detectada y corregida — báscula responde: ${fmtKg(a.kg)} kg${baudTxt}`
      : `✓ La báscula responde: ${fmtKg(a.kg)} kg (señal directa${baudTxt})`;
  } else {
    message =
      `✓ Llegan datos de peso (señal ${polarity}${baudTxt}), pero el modelo elegido ` +
      "no entiende la trama — revisa la marca y el modelo en el paso 2.";
  }
  return {
    ok: true,
    verdict: polarity,
    kg: a.kg,
    baudrate: baud,
    invert_bits: inverted,
    parser_ok: a.parserOk,
    message,
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
        invert_bits: false, parser_ok: false,
        message: DETECT_MESSAGES.sin_datos, hex,
      };
    } else {
      const direct = analyzeBytes(opts.profile, data);
      if (direct.parserOk || direct.weightLike) {
        result = verdictFor("directa", direct, baud, sweep, hex);
      } else {
        const inverted = analyzeBytes(opts.profile, invertBytes(data));
        if (inverted.parserOk || inverted.weightLike) {
          result = verdictFor("invertida", inverted, baud, sweep, hex);
        } else {
          result = {
            ok: false, verdict: "sin_peso", kg: null, baudrate: baud,
            invert_bits: false, parser_ok: false,
            message: DETECT_MESSAGES.sin_peso, hex,
          };
        }
      }
    }

    if (result.parser_ok) return result; // veredicto fuerte: no seguir barriendo
    if (best === null || rank(result) > rank(best)) best = result;
  }
  return best as DetectResult;
}
