/**
 * Modelos compartidos — espejo 1:1 de porcipeso/core/models.py.
 * CONTRATO CONGELADO: mismos nombres de campos que el backend Python
 * para que la sincronización futura sea 1:1.
 */

export type EventTypeT = "referencia" | "subida" | "bajada" | "reingreso" | "ajuste";

export type EngineStateT = "idle" | "estable" | "movimiento" | "sin_senal";

export interface Reading {
  ts_ms: number;
  kg: number;
  scale_id: string;
  stable_flag: boolean | null;
}

export function mkReading(
  ts_ms: number,
  kg: number,
  scale_id = "default",
  stable_flag: boolean | null = null,
): Reading {
  return { ts_ms, kg, scale_id, stable_flag };
}

export interface WeighEvent {
  id: number | null;
  session_id: number;
  ts_ms: number;
  peso_antes: number;
  peso_despues: number;
  delta_kg: number;
  animales_estimados: number;
  tipo: EventTypeT;
  ambiguo: boolean;
  opciones: number[];
  animales_confirmados: number | null;
  estab_ms: number;
  motivo_bajada: string | null;
  confirmado_por: string | null;
}

export interface EngineConfig {
  window_readings: number; // 2 s @ 10 Hz
  stability_range_kg: number; // max-min dentro de la ventana
  min_delta_kg: number; // escalón mínimo para ser evento
  tolerance: number; // residuo máximo antes de marcar ambiguo
  no_signal_after_s: number; // watchdog SIN_SENAL
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  window_readings: 20,
  stability_range_kg: 2.0,
  min_delta_kg: 40.0,
  tolerance: 0.2,
  no_signal_after_s: 3.0,
};

/** Fases del pesaje (motor v2). */
export type FaseT = "calibracion" | "bajar_prueba" | "lote" | "unidades";

/** Modos de sesión (motor v2). */
export type ModoT = "lote" | "unidades";

export const MODOS: readonly ModoT[] = ["lote", "unidades"];

export interface EngineSnapshot {
  state: EngineStateT;
  kg_now: number;
  ref_kg: number | null;
  avg_kg: number | null;
  count: number;
  total_kg: number;
  pending: number; // eventos ambiguos sin confirmar
  fase: FaseT; // calibracion | bajar_prueba | lote | unidades (v2)
}

export interface ScaleProfile {
  id: string;
  name: string;
  brand: string;
  parser: string;
  transport: string;
  port?: string | null;
  baudrate?: number;
  bytesize?: number;
  parity?: string;
  stopbits?: number;
  host?: string | null;
  tcp_port?: number | null;
  extra: Record<string, unknown>;
}

/** round() de Python: half-to-even (banker's rounding). */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
