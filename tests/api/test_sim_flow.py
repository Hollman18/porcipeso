"""Flujo COMPLETO del simulador interactivo con el motor REAL.

Sin FakeEngine: sim/start alimenta al WeighingEngine de verdad y la data
(eventos + lecturas crudas + cierre) queda en SQLite.
"""
from __future__ import annotations

import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from porcipeso.api.app import create_app

SESSION_PAYLOAD = {"lote": "L-SIM", "corral": "C1", "destino": "Planta",
                   "placa": "SIM123", "conductor": "Juan", "operador": "Pedro"}


@pytest.fixture()
def ctx(tmp_path):
    db_path = tmp_path / "sim.db"
    app = create_app(db_path)  # motor real (default engine_factory)
    with TestClient(app) as client:
        yield client, db_path


def wait_for(fn, timeout=25.0, interval=0.1, msg="condición"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError(f"timeout ({timeout}s) esperando {msg}")


def test_sim_action_sin_start_da_409(ctx):
    client, _ = ctx
    resp = client.post("/api/sim/action", json={"action": "pigs_on", "n": 1})
    assert resp.status_code == 409
    assert "sim/start" in resp.json()["detail"]


def test_flujo_sim_completo_engine_real(ctx):
    client, db_path = ctx

    # --- start: báscula simulada conectada, status vivo -------------------
    resp = client.post("/api/sim/start")
    assert resp.status_code == 200
    body = resp.json()
    assert body["connected"] is True
    assert body["profile_id"] == "simulador"
    assert body["pigs_fisicos"] == 0

    def _status_vivo():
        s = client.get("/api/scale/status").json()
        return s if (s["connected"] and s["last_kg"] is not None) else None

    status = wait_for(_status_vivo, msg="scale/status con last_kg vivo")
    assert status["profile_id"] == "simulador"

    # --- sesión: baseline estable en ~0 antes del primer cerdo ------------
    resp = client.post("/api/sessions", json=SESSION_PAYLOAD)
    assert resp.status_code == 201
    sid = resp.json()["id"]

    wait_for(
        lambda: client.get("/api/scale/status").json()["state"] == "estable",
        msg="báscula estable en vacío",
    )

    def _events():
        return client.get(f"/api/sessions/{sid}/events").json()

    # --- pigs_on 1 (102.5) → evento REFERENCIA ----------------------------
    resp = client.post("/api/sim/action",
                       json={"action": "pigs_on", "n": 1, "kg_each": 102.5})
    assert resp.status_code == 200
    assert resp.json()["pigs_fisicos"] == 1
    assert resp.json()["kg_target"] == pytest.approx(102.5)

    events = wait_for(lambda: e if len(e := _events()) >= 1 else None,
                      msg="evento referencia")
    ref = events[0]
    assert ref["tipo"] == "referencia"
    assert ref["delta_kg"] == pytest.approx(102.5, abs=2.5)
    assert ref["animales_estimados"] == 1

    # --- pigs_on 2 (100 c/u) → SUBIDA de 2 sin ambigüedad ------------------
    resp = client.post("/api/sim/action",
                       json={"action": "pigs_on", "n": 2, "kg_each": 100.0})
    assert resp.json()["pigs_fisicos"] == 3
    assert resp.json()["kg_target"] == pytest.approx(302.5)

    events = wait_for(lambda: e if len(e := _events()) >= 2 else None,
                      msg="evento subida x2")
    subida = events[1]
    assert subida["tipo"] == "subida"
    assert subida["animales_estimados"] == 2
    assert subida["delta_kg"] == pytest.approx(200.0, abs=4.0)
    assert subida["ambiguo"] is False

    # --- pig_off → BAJADA de 1 (se devuelve el de 100) ---------------------
    resp = client.post("/api/sim/action", json={"action": "pig_off"})
    assert resp.json()["pigs_fisicos"] == 2
    assert resp.json()["kg_target"] == pytest.approx(202.5)

    events = wait_for(lambda: e if len(e := _events()) >= 3 else None,
                      msg="evento bajada")
    bajada = events[2]
    assert bajada["tipo"] == "bajada"
    assert bajada["delta_kg"] == pytest.approx(-100.0, abs=4.0)
    assert bajada["animales_estimados"] == 1

    # --- lecturas crudas de verdad en SQLite -------------------------------
    conn = sqlite3.connect(db_path)
    try:
        (n_lecturas,) = conn.execute(
            "SELECT COUNT(*) FROM lecturas_crudas WHERE sesion_id = ?", (sid,)
        ).fetchone()
    finally:
        conn.close()
    assert n_lecturas > 20  # 10 Hz durante varios segundos

    # --- close con conteo físico → conciliación desde el ENGINE real ------
    resp = client.post(f"/api/sessions/{sid}/close", json={"conteo_fisico": 2})
    assert resp.status_code == 200
    closed = resp.json()
    assert closed["estado"] == "cerrada"
    assert closed["total_animales"] == 2          # 1 + 2 - 1
    assert closed["total_kg"] == pytest.approx(202.5, abs=6.0)
    assert closed["promedio_final"] == pytest.approx(101.25, abs=3.0)
    assert closed["conteo_fisico"] == 2
    assert closed["diferencia_conciliacion"] == 0

    stats = client.get(f"/api/sessions/{sid}/stats").json()
    assert stats["total_animales"] == 2
    assert stats["total_kg"] == pytest.approx(202.5, abs=6.0)

    # --- nervous / silence responden estado físico (smoke) -----------------
    resp = client.post("/api/sim/action",
                       json={"action": "nervous", "seconds": 0.3})
    assert resp.status_code == 200
    assert resp.json()["pigs_fisicos"] == 2
    resp = client.post("/api/sim/action",
                       json={"action": "silence", "seconds": 0.2})
    assert resp.status_code == 200

    # --- stop ---------------------------------------------------------------
    resp = client.post("/api/sim/stop")
    assert resp.json() == {"connected": False, "stopped": True}
    status = client.get("/api/scale/status").json()
    assert status["connected"] is False
    assert client.post("/api/sim/action",
                       json={"action": "pig_off"}).status_code == 409
