"""Tests del motor de pesaje v2 (SPEC §4 y §4.1) con streams sintéticos a 10 Hz.

El helper `feed_level` emite lecturas con ts_ms incrementales de 100 ms (10 Hz).
Los timestamps parten de time.time()*1000 para que el watchdog de snapshot()
(que compara contra el reloj de pared) no dispare SIN_SENAL en falso.

Flujo v2 modo "lote": la sesión arranca en fase "calibracion"; la referencia
exige subir el cerdo de prueba Y BAJARLO (el peak estable sostenido es la ref).
El helper `calibrar` recorre ese ciclo completo (0 → ref → 0) y deja el motor
en fase "lote" con ref_kg fijada y count=0.
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


def calibrar(eng: WeighingEngine, ts: int, ref: float = 102.5) -> int:
    """Ciclo de calibración completo: vacío → cerdo de prueba → vacío."""
    ts = feed_level(eng, ts, 0.0)     # base vacía
    ts = feed_level(eng, ts, ref)     # sube el cerdo de prueba
    ts = feed_level(eng, ts, 0.0)     # se baja → REFERENCIA, fase "lote"
    return ts


# ------------------------------------------------------- calibración (lote)

def test_calibracion_referencia_exige_subir_y_bajar():
    """0 → 102.5 → 0: la REFERENCIA solo se emite al bajar el cerdo de prueba."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    assert eng.snapshot().fase == "calibracion"

    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    assert eng.snapshot().fase == "calibracion"  # base vacía, sin candidato

    ts = feed_level(eng, ts, 102.5)
    # candidato capturado, esperando la bajada: SIN evento todavía
    assert events == []
    snap = eng.snapshot()
    assert snap.fase == "bajar_prueba"
    assert snap.ref_kg is None
    assert snap.count == 0

    ts = feed_level(eng, ts, 0.0)     # se baja el cerdo de prueba
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
    assert snap.fase == "lote"
    assert snap.ref_kg == pytest.approx(102.5)
    assert snap.avg_kg == pytest.approx(102.5)
    assert snap.count == 0                      # el de prueba se bajó
    assert snap.total_kg == pytest.approx(0.0)
    assert snap.pending == 0


def test_snapshot_cand_kg_es_el_peso_que_sera_la_referencia():
    """bajar_prueba: cand_kg ya trae el peso del cerdo de prueba (la UI lo
    muestra antes de ref_kg; antes salía "– kg") y es EXACTO la referencia."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    assert eng.snapshot().cand_kg is None          # vacío: sin candidato
    ts = feed_level(eng, ts, 98.0)
    ts = feed_level(eng, ts, 101.5)                 # peak hold
    snap = eng.snapshot()
    assert snap.fase == "bajar_prueba"
    assert snap.ref_kg is None
    assert snap.cand_kg == pytest.approx(101.5)
    ts = feed_level(eng, ts, 0.0)                   # se baja → REFERENCIA
    assert events[0].delta_kg == pytest.approx(snap.cand_kg)
    snap = eng.snapshot()
    assert snap.fase == "lote"
    assert snap.cand_kg is None                     # ya hay ref_kg
    assert snap.ref_kg == pytest.approx(101.5)


def test_calibracion_peak_hold_cerdo_inquieto():
    """Niveles estables 98 → 102 → 100 y se baja → ref = 102 (peak estable)."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 98.0)
    assert eng.snapshot().fase == "bajar_prueba"
    ts = feed_level(eng, ts, 102.0)   # se acomoda: +4 < min_delta → mismo cerdo
    assert eng.snapshot().fase == "bajar_prueba"
    ts = feed_level(eng, ts, 100.0)   # peak hold: el candidato no baja
    assert eng.snapshot().fase == "bajar_prueba"
    assert events == []               # nada de eventos durante la calibración

    ts = feed_level(eng, ts, 0.0)     # se baja
    assert len(events) == 1
    assert events[0].tipo == EventType.REFERENCIA
    assert events[0].delta_kg == pytest.approx(102.0)
    snap = eng.snapshot()
    assert snap.fase == "lote"
    assert snap.ref_kg == pytest.approx(102.0)
    assert snap.count == 0


