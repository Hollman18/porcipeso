/**
 * Motor de pesaje PorciPeso — PORT FIEL de porcipeso/engine/engine.py.
 *
 * Máquina de estados pura y determinista sobre el stream de lecturas:
 * sin timers, sin I/O. El tiempo viene de reading.ts_ms; el reloj de
 * pared (inyectable vía `nowMs`) solo se consulta en snapshot() para el
 * watchdog SIN_SENAL — igual que time.time() en el original.
 *
 * PARIDAD: la aritmética replica a Python operación por operación
 * (misma media de ventana sum/len en el mismo orden, round() banquero
 * vía pyRound, floor/ceil idénticos). Los fixtures generados con el
 * WeighingEngine real de Python (scripts/gen_engine_fixtures.py) exigen
 * salida idéntica en test/engine.test.ts.
 */
import {
  DEFAULT_ENGINE_CONFIG,
  EngineConfig,
  EngineSnapshot,
  EngineStateT,
  EventTypeT,
  pyRound,
  Reading,
  WeighEvent,
} from "./models";

export type OnEvent = (ev: WeighEvent) => void;
export type OnState = (state: EngineStateT) => void;

export class WeighingEngine {
  readonly config: EngineConfig;
  private onEvent: OnEvent;
  private onState: OnState | null;
  /** Reloj de pared en ms (inyectable en tests para determinismo). */
  nowMs: () => number;

  // stream / ventana
  private state: EngineStateT = "idle";
  private window: number[] = [];
  private lastTsMs: number | null = null;
  private kgNow = 0.0;
  private movementStartTs: number | null = null;

  // sesión
  private sessionId: number | null = null;
  private nextEventId = 1;
  private refKg: number | null = null;
  private avgKg: number | null = null;
  private count = 0;
  private totalKg = 0.0;
  private baseline: number | null = null; // último nivel estable relevante
  private pending = new Map<number, WeighEvent>();
  private unmatchedBajadas: number[] = []; // ids de BAJADA sin reingreso
  private links = new Map<number, number>(); // reingreso_id -> bajada_id

  constructor(
    config: EngineConfig = DEFAULT_ENGINE_CONFIG,
    onEvent: OnEvent,
    onState: OnState | null = null,
    nowMs: () => number = () => Date.now(),
  ) {
    this.config = config;
    this.onEvent = onEvent;
    this.onState = onState;
    this.nowMs = nowMs;
  }

  // ------------------------------------------------------------------ API

  feed(reading: Reading): void {
    const cfg = this.config;

    // Watchdog dentro de feed: hueco entre lecturas > no_signal_after_s.
    if (
      this.lastTsMs !== null &&
      reading.ts_ms - this.lastTsMs > cfg.no_signal_after_s * 1000.0
    ) {
      this.window.length = 0; // lo anterior al apagón ya no es comparable
      this.movementStartTs = reading.ts_ms;
      if (this.sessionId !== null) this.setState("sin_senal");
    }

    this.lastTsMs = reading.ts_ms;
    this.kgNow = reading.kg;
    this.window.push(reading.kg);
    if (this.window.length > cfg.window_readings) this.window.shift();
    if (this.movementStartTs === null) this.movementStartTs = reading.ts_ms;

    if (this.sessionId === null) return; // sin sesión: solo tracking

    if (this.windowStable()) {
      if (this.state !== "estable") {
        const estabMs = Math.max(0, reading.ts_ms - (this.movementStartTs ?? reading.ts_ms));
        this.setState("estable");
        this.handleStableLevel(this.windowMean(), reading.ts_ms, estabMs);
      }
    } else {
      if (this.state !== "movimiento") {
        this.movementStartTs = reading.ts_ms;
        this.setState("movimiento");
      }
    }
  }

  openSession(sessionId: number): void {
    this.sessionId = sessionId;
    this.resetSessionVars();
    if (this.windowStable()) {
      // la báscula ya está estable: ese nivel es la base de la sesión
      this.baseline = this.windowMean();
      this.setState("estable");
    } else {
      this.movementStartTs = this.lastTsMs;
      this.setState("movimiento");
    }
  }

  confirm(eventId: number, n: number): WeighEvent | null {
    const ev = this.pending.get(eventId);
    if (ev === undefined || n < 1) return null;
    this.pending.delete(eventId);
    ev.ambiguo = false;
    ev.animales_confirmados = n;
    this.apply(ev, n);
    return ev;
  }

  snapshot(): EngineSnapshot {
    // Watchdog contra reloj de pared: solo aquí (feed jamás lo consulta).
    if (
      this.sessionId !== null &&
      this.lastTsMs !== null &&
      this.nowMs() - this.lastTsMs > this.config.no_signal_after_s * 1000.0
    ) {
      this.setState("sin_senal");
    }
    return {
      state: this.state,
      kg_now: this.kgNow,
      ref_kg: this.refKg,
      avg_kg: this.avgKg,
      count: this.count,
      total_kg: this.totalKg,
      pending: this.pending.size,
    };
  }

  closeSession(): EngineSnapshot {
    const final = this.snapshot();
    this.sessionId = null;
    this.resetSessionVars();
    this.setState("idle");
    return final;
  }

