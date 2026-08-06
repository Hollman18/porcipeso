"""POST /api/scale/disconnect — corta el driver SIN tocar la config guardada.

La config vive en el cliente (localStorage): desconectar solo detiene el
hilo del driver (real o simulado); reconectar es POST /api/scale/connect
o /api/sim/start de nuevo. La tarjeta de estado de ⚙ Báscula depende de
este contrato (Desconectar → chip "Sin conectar" → botón Conectar).
"""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from porcipeso.api.app import create_app

from .fake_engine import FakeEngine


@pytest.fixture()
def client(tmp_path):
    holder: dict[str, FakeEngine] = {}

    def factory(config, on_event, on_state=None):
        engine = FakeEngine(config, on_event, on_state)
        holder["engine"] = engine
        return engine

    app = create_app(tmp_path / "api.db", engine_factory=factory)
    with TestClient(app) as c:
        yield c


def _wait_until(cond, timeout_s: float = 3.0, interval_s: float = 0.05) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(interval_s)
    return bool(cond())


def test_disconnect_idempotente_sin_driver(client):
    resp = client.post("/api/scale/disconnect")
    assert resp.status_code == 200
    assert resp.json() == {"connected": False, "disconnected": False}
    # el status sigue coherente
    st = client.get("/api/scale/status").json()
    assert st["connected"] is False
    assert st["profile_id"] is None


def test_disconnect_corta_sim_y_permite_reconectar(client):
    # conectar la báscula simulada (mismo camino que scale/connect sim)
    start = client.post("/api/sim/start")
    assert start.status_code == 200
    assert start.json()["connected"] is True
    assert _wait_until(
        lambda: client.get("/api/scale/status").json()["connected"]
    )

    # desconectar: driver muerto, status suelto, error limpio
    resp = client.post("/api/scale/disconnect")
    assert resp.status_code == 200
    assert resp.json() == {"connected": False, "disconnected": True}
    st = client.get("/api/scale/status").json()
    assert st["connected"] is False
    assert st["profile_id"] is None
    assert st["error"] is None

    # el simulador quedó realmente detenido (no acepta acciones)
    accion = client.post("/api/sim/action", json={"action": "pigs_on", "n": 1})
    assert accion.status_code == 409

    # reconectar con un toque: la config guardada (cliente) sigue válida
    again = client.post("/api/sim/start")
    assert again.status_code == 200
    assert again.json()["connected"] is True
    assert _wait_until(
        lambda: client.get("/api/scale/status").json()["connected"]
    )


def test_disconnect_despues_de_connect_real_fallido_limpia_error(client):
    # perfil serial sin hardware: el hilo del driver muere con error
    profiles = client.get("/api/profiles").json()
    serial_ids = [p["id"] for p in profiles if p.get("transport") == "serial"]
    if not serial_ids:
        pytest.skip("catálogo sin perfiles seriales")
    resp = client.post(
        "/api/scale/connect",
        json={"profile_id": serial_ids[0], "port": "/dev/tty-no-existe"},
    )
    assert resp.status_code == 200  # el connect arranca el hilo; el error llega después
    _wait_until(
        lambda: client.get("/api/scale/status").json()["error"] is not None,
        timeout_s=5.0,
    )

    off = client.post("/api/scale/disconnect")
    assert off.status_code == 200
    st = client.get("/api/scale/status").json()
    assert st["connected"] is False
    assert st["error"] is None  # desconectar deja el estado limpio