def test_calibracion_doble_monta_vuelve_a_calibracion():
    """A4: montaron otro sin bajar el primero → fase vuelve a 'calibracion'
    con el nuevo máximo; el motor no se rompe y al vaciar emite REFERENCIA."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 100.0)   # cerdo de prueba
    assert eng.snapshot().fase == "bajar_prueba"
    ts = feed_level(eng, ts, 205.0)   # +105 ≥ min_delta: se montó otro
    assert eng.snapshot().fase == "calibracion"
    assert events == []

    ts = feed_level(eng, ts, 0.0)     # bajan ambos → termina con el máximo
    assert len(events) == 1
    assert events[0].tipo == EventType.REFERENCIA
    assert events[0].delta_kg == pytest.approx(205.0)
    snap = eng.snapshot()
    assert snap.fase == "lote"
    assert snap.ref_kg == pytest.approx(205.0)
    assert snap.count == 0
    assert snap.total_kg == pytest.approx(0.0)


def test_calibracion_bajada_inicial_no_fija_candidato():
    """Base con peso ya en plataforma: una bajada inicial no es candidato;
    la subida ≥ min_delta sobre la base sí, y al volver a la base → REFERENCIA."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 200.0)   # base (había peso muerto en plataforma)
    ts = feed_level(eng, ts, 90.0)    # quitan peso: rel negativo → ignorado
    assert events == []
    assert eng.snapshot().fase == "calibracion"
    assert eng.snapshot().ref_kg is None

    ts = feed_level(eng, ts, 302.5)   # +102.5 sobre la base → candidato
    assert eng.snapshot().fase == "bajar_prueba"
    ts = feed_level(eng, ts, 195.0)   # vuelve ~a la base → calibración lista
    assert len(events) == 1
    assert events[0].tipo == EventType.REFERENCIA
    assert events[0].delta_kg == pytest.approx(102.5)
    assert eng.snapshot().fase == "lote"
    assert eng.snapshot().count == 0


def test_lote_completo_tras_calibracion():
    """Tras calibrar, suben los cerdos (incluido el de prueba de nuevo):
    el conteo arranca en 0 y cuenta cada subida normal."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = calibrar(eng, ts, 102.5)

    ts = feed_level(eng, ts, 102.5)   # vuelve a subir el cerdo de prueba
    ts = feed_level(eng, ts, 205.0)   # sube otro (+102.5)
    ts = feed_level(eng, ts, 309.5)   # sube otro (+104.5)

    tipos = [e.tipo for e in events]
    assert tipos == [EventType.REFERENCIA, EventType.SUBIDA,
                     EventType.SUBIDA, EventType.SUBIDA]
    assert all(e.animales_estimados == 1 for e in events[1:])
    snap = eng.snapshot()
    assert snap.fase == "lote"
    assert snap.count == 3
    assert snap.total_kg == pytest.approx(309.5)
    assert snap.avg_kg == pytest.approx(309.5 / 3)
    assert snap.ref_kg == pytest.approx(102.5)   # la referencia no cambia


# ------------------------------------------------------------- fase "lote"

def test_suben_dos_promedio_autocorregido():
    """+207 con avg 102.5 → n=2; el promedio se auto-corrige a total/count."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = calibrar(eng, ts, 102.5)
    ts = feed_level(eng, ts, 102.5)   # sube 1 (count=1)
    ts = feed_level(eng, ts, 309.5)   # delta +207

    assert len(events) == 3           # REFERENCIA + SUBIDA + SUBIDA
    ev = events[-1]
    assert ev.tipo == EventType.SUBIDA
    assert ev.animales_estimados == 2
    assert ev.delta_kg == pytest.approx(207.0)

    snap = eng.snapshot()
    assert snap.count == 3
    assert snap.total_kg == pytest.approx(309.5)
    assert snap.avg_kg == pytest.approx(309.5 / 3)  # auto-corregido
    assert snap.ref_kg == pytest.approx(102.5)      # la referencia no cambia


