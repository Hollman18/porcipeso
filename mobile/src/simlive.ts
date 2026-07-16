/**
 * Báscula simulada INTERACTIVA — port de porcipeso/api/simlive.py.
 *
 * Misma física y constantes: el peso mostrado persigue al físico con
 * rampa exponencial (ramp_alpha por tick a 10 Hz) y un jitter que
 * arranca alto en cada perturbación y decae geométricamente
 * (jitter_decay) hasta el ruido base de la celda. `nervous` sostiene
 * jitter alto; `silence` enmudece el indicador (dispara el watchdog
 * SIN_SENAL del engine). Corre con setInterval (los tests usan fake
 * timers de vitest).
 */
import { Reading } from "./models";

export interface SimLiveOptions {
  hz?: number;
  scaleId?: string;
  seed?: number | null;
  baseNoiseKg?: number;
  rampAlpha?: number;
  disturbJitterKg?: number;
  jitterDecay?: number;
  nervousJitterKg?: number;
  meanPigKg?: number;
  sdPigKg?: number;
}

/** RNG determinista (mulberry32) + gauss Box-Muller, sembrable en tests. */
class Rng {
  private state: number;
  private spare: number | null = null;
  private seeded: boolean;

  constructor(seed: number | null) {
    this.seeded = seed !== null && seed !== undefined;
    this.state = (seed ?? 0) >>> 0;
  }

  random(): number {
    if (!this.seeded) return Math.random();
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  gauss(mu: number, sigma: number): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return mu + sigma * v;
    }
    let u = 0;
    let v = 0;
    do {
      u = this.random();
    } while (u <= 1e-12);
    v = this.random();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    this.spare = mag * Math.sin(2.0 * Math.PI * v);
    return mu + sigma * mag * Math.cos(2.0 * Math.PI * v);
  }
}

export class SimLiveScale {
  private onReading: (r: Reading) => void;
  readonly hz: number;
  readonly scaleId: string;
  private rng: Rng;
  private baseNoise: number;
  private alpha: number;
  private disturbJitter: number;
  private jitterDecay: number;
  private nervousJitter: number;
  private meanPig: number;
  private sdPig: number;

  private pigs: number[] = []; // pesos físicos sobre plataforma
  private displayed = 0.0; // peso que "muestra" el indicador
  private jitter = 0.0; // amplitud actual de jitter
  private nervousUntil = 0.0; // Date.now() límite (ms)
  private silenceUntil = 0.0;
  kgNow: number | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(onReading: (r: Reading) => void, opts: SimLiveOptions = {}) {
    this.onReading = onReading;
    this.hz = opts.hz ?? 10;
    this.scaleId = opts.scaleId ?? "simulador";
    this.rng = new Rng(opts.seed ?? null);
    this.baseNoise = opts.baseNoiseKg ?? 0.05;
    this.alpha = opts.rampAlpha ?? 0.6;
    this.disturbJitter = opts.disturbJitterKg ?? 2.5;
    this.jitterDecay = opts.jitterDecay ?? 0.7;
    this.nervousJitter = opts.nervousJitterKg ?? 6.0;
    this.meanPig = opts.meanPigKg ?? 102.0;
    this.sdPig = opts.sdPigKg ?? 6.0;
  }

  // ------------------------------------------------------------ ciclo vida

  start(): SimLiveScale {
    if (this.running) return this;
    const period = 1000.0 / this.hz;
    this.timer = setInterval(() => this.step(), period);
    return this;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }

  // -------------------------------------------------------------- comandos

  pigsOn(n = 1, kgEach: number | number[] | null = null): Record<string, unknown> {
    if (n < 1) throw new RangeError("pigs_on: n debe ser >= 1");
    const weights = this.pigWeights(n, kgEach);
    this.pigs.push(...weights);
    this.disturb();
    return this.status();
  }

  pigOff(): Record<string, unknown> {
    if (this.pigs.length) this.pigs.pop();
    this.disturb();
    return this.status();
  }

  nervous(seconds = 3.0): Record<string, unknown> {
    this.nervousUntil = Date.now() + Math.max(0.0, seconds) * 1000.0;
    return this.status();
  }

  silence(seconds = 4.0): Record<string, unknown> {
    this.silenceUntil = Date.now() + Math.max(0.0, seconds) * 1000.0;
    return this.status();
  }

  status(): Record<string, unknown> {
    return {
      running: this.running,
      kg_target: round2(this.pigs.reduce((a, b) => a + b, 0)),
      pigs_fisicos: this.pigs.length,
      kg_now: this.kgNow !== null ? round2(this.kgNow) : null,
    };
  }

  // ------------------------------------------------------------- internos

  private disturb(): void {
    this.jitter = Math.max(this.jitter, this.disturbJitter);
  }

  private pigWeights(n: number, kgEach: number | number[] | null): number[] {
    if (kgEach === null || kgEach === undefined) {
      return Array.from({ length: n }, () =>
        Math.max(1.0, this.rng.gauss(this.meanPig, this.sdPig)),
      );
    }
    if (typeof kgEach === "number") return Array(n).fill(kgEach);
    const weights = kgEach.map(Number);
    if (weights.length !== n) {
      throw new RangeError(`pigs_on: se esperaban ${n} pesos, llegaron ${weights.length}`);
    }
    return weights;
  }

  /** Un paso de física a 1/hz. Retorna kg o null (silencio). */
  private tick(): number | null {
    const now = Date.now();
    const target = this.pigs.reduce((a, b) => a + b, 0);
    this.displayed += (target - this.displayed) * this.alpha;
    this.jitter = Math.max(this.baseNoise, this.jitter * this.jitterDecay);
    if (now < this.silenceUntil) {
      this.kgNow = null;
      return null;
    }
    const amp = now < this.nervousUntil ? this.nervousJitter : this.jitter;
    const kg = Math.max(0.0, this.displayed + this.rng.gauss(0.0, amp * 0.5));
    this.kgNow = kg;
    return kg;
  }

  private step(): void {
    const kg = this.tick();
    if (kg !== null) {
      const reading: Reading = {
        ts_ms: Date.now(),
        kg: round2(kg),
        scale_id: this.scaleId,
        stable_flag: null,
      };
      try {
        this.onReading(reading);
      } catch {
        /* un consumidor roto no tumba la báscula */
      }
    }
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
