#!/usr/bin/env python
"""Genera mobile/test/fixtures/engine_cases.json con el WeighingEngine REAL.

Correr con el venv del repo:

    ./.venv/bin/python scripts/gen_engine_fixtures.py

Cada caso es un guion determinista (streams de lecturas ts_ms/kg +
confirmaciones intercaladas) ejecutado contra porcipeso.engine.engine.
La salida esperada (eventos emitidos, cambios de estado, resultados de
confirm y snapshot final) es el ORACULO de paridad para el port TS
(mobile/src/engine.ts, test mobile/test/engine.test.ts).

Determinismo del watchdog de reloj de pared: se parchea time.time() del
módulo del engine para que devuelva el ts de la última lectura — el
port TS hace lo mismo inyectando `nowMs`.
"""
from __future__ import annotations

import dataclasses
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

import porcipeso.engine.engine as engine_mod  # noqa: E402
from porcipeso.core.models import EngineConfig, Reading  # noqa: E402
from porcipeso.engine.engine import WeighingEngine  # noqa: E402

OUT = REPO / "mobile" / "test" / "fixtures" / "engine_cases.json"

DT = 100  # ms entre lecturas (10 Hz)
PLATEAU = 25  # lecturas por meseta (> window_readings=20)


class _FakeTime:
    """Reemplazo de time.time(): devuelve el ts de la última lectura."""

    def __init__(self) -> None:
        self.now_ms = 0.0

    def time(self) -> float:
        return self.now_ms / 1000.0


class Script:
    """Constructor de un caso: guion de acciones + stream determinista."""

    def __init__(self, name: str, description: str) -> None:
        self.name = name
        self.description = description
        self.actions: list[dict] = []
        self.ts = 1000

    # ------------------------------------------------ stream helpers

    def _feed_block(self, readings: list[list[float]]) -> None:
        if self.actions and self.actions[-1]["op"] == "feed":
            self.actions[-1]["readings"].extend(readings)
        else:
            self.actions.append({"op": "feed", "readings": readings})

    def plateau(self, kg: float, n: int = PLATEAU) -> "Script":
        block = []
        for _ in range(n):
            block.append([self.ts, kg])
            self.ts += DT
        self._feed_block(block)
        return self

    def ramp(self, kg_from: float, kg_to: float, n: int = 8) -> "Script":
        """Transición con pasos grandes: la ventana nunca es estable."""
        block = []
        for i in range(1, n + 1):
            kg = kg_from + (kg_to - kg_from) * i / n
            block.append([self.ts, round(kg, 3)])
            self.ts += DT
        self._feed_block(block)
        return self

    def noise(self, center: float, amp: float, n: int) -> "Script":
        """Zigzag determinista ±amp (rango 2*amp > 2 kg ⇒ inestable)."""
        block = []
        for i in range(n):
            kg = center + (amp if i % 2 == 0 else -amp)
            block.append([self.ts, round(kg, 3)])
            self.ts += DT
        self._feed_block(block)
        return self

    def gap(self, ms: int) -> "Script":
        self.ts += ms
        return self

    # ------------------------------------------------ acciones

    def open_session(self, session_id: int = 1, modo: str = "lote") -> "Script":
        self.actions.append(
            {"op": "open_session", "session_id": session_id, "modo": modo}
        )
        return self

    def confirm(self, event_index: int, n: int) -> "Script":
        self.actions.append({"op": "confirm", "event_index": event_index, "n": n})
        return self


def event_dict(ev) -> dict:
    d = dataclasses.asdict(ev)
    d["tipo"] = ev.tipo.value
    return d


def run_case(script: Script) -> dict:
    fake = _FakeTime()
    engine_mod.time = fake  # determinismo del watchdog en snapshot()

    events: list[dict] = []
    states: list[str] = []
    emitted = []  # refs a los WeighEvent reales, por orden de emisión

    def on_event(ev) -> None:
        emitted.append(ev)
        events.append(event_dict(ev))  # copia al momento de la emisión

    engine = WeighingEngine(EngineConfig(), on_event, on_state=states.append)

    confirms: list[dict] = []
    for action in script.actions:
        if action["op"] == "feed":
            for ts_ms, kg in action["readings"]:
                fake.now_ms = float(ts_ms)
                engine.feed(Reading(ts_ms=int(ts_ms), kg=float(kg)))
        elif action["op"] == "open_session":
            engine.open_session(action["session_id"],
                                modo=action.get("modo", "lote"))
        elif action["op"] == "confirm":
            target = emitted[action["event_index"]]
            result = engine.confirm(target.id, action["n"])
            assert result is not None, (
                f"{script.name}: confirm sobre evento no-pendiente "
                f"(index {action['event_index']})"
            )
            confirms.append({
                "event_index": action["event_index"],
                "n": action["n"],
                "result": event_dict(result),
            })
        else:  # pragma: no cover
            raise ValueError(f"acción desconocida: {action['op']}")

    final = engine.close_session()
    snapshot = dataclasses.asdict(final)
    snapshot["state"] = final.state.value

    return {
        "name": script.name,
        "description": script.description,
        "actions": script.actions,
        "expected": {
            "events": events,
            "states": states,
            "confirms": confirms,
            "final_snapshot": snapshot,
        },
    }


