"""Sesiones DEMO (báscula simulada): migración es_demo, marcado al crear
con la simulada conectada, exclusión de stats_global y AUTODESTRUCCIÓN
(60 min tras el cierre; jamás toca reales ni abiertas).
"""
from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from porcipeso.api.app import create_app
from porcipeso.db.repo import Repo, init_db

from .fake_engine import FakeEngine


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _hace_minutos(mins: float) -> str:
    return _iso(datetime.now(timezone.utc) - timedelta(minutes=mins))


@pytest.fixture()
def ctx(tmp_path):
    app = create_app(
        tmp_path / "api.db",
        engine_factory=lambda cfg, on_event, on_state=None: FakeEngine(
            cfg, on_event, on_state
        ),
    )
    with TestClient(app) as client:
        yield client, tmp_path / "api.db"


# ---------------------------------------------------------------- migración

def test_init_db_migra_columna_es_demo_en_db_vieja(tmp_path):
    """DB pre-v3 (sesiones sin 'es_demo'): init_db la agrega con ALTER
    TABLE y las filas existentes quedan como reales (es_demo=0)."""
    db = tmp_path / "vieja.db"
    conn = sqlite3.connect(db)
    try:
        conn.execute(
            """CREATE TABLE sesiones (
                   id INTEGER PRIMARY KEY, uuid TEXT UNIQUE, lote TEXT,
                   hora_entrada TEXT,
                   estado TEXT NOT NULL DEFAULT 'abierta'
                       CHECK (estado IN ('abierta', 'cerrada', 'anulada'))
               )"""
        )
        conn.execute(
            "INSERT INTO sesiones (uuid, lote, estado) VALUES ('u1', 'L-1', 'abierta')"
        )
        conn.commit()
    finally:
        conn.close()

    init_db(db)

    conn = sqlite3.connect(db)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(sesiones)")}
        assert "es_demo" in cols
        (es_demo,) = conn.execute(
            "SELECT es_demo FROM sesiones WHERE uuid = 'u1'"
        ).fetchone()
    finally:
        conn.close()
    assert es_demo == 0

    init_db(db)  # idempotente: el ALTER no se repite ni falla


def test_db_nueva_trae_es_demo_default_0(tmp_path):
    repo = Repo(tmp_path / "n.db")
    sid = repo.create_session({"lote": "L-real"})
    session = repo.get_session(sid)
    repo.close()
    assert session is not None and session["es_demo"] == 0


# ---------------------------------------------------- marcado por perfil sim

def test_sesion_con_simulada_conectada_nace_es_demo(ctx):
    client, _ = ctx
    assert client.post("/api/sim/start").status_code == 200
    r = client.post("/api/sessions", json={"lote": "L-práctica"})
    assert r.status_code == 201
    assert r.json()["es_demo"] == 1
    sid = r.json()["id"]
    closed = client.post(f"/api/sessions/{sid}/close", json={}).json()
    assert closed["es_demo"] == 1
    client.post("/api/sim/stop")


def test_sesion_sin_simulada_nace_real(ctx):
    client, _ = ctx
    r = client.post("/api/sessions", json={"lote": "L-real"})
    assert r.status_code == 201
    assert r.json()["es_demo"] == 0


def test_ui_no_puede_forzar_es_demo(ctx):
    """El flag lo decide el backend por el perfil conectado; un body
    malicioso/ingenuo con es_demo=1 no marca la sesión."""
    client, _ = ctx
    r = client.post("/api/sessions", json={"lote": "L-x", "es_demo": 1})
    assert r.status_code == 201
    assert r.json()["es_demo"] == 0


# ----------------------------------------------------------- stats excluyen

