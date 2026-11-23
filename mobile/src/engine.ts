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
 * retorno a vacío SIN evento. SIN REPESAJE (unit_return_to_zero): con un
 * cerdo arriba se ignora todo hasta volver a ~vacío. BANDA DE TOLERANCIA:
 * tras min_animals_for_band cerdos, un nivel fuera de [avg*band_low,
 * avg*band_high] no cuenta (bajo) o queda ambiguo (alto).
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

  // stream / estabilidad por TIEMPO (no por conteo de lecturas): una "meseta"
  // es una racha de lecturas dentro de stability_range_kg; es ESTABLE cuando
  // la racha lleva >= min_stable_ms sostenida (espejo de engine.py).
  private state: EngineStateT = "idle";
  private runStartTs: number | null = null; // inicio de la racha en curso
  private runLo = 0.0; // mínimo de la racha
  private runHi = 0.0; // máximo de la racha
  private runSum = 0.0; // suma (para la media)
  private runN = 0; // nº de lecturas de la racha
  private lastTsMs: number | null = null;
  private kgNow = 0.0;
  // inicio del MOVIMIENTO en curso (para estab_ms): se fija al ENTRAR en
  // movimiento, no en cada racha nueva.
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
      this.resetRun(); // lo anterior al apagón ya no es comparable
      this.movementStartTs = reading.ts_ms;
      if (this.sessionId !== null) this.setState("sin_senal");
    }

    this.lastTsMs = reading.ts_ms;
    this.kgNow = reading.kg;
    this.updateRun(reading.ts_ms, reading.kg);
    if (this.movementStartTs === null) this.movementStartTs = reading.ts_ms;

    if (this.sessionId === null) return; // sin sesión: solo tracking

    if (this.runStable(reading.ts_ms)) {
      if (this.state !== "estable") {
        const start = this.movementStartTs ?? reading.ts_ms;
        const estabMs = Math.max(0, reading.ts_ms - start);
        this.setState("estable");
        this.handleStableLevel(this.runMean(), reading.ts_ms, estabMs);
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
    // racha de la conexión/sesión anterior daría una base falsa y la
    // sesión quedaría muda (paridad con engine.py).
    this.resetRun();
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
      cand_kg: this.calibCandidate,
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

  private resetRun(): void {
    this.runStartTs = null;
    this.runLo = 0.0;
    this.runHi = 0.0;
    this.runSum = 0.0;
    this.runN = 0;
  }

  private startRun(tsMs: number, kg: number): void {
    this.runStartTs = tsMs;
    this.runLo = kg;
    this.runHi = kg;
    this.runSum = kg;
    this.runN = 1;
  }

  /** Extiende la racha si la lectura cabe en stability_range_kg; si la rompe,
   *  arranca una racha nueva desde esta lectura (espejo de _update_run). */
  private updateRun(tsMs: number, kg: number): void {
    if (this.runStartTs === null) {
      this.startRun(tsMs, kg);
      return;
    }
    const lo = kg < this.runLo ? kg : this.runLo;
    const hi = kg > this.runHi ? kg : this.runHi;
    if (hi - lo <= this.config.stability_range_kg) {
      this.runLo = lo;
      this.runHi = hi;
      this.runSum += kg;
      this.runN += 1;
    } else {
      this.startRun(tsMs, kg);
    }
  }

  /** Estable = la racha lleva >= min_stable_ms sostenida (>= 2 lecturas). */
  private runStable(tsMs: number): boolean {
    return (
      this.runStartTs !== null &&
      this.runN >= 2 &&
      tsMs - this.runStartTs >= this.config.min_stable_ms
    );
  }

  private runMean(): number {
    return this.runN ? this.runSum / this.runN : 0.0;
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

  /** Descuento MANUAL de cerdos devueltos (rebote por miedo). Espejo de
   *  engine.py:register_returned. kg=null (lote) resta n×promedio (peso
   *  individual desconocido, promedio intacto); kg=peso real (unidades) resta
   *  el peso real de los cerdos elegidos y recalcula el promedio (cuadra exacto
   *  cuando re-pasen). Nunca deja el conteo negativo. */
  registerReturned(n: number, kg: number | null = null): WeighEvent | null {
    if (this.sessionId === null || n < 1) return null;
    n = Math.min(n, this.count);
    if (n === 0) return null;
    let delta: number;
    if (kg !== null && kg !== undefined) {
      if (kg < 0) return null;
      delta = -kg; // descuento por PESO REAL de los cerdos elegidos
    } else {
      const avg = this.avgKg ?? 0;
      delta = -avg * n; // descuento por PROMEDIO (peso individual N/D)
    }
    const pesoAntes = this.totalKg;
    this.count -= n;
    this.totalKg = Math.max(0, this.totalKg + delta);
    if (kg !== null && kg !== undefined) {
      // al quitar pesos reales el promedio cambia: se recalcula
      if (this.count > 0) this.avgKg = this.totalKg / this.count;
    }
    // con kg=null el promedio por cerdo se mantiene (se restó n×avg)
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
        this.countOrFlagUnidad(this.unitBase, level, rel, tsMs, estabMs);
      }
      return;
    }

    // hay un animal arriba
    if (rel < cfg.min_delta_kg) {
      // volvió a vacío: el animal salió — listo para el siguiente
      this.unitLevel = null;
      return;
    }
    if (!cfg.unit_return_to_zero) {
      // LEGADO (opción apagada): apilar cuenta la diferencia ≥ min_delta
      const extra = level - this.unitLevel;
      if (extra >= cfg.min_delta_kg) {
        this.countOrFlagUnidad(this.unitLevel, level, extra, tsMs, estabMs);
      }
    }
    // SIN REPESAJE (por defecto): con un cerdo arriba se ignora TODO hasta que
    // la plataforma vuelva a ~vacío (no se cuenta dos veces el mismo cerdo que
    // se reacomoda ni el que se monta encima sin bajar).
  }

  /** Aplica la banda de plausibilidad (una vez hay promedio confiable) y
   *  cuenta / descarta / marca ambiguo (espejo de _count_or_flag_unidad). */
  private countOrFlagUnidad(
    pesoAntes: number,
    level: number,
    peso: number,
    tsMs: number,
    estabMs: number,
  ): void {
    const cfg = this.config;
    const avg = this.avgKg;
    if (avg && this.count >= cfg.min_animals_for_band) {
      const lo = avg * cfg.band_low;
      const hi = avg * cfg.band_high;
      if (peso < lo) {
        // demasiado liviano (medio subido u objeto): NO cuenta. No fija
        // unitLevel: si termina de subir y entra en banda, se reevalúa.
        return;
      }
      if (peso > hi) {
        // demasiado pesado: posible doble → AMBIGUO (confirma 1 o 2).
        this.unitLevel = level;
        const r = peso / avg;
        const candidatos = new Set<number>();
        for (const c of [Math.floor(r), Math.ceil(r)]) {
          if (c > 0) candidatos.add(c);
        }
        const opciones = Array.from(candidatos).sort((a, b) => a - b);
        const ev = this.newEvent(tsMs, pesoAntes, level, peso, pyRound(r), "subida", estabMs, true, opciones);
        this.pending.set(ev.id as number, ev);
        this.onEvent(ev);
        return;
      }
    }
    // dentro de banda (o banda aún no aplica): cuenta 1
    this.unitLevel = level;
    this.emitUnidad(pesoAntes, level, peso, tsMs, estabMs);
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
