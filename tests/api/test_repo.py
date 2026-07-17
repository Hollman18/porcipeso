"""Tests del repositorio SQLite (sin API)."""
from __future__ import annotations

import statistics

import pytest

from porcipeso.core.models import EventType, WeighEvent
from porcipeso.db.repo import Repo


@pytest.fixture()
def repo(tmp_path):
    r = Repo(tmp_path / "p.db")
    yield r
    r.close()


def _event(session_id, ts_ms, antes, despues, n, tipo,
           ambiguo=False, opciones=None) -> WeighEvent:
    return WeighEvent(
        id=None, session_id=session_id, ts_ms=ts_ms,
        peso_antes=antes, peso_despues=despues,
        delta_kg=round(despues - antes, 3),
        animales_estimados=n, tipo=tipo,
        ambiguo=ambiguo, opciones=opciones or [], estab_ms=700,
    )


# ------------------------------------------------------------------ sesiones

def test_create_get_list_session(repo):
    sid = repo.create_session({
        "granja": "La Esperanza", "lote": "L-42", "corral_origen": "C3",
        "destino": "Planta Norte", "placa": "ABC123",
        "conductor": "Juan", "operador": "Pedro",
    })
    s = repo.get_session(sid)
    assert s is not None
    assert s["lote"] == "L-42"
    assert s["corral_origen"] == "C3"
    assert s["estado"] == "abierta"
    assert s["modo"] == "lote"                  # default v2
    assert s["uuid"]
    assert s["hora_entrada"]
    assert repo.get_session(9999) is None
    assert [x["id"] for x in repo.list_sessions()] == [sid]


def test_create_session_modo_unidades_persiste(repo):
    sid = repo.create_session({"lote": "L-U", "modo": "unidades"})
    assert repo.get_session(sid)["modo"] == "unidades"
    assert repo.list_sessions()[0]["modo"] == "unidades"
    assert repo.stats(sid)["modo"] == "unidades"
    assert repo.stats(sid)["tipo_muestra"] == "completa"


def test_close_session_con_conciliacion(repo):
    sid = repo.create_session({"lote": "L-1"})
    closed = repo.close_session(
        sid,
        {"total_kg": 575.0, "count": 6, "avg_kg": 95.83},
        conteo_fisico=7,
    )
    assert closed["estado"] == "cerrada"
    assert closed["total_kg"] == 575.0
    assert closed["total_animales"] == 6
    assert closed["promedio_final"] == 95.83
    assert closed["conteo_fisico"] == 7
    assert closed["diferencia_conciliacion"] == 1
    assert closed["hora_salida"]


def test_close_session_sin_conteo_fisico(repo):
    sid = repo.create_session({"lote": "L-1"})
    closed = repo.close_session(sid, {"total_kg": 100.0, "count": 1, "avg_kg": 100.0})
    assert closed["conteo_fisico"] is None
    assert closed["diferencia_conciliacion"] is None


def test_close_session_solo_una_vez(repo):
    sid = repo.create_session({"lote": "L-1"})
    repo.close_session(sid, {"total_kg": 10.0, "count": 1, "avg_kg": 10.0})
    again = repo.close_session(sid, {"total_kg": 999.0, "count": 9, "avg_kg": 111.0})
    assert again["total_kg"] == 10.0  # append-only: el cierre no se pisa


# ------------------------------------------------------------------- eventos

def test_insert_list_confirm_motivo(repo):
    sid = repo.create_session({"lote": "L-1"})
    e1 = repo.insert_event(_event(sid, 1000, 0.0, 102.5, 1, EventType.REFERENCIA))
    e2 = repo.insert_event(_event(sid, 2000, 102.5, 352.5, 2, EventType.SUBIDA,
                                  ambiguo=True, opciones=[2, 3]))
    e3 = repo.insert_event(_event(sid, 3000, 352.5, 251.3, 1, EventType.BAJADA))

    events = repo.list_events(sid)
    assert [e["id"] for e in events] == [e1, e2, e3]
    amb = events[1]
    assert amb["ambiguo"] is True
    assert amb["opciones"] == [2, 3]
    assert amb["animales_confirmados"] is None

    repo.update_event_confirm(e2, 3, "operador1")
    amb = repo.get_event(e2)
    assert amb["animales_confirmados"] == 3
    assert amb["ambiguo"] is False
    assert amb["confirmado_por"] == "operador1"

    repo.set_event_motivo(e3, "lesion")
    assert repo.get_event(e3)["motivo_bajada"] == "lesion"


# ------------------------------------------------------------------ lecturas

def test_insert_reading_respetando_flag(tmp_path):
    on = Repo(tmp_path / "on.db", store_readings=True)
    off = Repo(tmp_path / "off.db", store_readings=False)
    sid_on = on.create_session({"lote": "L"})
    sid_off = off.create_session({"lote": "L"})
    for i in range(5):
        on.insert_reading(sid_on, 1000 + i, 100.0 + i)
        off.insert_reading(sid_off, 1000 + i, 100.0 + i)
    assert on.count_readings(sid_on) == 5
    assert off.count_readings(sid_off) == 0
    on.close()
    off.close()