def build_cases() -> list[Script]:
    cases: list[Script] = []

    # ------------------------------------------------ modo lote (v2)

    s = Script("calibracion_simple",
               "cerdo de prueba 100 kg sube y SE BAJA -> REFERENCIA 100, count 0")
    (s.open_session(1).plateau(0.0)
      .ramp(0, 100).plateau(100.0)          # candidato 100 -> bajar_prueba
      .ramp(100, 0).plateau(0.0))           # vacío -> REFERENCIA 100, fase lote
    cases.append(s)

    s = Script("calibracion_peak_hold",
               "peak hold sobre niveles ESTABLES: 98 -> 102 -> 100 -> vacío = REFERENCIA 102")
    (s.open_session(1).plateau(0.0)
      .ramp(0, 98).plateau(98.0)            # candidato 98
      .ramp(98, 102).plateau(102.0)         # se acomoda: peak 102 (< min_delta, sigue bajar_prueba)
      .ramp(102, 100).plateau(100.0)        # más liviano: peak hold, nada
      .ramp(100, 0).plateau(0.0))           # vacío -> REFERENCIA 102
    cases.append(s)

    s = Script("calibracion_doble_monta",
               "montan otro sin bajar el 1º (100 -> 205): recalibra con el máximo; REFERENCIA 205")
    (s.open_session(1).plateau(0.0)
      .ramp(0, 100).plateau(100.0)          # candidato 100 -> bajar_prueba
      .ramp(100, 205).plateau(205.0)        # +105 >= min_delta -> vuelve a calibracion, peak 205
      .ramp(205, 103).plateau(103.0)        # se baja uno: peak hold, nada
      .ramp(103, 0).plateau(0.0))           # vacío -> REFERENCIA 205
    cases.append(s)

    s = Script("lote_completo_post_calibracion",
               "calibración -> lote clásico: subida n=1, subida n=2, bajada, reingreso")
    (s.open_session(1).plateau(0.0)
      .ramp(0, 100).plateau(100.0)          # candidato 100
      .ramp(100, 0).plateau(0.0)            # REFERENCIA 100 (evento 0), count 0
      .ramp(0, 105).plateau(105.0)          # +105 -> subida n=1
      .ramp(105, 310).plateau(310.0)        # +205 -> subida n=2 (avg 105)
      .ramp(310, 209).plateau(209.0)        # -101 -> bajada
      .ramp(209, 311).plateau(311.0))       # +102 -> reingreso
    cases.append(s)

    s = Script("lote_ambiguo_confirm",
               "post-calibración: +145 sobre avg 100 -> ambiguo [1,2], confirma 1; luego +145 n=1")
    (s.open_session(1).plateau(0.0)
      .ramp(0, 100).plateau(100.0)
      .ramp(100, 0).plateau(0.0)            # REFERENCIA 100 (evento 0)
      .ramp(0, 145).plateau(145.0)          # +145 -> n_raw 1.45 ambiguo (evento 1)
      .confirm(1, 1)                        # avg pasa a 145
      .ramp(145, 290).plateau(290.0))       # +145 sobre avg 145 -> n=1 residuo 0
    cases.append(s)

    s = Script("lote_ambiguo_mitad_banquero",
               "delta 250 sobre avg 100: n_raw 2.5 -> round banquero 2, ambiguo [2,3], confirma 3")
    (s.open_session(1).plateau(0.0)
      .ramp(0, 100).plateau(100.0)
      .ramp(100, 0).plateau(0.0)            # REFERENCIA 100 (evento 0)
      .ramp(0, 250).plateau(250.0)          # +250 -> ambiguo opciones [2,3] (evento 1)
      .confirm(1, 3))
    cases.append(s)

    s = Script("sin_senal_gap",
               "gap de 4 s tras la calibración: SIN_SENAL, ventana limpia; reaparece con +205 n=2")
    (s.open_session(1).plateau(0.0)
      .ramp(0, 100).plateau(100.0)
      .ramp(100, 0).plateau(0.0)            # REFERENCIA 100
      .gap(4000)                            # apagón -> sin_senal
      .plateau(205.0))                      # reaparece con +205 -> subida n=2
    cases.append(s)

    s = Script("escalon_parcial_y_deriva",
               "post-ref: deriva <40 kg no es evento; parcial n=0 tampoco avanza la base")
    (s.open_session(1).plateau(0.0)
      .ramp(0, 100).plateau(100.0)
      .ramp(100, 0).plateau(0.0)            # REFERENCIA 100, base 0
      .ramp(0, 30).plateau(30.0)            # +30 < min_delta -> nada, base sigue 0
      .ramp(30, 45).plateau(45.0)           # +45 >= min_delta, n_raw .45 -> 0: nada, base 0
      .ramp(45, 100).plateau(100.0))        # +100 desde base 0 -> n=1
    cases.append(s)

    s = Script("cerdo_inquieto",
               "calibración con ruido largo (nunca estable); al calmarse un solo nivel estable")
    (s.open_session(1).plateau(0.0)
      .ramp(0, 100).plateau(100.0)
      .ramp(100, 0).plateau(0.0)            # REFERENCIA 100
      .noise(103.0, 3.0, 60)                # inquieto: rango 6 kg > 2 kg
      .plateau(103.0))                      # se calma -> +103 n=1
    cases.append(s)

    s = Script("lote_bajadas_fifo",
               "dos bajadas sin emparejar; dos subidas siguientes son reingresos FIFO")
    (s.open_session(1).plateau(0.0)
      .ramp(0, 100).plateau(100.0)
      .ramp(100, 0).plateau(0.0)            # REFERENCIA 100
      .ramp(0, 101).plateau(101.0)          # +101 subida
      .ramp(101, 202).plateau(202.0)        # +101 subida
      .ramp(202, 101).plateau(101.0)        # -101 bajada A
      .ramp(101, 0).plateau(0.0)            # -101 bajada B
      .ramp(0, 102).plateau(102.0)          # +102 reingreso (parea A)
      .ramp(102, 203).plateau(203.0))       # +101 reingreso (parea B)
    cases.append(s)

    s = Script("arranque_cargado_sin_eventos",
               "sesión abre con plataforma cargada: la base de calibración es 150 y nada supera el umbral")
    (s.plateau(150.0).open_session(1)
      .ramp(150, 0).plateau(0.0)            # rel -150 < min_delta -> nada
      .ramp(0, 98).plateau(98.0))           # rel -52 < min_delta -> nada (sigue calibracion)
    cases.append(s)

    # -------------------------------------------- modo unidades (v2)

    s = Script("unidades_sin_repesaje",
               "SIN REPESAJE: montado sin vaciar NO cuenta; solo tras volver a vacío")
    (s.open_session(1, modo="unidades").plateau(0.0)   # base vacía = 0
      .ramp(0, 100).plateau(100.0)          # SUBIDA n=1 (100)
      .ramp(100, 0).plateau(0.0)            # salió: SIN evento
      .ramp(0, 98).plateau(98.0)            # SUBIDA n=1 (98)
      .ramp(98, 215).plateau(215.0)         # otro encima SIN vaciar: NO cuenta (retorno a cero)
      .ramp(215, 160).plateau(160.0)        # sigue con carga: NO cuenta
      .ramp(160, 0).plateau(0.0)            # vacío: SIN evento, listo para el próximo
      .ramp(0, 102).plateau(102.0))         # SUBIDA n=1 (102)
    cases.append(s)

    s = Script("unidades_retorno_vacio",
               "un animal sube y baja; vibraciones < min_delta no son eventos")
    (s.open_session(1, modo="unidades").plateau(0.0)   # base vacía = 0
      .ramp(0, 90).plateau(90.0)            # SUBIDA n=1 (90)
      .ramp(90, 30).plateau(30.0)           # < min_delta: salió, SIN evento
      .ramp(30, 0).plateau(0.0))            # vacío, nada
    cases.append(s)

    s = Script("unidades_banda_tolerancia",
               "tras 3 cerdos (avg 100): 170 = AMBIGUO [1,2] (confirmado 2); 55 descartado; 95 cuenta")
    (s.open_session(1, modo="unidades").plateau(0.0)             # base vacía = 0
      .ramp(0, 100).plateau(100.0).ramp(100, 0).plateau(0.0)    # cerdo 1 (100)
      .ramp(0, 100).plateau(100.0).ramp(100, 0).plateau(0.0)    # cerdo 2 (100)
      .ramp(0, 100).plateau(100.0).ramp(100, 0).plateau(0.0)    # cerdo 3 (100) -> avg 100
      .ramp(0, 170).plateau(170.0).ramp(170, 0).plateau(0.0))   # 170 > 1.5*avg -> AMBIGUO idx3
    s.confirm(3, 2)                                              # el operario confirma 2
    (s.ramp(0, 55).plateau(55.0).ramp(55, 0).plateau(0.0)       # 55 < 0.65*avg -> DESCARTADO
      .ramp(0, 95).plateau(95.0).ramp(95, 0).plateau(0.0))      # 95 en banda -> cuenta
    cases.append(s)

    return cases


def main() -> None:
    cases = [run_case(s) for s in build_cases()]
    payload = {
        "generated_by": "scripts/gen_engine_fixtures.py (WeighingEngine real de Python)",
        "engine_config": dataclasses.asdict(EngineConfig()),
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    n_events = sum(len(c["expected"]["events"]) for c in cases)
    print(f"OK: {len(cases)} casos, {n_events} eventos -> {OUT}")


if __name__ == "__main__":
    main()
