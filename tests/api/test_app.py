"""Tests de la API FastAPI con FakeEngine inyectado vía engine_factory."""
from __future__ import annotations

import io
import json
import statistics

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from porcipeso.api.app import create_app
from porcipeso.core.models import EventType

from .fake_engine import FakeEngine

SESSION_PAYLOAD = {
    "granja": "La Esperanza",
    "lote": "L-42",
    "corral": "C3",
    "destino": "Planta Norte",
    "placa": "ABC123",
    "conductor": "Juan",
    "operador": "Pedro",
}


@pytest.fixture()
def ctx(tmp_path):
    """App + cliente + acceso al FakeEngine creado por la fábrica."""
    holder: dict[str, FakeEngine] = {}

    def factory(config, on_event, on_state=None):
        engine = FakeEngine(config, on_event, on_state)
        holder["engine"] = engine
        return engine

    app = create_app(tmp_path / "api.db", engine_factory=factory)
    with TestClient(app) as client:
        yield client, holder


def _open_session(client) -> dict:
    resp = client.post("/api/sessions", json=SESSION_PAYLOAD)
    assert resp.status_code == 201
    return resp.json()


def _feed_standard_events(engine: FakeEngine) -> list:
    """4 subidas individuales (100/110/90/120) + ambigua 250 kg + bajada 95."""
    events = []
    w = 0.0
    for i, (kg, tipo) in enumerate([
        (100.0, EventType.REFERENCIA),
        (110.0, EventType.SUBIDA),
        (90.0, EventType.SUBIDA),
        (120.0, EventType.SUBIDA),
    ]):
        events.append(engine.emit(ts_ms=1000 * (i + 1), peso_antes=w,
                                  peso_despues=w + kg, animales_estimados=1,
                                  tipo=tipo))
        w += kg
    events.append(engine.emit(ts_ms=5000, peso_antes=w, peso_despues=w + 250.0,
                              animales_estimados=2, tipo=EventType.SUBIDA,
                              ambiguo=True, opciones=[2, 3]))
    w += 250.0
    events.append(engine.emit(ts_ms=6000, peso_antes=w, peso_despues=w - 95.0,
                              animales_estimados=1, tipo=EventType.BAJADA))
    return events


# --------------------------------------------------------------- ciclo completo

def test_ciclo_completo(ctx):
    client, holder = ctx

    # 1) crear sesión → abre en engine y en DB
    session = _open_session(client)
    sid = session["id"]
    assert session["estado"] == "abierta"
    assert session["corral_origen"] == "C3"
    engine = holder["engine"]
    assert engine.session_id == sid

    # 2) eventos emitidos por el engine → persistidos vía on_event
    _feed_standard_events(engine)
    events = client.get(f"/api/sessions/{sid}/events").json()
    assert len(events) == 6
    assert all(e["sesion_id"] == sid for e in events)
    assert all(e["id"] is not None for e in events)
    amb = next(e for e in events if e["ambiguo"])
    assert amb["opciones"] == [2, 3]
    baja = next(e for e in events if e["tipo"] == "bajada")
    assert baja["delta_kg"] == pytest.approx(-95.0)

    # 3) confirmar el ambiguo → engine.confirm + DB
    resp = client.post(f"/api/events/{amb['id']}/confirm",
                       json={"n": 3, "confirmado_por": "Pedro"})
    assert resp.status_code == 200
    confirmed = resp.json()
    assert confirmed["animales_confirmados"] == 3
    assert confirmed["ambiguo"] is False
    assert confirmed["confirmado_por"] == "Pedro"
    assert engine.confirmed == [(amb["id"], 3)]

    # 4) motivo de la bajada
    resp = client.post(f"/api/events/{baja['id']}/motivo",
                       json={"motivo": "lesion"})
    assert resp.status_code == 200
    assert resp.json()["motivo_bajada"] == "lesion"

    # 5) stats con datos conocidos (dispersión sobre las 4 individuales)
    stats = client.get(f"/api/sessions/{sid}/stats").json()
    singles = [100.0, 110.0, 90.0, 120.0]
    media = statistics.fmean(singles)
    std = statistics.pstdev(singles)
    assert stats["total_kg"] == pytest.approx(575.0)
    assert stats["total_animales"] == 6
    assert stats["promedio"] == pytest.approx(575.0 / 6, abs=1e-3)
    assert stats["desviacion_std"] == pytest.approx(std, abs=1e-3)
    assert stats["cv_pct"] == pytest.approx(std / media * 100, abs=1e-2)
    assert stats["uniformidad_pct"] == pytest.approx(50.0)

    # 6) cerrar con conteo físico → conciliación
    engine.set_snapshot(kg_now=0.0, ref_kg=100.0, avg_kg=575.0 / 6,
                        count=6, total_kg=575.0, pending=0)
    resp = client.post(f"/api/sessions/{sid}/close", json={"conteo_fisico": 7})
    assert resp.status_code == 200
    closed = resp.json()
    assert closed["estado"] == "cerrada"
    assert closed["total_kg"] == pytest.approx(575.0)
    assert closed["total_animales"] == 6
    assert closed["promedio_final"] == pytest.approx(575.0 / 6, abs=1e-3)
    assert closed["conteo_fisico"] == 7
    assert closed["diferencia_conciliacion"] == 1
    assert engine.closed is True

    # 7) cerrar dos veces → 409
    assert client.post(f"/api/sessions/{sid}/close", json={}).status_code == 409

    # 8) export xlsx con las filas
    resp = client.get(f"/api/sessions/{sid}/export.xlsx")
    assert resp.status_code == 200
    assert "spreadsheetml" in resp.headers["content-type"]
    wb = load_workbook(io.BytesIO(resp.content))
    assert wb.sheetnames == ["Resumen", "Eventos"]
    resumen = {row[0]: row[1] for row in wb["Resumen"].iter_rows(values_only=True)
               if row and row[0]}
    assert resumen["Lote"] == "L-42"
    assert resumen["Total animales"] == 6
    assert resumen["Conteo físico"] == 7
    assert resumen["Diferencia conciliación"] == 1
    assert resumen["Estado"] == "cerrada"
    rows = list(wb["Eventos"].iter_rows(values_only=True))
    assert len(rows) == 1 + 6  # header + eventos
    header = list(rows[0])
    idx_delta = header.index("delta_kg")
    idx_tipo = header.index("tipo")
    assert rows[1][idx_delta] == pytest.approx(100.0)
    assert rows[1][idx_tipo] == "referencia"
    assert rows[6][idx_delta] == pytest.approx(-95.0)


