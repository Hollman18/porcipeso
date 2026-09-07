/**
 * PARIDAD OBLIGATORIA engine.ts ↔ engine.py.
 *
 * test/fixtures/engine_cases.json lo genera scripts/gen_engine_fixtures.py
 * con el WeighingEngine REAL de Python. Aquí se reproduce cada stream y
 * se exige salida idéntica: misma secuencia de eventos (tipo, delta, n,
 * ambiguo, opciones), mismos cambios de estado, mismos resultados de
 * confirm y mismo snapshot final. Floats con tolerancia 0.01.
 */
import { describe, expect, it } from "vitest";
import { WeighingEngine } from "../src/engine";
import { DEFAULT_ENGINE_CONFIG, EngineConfig, EngineStateT, Reading, WeighEvent } from "../src/models";
import fixtures from "./fixtures/engine_cases.json";

const TOL = 0.01;

interface FixtureAction {
  op: "feed" | "open_session" | "confirm";
  readings?: Array<[number, number]>;
  session_id?: number;
  modo?: string;
  event_index?: number;
  n?: number;
}

interface FixtureCase {
  name: string;
  description: string;
  actions: FixtureAction[];
  expected: {
    events: Array<Record<string, unknown>>;
    states: string[];
    confirms: Array<{ event_index: number; n: number; result: Record<string, unknown> }>;
    final_snapshot: Record<string, unknown>;
  };
}

const FLOAT_FIELDS = new Set(["peso_antes", "peso_despues", "delta_kg", "kg_now", "ref_kg", "avg_kg", "total_kg"]);

function expectMatch(actual: Record<string, unknown>, expected: Record<string, unknown>, ctx: string): void {
  for (const [key, expVal] of Object.entries(expected)) {
    const actVal = actual[key];
    const where = `${ctx}.${key}`;
    if (typeof expVal === "number" && FLOAT_FIELDS.has(key)) {
      expect(actVal, where).toBeTypeOf("number");
      expect(Math.abs((actVal as number) - expVal), `${where}: ${actVal} != ${expVal}`).toBeLessThanOrEqual(TOL);
    } else if (Array.isArray(expVal)) {
      expect(actVal, where).toEqual(expVal);
    } else {
      expect(actVal, where).toBe(expVal);
    }
  }
}

describe("paridad engine.ts vs engine.py (fixtures del engine real)", () => {
  const cases = fixtures.cases as unknown as FixtureCase[];

  it("hay suficientes escenarios (≥12) y cubren ambos modos", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    const modos = new Set(
      cases.flatMap((c) =>
        c.actions.filter((a) => a.op === "open_session").map((a) => a.modo ?? "lote"),
      ),
    );
    expect(modos).toContain("lote");
    expect(modos).toContain("unidades");
    // los escenarios v2 deben ejercitar la REFERENCIA de calibración y subidas
    // (las bajadas ya NO emiten evento: báscula de paso, se ignoran)
    const tipos = new Set(
      cases.flatMap((c) => c.expected.events.map((e) => e["tipo"] as string)),
    );
    for (const t of ["referencia", "subida"]) {
      expect(tipos).toContain(t);
    }
  });

  for (const c of cases) {
    it(`${c.name} — ${c.description}`, () => {
      const events: Array<Record<string, unknown>> = [];
      const emitted: WeighEvent[] = [];
      const states: EngineStateT[] = [];
      let lastTs = 0;

      const engine = new WeighingEngine(
        fixtures.engine_config as EngineConfig,
        (ev) => {
          emitted.push(ev);
          events.push({ ...ev, opciones: [...ev.opciones] }); // copia al emitir
        },
        (st) => states.push(st),
        () => lastTs, // reloj = ts de la última lectura (igual que el generador)
      );

      const confirms: Array<{ event_index: number; n: number; result: Record<string, unknown> }> = [];
      for (const action of c.actions) {
        if (action.op === "feed") {
          for (const [ts_ms, kg] of action.readings!) {
            lastTs = ts_ms;
            engine.feed({ ts_ms, kg, scale_id: "default", stable_flag: null });
          }
        } else if (action.op === "open_session") {
          engine.openSession(action.session_id!, action.modo ?? "lote");
        } else {
          const target = emitted[action.event_index!];
          const result = engine.confirm(target.id as number, action.n!);
          expect(result, `${c.name}: confirm devolvió null`).not.toBeNull();
          confirms.push({
            event_index: action.event_index!,
            n: action.n!,
            result: { ...(result as WeighEvent), opciones: [...(result as WeighEvent).opciones] },
          });
        }
      }
      const finalSnapshot = engine.closeSession();

      // misma cantidad y contenido de eventos, en el mismo orden
      expect(events.length, `${c.name}: n eventos`).toBe(c.expected.events.length);
      c.expected.events.forEach((expEv, i) => {
        expectMatch(events[i], expEv, `${c.name}.events[${i}]`);
      });

      // misma secuencia de estados
      expect(states, `${c.name}: states`).toEqual(c.expected.states);

      // mismos resultados de confirm
      expect(confirms.length).toBe(c.expected.confirms.length);
      c.expected.confirms.forEach((expC, i) => {
        expect(confirms[i].event_index).toBe(expC.event_index);
        expect(confirms[i].n).toBe(expC.n);
        expectMatch(confirms[i].result, expC.result, `${c.name}.confirms[${i}]`);
      });

      // snapshot final idéntico
      expectMatch(
        finalSnapshot as unknown as Record<string, unknown>,
        c.expected.final_snapshot,
        `${c.name}.final_snapshot`,
      );
    });
  }
});