def test_bajada_no_descuenta_es_avance_al_camion():
    """Báscula de paso (2026-08): una BAJADA = el grupo pesado avanzó al
    camión (flujo normal). NO descuenta nada automáticamente y NO emite
    evento; solo resetea la base para el siguiente grupo que suba."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = calibrar(eng, ts, 102.5)
    ts = feed_level(eng, ts, 102.5)   # sube 1 → count 1
    ts = feed_level(eng, ts, 309.5)   # +207 → count 3
    n_eventos_antes = len(events)
    ts = feed_level(eng, ts, 0.0)     # baja todo (avanzó al camión)
    snap = eng.snapshot()
    assert snap.count == 3            # NO descuenta
    assert snap.total_kg == pytest.approx(309.5)
    assert len(events) == n_eventos_antes   # la bajada no emite evento

    # el siguiente grupo suma sobre la base reseteada (vacío)
    ts = feed_level(eng, ts, 205.0)   # +205 ≈ 2 cerdos → count 5
    snap = eng.snapshot()
    assert snap.count == 5
    assert events[-1].tipo == EventType.SUBIDA


def test_devueltos_manual_corrige_doble_conteo():
    """Rebote: un cerdo sube, se devuelve por miedo y al pasar el lote vuelve
    a subir → contó 2 siendo 1. El operario registra 1 devuelto y queda 1."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = calibrar(eng, ts, 100.0)
    ts = feed_level(eng, ts, 100.0)   # sube 1 (se pesó)
    ts = feed_level(eng, ts, 0.0)     # se devolvió por miedo (bajada ignorada)
    ts = feed_level(eng, ts, 100.0)   # vuelve a subir → contó 2 (doble)
    assert eng.snapshot().count == 2

    ev = eng.register_returned(1)     # el operario ve el rebote y registra 1
    assert ev is not None
    assert ev.tipo == EventType.AJUSTE
    assert ev.animales_confirmados == 1
    assert ev.motivo_bajada == "devuelto_manual"
    snap = eng.snapshot()
    assert snap.count == 1                       # corregido
    assert snap.total_kg == pytest.approx(100.0) # descontó 1×promedio
    assert snap.avg_kg == pytest.approx(100.0)   # promedio estable

    # no deja el conteo negativo
    assert eng.register_returned(99) is not None
    assert eng.snapshot().count == 0
    assert eng.register_returned(1) is None      # ya en 0 → no hace nada


def test_devueltos_por_peso_real_cuadra_exacto_unidades():
    """UNIDADES: descontar por PESO REAL del cerdo elegido (kg) cuadra al gramo
    cuando ese cerdo re-pasa por la báscula. A=60, B=55: B rebota y se descuenta
    su peso real; al re-pasar el total vuelve a 115 exacto."""
    eng, events, _ = make_engine()
    eng.open_session(1, modo="unidades")
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)     # base vacía
    ts = feed_level(eng, ts, 60.0)    # A
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 55.0)    # B (se contó)
    ts = feed_level(eng, ts, 0.0)     # B rebota y baja
    assert eng.snapshot().count == 2
    assert eng.snapshot().total_kg == pytest.approx(115.0)

    ev = eng.register_returned(1, kg=55.0)   # descuento el PESO REAL de B
    assert ev is not None and ev.tipo == EventType.AJUSTE
    assert ev.delta_kg == pytest.approx(-55.0)
    snap = eng.snapshot()
    assert snap.count == 1
    assert snap.total_kg == pytest.approx(60.0)   # queda solo A
    assert snap.avg_kg == pytest.approx(60.0)     # promedio recalculado (solo A)

    ts = feed_level(eng, ts, 55.0)    # B RE-PASA por la báscula
    ts = feed_level(eng, ts, 0.0)
    snap = eng.snapshot()
    assert snap.count == 2
    assert snap.total_kg == pytest.approx(115.0)  # EXACTO (60 + 55)


def test_devueltos_promedio_sigue_disponible_sin_kg():
    """Sin kg (lote), el descuento por promedio sigue intacto: promedio estable."""
    eng, _, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = calibrar(eng, ts, 100.0)
    ts = feed_level(eng, ts, 100.0)   # sube 1
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 100.0)   # doble
    assert eng.snapshot().count == 2
    ev = eng.register_returned(1)     # sin kg → promedio
    assert ev.delta_kg == pytest.approx(-100.0)
    assert eng.snapshot().avg_kg == pytest.approx(100.0)  # promedio no cambia


