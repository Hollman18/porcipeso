"""E2E completo SIN hardware: simulador TCP → drivers → engine.

Guion v2 (SPEC §4 y §4.1): CALIBRACIÓN con cerdo de prueba que se baja
(sube 102.5 y baja → evento REFERENCIA, fase "lote", count 0), luego el
lote: sube 1, suben 2, se devuelve 1 (BAJADA), reingresa (REINGRESO),
sube 1 más → conteo neto final = 4.

Los módulos hermanos (porcipeso.drivers.*, porcipeso.engine.*) se construyen
en paralelo: si aún no existen, estos tests se SALTAN (importorskip) y quedan
listos para la integración (Task 6).
"""
from __future__ import annotations

import threading
import time

import pytest

transports = pytest.importorskip(
    "porcipeso.drivers.transports", reason="drivers/transports.py aún no construido")
parsers = pytest.importorskip(
    "porcipeso.drivers.parsers", reason="drivers/parsers.py aún no construido")
runner = pytest.importorskip(
    "porcipeso.drivers.runner", reason="drivers/runner.py aún no construido")
engine_mod = pytest.importorskip(
    "porcipeso.engine.engine", reason="engine/engine.py aún no construido")

from porcipeso.core.models import (  # noqa: E402
    EngineConfig, EngineState, EventType, ScaleProfile,
)
from porcipeso.sim.indicator_sim import IndicatorSimServer, Scenario  # noqa: E402