def test_stats_global_excluye_demo_pero_lista_las_muestra(ctx):
    client, db_path = ctx
    # una real cerrada
    real = client.post("/api/sessions", json={"lote": "L-real"}).json()["id"]
    client.post(f"/api/sessions/{real}/close", json={})
    # una demo cerrada (con la simulada conectada)
    client.post("/api/sim/start")
    demo = client.post("/api/sessions", json={"lote": "L-demo"}).json()["id"]
    client.post(f"/api/sessions/{demo}/close", json={})
    client.post("/api/sim/stop")
    # darle totales a ambas para que un error de filtro se note en los kg
    seed = Repo(db_path)
    seed._conn.execute(
        "UPDATE sesiones SET total_kg = 500.0, total_animales = 5, "
        "promedio_final = 100.0 WHERE id IN (?, ?)", (real, demo))
    seed._conn.commit()
    seed.close()

    g = client.get("/api/stats/global").json()
    assert g["sesiones"] == 1              # la demo NO cuenta
    assert g["total_animales"] == 5
    assert g["total_kg"] == pytest.approx(500.0)
    assert {r["lote"] for r in g["por_lote"]} == {"L-real"}

    # …pero la lista SÍ la muestra, con su flag para el chip DEMO
    sesiones = {s["id"]: s for s in client.get("/api/sessions").json()}
    assert sesiones[demo]["es_demo"] == 1
    assert sesiones[real]["es_demo"] == 0


# ------------------------------------------------------------ autodestrucción

def _mk_demo(repo: Repo, lote: str, *, estado: str, cerrada_hace: float | None) -> int:
    sid = repo.create_session({"lote": lote, "es_demo": 1})
    if estado != "abierta":
        repo.close_session(sid, {"total_kg": 100.0, "count": 1, "avg_kg": 100.0})
        if cerrada_hace is not None:
            repo._conn.execute(
                "UPDATE sesiones SET hora_salida = ? WHERE id = ?",
                (_hace_minutos(cerrada_hace), sid))
            repo._conn.commit()
    return sid


def test_cleanup_demo_borra_solo_demo_cerradas_viejas(tmp_path):
    repo = Repo(tmp_path / "d.db")
    vieja = _mk_demo(repo, "D-vieja", estado="cerrada", cerrada_hace=61)
    reciente = _mk_demo(repo, "D-reciente", estado="cerrada", cerrada_hace=30)
    abierta = repo.create_session({"lote": "D-abierta", "es_demo": 1})
    # real cerrada hace mucho: JAMÁS se toca
    real = repo.create_session({"lote": "R-vieja"})
    repo.close_session(real, {"total_kg": 200.0, "count": 2, "avg_kg": 100.0})
    repo._conn.execute(
        "UPDATE sesiones SET hora_salida = ? WHERE id = ?",
        (_hace_minutos(600), real))
    repo._conn.commit()
    # eventos y lecturas de la demo vieja también deben irse
    from porcipeso.core.models import EventType, WeighEvent
    repo.insert_event(WeighEvent(
        id=None, session_id=vieja, ts_ms=1000, peso_antes=0.0,
        peso_despues=100.0, delta_kg=100.0, animales_estimados=1,
        tipo=EventType.SUBIDA))
    repo.insert_reading(vieja, 1000, 100.0)

    assert repo.cleanup_demo_sessions() == 1

    assert repo.get_session(vieja) is None
    assert repo.list_events(vieja) == []
    assert repo.count_readings(vieja) == 0
    assert repo.get_session(reciente) is not None   # aún no cumple 60 min
    assert repo.get_session(abierta) is not None    # abierta: intocable
    assert repo.get_session(real) is not None       # real: intocable
    # segunda pasada: nada que borrar
    assert repo.cleanup_demo_sessions() == 0
    repo.close()


def test_cleanup_demo_respeta_umbral_exacto(tmp_path):
    repo = Repo(tmp_path / "u.db")
    justo = _mk_demo(repo, "D-59", estado="cerrada", cerrada_hace=59)
    pasada = _mk_demo(repo, "D-61", estado="cerrada", cerrada_hace=61)
    assert repo.cleanup_demo_sessions(max_age_minutes=60) == 1
    assert repo.get_session(justo) is not None
    assert repo.get_session(pasada) is None
    repo.close()


def test_reaper_corre_al_abrir_la_app(tmp_path):
    """Al arrancar la API (lifespan) se barren las demo vencidas sin
    tocar las reales — 'al abrir la app y cada hora'."""
    db = tmp_path / "boot.db"
    seed = Repo(db)
    vencida = _mk_demo(seed, "D-vencida", estado="cerrada", cerrada_hace=120)
    real = seed.create_session({"lote": "R-1"})
    seed.close_session(real, {"total_kg": 100.0, "count": 1, "avg_kg": 100.0})
    seed.close()

    app = create_app(
        db,
        engine_factory=lambda cfg, on_event, on_state=None: FakeEngine(
            cfg, on_event, on_state
        ),
    )
    with TestClient(app) as client:
        # el barrido corre en una tarea async: dar un momento
        for _ in range(50):
            if client.get(f"/api/sessions/{vencida}").status_code == 404:
                break
            time.sleep(0.1)
        assert client.get(f"/api/sessions/{vencida}").status_code == 404
        assert client.get(f"/api/sessions/{real}").status_code == 200


