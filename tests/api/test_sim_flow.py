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

    # --- sesión (modo lote default): baseline estable en ~0 ---------------
    resp = client.post("/api/sessions", json=SESSION_PAYLOAD)
    assert resp.status_code == 201
    session = resp.json()
    sid = session["id"]
    assert session["modo"] == "lote"

    wait_for(
        lambda: client.get("/api/scale/status").json()["state"] == "estable",
        msg="báscula estable en vacío",
    )

    def _events():
        return client.get(f"/api/sessions/{sid}/events").json()

    # --- pigs_on 1 (102.5): sube el cerdo de PRUEBA — aún SIN evento -------
    resp = client.post("/api/sim/action",
                       json={"action": "pigs_on", "n": 1, "kg_each": 102.5})
    assert resp.status_code == 200
    assert resp.json()["pigs_fisicos"] == 1
    assert resp.json()["kg_target"] == pytest.approx(102.5)

    def _estable_con_prueba():
        s = client.get("/api/scale/status").json()
        return s if (s["state"] == "estable" and s["last_kg"]
                     and s["last_kg"] > 90.0) else None

    wait_for(_estable_con_prueba, msg="cerdo de prueba estable en báscula")
    assert _events() == []  # la calibración no emite hasta que se BAJE

    # --- pig_off (se baja el de prueba) → AHORA sí evento REFERENCIA -------
    resp = client.post("/api/sim/action", json={"action": "pig_off"})
    assert resp.json()["pigs_fisicos"] == 0
    assert resp.json()["kg_target"] == pytest.approx(0.0)

    events = wait_for(lambda: e if len(e := _events()) >= 1 else None,
                      msg="evento referencia")
    ref = events[0]
    assert ref["tipo"] == "referencia"
    assert ref["delta_kg"] == pytest.approx(102.5, abs=2.5)
    assert ref["animales_estimados"] == 1

    # --- pigs_on 2 (100 c/u) → SUBIDA de 2 sin ambigüedad (count 0 → 2) ----
    resp = client.post("/api/sim/action",
                       json={"action": "pigs_on", "n": 2, "kg_each": 100.0})
    assert resp.json()["pigs_fisicos"] == 2
    assert resp.json()["kg_target"] == pytest.approx(200.0)

    events = wait_for(lambda: e if len(e := _events()) >= 2 else None,
                      msg="evento subida x2")
    subida = events[1]
    assert subida["tipo"] == "subida"
    assert subida["animales_estimados"] == 2
    assert subida["delta_kg"] == pytest.approx(200.0, abs=4.0)
    assert subida["ambiguo"] is False

    # --- pig_off → BAJADA de 1 (se devuelve uno de 100) --------------------
    resp = client.post("/api/sim/action", json={"action": "pig_off"})
    assert resp.json()["pigs_fisicos"] == 1
    assert resp.json()["kg_target"] == pytest.approx(100.0)

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
    # Tras calibrar count arranca en 0: subieron 2 y bajó 1 → queda 1.
    resp = client.post(f"/api/sessions/{sid}/close", json={"conteo_fisico": 1})
    assert resp.status_code == 200
    closed = resp.json()
    assert closed["estado"] == "cerrada"
    assert closed["total_animales"] == 1          # 0 + 2 - 1
    assert closed["total_kg"] == pytest.approx(100.0, abs=6.0)
    assert closed["promedio_final"] == pytest.approx(100.0, abs=3.0)
    assert closed["conteo_fisico"] == 1
    assert closed["diferencia_conciliacion"] == 0

    stats = client.get(f"/api/sessions/{sid}/stats").json()
    assert stats["total_animales"] == 1
    assert stats["total_kg"] == pytest.approx(100.0, abs=6.0)
    assert stats["modo"] == "lote"
    assert stats["tipo_muestra"] == "estimada"
    # única muestra individual: la referencia (102.5) → sin dispersión
    assert stats["n_muestras"] == 1
    assert stats["desviacion_std"] == 0.0
    assert stats["varianza"] == 0.0
    assert stats["mediana"] == pytest.approx(102.5, abs=2.5)

    # --- nervous / silence responden estado físico (smoke) -----------------
    resp = client.post("/api/sim/action",
                       json={"action": "nervous", "seconds": 0.3})
    assert resp.status_code == 200
    assert resp.json()["pigs_fisicos"] == 1
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