def test_ambiguo_opciones_y_confirm():
    """+155 con avg 102.5 → residuo > 20% → ambiguo [1,2]; confirm aplica."""
    eng, events, _ = make_engine()
    eng.open_session(7)
    ts = now_ms()
    ts = calibrar(eng, ts, 102.5)
    ts = feed_level(eng, ts, 102.5)   # sube 1 → count 1, avg 102.5
    ts = feed_level(eng, ts, 257.5)   # delta +155 → n_raw 1.512 → ambiguo

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


def test_cerdo_inquieto_un_solo_evento():
    """8 s de ruido ±14 kg y luego estabiliza → UN solo evento."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = calibrar(eng, ts, 102.5)
    ts = feed_level(eng, ts, 102.5)          # sube 1 → count 1
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


def test_vibracion_menor_a_min_delta_no_genera_evento():
    """Escalón estable de 27.5 kg (< min_delta 40) → ni evento ni cambio."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = calibrar(eng, ts, 102.5)
    ts = feed_level(eng, ts, 102.5)   # sube 1 → count 1
    n_before = len(events)
    ts = feed_level(eng, ts, 130.0)   # +27.5 < min_delta_kg
    ts = feed_level(eng, ts, 102.5)   # regresa

    assert len(events) == n_before
    snap = eng.snapshot()
    assert snap.count == 1
    assert snap.total_kg == pytest.approx(102.5)


def test_transiciones_on_state():
    """on_state se dispara exactamente en cada transición, con los valores del enum."""
    eng, _, states = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = calibrar(eng, ts, 102.5)     # 0 → 102.5 → 0: tres estabilizaciones
    assert states == ["movimiento", "estable",
                      "movimiento", "estable",
                      "movimiento", "estable"]

    eng.close_session()
    assert states[-1] == "idle"


def test_invariante_total_igual_suma_de_deltas():
    """Tras cada evento aplicado, |total - Σ deltas aplicados| < 0.01.

    v2: la REFERENCIA de calibración NO se aplica al total (el cerdo de
    prueba se bajó); el invariante suma solo SUBIDA/BAJADA/REINGRESO.
    """
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()

    def check():
        # v2 báscula de paso: las bajadas ya no emiten evento; el total suma
        # solo las SUBIDAS aplicadas (la REFERENCIA no cuenta).
        aplicados = [e for e in events
                     if not e.ambiguo and e.tipo == EventType.SUBIDA]
        assert abs(eng.snapshot().total_kg
                   - sum(e.delta_kg for e in aplicados)) < 0.01

    # calibración + lote: sube 1, suben 2, baja(ignorada), sube 1, suben 2
    for kg in (0.0, 102.5, 0.0, 102.5, 309.5, 208.5, 309.5, 514.5):
        ts = feed_level(eng, ts, kg)
        check()

    snap = eng.snapshot()
    assert snap.count == 6          # 1 + 2 + 1 + 2 (la bajada no descuenta)
    assert snap.total_kg == pytest.approx(615.5)


# ---------------------------------------------------------------- SIN_SENAL

def test_sin_senal_por_hueco_entre_lecturas():
    """Hueco > no_signal_after_s entre lecturas → transición SIN_SENAL en feed."""
    eng, events, states = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts += 5000                       # 5 s sin señal (> 3 s)
    ts = feed_level(eng, ts, 102.5)  # vuelve la señal, ya con el de prueba arriba

    assert "sin_senal" in states
    # el nivel alcanzado durante el apagón igual se captura como candidato
    assert events == []
    assert eng.snapshot().fase == "bajar_prueba"

    ts = feed_level(eng, ts, 0.0)    # se baja → referencia
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


# ------------------------------------------------------------ modo unidades

