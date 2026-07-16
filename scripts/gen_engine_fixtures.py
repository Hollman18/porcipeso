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

    def open_session(self, session_id: int = 1) -> "Script":
        self.actions.append({"op": "open_session", "session_id": session_id})
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
            engine.open_session(action["session_id"])
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

    s = Script("referencia_simple", "báscula vacía, sube el cerdo de prueba (100 kg)")
    s.plateau(0.0).open_session(1).ramp(0, 100).plateau(100.0)
    cases.append(s)

    s = Script("subidas_multiples", "ref 100, luego 1 cerdo de 105 y 2 de 205 en total")
    (s.plateau(0.0).open_session(1)
      .ramp(0, 100).plateau(100.0)          # referencia 100
      .ramp(100, 205).plateau(205.0)        # +105 -> n=1 (residuo .05)
      .ramp(205, 410).plateau(410.0))       # +205 -> n=2 (avg 102.5)
    cases.append(s)

    s = Script("dos_de_una", "ref 100, suben 2 exactos (+200), luego 1 (+98)")
    (s.plateau(0.0).open_session(1)
      .ramp(0, 100).plateau(100.0)
      .ramp(100, 300).plateau(300.0)        # +200 -> n=2 residuo 0
      .ramp(300, 398).plateau(398.0))       # +98  -> n=1
    cases.append(s)

    s = Script("bajada_reingreso", "sube 1, se baja, vuelve a subir = reingreso pareado")
    (s.plateau(0.0).open_session(1)
      .ramp(0, 100).plateau(100.0)          # referencia
      .ramp(100, 202).plateau(202.0)        # +102 subida
      .ramp(202, 101).plateau(101.0)        # -101 bajada (sin emparejar)
      .ramp(101, 204).plateau(204.0))       # +103 reingreso
    cases.append(s)

    s = Script("ambiguo_confirm", "escalón +145 sobre avg 100 -> ambiguo [1,2], confirma 1")
    (s.plateau(0.0).open_session(1)
      .ramp(0, 100).plateau(100.0)          # referencia (evento 0)
      .ramp(100, 245).plateau(245.0)        # +145 -> n_raw 1.45 ambiguo (evento 1)
      .confirm(1, 1)
      .ramp(245, 390).plateau(390.0))       # +145 sobre avg 122.5 -> n=1 residuo .18
    cases.append(s)

    s = Script("ambiguo_mitad_banquero",
               "delta 250 sobre avg 100: n_raw 2.5 -> round banquero 2, ambiguo [2,3], confirma 3")
    (s.plateau(0.0).open_session(1)
      .ramp(0, 100).plateau(100.0)          # referencia (evento 0)
      .ramp(100, 350).plateau(350.0)        # +250 -> ambiguo opciones [2,3] (evento 1)
      .confirm(1, 3))
    cases.append(s)

    s = Script("sin_senal_gap", "gap de 4 s en plena sesión: SIN_SENAL y ventana limpia")
    (s.plateau(0.0).open_session(1)
      .ramp(0, 100).plateau(100.0)          # referencia
      .gap(4000)                            # apagón -> sin_senal
      .plateau(205.0))                      # reaparece con +105 -> subida n=1
    cases.append(s)

    s = Script("bajada_primero_ignorada",
               "sesión abre con plataforma cargada; se vacía (ref negativa ignorada) y luego ref real")
    (s.plateau(150.0).open_session(1)
      .ramp(150, 0).plateau(0.0)            # delta -150 sin ref -> se ignora, base avanza
      .ramp(0, 98).plateau(98.0))           # +98 -> referencia
    cases.append(s)

    s = Script("escalon_parcial_y_deriva",
               "deriva <40 kg no es evento (base quieta); parcial n=0 tampoco avanza la base")
    (s.plateau(0.0).open_session(1)
      .ramp(0, 100).plateau(100.0)          # referencia 100
      .ramp(100, 130).plateau(130.0)        # +30 < min_delta -> nada, base sigue 100
      .ramp(130, 145).plateau(145.0)        # +45 >= min_delta, n_raw .45 -> 0: nada, base 100
      .ramp(145, 200).plateau(200.0))       # +100 desde base 100 -> n=1
    cases.append(s)

    s = Script("cerdo_inquieto", "ruido largo (nunca estable) y al calmarse un solo evento")
    (s.plateau(0.0).open_session(1)
      .ramp(0, 100).plateau(100.0)          # referencia
      .noise(203.0, 3.0, 60)                # inquieto: rango 6 kg > 2 kg
      .plateau(203.0))                      # se calma -> +103 n=1
    cases.append(s)

    s = Script("bajadas_multiples_pareo_fifo",
               "dos bajadas sin emparejar; dos subidas siguientes son reingresos FIFO")
    (s.plateau(0.0).open_session(1)
      .ramp(0, 100).plateau(100.0)          # referencia
      .ramp(100, 201).plateau(201.0)        # +101 subida
      .ramp(201, 302).plateau(302.0)        # +101 subida
      .ramp(302, 201).plateau(201.0)        # -101 bajada A
      .ramp(201, 100).plateau(100.0)        # -101 bajada B
      .ramp(100, 202).plateau(202.0)        # +102 reingreso (parea A)
      .ramp(202, 303).plateau(303.0))       # +101 reingreso (parea B)
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
