/**
 * Parsers de tramas — port de porcipeso/drivers/parsers.py, SOLO los
 * necesarios para el MVP móvil: `matrix`, `xk3190_a12e`, `generic_regex`
 * (los demás protocolos quedan para después; el registro usa las MISMAS
 * claves que PARSER_REGISTRY de Python para que profiles.yaml aplique
 * sin cambios).
 *
 * Misma mecánica: buffer interno tolerante a fragmentación arbitraria,
 * resincronización ante basura, Reading.ts_ms = Date.now().
 */
import { Reading, ScaleProfile } from "./models";

const MAX_BUFFER = 4096; // tope del buffer; ante desborde se conserva la cola

function nowMs(): number {
  return Date.now();
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** float() de Python sobre texto ASCII: estricto (sin parseFloat laxo). */
function pyFloat(text: string): number | null {
  const t = text.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export abstract class FrameParser {
  readonly profile: ScaleProfile;
  protected buf: Uint8Array = new Uint8Array(0);

  constructor(profile: ScaleProfile) {
    this.profile = profile;
  }

  push(data: Uint8Array): Reading[] {
    this.buf = concatBytes(this.buf, data);
    const readings = this.extract();
    if (this.buf.length > MAX_BUFFER) {
      this.buf = this.buf.slice(this.buf.length - 256);
    }
    return readings;
  }

  protected abstract extract(): Reading[];

  protected reading(kg: number, stable: boolean | null = null): Reading {
    return { ts_ms: nowMs(), kg, scale_id: this.profile.id, stable_flag: stable };
  }
}

/** Decodifica bytes como ASCII con reemplazo (paridad con decode("ascii","replace")). */
function asciiDecode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : "�";
  return s;
}

// ---------------------------------------------------------------------------
// Lexus / Trumax Matrix — trama continua de 8 bytes: '=' + 7 chars de peso.
// Adr 00: '= 126.35' (normal).  Adr 99: dígitos invertidos, '=53.621 '.
// ---------------------------------------------------------------------------
export class MatrixParser extends FrameParser {
  static parserName = "matrix";
  protected forcedReversed = false;
  protected readonly FRAME_LEN = 8;

  private isReversed(): boolean {
    return this.forcedReversed || Boolean(this.profile.extra["reversed"]);
  }

  protected extract(): Reading[] {
    const out: Reading[] = [];
    for (;;) {
      const start = this.buf.indexOf(0x3d); // '='
      if (start < 0) {
        this.buf = new Uint8Array(0);
        break;
      }
      if (start > 0) this.buf = this.buf.slice(start);
      if (this.buf.length < this.FRAME_LEN) break;
      const payload = asciiDecode(this.buf.slice(1, this.FRAME_LEN));
      let text = payload.trim();
      if (this.isReversed()) text = text.split("").reverse().join("");
      const kg = pyFloat(text);
      if (kg === null) {
        this.buf = this.buf.slice(1); // basura tras '=': resincronizar
        continue;
      }
      this.buf = this.buf.slice(this.FRAME_LEN);
      out.push(this.reading(kg));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Yaohua XK3190-A12E / A9 / A27 (y Rhino I-QY) — stream ASCII continuo:
// '=' + 7 chars con el peso invertido (display 0126.35 -> '=53.6210').
// ---------------------------------------------------------------------------
export class Xk3190A12eParser extends MatrixParser {
  static parserName = "xk3190_a12e";
  protected forcedReversed = true;
}

// ---------------------------------------------------------------------------
// Genérico regex — líneas ASCII; extra.pattern (grupo 1 = peso) y
// extra.line_terminator opcionales. Cubre tuxon_ascii/Prometálicos/etc.
// ---------------------------------------------------------------------------
export class GenericRegexParser extends FrameParser {
  static parserName = "generic_regex";
  static readonly DEFAULT_PATTERN = "([-+]?\\d+\\.?\\d*)";
  private re: RegExp;
  private terminators: Set<number>;

  constructor(profile: ScaleProfile) {
    super(profile);
    const pattern = (profile.extra["pattern"] as string) || GenericRegexParser.DEFAULT_PATTERN;
    this.re = new RegExp(pattern);
    const term = profile.extra["line_terminator"] as string | undefined;
    const termStr = term && term.length ? term : "\r\n";
    this.terminators = new Set(Array.from(termStr).map((c) => c.charCodeAt(0)));
  }

  protected extract(): Reading[] {
    const out: Reading[] = [];
    for (;;) {
      let idx = -1;
      for (let i = 0; i < this.buf.length; i++) {
        if (this.terminators.has(this.buf[i])) {
          idx = i;
          break;
        }
      }
      if (idx < 0) break;
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const text = asciiDecode(line);
      if (!text.trim()) continue;
      const m = this.re.exec(text);
      if (!m || m[1] === undefined) continue;
      const kg = pyFloat(m[1]);
      if (kg === null) continue;
      out.push(this.reading(kg));
    }
    return out;
  }
}

/** Mismas claves que PARSER_REGISTRY de Python (subset móvil). */
export const PARSER_REGISTRY: Record<string, new (p: ScaleProfile) => FrameParser> = {
  matrix: MatrixParser,
  xk3190_a12e: Xk3190A12eParser,
  generic_regex: GenericRegexParser,
};

export function isParserSupported(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(PARSER_REGISTRY, key);
}

/** Convierte el string que entrega el plugin BT (chars = bytes) a bytes. */
export function stringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