  // ------------------------------------------------------------ interno

  private resetSessionVars(): void {
    this.refKg = null;
    this.avgKg = null;
    this.count = 0;
    this.totalKg = 0.0;
    this.baseline = null;
    this.pending = new Map();
    this.unmatchedBajadas = [];
    this.links = new Map();
  }

  private windowStable(): boolean {
    if (this.window.length !== this.config.window_readings) return false;
    let mx = -Infinity;
    let mn = Infinity;
    for (const v of this.window) {
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    return mx - mn <= this.config.stability_range_kg;
  }

  private windowMean(): number {
    let s = 0.0;
    for (const v of this.window) s += v; // mismo orden que sum() en Python
    return s / this.window.length;
  }

  private setState(newState: EngineStateT): void {
    if (newState !== this.state) {
      this.state = newState;
      if (this.onState !== null) this.onState(newState);
    }
  }

  /** Procesa una transición movimiento→estable con sesión abierta. */
  private handleStableLevel(level: number, tsMs: number, estabMs: number): void {
    if (this.baseline === null) {
      // primer nivel estable de la sesión: base, sin evento
      this.baseline = level;
      return;
    }
    const delta = level - this.baseline;
    if (Math.abs(delta) < this.config.min_delta_kg) {
      return; // vibración / deriva: no es escalón (baseline NO avanza)
    }
    if (this.refKg === null) {
      this.setReference(level, delta, tsMs, estabMs);
    } else {
      this.step(level, delta, tsMs, estabMs);
    }
  }

  private setReference(level: number, delta: number, tsMs: number, estabMs: number): void {
    const pesoAntes = this.baseline as number;
    // el nivel físico cambió: la base avanza aunque no haya referencia
    this.baseline = level;
    if (delta <= 0) return; // la referencia debe ser positiva; se ignora
    this.refKg = delta;
    this.avgKg = delta;
    this.count = 1;
    this.totalKg = delta;
    const ev = this.newEvent(tsMs, pesoAntes, level, delta, 1, "referencia", estabMs);
    this.onEvent(ev);
  }

  private step(level: number, delta: number, tsMs: number, estabMs: number): void {
    const avg = this.avgKg as number;
    const nRaw = delta / avg;
    const nSigned = pyRound(nRaw);
    if (nSigned === 0) {
      // escalón parcial (ej. cerdo a medio subir): se ignora SIN
      // avanzar la base, para que el escalón completo se mida entero
      return;
    }
    const n = Math.abs(nSigned);
    const residuo = Math.abs(nRaw - nSigned);
    const pesoAntes = this.baseline as number;
    this.baseline = level; // el peso en plataforma cambió de verdad

    if (residuo > this.config.tolerance) {
      const candidatos = new Set<number>();
      for (const c of [Math.floor(Math.abs(nRaw)), Math.ceil(Math.abs(nRaw))]) {
        if (c > 0) candidatos.add(c);
      }
      const opciones = Array.from(candidatos).sort((a, b) => a - b);
      const tipo: EventTypeT = delta > 0 ? "subida" : "bajada";
      const ev = this.newEvent(tsMs, pesoAntes, level, delta, n, tipo, estabMs, true, opciones);
      this.pending.set(ev.id as number, ev);
      this.onEvent(ev);
      return;
    }

    const tipo: EventTypeT = delta > 0 ? "subida" : "bajada";
    const ev = this.newEvent(tsMs, pesoAntes, level, delta, n, tipo, estabMs);
    this.apply(ev, n);
    this.onEvent(ev);
  }

  /** Aplica n animales (con el signo del delta) al estado de sesión. */
  private apply(ev: WeighEvent, n: number): void {
    if (ev.delta_kg > 0) {
      if (this.unmatchedBajadas.length > 0) {
        // SPEC §4.1: subida tras bajada sin emparejar = reingreso
        ev.tipo = "reingreso";
        this.links.set(ev.id as number, this.unmatchedBajadas.shift() as number);
      } else {
        ev.tipo = "subida";
      }
      this.count += n;
    } else {
      ev.tipo = "bajada";
      this.unmatchedBajadas.push(ev.id as number);
      this.count -= n;
    }
    this.totalKg += ev.delta_kg;
    if (this.count > 0) {
      this.avgKg = this.totalKg / this.count;
    }
  }

  private newEvent(
    tsMs: number,
    pesoAntes: number,
    pesoDespues: number,
    delta: number,
    n: number,
    tipo: EventTypeT,
    estabMs: number,
    ambiguo = false,
    opciones: number[] | null = null,
  ): WeighEvent {
    const ev: WeighEvent = {
      id: this.nextEventId,
      session_id: this.sessionId as number,
      ts_ms: tsMs,
      peso_antes: pesoAntes,
      peso_despues: pesoDespues,
      delta_kg: delta,
      animales_estimados: n,
      tipo,
      ambiguo,
      opciones: opciones ?? [],
      animales_confirmados: null,
      estab_ms: estabMs,
      motivo_bajada: null,
      confirmado_por: null,
    };
    this.nextEventId += 1;
    return ev;
  }
}