# ------------------------------------------------------------------- sesiones

def test_listar_y_obtener_sesiones(ctx):
    client, _ = ctx
    assert client.get("/api/sessions").json() == []
    session = _open_session(client)
    listado = client.get("/api/sessions").json()
    assert [s["id"] for s in listado] == [session["id"]]
    assert client.get(f"/api/sessions/{session['id']}").json()["lote"] == "L-42"


def test_404s(ctx):
    client, _ = ctx
    assert client.get("/api/sessions/999").status_code == 404
    assert client.get("/api/sessions/999/events").status_code == 404
    assert client.get("/api/sessions/999/stats").status_code == 404
    assert client.get("/api/sessions/999/export.xlsx").status_code == 404
    assert client.post("/api/sessions/999/close", json={}).status_code == 404
    assert client.post("/api/events/999/confirm", json={"n": 2}).status_code == 404
    assert client.post("/api/events/999/motivo",
                       json={"motivo": "estres"}).status_code == 404


# --------------------------------------------------------------------- báscula

def test_scale_status_desconectada(ctx):
    client, _ = ctx
    status = client.get("/api/scale/status").json()
    assert status["connected"] is False
    assert status["profile_id"] is None
    assert status["last_kg"] is None
    assert status["state"] == "idle"


# ------------------------------------------------------------------ websocket

def test_ws_recibe_evento_y_snapshot(ctx):
    client, holder = ctx
    session = _open_session(client)
    engine = holder["engine"]
    with client.websocket_connect("/ws") as ws:
        engine.set_snapshot(kg_now=102.5, ref_kg=102.5, avg_kg=102.5,
                            count=1, total_kg=102.5, pending=0)
        engine.emit(ts_ms=1000, peso_antes=0.0, peso_despues=102.5,
                    animales_estimados=1, tipo=EventType.REFERENCIA)
        event_msg = json.loads(ws.receive_text())
        assert event_msg["type"] == "event"
        assert event_msg["sesion_id"] == session["id"]
        assert event_msg["delta_kg"] == pytest.approx(102.5)
        assert event_msg["tipo"] == "referencia"
        snap_msg = json.loads(ws.receive_text())
        assert snap_msg["type"] == "snapshot"
        assert snap_msg["count"] == 1
        assert snap_msg["total_kg"] == pytest.approx(102.5)
        assert snap_msg["state"] == "estable"
        assert snap_msg["pending"] == 0
