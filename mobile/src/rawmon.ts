/**
 * Monitor de bytes CRUDOS — fuente de verdad para "ver qué llega". El detector
 * adivina; esto NO. Acumula los últimos ~2 KB recibidos por CUALQUIER
 * transporte conectado (BT clásico / BLE / USB) y los expone en HEX + texto
 * ASCII, más un contador total y unas tramas de muestra. Lo consume
 * GET /api/scale/raw (apishim) para el monitor en vivo del wizard y de
 * ⚙ Báscula, y el connect "de todos modos" lo usa para elegir parser.
 *
 * Módulo SIN dependencias de Capacitor a propósito: apishim lo importa de forma
 * ESTÁTICA (necesita una instancia como campo) sin arrastrar el plugin nativo
 * (serial.ts/ble.ts se siguen cargando con import() perezoso). serial.ts lo
 * re-exporta para cohesión con el resto de transportes.
 */
import type { ByteTransport } from "./serial";

const EMPTY = new Uint8Array(0);

export interface RawSnapshot {
  /** Últimos bytes en hexadecimal ("3D 20 31 32 36 2E 33 35"). */
  hex: string;
  /** Interpretación ASCII imprimible (· para bytes no-imprimibles). */
  text: string;
  /** Total de bytes recibidos desde el último reset (0 = el módulo no envía). */
  bytes_recibidos: number;
  /** Tramas de muestra (segmentadas por control/'='), las más recientes. */
  muestra_frames: string[];
}

/** Acumulador de los últimos bytes crudos de un transporte (ring de ~2 KB). */
export class RawMonitor {
  private buf: Uint8Array = EMPTY;
  private total = 0;
  private readonly cap: number;
  /** Bytes mostrados en hex/text (cola): suficiente para ver, sin inflar el JSON. */
  private readonly showTail: number;

  constructor(cap = 2048, showTail = 512) {
    this.cap = cap;
    this.showTail = showTail;
  }

  /** Registra un chunk recién leído (no-op si viene vacío). */
  record(bytes: Uint8Array): void {
    if (!bytes || !bytes.length) return;
    this.total += bytes.length;
    const combined = new Uint8Array(this.buf.length + bytes.length);
    combined.set(this.buf, 0);
    combined.set(bytes, this.buf.length);
    this.buf = combined.length > this.cap ? combined.slice(combined.length - this.cap) : combined;
  }

  /** Vacía el buffer y el contador (nuevo enlace = cuenta desde cero). */
  reset(): void {
    this.buf = EMPTY;
    this.total = 0;
  }

  /** Total de bytes vistos desde el último reset. */
  get bytesReceived(): number {
    return this.total;
  }

  /** Copia del buffer retenido (para elegir parser por mejor esfuerzo). */
  bytes(): Uint8Array {
    return this.buf.slice();
  }

  private tail(): Uint8Array {
    return this.buf.length > this.showTail ? this.buf.slice(this.buf.length - this.showTail) : this.buf;
  }

  private frameSamples(): string[] {
    // Agrupa por límites de trama: cualquier byte de control corta la trama y
    // un '=' (sync de Matrix/XK3190) inicia una nueva. Devuelve las últimas 6.
    const out: string[] = [];
    let cur = "";
    const flush = (): void => {
      const t = cur.trim();
      if (t) out.push(t);
      cur = "";
    };
    for (const b of this.buf) {
      if (b < 0x20 || b >= 0x7f) {
        flush();
        continue;
      }
      if (b === 0x3d && cur.trim()) flush(); // '=' inicia trama nueva
      cur += String.fromCharCode(b);
    }
    flush();
    return out.slice(-6);
  }

  snapshot(): RawSnapshot {
    const tail = this.tail();
    const hex = Array.from(tail)
      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");
    let text = "";
    for (const b of tail) text += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·";
    return { hex, text, bytes_recibidos: this.total, muestra_frames: this.frameSamples() };
  }
}

/**
 * Envuelve un transporte para COPIAR cada chunk leído al RawMonitor sin tocar
 * el pipeline: read() delega y de paso registra. Preserva `label` y el
 * `status()` opcional (para el indicador HONESTO de reconexión).
 */
export function tapTransport(inner: ByteTransport, monitor: RawMonitor): ByteTransport {
  const wrapped: ByteTransport = {
    label: inner.label,
    open: () => inner.open(),
    read: async () => {
      const b = await inner.read();
      monitor.record(b);
      return b;
    },
    close: () => inner.close(),
  };
  if (inner.status) wrapped.status = () => inner.status!();
  return wrapped;
}