describe("registerReturned: promedio (lote) vs peso real (unidades)", () => {
  function build() {
    const events: WeighEvent[] = [];
    let lastTs = 0;
    const eng = new WeighingEngine(
      DEFAULT_ENGINE_CONFIG,
      (ev) => events.push(ev),
      null,
      () => lastTs,
    );
    // mete una meseta estable de kg durante ~2.5 s (supera min_stable_ms)
    const feed = (ts0: number, kg: number, n = 25): number => {
      for (let i = 0; i < n; i++) {
        lastTs = ts0 + i * 100;
        eng.feed({ ts_ms: lastTs, kg } as Reading);
      }
      return ts0 + n * 100;
    };
    return { eng, events, feed };
  }

  it("unidades: kg descuenta el PESO REAL y cuadra al re-pasar", () => {
    const { eng, feed } = build();
    eng.openSession(1, "unidades");
    let ts = 1000;
    ts = feed(ts, 0); ts = feed(ts, 60); ts = feed(ts, 0); ts = feed(ts, 55); ts = feed(ts, 0);
    let snap = eng.snapshot();
    expect(snap.count).toBe(2);
    expect(snap.total_kg).toBeCloseTo(115, 5);

    const ev = eng.registerReturned(1, 55); // peso real de B
    expect(ev).not.toBeNull();
    expect(ev!.delta_kg).toBeCloseTo(-55, 5);
    snap = eng.snapshot();
    expect(snap.count).toBe(1);
    expect(snap.total_kg).toBeCloseTo(60, 5);
    expect(snap.avg_kg!).toBeCloseTo(60, 5); // recalculado (solo A)

    ts = feed(ts, 55); ts = feed(ts, 0); // B re-pasa
    snap = eng.snapshot();
    expect(snap.count).toBe(2);
    expect(snap.total_kg).toBeCloseTo(115, 5); // EXACTO
  });

  it("sin kg descuenta por PROMEDIO y no cambia el promedio", () => {
    const { eng, feed } = build();
    eng.openSession(1, "unidades");
    let ts = 1000;
    ts = feed(ts, 0); ts = feed(ts, 60); ts = feed(ts, 0); ts = feed(ts, 55); ts = feed(ts, 0);
    const ev = eng.registerReturned(1); // sin kg → promedio 57.5
    expect(ev!.delta_kg).toBeCloseTo(-57.5, 5);
    const snap = eng.snapshot();
    expect(snap.count).toBe(1);
    expect(snap.total_kg).toBeCloseTo(57.5, 5);
    expect(snap.avg_kg!).toBeCloseTo(57.5, 5); // promedio intacto
  });
});
