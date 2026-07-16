"""Tests del motor de pesaje (SPEC §4 y §4.1) con streams sintéticos a 10 Hz.

El helper `feed_level` emite lecturas con ts_ms incrementales de 100 ms (10 Hz).
Los timestamps parten de time.time()*1000 para que el watchdog de snapshot()
(que compara contra el reloj de pared) no dispare SIN_SENAL en falso.
"""
from __future__ import annotations

import time

import pytest

from porcipeso.core.models import EngineConfig, EngineState, EventType, Reading
from porcipeso.engine.engine import WeighingEngine

HZ_MS = 100  # 10 Hz


def now_ms() -> int:
    return int(time.time() * 1000)


def make_engine(**overrides):
    """Motor con callbacks capturados en listas."""
    events: list = []
    states: list[str] = []
    cfg = EngineConfig(**overrides)
    eng = WeighingEngine(cfg, on_event=events.append, on_state=states.append)
    return eng, events, states


def feed_level(eng: WeighingEngine, ts: int, kg: float, n: int = 25,
               noise: float = 0.0) -> int:
    """Alimenta n lecturas a 10 Hz en el nivel kg (±noise alternada).

    Retorna el siguiente ts_ms disponible. Con noise=0 la ventana estabiliza
    apenas se llena; con noise > stability_range_kg/2 nunca estabiliza.
    """
    for i in range(n):
        jitter = noise if i % 2 == 0 else -noise
        eng.feed(Reading(ts_ms=ts, kg=kg + jitter))
        ts += HZ_MS
    return ts


# ---------------------------------------------------------------- caso 1

def test_referencia_limpia():
    """0 → 102.5: primer escalón de la sesión fija la referencia."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 102.5)

    assert len(events) == 1
    ev = events[0]
    assert ev.tipo == EventType.REFERENCIA
    assert ev.session_id == 1
    assert ev.id is not None
    assert ev.peso_antes == pytest.approx(0.0)
    assert ev.peso_despues == pytest.approx(102.5)
    assert ev.delta_kg == pytest.approx(102.5)
    assert ev.animales_estimados == 1
    assert ev.ambiguo is False
    assert ev.estab_ms > 0

    snap = eng.snapshot()
    assert snap.state == EngineState.ESTABLE
    assert snap.ref_kg == pytest.approx(102.5)
    assert snap.avg_kg == pytest.approx(102.5)
    assert snap.count == 1
    assert snap.total_kg == pytest.approx(102.5)
    assert snap.pending == 0


# ---------------------------------------------------------------- caso 2

def test_suben_dos_promedio_autocorregido():
    """+207 con avg 102.5 → n=2; el promedio se auto-corrige a total/count."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 102.5)
    ts = feed_level(eng, ts, 309.5)  # delta +207

    assert len(events) == 2
    ev = events[-1]
    assert ev.tipo == EventType.SUBIDA
    assert ev.animales_estimados == 2
    assert ev.delta_kg == pytest.approx(207.0)

    snap = eng.snapshot()
    assert snap.count == 3
    assert snap.total_kg == pytest.approx(309.5)
    assert snap.avg_kg == pytest.approx(309.5 / 3)  # auto-corregido
    assert snap.ref_kg == pytest.approx(102.5)      # la referencia no cambia


# ---------------------------------------------------------------- caso 3

def test_bajada_reingreso_neto_una_vez():
    """SPEC §4.1: bajada -101 descuenta; reingreso +101 suma. Neto = 1 vez."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 102.5)   # referencia
    ts = feed_level(eng, ts, 309.5)   # +207 → count 3
    ts = feed_level(eng, ts, 208.5)   # -101 → bajada
    snap = eng.snapshot()
    assert snap.count == 2
    assert snap.total_kg == pytest.approx(208.5)
    assert events[-1].tipo == EventType.BAJADA
    assert events[-1].animales_estimados == 1
    assert events[-1].delta_kg == pytest.approx(-101.0)

    ts = feed_level(eng, ts, 309.5)   # +101 → reingreso
    snap = eng.snapshot()
    assert snap.count == 3
    assert snap.total_kg == pytest.approx(309.5)
    assert events[-1].tipo == EventType.REINGRESO
    assert events[-1].animales_estimados == 1


# ---------------------------------------------------------------- caso 4

def test_ambiguo_opciones_y_confirm():
    """+155 con avg 102.5 → residuo > 20% → ambiguo [1,2]; confirm aplica."""
    eng, events, _ = make_engine()
    eng.open_session(7)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 102.5)   # referencia
    ts = feed_level(eng, ts, 257.5)   # delta +155 → n_raw 1.512 → ambiguo

    assert len(events) == 2
    ev = events[-1]
    assert ev.ambiguo is True
    assert ev.opciones == [1, 2]
    assert ev.animales_confirmados is None

    snap = eng.snapshot()
    assert snap.pending == 1
    # pendiente: NO se aplica al conteo todavía
    assert snap.count == 1
    assert snap.total_kg == pytest.approx(102.5)

    out = eng.confirm(ev.id, 2)
    assert out is not None
    assert out.ambiguo is False
    assert out.animales_confirmados == 2

    snap = eng.snapshot()
    assert snap.pending == 0
    assert snap.count == 3
    assert snap.total_kg == pytest.approx(257.5)
    assert snap.avg_kg == pytest.approx(257.5 / 3)


def test_confirm_id_inexistente_retorna_none():
    eng, _, _ = make_engine()
    eng.open_session(1)
    assert eng.confirm(999, 1) is None


# ---------------------------------------------------------------- caso 5

def test_cerdo_inquieto_un_solo_evento():
    """8 s de ruido ±14 kg y luego estabiliza → UN solo evento."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 102.5)          # referencia
    n_before = len(events)
    ts = feed_level(eng, ts, 205.0, n=80, noise=14.0)  # 8 s de ruido, nunca estable
    assert len(events) == n_before            # sin eventos durante el ruido
    ts = feed_level(eng, ts, 205.0)           # por fin estabiliza

    assert len(events) == n_before + 1
    ev = events[-1]
    assert ev.tipo == EventType.SUBIDA
    assert ev.animales_estimados == 1
    assert ev.estab_ms >= 8000                # el movimiento duró ≥ 8 s
    assert eng.snapshot().count == 2


