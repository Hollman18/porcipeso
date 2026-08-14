"""Eliminar un lote (Función A): repo.delete_session en cascada y el
endpoint DELETE /api/sessions/{id} (404 · 409-abierta · borrado)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from porcipeso.api.app import create_app
from porcipeso.core.models import EventType, WeighEvent
from porcipeso.db.repo import Repo

from .fake_engine import FakeEngine


def _event(session_id, ts_ms, antes, despues, n, tipo) -> WeighEvent:
    return WeighEvent(
        id=None, session_id=session_id, ts_ms=ts_ms,
        peso_antes=antes, peso_despues=despues,
        delta_kg=round(despues - antes, 3),
        animales_estimados=n, tipo=tipo, estab_ms=700,
    )


# ---------------------------------------------------------------- repo (A1)

@pytest.fixture()
def repo(tmp_path):
    r = Repo(tmp_path / "del.db")
    yield r
    r.close()


def test_delete_session_cascada(repo):
    """Borra la sesión + sus eventos + sus lecturas; retorna cuántos
    eventos borró y no toca las demás sesiones."""
    sid = repo.create_session({"lote": "L-borrar"})
    repo.insert_event(_event(sid, 1000, 0.0, 100.0, 1, EventType.REFERENCIA))
    repo.insert_event(_event(sid, 2000, 0.0, 210.0, 2, EventType.SUBIDA))
    for i in range(5):
        repo.insert_reading(sid, 3000 + i, 100.0 + i)
    repo.close_session(sid, {"total_kg": 210.0, "count": 2, "avg_kg": 105.0})

    otra = repo.create_session({"lote": "L-queda"})
    repo.insert_event(_event(otra, 1000, 0.0, 99.0, 1, EventType.SUBIDA))

    assert repo.delete_session(sid) == 2            # dos eventos borrados
    assert repo.get_session(sid) is None            # la sesión ya no está
    assert repo.list_events(sid) == []              # eventos en cascada
    assert repo.count_readings(sid) == 0            # lecturas en cascada
    # la otra sesión queda intacta
    assert repo.get_session(otra) is not None
    assert len(repo.list_events(otra)) == 1


def test_delete_session_inexistente_retorna_0(repo):
    assert repo.delete_session(9999) == 0           # nunca falla


def test_delete_session_sin_eventos(repo):
    sid = repo.create_session({"lote": "L-vacia"})
    repo.close_session(sid, {"total_kg": 0.0, "count": 0, "avg_kg": None})
    assert repo.delete_session(sid) == 0
    assert repo.get_session(sid) is None


def test_delete_session_demo(repo):
    """Las sesiones DEMO se borran igual (sin trato especial en el repo)."""
    sid = repo.create_session({"lote": "L-demo", "es_demo": 1})
    repo.insert_event(_event(sid, 1000, 0.0, 90.0, 1, EventType.SUBIDA))
    repo.close_session(sid, {"total_kg": 90.0, "count": 1, "avg_kg": 90.0})
    assert repo.delete_session(sid) == 1
    assert repo.get_session(sid) is None


# ------------------------------------------------------------- endpoint (A2)

@pytest.fixture()
def client(tmp_path):
    app = create_app(
        tmp_path / "api.db",
        engine_factory=lambda cfg, on_event, on_state=None: FakeEngine(
            cfg, on_event, on_state
        ),
    )
    with TestClient(app) as c:
        yield c


def test_delete_endpoint_404(client):
    assert client.delete("/api/sessions/9999").status_code == 404


def test_delete_endpoint_409_si_abierta(client):
    created = client.post("/api/sessions", json={"lote": "L-abierta"}).json()
    r = client.delete(f"/api/sessions/{created['id']}")
    assert r.status_code == 409
    assert "cierra el pesaje" in r.json()["detail"].lower()
    # el pesaje abierto sigue existiendo (no se borró)
    assert client.get(f"/api/sessions/{created['id']}").status_code == 200


def test_delete_endpoint_borra_cerrada(client):
    created = client.post("/api/sessions", json={"lote": "L-cerrar"}).json()
    sid = created["id"]
    client.post(f"/api/sessions/{sid}/close", json={})
    r = client.delete(f"/api/sessions/{sid}")
    assert r.status_code == 200
    body = r.json()
    assert body["deleted"] is True
    assert body["id"] == sid
    # desaparece del detalle y de la lista
    assert client.get(f"/api/sessions/{sid}").status_code == 404
    assert sid not in {s["id"] for s in client.get("/api/sessions").json()}