def test_unidades_ciclo_cinco_animales():
    """Cinco ciclos vacío→animal→vacío: 5 SUBIDAS n=1 con el peso de cada uno."""
    pesos = (95.0, 110.0, 102.5, 87.0, 120.0)
    eng, events, _ = make_engine()
    eng.open_session(3, modo="unidades")
    assert eng.snapshot().fase == "unidades"

    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)     # base vacía
    for peso in pesos:
        ts = feed_level(eng, ts, peso)
        ts = feed_level(eng, ts, 0.0)  # el animal sale: NO es evento

    assert len(events) == len(pesos)
    for ev, peso in zip(events, pesos):
        assert ev.tipo == EventType.SUBIDA
        assert ev.animales_estimados == 1
        assert ev.ambiguo is False
        assert ev.delta_kg == pytest.approx(peso)
        assert ev.session_id == 3

    snap = eng.snapshot()
    assert snap.fase == "unidades"    # siempre, en todo momento
    assert snap.count == 5
    assert snap.total_kg == pytest.approx(sum(pesos))
    assert snap.avg_kg == pytest.approx(sum(pesos) / 5)
    assert snap.ref_kg is None        # sin calibración ni referencia
    assert snap.pending == 0          # jamás ambiguos en este modo


def test_unidades_bajada_parcial_se_ignora_hasta_vaciar():
    """Animal de 100 que baja a 55 sin vaciar: se ignora; al vaciar, listo."""
    eng, events, _ = make_engine()
    eng.open_session(1, modo="unidades")
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 100.0)   # SUBIDA 100
    assert len(events) == 1
    ts = feed_level(eng, ts, 55.0)    # bajada parcial extraña → ignorada
    assert len(events) == 1
    assert eng.snapshot().count == 1
    ts = feed_level(eng, ts, 0.0)     # vacía: sin evento
    assert len(events) == 1
    ts = feed_level(eng, ts, 90.0)    # siguiente animal
    assert len(events) == 2
    assert events[-1].delta_kg == pytest.approx(90.0)

    snap = eng.snapshot()
    assert snap.count == 2
    assert snap.total_kg == pytest.approx(190.0)
    assert snap.fase == "unidades"


def test_unidades_sin_repesaje_exige_volver_a_vacio():
    """SIN REPESAJE (unit_return_to_zero, por defecto): un cerdo montado encima
    sin bajar el primero NO se cuenta; solo tras volver a ~vacío cuenta el
    siguiente. Evita el doble pesaje del mismo cerdo que se reacomoda."""
    eng, events, _ = make_engine()
    eng.open_session(1, modo="unidades")
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 100.0)   # animal 1 → SUBIDA
    assert len(events) == 1
    ts = feed_level(eng, ts, 195.0)   # otro encima SIN vaciar: NO cuenta
    assert len(events) == 1
    ts = feed_level(eng, ts, 210.0)   # sigue con carga: NO cuenta
    assert len(events) == 1
    ts = feed_level(eng, ts, 0.0)     # vacía: sin evento, listo para el próximo
    ts = feed_level(eng, ts, 96.0)    # animal 2 → SUBIDA
    assert len(events) == 2
    assert events[-1].delta_kg == pytest.approx(96.0)

    snap = eng.snapshot()
    assert snap.count == 2
    assert snap.total_kg == pytest.approx(196.0)


def test_unidades_apilado_legado_cuando_return_to_zero_off():
    """Con unit_return_to_zero=False vuelve el apilado: montar otro encima
    cuenta la diferencia ≥ min_delta (comportamiento legado, opcional)."""
    eng, events, _ = make_engine(unit_return_to_zero=False)
    eng.open_session(1, modo="unidades")
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 100.0)   # animal 1
    ts = feed_level(eng, ts, 195.0)   # animal 2 encima: diferencia +95
    assert len(events) == 2
    assert events[-1].delta_kg == pytest.approx(95.0)
    snap = eng.snapshot()
    assert snap.count == 2
    assert snap.total_kg == pytest.approx(195.0)


def test_unidades_banda_descarta_muy_liviano():
    """Con promedio establecido (≥3 cerdos), un peso < band_low*avg NO cuenta
    (cerdo a medio subir / objeto)."""
    eng, events, _ = make_engine()  # band_low 0.65, min_animals_for_band 3
    eng.open_session(1, modo="unidades")
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    for peso in (100.0, 100.0, 100.0):          # avg 100, count 3
        ts = feed_level(eng, ts, peso)
        ts = feed_level(eng, ts, 0.0)
    assert eng.snapshot().count == 3
    ts = feed_level(eng, ts, 55.0)              # 55 < 0.65*100 = 65 → descartado
    ts = feed_level(eng, ts, 0.0)
    assert eng.snapshot().count == 3            # no contó
    ts = feed_level(eng, ts, 95.0)              # 95 en banda → cuenta
    ts = feed_level(eng, ts, 0.0)
    assert eng.snapshot().count == 4