# ---------------------------------------------------------------- caso 6

def test_vibracion_menor_a_min_delta_no_genera_evento():
    """Escalón estable de 27.5 kg (< min_delta 40) → ni evento ni cambio."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 102.5)   # referencia
    n_before = len(events)
    ts = feed_level(eng, ts, 130.0)   # +27.5 < min_delta_kg
    ts = feed_level(eng, ts, 102.5)   # regresa

    assert len(events) == n_before
    snap = eng.snapshot()
    assert snap.count == 1
    assert snap.total_kg == pytest.approx(102.5)


# ---------------------------------------------------------------- caso 7

def test_transiciones_on_state():
    """on_state se dispara exactamente en cada transición, con los valores del enum."""
    eng, _, states = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 102.5)
    assert states == ["movimiento", "estable", "movimiento", "estable"]

    eng.close_session()
    assert states[-1] == "idle"


# ---------------------------------------------------------------- caso 8

def test_invariante_total_igual_suma_de_deltas():
    """Tras cada evento aplicado, |total - Σ deltas aplicados| < 0.01."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()

    def check():
        aplicados = [e for e in events if not e.ambiguo]
        assert abs(eng.snapshot().total_kg
                   - sum(e.delta_kg for e in aplicados)) < 0.01

    for kg in (0.0, 102.5, 309.5, 208.5, 309.5, 514.5):
        ts = feed_level(eng, ts, kg)
        check()

    snap = eng.snapshot()
    assert snap.count == 5          # 1 + 2 - 1 + 1 + 2
    assert snap.total_kg == pytest.approx(514.5)


# ---------------------------------------------------------------- SIN_SENAL

def test_sin_senal_por_hueco_entre_lecturas():
    """Hueco > no_signal_after_s entre lecturas → transición SIN_SENAL en feed."""
    eng, events, states = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts += 5000                       # 5 s sin señal (> 3 s)
    ts = feed_level(eng, ts, 102.5)  # vuelve la señal, ya con un cerdo arriba

    assert "sin_senal" in states
    # el escalón ocurrido durante el apagón igual se detecta al reestabilizar
    assert len(events) == 1
    assert events[0].tipo == EventType.REFERENCIA
    assert events[0].delta_kg == pytest.approx(102.5)


def test_sin_senal_watchdog_en_snapshot():
    """snapshot() compara ts de la última lectura contra time.time()*1000."""
    eng, _, states = make_engine()
    eng.open_session(1)
    ts = now_ms() - 10_000           # lecturas viejas: hace ~10 s
    feed_level(eng, ts, 0.0)

    snap = eng.snapshot()
    assert snap.state == EngineState.SIN_SENAL
    assert states[-1] == "sin_senal"


# ---------------------------------------------------------------- bordes

def test_referencia_negativa_se_ignora():
    """El primer delta debe ser positivo; una bajada inicial no fija referencia."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 200.0)   # baseline con peso ya en plataforma
    ts = feed_level(eng, ts, 90.0)    # delta -110: negativo → ignorado
    assert events == []
    assert eng.snapshot().ref_kg is None

    ts = feed_level(eng, ts, 192.5)   # +102.5 desde el nuevo nivel → referencia
    assert len(events) == 1
    assert events[0].tipo == EventType.REFERENCIA
    assert events[0].delta_kg == pytest.approx(102.5)
    assert eng.snapshot().count == 1


def test_escalon_parcial_n_cero_se_acumula():
    """delta ≥ min_delta pero n=0 → se ignora SIN avanzar el nivel base,
    así el cerdo que sube en dos tiempos cuenta una sola vez al completar."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 102.5)   # referencia
    n_before = len(events)
    ts = feed_level(eng, ts, 147.5)   # +45: n_raw 0.44 → n=0 → ignorado
    assert len(events) == n_before
    ts = feed_level(eng, ts, 205.0)   # completa la subida: delta 102.5 desde base
    assert len(events) == n_before + 1
    ev = events[-1]
    assert ev.tipo == EventType.SUBIDA
    assert ev.animales_estimados == 1
    assert ev.peso_antes == pytest.approx(102.5)
    assert eng.snapshot().count == 2
    assert eng.snapshot().total_kg == pytest.approx(205.0)


def test_close_session_resetea_y_queda_idle():
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 102.5)

    final = eng.close_session()
    assert final.count == 1
    assert final.total_kg == pytest.approx(102.5)

    snap = eng.snapshot()
    assert snap.state == EngineState.IDLE
    assert snap.count == 0
    assert snap.ref_kg is None
    assert snap.total_kg == pytest.approx(0.0)

    # sin sesión abierta no se generan eventos
    n_before = len(events)
    ts = feed_level(eng, ts, 309.5)
    assert len(events) == n_before


def test_sin_sesion_no_emite_eventos_pero_trackea_kg():
    eng, events, _ = make_engine()
    ts = now_ms()
    ts = feed_level(eng, ts, 250.0)
    assert events == []
    snap = eng.snapshot()
    assert snap.state == EngineState.IDLE
    assert snap.kg_now == pytest.approx(250.0)
