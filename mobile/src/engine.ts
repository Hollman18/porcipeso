/**
 * Motor de pesaje PorciPeso v2 — PORT FIEL de porcipeso/engine/engine.py.
 *
 * Máquina de estados pura y determinista sobre el stream de lecturas:
 * sin timers, sin I/O. El tiempo viene de reading.ts_ms; el reloj de
 * pared (inyectable vía `nowMs`) solo se consulta en snapshot() para el
 * watchdog SIN_SENAL — igual que time.time() en el original.
 *
 * MODO "lote" (v2 — calibración con cerdo de prueba que SE BAJA):
 * openSession(id, "lote") arranca en fase "calibracion"; el candidato a
 * referencia es el MÁXIMO nivel estable sostenido (peak hold sobre
 * niveles ESTABLES). Con candidato → fase "bajar_prueba"; si montan otro
 * sin bajar el primero (subida estable ≥ min_delta) vuelve a
 * "calibracion" con el nuevo máximo. Al vaciar (< min_delta o < 20 % del
 * candidato) se emite UN evento REFERENCIA (delta=ref, n=1) SIN sumar a
 * count/total (count arranca 0) y la fase pasa a "lote" (comportamiento
 * clásico: n = round(delta/avg), ambiguos, bidireccional).
 *
 * MODO "unidades" (v2 — pesaje uno a uno): fase "unidades" siempre.
 * Cada nivel estable ≥ min_delta = SUBIDA n=1 con el peso del animal;
 * retorno a vacío SIN evento; otro animal sin vaciar = SUBIDA con la
 * diferencia; sin ambiguos.
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
  FaseT,
  ModoT,
  MODOS,
  pyRound,
  Reading,
  WeighEvent,
} from "./models";

export type OnEvent = (ev: WeighEvent) => void;
export type OnState = (state: EngineStateT) => void;

// Fases del pesaje (EngineSnapshot.fase) — espejo de engine.py
export const FASE_CALIBRACION: FaseT = "calibracion";
export const FASE_BAJAR_PRUEBA: FaseT = "bajar_prueba";
export const FASE_LOTE: FaseT = "lote";
export const FASE_UNIDADES: FaseT = "unidades";

/** Fracción del candidato bajo la cual la plataforma se considera vacía
 *  al terminar la calibración (además del umbral absoluto min_delta_kg). */