def test_unidades_banda_sobre_techo_marca_ambiguo():
    """Un peso > band_high*avg se marca AMBIGUO con opciones; el operario
    confirma 1 o 2 (posible doble)."""
    eng, events, _ = make_engine()
    eng.open_session(1, modo="unidades")
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)
    for _ in range(3):                          # avg 100, count 3
        ts = feed_level(eng, ts, 100.0)
        ts = feed_level(eng, ts, 0.0)
    ts = feed_level(eng, ts, 170.0)             # 170 > 1.5*100 = 150 → ambiguo
    ev = events[-1]
    assert ev.ambiguo is True
    assert ev.opciones == [1, 2]
    assert eng.snapshot().pending == 1
    assert eng.snapshot().count == 3            # aún sin aplicar
    res = eng.confirm(ev.id, 2)
    assert res is not None
    assert eng.snapshot().count == 5
    assert eng.snapshot().pending == 0


def test_tiempo_minimo_estable_no_registra_pesaje_fugaz():
    """Un peso que NO se sostiene min_stable_ms (cerdo que pasa de largo) no se
    registra; el mismo peso sostenido ≥ 2 s sí."""
    eng, events, _ = make_engine()
    eng.open_session(1, modo="unidades")
    ts = now_ms()
    ts = feed_level(eng, ts, 0.0)               # base vacía (2.5 s → estable)
    n_before = len(events)
    ts = feed_level(eng, ts, 100.0, n=12)       # 1.2 s < 2 s → fugaz, no registra
    assert len(events) == n_before
    ts = feed_level(eng, ts, 0.0)               # vuelve a vacío
    ts = feed_level(eng, ts, 100.0)             # 2.5 s sostenido → registra
    assert len(events) == n_before + 1


def test_modo_desconocido_lanza_valueerror():
    eng, _, _ = make_engine()
    with pytest.raises(ValueError):
        eng.open_session(1, modo="granel")


# ------------------------------------------------------------------- bordes

def test_escalon_parcial_n_cero_se_acumula():
    """delta ≥ min_delta pero n=0 → se ignora SIN avanzar el nivel base,
    así el cerdo que sube en dos tiempos cuenta una sola vez al completar."""
    eng, events, _ = make_engine()
    eng.open_session(1)
    ts = now_ms()
    ts = calibrar(eng, ts, 102.5)
    ts = feed_level(eng, ts, 102.5)   # sube 1 → count 1
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
    ts = calibrar(eng, ts, 102.5)
    ts = feed_level(eng, ts, 102.5)   # sube 1 → count 1

    final = eng.close_session()
    assert final.count == 1
    assert final.total_kg == pytest.approx(102.5)
    assert final.fase == "lote"

    snap = eng.snapshot()
    assert snap.state == EngineState.IDLE
    assert snap.count == 0
    assert snap.ref_kg is None
    assert snap.total_kg == pytest.approx(0.0)
    assert snap.fase == "lote"        # C: close_session resetea la fase

    # sin sesión abierta no se generan eventos
    n_before = len(events)
    ts = feed_level(eng, ts, 309.5)
    assert len(events) == n_before


def test_close_session_resetea_fase_unidades():
    eng, _, _ = make_engine()
    eng.open_session(1, modo="unidades")
    assert eng.snapshot().fase == "unidades"
    final = eng.close_session()
    assert final.fase == "unidades"
    assert eng.snapshot().fase == "lote"   # reset al default del contrato


def test_sin_sesion_no_emite_eventos_pero_trackea_kg():
    eng, events, _ = make_engine()
    ts = now_ms()
    ts = feed_level(eng, ts, 250.0)
    assert events == []
    snap = eng.snapshot()
    assert snap.state == EngineState.IDLE
    assert snap.kg_now == pytest.approx(250.0)