def test_retencion_lecturas_crudas(tmp_path):
    """Tope de lecturas: borra las más viejas de sesiones CERRADAS;
    la sesión abierta nunca pierde lecturas."""
    repo = Repo(tmp_path / "ret.db", max_raw_readings=50, prune_check_every=10)
    cerrada = repo.create_session({"lote": "vieja"})
    for i in range(40):
        repo.insert_reading(cerrada, 1000 + i, 100.0)
    repo.close_session(cerrada, {"total_kg": 100.0, "count": 1, "avg_kg": 100.0})

    abierta = repo.create_session({"lote": "en-curso"})
    for i in range(30):
        repo.insert_reading(abierta, 50_000 + i, 200.0)

    repo.prune_readings()  # forzar el chequeo final
    n_abierta = repo.count_readings(abierta)
    n_cerrada = repo.count_readings(cerrada)
    assert n_abierta == 30                      # intocable (sesión abierta)
    assert n_cerrada + n_abierta <= 50          # tope respetado
    assert n_cerrada == 20                      # se fueron las 20 más viejas
    repo.close()


def test_prune_no_borra_si_todo_es_sesion_abierta(tmp_path):
    repo = Repo(tmp_path / "ret2.db", max_raw_readings=10, prune_check_every=1000)
    abierta = repo.create_session({"lote": "L"})
    for i in range(20):
        repo.insert_reading(abierta, 1000 + i, 100.0)
    assert repo.prune_readings() == 0
    assert repo.count_readings(abierta) == 20
    repo.close()


# --------------------------------------------------------------------- stats

def test_stats_con_datos_conocidos(repo):
    """Subidas de 1 animal: 100, 110, 90, 120 · ambigua confirmada en 3 (250 kg)
    · bajada de 95. Dispersión MUESTRAL (n-1) SOLO sobre las cuatro
    individuales."""
    sid = repo.create_session({"lote": "L-1"})
    w = 0.0
    singles = [100.0, 110.0, 90.0, 120.0]
    tipos = [EventType.REFERENCIA, EventType.SUBIDA,
             EventType.SUBIDA, EventType.SUBIDA]
    for i, (kg, tipo) in enumerate(zip(singles, tipos)):
        repo.insert_event(_event(sid, 1000 * (i + 1), w, w + kg, 1, tipo))
        w += kg
    amb_id = repo.insert_event(_event(sid, 5000, w, w + 250.0, 2,
                                      EventType.SUBIDA, ambiguo=True,
                                      opciones=[2, 3]))
    w += 250.0
    repo.insert_event(_event(sid, 6000, w, w - 95.0, 1, EventType.BAJADA))
    repo.update_event_confirm(amb_id, 3, "op")

    stats = repo.stats(sid)
    # v2: la REFERENCIA (100 kg, cerdo de prueba que se bajó) NO integra
    # los totales, pero sí la muestra individual.
    assert stats["total_kg"] == pytest.approx(110 + 90 + 120 + 250 - 95)
    assert stats["total_animales"] == 1 + 1 + 1 + 3 - 1  # == 5
    assert stats["promedio"] == pytest.approx(475.0 / 5, abs=1e-3)
    assert stats["n_muestras"] == 4
    assert stats["n_muestras_individuales"] == 4    # alias legado
    assert stats["min_delta"] == 90.0
    assert stats["max_delta"] == 120.0
    assert stats["mediana"] == pytest.approx(105.0)  # (100+110)/2

    media = statistics.fmean(singles)                       # 105.0
    std = statistics.stdev(singles)                         # muestral ~12.9099
    assert stats["desviacion_std"] == pytest.approx(std, abs=1e-3)
    assert stats["varianza"] == pytest.approx(statistics.variance(singles),
                                              abs=1e-3)
    assert stats["varianza"] == pytest.approx(std ** 2, abs=1e-2)
    assert stats["cv_pct"] == pytest.approx(std / media * 100, abs=1e-2)
    # banda ±10%: [94.5, 115.5] → dentro: 100 y 110 → 50%
    assert stats["uniformidad_pct"] == pytest.approx(50.0)
    assert stats["modo"] == "lote"
    assert stats["tipo_muestra"] == "estimada"


def test_stats_sesion_vacia(repo):
    sid = repo.create_session({"lote": "L-1"})
    stats = repo.stats(sid)
    assert stats["total_kg"] == 0.0
    assert stats["total_animales"] == 0
    assert stats["promedio"] is None
    assert stats["n_muestras"] == 0
    assert stats["mediana"] is None
    assert stats["desviacion_std"] == 0.0    # n < 2 → 0 por contrato
    assert stats["varianza"] == 0.0
    assert stats["cv_pct"] is None
    assert stats["uniformidad_pct"] is None


def test_stats_una_sola_muestra_sin_dispersion(repo):
    """Con n=1 la desviación/varianza muestral no existe (n-1=0): 0.
    Además la REFERENCIA v2 no suma a los totales (el de prueba se bajó)."""
    sid = repo.create_session({"lote": "L-1"})
    repo.insert_event(_event(sid, 1000, 0.0, 102.5, 1, EventType.REFERENCIA))
    stats = repo.stats(sid)
    assert stats["total_animales"] == 0
    assert stats["total_kg"] == 0.0
    assert stats["n_muestras"] == 1
    assert stats["desviacion_std"] == 0.0
    assert stats["varianza"] == 0.0
    assert stats["mediana"] == pytest.approx(102.5)
    assert stats["cv_pct"] == pytest.approx(0.0)
    assert stats["uniformidad_pct"] == pytest.approx(100.0)
