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


def test_devueltos_manual_endpoint(ctx):
    """POST /api/session/returned descuenta n×promedio del conteo/total y
    persiste un evento AJUSTE; 409 sin sesión o sin cerdos que descontar."""
    client, holder = ctx
    # sin sesión activa → 409
    assert client.post("/api/session/returned", json={"n": 1}).status_code == 409
    session = _open_session(client)
    sid = session["id"]
    engine = holder["engine"]
    # simula 3 cerdos a 100 kg de promedio
    engine.set_snapshot(count=3, total_kg=300.0, avg_kg=100.0)
    # n<1 → 400
    assert client.post("/api/session/returned", json={"n": 0}).status_code == 400
    # registra 1 devuelto
    r = client.post("/api/session/returned", json={"n": 1})
    assert r.status_code == 200
    body = r.json()
    assert body["descontados"] == 1
    assert body["count"] == 2
    assert body["total_kg"] == pytest.approx(200.0)
    # quedó un evento AJUSTE persistido con el motivo
    evs = client.get(f"/api/sessions/{sid}/events").json()
    aj = [e for e in evs if e["tipo"] == "ajuste"]
    assert len(aj) == 1 and aj[0]["motivo_bajada"] == "devuelto_manual"


# --------------------------------------------------------------- ciclo completo

def test_ciclo_completo(ctx):
    client, holder = ctx

    # 1) crear sesión → abre en engine y en DB
    session = _open_session(client)
    sid = session["id"]
    assert session["estado"] == "abierta"
    assert session["corral_origen"] == "C3"
    assert session["modo"] == "lote"          # default v2
    engine = holder["engine"]
    assert engine.session_id == sid
    assert engine.modo == "lote"

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

    # 5) stats con datos conocidos (dispersión MUESTRAL sobre las 4
    #    individuales: n-1)
    stats = client.get(f"/api/sessions/{sid}/stats").json()
    singles = [100.0, 110.0, 90.0, 120.0]
    media = statistics.fmean(singles)
    std = statistics.stdev(singles)                 # muestral (n-1)
    # v2: la REFERENCIA (100 kg) es el cerdo de prueba que se bajó: no
    # suma a los totales pero sí a la muestra individual.
    assert stats["total_kg"] == pytest.approx(475.0)
    assert stats["total_animales"] == 5
    assert stats["promedio"] == pytest.approx(475.0 / 5, abs=1e-3)
    assert stats["n_muestras"] == 4
    assert stats["mediana"] == pytest.approx(statistics.median(singles))
    assert stats["desviacion_std"] == pytest.approx(std, abs=1e-3)
    assert stats["varianza"] == pytest.approx(statistics.variance(singles),
                                              abs=1e-3)
    assert stats["cv_pct"] == pytest.approx(std / media * 100, abs=1e-2)
    assert stats["uniformidad_pct"] == pytest.approx(50.0)
    assert stats["modo"] == "lote"
    assert stats["tipo_muestra"] == "estimada"

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
    assert resumen["Modo"] == "lote"
    assert resumen["Total animales"] == 6
    assert resumen["Conteo físico"] == 7
    assert resumen["Diferencia conciliación"] == 1
    assert resumen["Estado"] == "cerrada"
    # métricas v2 en la hoja Resumen
    assert resumen["N muestras"] == 4
    assert resumen["Tipo de muestra"] == "estimada"
    assert resumen["Mediana (kg)"] == pytest.approx(105.0)
    assert resumen["Varianza muestral (kg²)"] == pytest.approx(
        statistics.variance([100.0, 110.0, 90.0, 120.0]), abs=1e-3)
    assert resumen["Desviación estándar muestral (kg)"] == pytest.approx(
        statistics.stdev([100.0, 110.0, 90.0, 120.0]), abs=1e-3)
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


def test_crear_sesion_modo_unidades(ctx):
    client, holder = ctx
    resp = client.post("/api/sessions",
                       json={**SESSION_PAYLOAD, "modo": "unidades"})
    assert resp.status_code == 201
    session = resp.json()
    assert session["modo"] == "unidades"
    engine = holder["engine"]
    assert engine.modo == "unidades"
    # el modo persiste y viaja en list/get
    sid = session["id"]
    assert client.get(f"/api/sessions/{sid}").json()["modo"] == "unidades"
    listado = client.get("/api/sessions").json()
    assert [s["modo"] for s in listado if s["id"] == sid] == ["unidades"]
    stats = client.get(f"/api/sessions/{sid}/stats").json()
    assert stats["modo"] == "unidades"
    assert stats["tipo_muestra"] == "completa"


def test_crear_sesion_modo_invalido_400(ctx):
    client, _ = ctx
    resp = client.post("/api/sessions",
                       json={**SESSION_PAYLOAD, "modo": "turbo"})
    assert resp.status_code == 400
    assert "modo" in resp.json()["detail"]
    assert client.get("/api/sessions").json() == []  # sin fila huérfana


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
        # v2: la fase SIEMPRE viaja en los snapshot del WS
        assert snap_msg["fase"] == "calibracion"


def test_ws_snapshot_cierre_incluye_fase(ctx):
    """El broadcast sintético al cerrar también lleva 'fase'."""
    client, holder = ctx
    session = _open_session(client)
    engine = holder["engine"]
    engine.set_snapshot(kg_now=0.0, avg_kg=100.0, count=1, total_kg=100.0)
    with client.websocket_connect("/ws") as ws:
        resp = client.post(f"/api/sessions/{session['id']}/close", json={})
        assert resp.status_code == 200
        snap_msg = json.loads(ws.receive_text())
        assert snap_msg["type"] == "snapshot"
        assert snap_msg["state"] == "idle"
        assert snap_msg["fase"] == "lote"