def _wait_until(cond, timeout_s: float, interval_s: float = 0.1) -> bool:
    """Polling con timeout — nunca sleeps ciegos largos."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(interval_s)
    return bool(cond())


def _sim_profile(port: int) -> ScaleProfile:
    return ScaleProfile(
        id="sim-matrix",
        name="Simulador Matrix (TCP)",
        brand="Sim",
        parser="matrix",
        transport="tcp",
        host="127.0.0.1",
        tcp_port=port,
    )


def _run_stack(scenario: Scenario):
    """Arranca simulador + run_driver→engine. Retorna (server, engine, events, stop, thread)."""
    server = IndicatorSimServer(port=0, encoder="matrix", scenario=scenario, hz=10)
    server.start()
    profile = _sim_profile(server.port)

    events = []
    engine = engine_mod.WeighingEngine(EngineConfig(), on_event=events.append)
    engine.open_session(1)

    stop_flag = threading.Event()
    t = threading.Thread(
        target=runner.run_driver,
        args=(profile, engine.feed, stop_flag.is_set),
        name="e2e-driver",
        daemon=True,
    )
    t.start()
    return server, engine, events, stop_flag, t


def test_contrato_transporte_y_parser_matrix():
    """make_transport(tcp) + PARSER_REGISTRY['matrix'] leen tramas del simulador."""
    scenario = Scenario([("pigs_on", 1, 100.0), ("wait", 20.0)], seed=5)
    server = IndicatorSimServer(port=0, encoder="matrix", scenario=scenario, hz=10)
    server.start()
    try:
        profile = _sim_profile(server.port)
        transport = transports.make_transport(profile)
        assert isinstance(transport, transports.TcpTransport)
        assert "matrix" in parsers.PARSER_REGISTRY
        parser = parsers.PARSER_REGISTRY["matrix"](profile)

        readings = []
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and len(readings) < 5:
            data = transport.read(max_bytes=256, timeout_s=0.3)
            if data:
                readings.extend(parser.push(data))
        transport.close()
    finally:
        server.stop()

    assert len(readings) >= 5, "el parser no produjo lecturas del stream del sim"
    assert all(0.0 <= r.kg <= 200.0 for r in readings)


def test_flujo_completo_con_bajada_y_reingreso():
    """Guion completo v2: calibración (cerdo de prueba sube Y BAJA) → lote:
    sube 1 → suben 2 → se devuelve 1 → reingresa → sube 1 más.

    Conteo neto tras la calibración: 1 + 2 − 1 + 1 + 1 = 4 (el guion añade
    un cuarto cerdo al final para que el neto sea 4 manteniendo exactamente
    una BAJADA y un REINGRESO; la bajada del cerdo de prueba NO cuenta).
    """
    scenario = Scenario(
        [
            ("wait", 4.0),                       # línea base estable en 0
                                                 # (>2 s: la ventana de 20
                                                 # lecturas debe llenarse)
            ("pigs_on", 1, 102.5),               # sube el cerdo de prueba
            ("wait", 3.0),
            ("pig_off", None),                   # se baja → REFERENCIA, fase lote
            ("wait", 3.0),
            ("pigs_on", 1, 102.5),               # el de prueba vuelve con el lote
            ("wait", 3.0),
            ("pigs_on", 2, (103.9, 103.1)),      # suben 2
            ("wait", 3.0),
            ("pig_off", None),                   # se devuelve el último (103.1)
            ("wait", 3.0),
            ("pigs_on", 1, 101.0),               # reingresa (mismo peso ~101)
            ("wait", 3.0),
            ("pigs_on", 1, 104.2),               # sube el 4.º cerdo neto
            ("wait", 3.0),
        ],
        seed=7,
    )
    server, engine, events, stop_flag, t = _run_stack(scenario)
    try:
        ok = _wait_until(
            lambda: scenario.done and engine.snapshot().count == 4,
            timeout_s=50.0,
        )
        # margen corto para que el último evento termine de persistirse
        _wait_until(lambda: engine.snapshot().pending == 0, timeout_s=3.0)
        snap = engine.snapshot()

        assert ok and snap.count == 4, (
            f"conteo final {snap.count} != 4 · eventos: "
            f"{[(e.tipo, e.animales_estimados, round(e.delta_kg, 1)) for e in events]}"
        )
        tipos = [e.tipo for e in events]
        # calibración v2: el primer evento es la REFERENCIA (peak del cerdo
        # de prueba) y su bajada NO genera BAJADA
        assert tipos[0] == EventType.REFERENCIA, f"tipos={tipos}"
        assert tipos.count(EventType.REFERENCIA) == 1, f"tipos={tipos}"
        assert abs(events[0].delta_kg - 102.5) <= 1.5, (
            f"referencia {events[0].delta_kg:.1f} != ~102.5"
        )
        assert snap.fase == "lote"
        assert snap.ref_kg is not None and abs(snap.ref_kg - 102.5) <= 1.5
        assert tipos.count(EventType.BAJADA) == 1, f"esperaba 1 BAJADA, tipos={tipos}"
        assert EventType.REINGRESO in tipos, f"esperaba un REINGRESO, tipos={tipos}"

        # total ≈ suma física real sobre plataforma (verdad-terreno del sim)
        assert abs(snap.total_kg - scenario.total_physical_kg) <= 1.0, (
            f"total {snap.total_kg:.1f} vs físico {scenario.total_physical_kg:.1f}"
        )
        # promedio coherente con total/conteo y con el rango de pesos del guion
        assert snap.avg_kg is not None
        assert abs(snap.avg_kg - snap.total_kg / snap.count) < 0.5
        assert 95.0 <= snap.avg_kg <= 110.0

        # ningún evento ambiguo sin resolver
        assert snap.pending == 0
        assert all(
            (not e.ambiguo) or (e.animales_confirmados is not None) for e in events
        ), f"evento ambiguo sin confirmar: {[e for e in events if e.ambiguo]}"
    finally:
        stop_flag.set()
        server.stop()
        t.join(timeout=5.0)


def test_watchdog_sin_senal():
    """("silence", 4) con guion terminado en mudo → snapshot().state == SIN_SENAL."""
    scenario = Scenario(
        [
            ("wait", 1.0),
            ("pigs_on", 1, 102.0),
            ("wait", 2.0),
            ("silence", 4.0),
        ],
        seed=9,
        hold_at_end=False,  # al acabar el guion sigue mudo: silencio permanente
    )
    server, engine, events, stop_flag, t = _run_stack(scenario)
    try:
        vio_sin_senal = _wait_until(
            lambda: engine.snapshot().state == EngineState.SIN_SENAL,
            timeout_s=15.0,
        )
        assert vio_sin_senal, (
            f"nunca entró en SIN_SENAL (estado final: {engine.snapshot().state})"
        )
    finally:
        stop_flag.set()
        server.stop()
        t.join(timeout=5.0)