def test_flujo_sim_modo_unidades_engine_real(ctx):
    """Modo unidades: cada nivel estable ≥ min_delta es SUBIDA n=1 con el
    peso del animal; el vaciado NO genera evento; sin calibración."""
    client, _ = ctx

    assert client.post("/api/sim/start").status_code == 200

    def _status():
        return client.get("/api/scale/status").json()

    wait_for(lambda: _status()["connected"] and _status()["last_kg"] is not None,
             msg="scale/status vivo")

    resp = client.post("/api/sessions",
                       json={"lote": "L-UNI", "modo": "unidades",
                             "operador": "Pedro"})
    assert resp.status_code == 201
    session = resp.json()
    sid = session["id"]
    assert session["modo"] == "unidades"

    wait_for(lambda: _status()["state"] == "estable",
             msg="báscula estable en vacío (base unidades)")

    def _events():
        return client.get(f"/api/sessions/{sid}/events").json()

    # --- animal 1 (98 kg) → SUBIDA n=1 inmediata (sin calibración) ---------
    client.post("/api/sim/action",
                json={"action": "pigs_on", "n": 1, "kg_each": 98.0})
    events = wait_for(lambda: e if len(e := _events()) >= 1 else None,
                      msg="evento unidad 1")
    e1 = events[0]
    assert e1["tipo"] == "subida"
    assert e1["animales_estimados"] == 1
    assert e1["ambiguo"] is False
    assert e1["delta_kg"] == pytest.approx(98.0, abs=2.5)

    # --- sale el animal (pig_off) → vacío estable SIN evento ---------------
    client.post("/api/sim/action", json={"action": "pig_off"})
    wait_for(
        lambda: (s := _status())["state"] == "estable"
        and s["last_kg"] is not None and s["last_kg"] < 40.0,
        msg="báscula vacía estable tras salir el animal",
    )
    assert len(_events()) == 1  # el vaciado no es evento en modo unidades

    # --- animal 2 (106 kg) → segundo evento n=1 ----------------------------
    client.post("/api/sim/action",
                json={"action": "pigs_on", "n": 1, "kg_each": 106.0})
    events = wait_for(lambda: e if len(e := _events()) >= 2 else None,
                      msg="evento unidad 2")
    e2 = events[1]
    assert e2["tipo"] == "subida"
    assert e2["animales_estimados"] == 1
    assert e2["delta_kg"] == pytest.approx(106.0, abs=2.5)

    # --- close → total_animales = 2, muestra COMPLETA ----------------------
    resp = client.post(f"/api/sessions/{sid}/close", json={"conteo_fisico": 2})
    assert resp.status_code == 200
    closed = resp.json()
    assert closed["estado"] == "cerrada"
    assert closed["total_animales"] == 2
    assert closed["total_kg"] == pytest.approx(204.0, abs=6.0)
    assert closed["promedio_final"] == pytest.approx(102.0, abs=3.0)
    assert closed["diferencia_conciliacion"] == 0

    stats = client.get(f"/api/sessions/{sid}/stats").json()
    assert stats["modo"] == "unidades"
    assert stats["tipo_muestra"] == "completa"
    assert stats["total_animales"] == 2
    assert stats["n_muestras"] == 2
    assert stats["mediana"] == pytest.approx(102.0, abs=3.0)
    # stdev muestral de ~{98, 106} ≈ 5.66 (con ruido del sim)
    assert stats["desviacion_std"] == pytest.approx(5.66, abs=2.5)
    assert stats["varianza"] > 0.0
    assert stats["uniformidad_pct"] == pytest.approx(100.0)

    client.post("/api/sim/stop")


def test_crear_sesion_modo_invalido_400(ctx):
    client, _ = ctx
    resp = client.post("/api/sessions", json={"lote": "L-X", "modo": "banana"})
    assert resp.status_code == 400
    assert "modo" in resp.json()["detail"]
    assert client.get("/api/sessions").json() == []  # sin fila huérfana