export const EMPTY_FRACTION = 0.2;

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
  private modo: ModoT = "lote";
  private fase: FaseT = FASE_LOTE;
  private refKg: number | null = null;
  private avgKg: number | null = null;
  private count = 0;
  private totalKg = 0.0;
  private baseline: number | null = null; // último nivel estable relevante
  private pending = new Map<number, WeighEvent>();
  private unmatchedBajadas: number[] = []; // ids de BAJADA sin reingreso
  private links = new Map<number, number>(); // reingreso_id -> bajada_id
  // calibración (modo lote)
  private calibBase: number | null = null; // nivel estable inicial (vacío)
  private calibCandidate: number | null = null; // peak hold del cerdo de prueba
  // modo unidades
  private unitBase: number | null = null; // nivel estable de plataforma vacía
  private unitLevel: number | null = null; // nivel registrado del animal arriba

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

  openSession(sessionId: number, modo: string = "lote"): void {
    if (!(MODOS as readonly string[]).includes(modo)) {
      throw new Error(`modo desconocido: '${modo}' (esperado: ('lote', 'unidades'))`);
    }
    this.sessionId = sessionId;
    this.resetSessionVars();
    this.modo = modo as ModoT;
    this.fase = modo === "lote" ? FASE_CALIBRACION : FASE_UNIDADES;
    // La base de la sesión se fija SOLO con lecturas frescas: heredar la
    // ventana de la conexión/sesión anterior daría una base falsa y la
    // sesión quedaría muda (paridad con engine.py).
    this.window.length = 0;
    this.movementStartTs = this.lastTsMs;
    this.setState("movimiento");
  }

  /**
   * Fija MANUALMENTE el peso de referencia del cerdo de prueba (espejo de
   * engine.py:set_reference). El operario escribe el peso conocido (ej. 1.5)
   * y el motor lo toma como referencia sin depender del umbral automático:
   * ref = avg = kg, conteo en 0, y pasa directo a fase "lote". Emite un
   * evento REFERENCIA auditado (confirmado_por="manual"). Solo aplica en modo
   * lote y con sesión abierta.
   */
  setReference(kg: number): WeighEvent | null {
    if (this.sessionId === null || this.modo !== "lote" || kg <= 0) return null;
    this.refKg = kg;
    this.avgKg = kg;
    this.count = 0;
    this.totalKg = 0.0;
    // base del lote = nivel vacío actual (o 0 si aún no hay uno)
    this.baseline = this.calibBase !== null ? this.calibBase : 0.0;
    this.calibCandidate = null;
    this.fase = FASE_LOTE;
    const ts = this.lastTsMs ?? 0;
    const ev = this.newEvent(ts, 0.0, kg, kg, 1, "referencia", 0);
    ev.confirmado_por = "manual";
    this.onEvent(ev);
    return ev;
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
      fase: this.fase,
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
    this.modo = "lote";
    this.fase = FASE_LOTE; // default del contrato; openSession la fija
    this.refKg = null;
    this.avgKg = null;
    this.count = 0;
    this.totalKg = 0.0;
    this.baseline = null;
    this.pending = new Map();
    this.unmatchedBajadas = [];
    this.links = new Map();
    this.calibBase = null;
    this.calibCandidate = null;
    this.unitBase = null;
    this.unitLevel = null;
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

  // --------------------------------------------------- despacho por fase

  /** Procesa una transición movimiento→estable con sesión abierta. */
  private handleStableLevel(level: number, tsMs: number, estabMs: number): void {
    if (this.modo === "unidades") {
      this.stableUnidades(level, tsMs, estabMs);
    } else if (this.fase === FASE_CALIBRACION || this.fase === FASE_BAJAR_PRUEBA) {
      this.stableCalibracion(level, tsMs, estabMs);
    } else {
      this.stableLote(level, tsMs, estabMs);
    }
  }

  // ------------------------------------------------- calibración (lote)

  /** Peak hold del cerdo de prueba; termina cuando vuelve a vacío. */
  private stableCalibracion(level: number, tsMs: number, estabMs: number): void {
    const cfg = this.config;
    if (this.calibBase === null) {
      // primer nivel estable de la sesión: base (vacío), sin evento
      this.calibBase = level;
      return;
    }
    const rel = level - this.calibBase;
    const cand = this.calibCandidate;

    if (cand !== null && (rel < cfg.min_ref_kg || rel < EMPTY_FRACTION * cand)) {
      // casi vacío: el cerdo de prueba se bajó → calibración lista.
      // Su bajada NO es evento BAJADA; se emite UN evento REFERENCIA
      // semánticamente "el cerdo de prueba pesó cand".
      this.refKg = cand;
      this.avgKg = cand;
      this.count = 0;
      this.totalKg = 0.0;
      this.baseline = level; // base del lote = nivel vacío actual
      this.calibCandidate = null;
      this.fase = FASE_LOTE;
      const ev = this.newEvent(tsMs, 0.0, cand, cand, 1, "referencia", estabMs);
      this.onEvent(ev);
      return;
    }

    if (rel < cfg.min_ref_kg) {
      return; // sigue vacío (o vibración): aún no sube el de prueba
    }

    if (cand === null) {
      // subió el cerdo de prueba: primer candidato
      this.calibCandidate = rel;
      this.fase = FASE_BAJAR_PRUEBA;
    } else if (rel > cand) {
      // peak hold: solo sube el candidato, nunca baja
      this.calibCandidate = rel;
      if (rel - cand >= cfg.min_delta_kg) {
        // montaron otro sin bajar el primero (A4): se recalibra
        // con el nuevo máximo — tolerante, sin romperse
        this.fase = FASE_CALIBRACION;
      } else {
        // cerdo inquieto acomodándose: sigue esperando la bajada
        this.fase = FASE_BAJAR_PRUEBA;
      }
    }
    // rel <= cand (se acomodó más liviano / bajada parcial): peak hold,
    // ni evento ni cambio de fase
  }

  // -------------------------------------------------------- fase "lote"

  private stableLote(level: number, tsMs: number, estabMs: number): void {
    // baseline y avgKg quedaron fijados al terminar la calibración
    const delta = level - (this.baseline as number);
    if (Math.abs(delta) < this.config.min_delta_kg) {
      return; // vibración / deriva: no es escalón (baseline NO avanza)
    }
    if (delta < 0) {
      // BAJADA = el grupo ya pesado avanzó al camión (flujo NORMAL). La
      // báscula de paso no distingue "avanzó" de "se devolvió", así que NO
      // descuenta nunca automáticamente; los devueltos los registra el
      // operario con registerReturned(). Solo resetea la base.
      this.baseline = level;
      return;
    }
    this.step(level, delta, tsMs, estabMs);
  }

  private step(level: number, delta: number, tsMs: number, estabMs: number): void {
    // delta > 0 garantizado por stableLote (las bajadas no llegan aquí)
    const avg = this.avgKg as number;
    const nRaw = delta / avg;
    const n = pyRound(nRaw);
    if (n === 0) {
      // escalón parcial (ej. cerdo a medio subir): se ignora SIN
      // avanzar la base, para que el escalón completo se mida entero
      return;
    }
    const residuo = Math.abs(nRaw - n);
    const pesoAntes = this.baseline as number;
    this.baseline = level; // el peso en plataforma cambió de verdad

    if (residuo > this.config.tolerance) {
      const candidatos = new Set<number>();
      for (const c of [Math.floor(nRaw), Math.ceil(nRaw)]) {
        if (c > 0) candidatos.add(c);
      }
      const opciones = Array.from(candidatos).sort((a, b) => a - b);
      const ev = this.newEvent(tsMs, pesoAntes, level, delta, n, "subida", estabMs, true, opciones);
      this.pending.set(ev.id as number, ev);
      this.onEvent(ev);
      return;
    }

    const ev = this.newEvent(tsMs, pesoAntes, level, delta, n, "subida", estabMs);
    this.apply(ev, n);
    this.onEvent(ev);
  }

  /** Aplica n cerdos SUBIDOS al estado de sesión (solo positivo). */
  private apply(ev: WeighEvent, n: number): void {
    ev.tipo = "subida";
    this.count += n;
    this.totalKg += ev.delta_kg;
    if (this.count > 0) {
      this.avgKg = this.totalKg / this.count;
    }
  }

  /** Descuento MANUAL de cerdos devueltos (rebote por miedo). Descuenta
   *  n × promedio del conteo y del total; nunca deja el conteo negativo.
   *  Es la única vía de descuento (ya no hay bajada automática). */
  registerReturned(n: number): WeighEvent | null {
    if (this.sessionId === null || n < 1) return null;
    n = Math.min(n, this.count);
    if (n === 0) return null;
    const avg = this.avgKg ?? 0;
    const delta = -avg * n;
    const pesoAntes = this.totalKg;
    this.count -= n;
    this.totalKg = Math.max(0, this.totalKg + delta);
    // el promedio por cerdo no cambia (se resta n×avg): se mantiene estable
    const ts = this.lastTsMs ?? 0;
    const ev = this.newEvent(ts, pesoAntes, this.totalKg, delta, n, "ajuste", 0);
    ev.animales_confirmados = n;
    ev.motivo_bajada = "devuelto_manual";
    this.onEvent(ev);
    return ev;
  }

  // ---------------------------------------------------- modo "unidades"

  /** Pesaje uno a uno: cada nivel estable ≥ min_delta = un animal. */
  private stableUnidades(level: number, tsMs: number, estabMs: number): void {
    const cfg = this.config;
    if (this.unitBase === null) {
      // primer nivel estable de la sesión: plataforma vacía (base)
      this.unitBase = level;
      return;
    }
    const rel = level - this.unitBase;

    if (this.unitLevel === null) {
      // plataforma vacía: ¿subió un animal?
      if (rel >= cfg.min_delta_kg) {
        this.unitLevel = level;
        this.emitUnidad(this.unitBase, level, rel, tsMs, estabMs);
      }
      return;
    }

    // hay un animal arriba
    if (rel < cfg.min_delta_kg) {
      // volvió a vacío: el animal salió — NO es evento
      this.unitLevel = null;
      return;
    }
    const extra = level - this.unitLevel;
    if (extra >= cfg.min_delta_kg) {
      // se montó otro encima sin pasar por vacío: cuenta como otro
      const pesoAntes = this.unitLevel;
      this.unitLevel = level;
      this.emitUnidad(pesoAntes, level, extra, tsMs, estabMs);
    }
    // bajada parcial extraña (o ajuste menor): se ignora hasta vaciar
  }

  private emitUnidad(
    pesoAntes: number,
    level: number,
    peso: number,
    tsMs: number,
    estabMs: number,
  ): void {
    this.count += 1;
    this.totalKg += peso;
    this.avgKg = this.totalKg / this.count;
    const ev = this.newEvent(tsMs, pesoAntes, level, peso, 1, "subida", estabMs);
    this.onEvent(ev);
  }

  // ------------------------------------------------------------- eventos

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