# ------------------------------------------------- sync a la nube (exclusión)

def test_sync_jamas_sube_sesiones_demo(tmp_path):
    """Las sesiones DEMO NUNCA entran al push del sync worker: se
    autodestruyen localmente en 1 h y el cloud no debe quedarse con
    datos de práctica disfrazados de reales (el payload ni lleva la
    marca es_demo)."""
    from porcipeso.api.syncworker import SyncWorker

    repo = Repo(tmp_path / "sync.db")
    real = repo.create_session({"lote": "R-real"})
    repo.close_session(real, {"total_kg": 100.0, "count": 1, "avg_kg": 100.0})
    demo = repo.create_session({"lote": "D-practica", "es_demo": 1})
    repo.close_session(demo, {"total_kg": 99.0, "count": 1, "avg_kg": 99.0})
    demo_abierta = repo.create_session({"lote": "D-abierta", "es_demo": 1})

    worker = SyncWorker(repo)
    try:
        # primer push (sin marcador): solo la real
        sin_marcador = {s["id"] for s in worker._pending_sessions(None)}
        assert sin_marcador == {real}
        # pushes siguientes (marcador viejo): la demo cerrada Y la demo
        # abierta (que antes subía SIEMPRE) quedan fuera
        con_marcador = {
            s["id"]
            for s in worker._pending_sessions("2000-01-01T00:00:00+00:00")
        }
        assert con_marcador == {real}
        assert demo not in con_marcador and demo_abierta not in con_marcador
    finally:
        worker.stop()
        repo.close()


# ------------------------------------------------- informes con marca DEMO

def _mk_demo_cerrada(repo: Repo) -> int:
    sid = repo.create_session({"lote": "L-practica", "es_demo": 1})
    repo.close_session(sid, {"total_kg": 300.0, "count": 3, "avg_kg": 100.0})
    return sid


def test_pdf_de_sesion_demo_lo_dice(ctx):
    """El PDF de una sesión DEMO lleva chip 'DEMO ·' en la banda y el
    callout de práctica — jamás circula como pesaje real."""
    pytest.importorskip("reportlab")
    client, db = ctx
    repo = Repo(db)
    demo = _mk_demo_cerrada(repo)
    real = repo.create_session({"lote": "L-real"})
    repo.close_session(real, {"total_kg": 100.0, "count": 1, "avg_kg": 100.0})
    repo.close()

    r = client.get(f"/api/sessions/{demo}/report.pdf")
    assert r.status_code == 200
    # pageCompression=0 ⇒ los streams del PDF son legibles como texto
    texto = r.content.decode("latin-1")
    assert "DEMO" in texto
    assert "PESAJE DE PR" in texto  # "PESAJE DE PRÁCTICA (DEMO)"

    r2 = client.get(f"/api/sessions/{real}/report.pdf")
    assert r2.status_code == 200
    assert "PESAJE DE PR" not in r2.content.decode("latin-1")


def test_xlsx_de_sesion_demo_lo_dice(ctx):
    """El .xlsx de una sesión DEMO lleva el aviso de práctica en la hoja
    Resumen; el de una real no."""
    pytest.importorskip("openpyxl")
    import io

    from openpyxl import load_workbook

    client, db = ctx
    repo = Repo(db)
    demo = _mk_demo_cerrada(repo)
    real = repo.create_session({"lote": "L-real-x"})
    repo.close_session(real, {"total_kg": 100.0, "count": 1, "avg_kg": 100.0})
    repo.close()

    def _resumen_texto(session_id: int) -> str:
        r = client.get(f"/api/sessions/{session_id}/export.xlsx")
        assert r.status_code == 200
        wb = load_workbook(io.BytesIO(r.content))
        ws = wb["Resumen"]
        return "\n".join(
            str(c.value) for row in ws.iter_rows() for c in row if c.value
        )

    assert "PESAJE DE PRÁCTICA (DEMO)" in _resumen_texto(demo)
    assert "PESAJE DE PRÁCTICA (DEMO)" not in _resumen_texto(real)
