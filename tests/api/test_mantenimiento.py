"""🧹 Liberar espacio — /api/mantenimiento/uso y /api/mantenimiento/limpiar.

Reglas: lecturas crudas de pesajes cerrados se borran siempre seguro;
pesajes cerrados anteriores a una fecha se borran con confirmación
(dry_run cuenta primero); las sesiones ABIERTAS jamás se tocan.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from porcipeso.api.app import create_app

from .fake_engine import FakeEngine


@pytest.fixture()
def ctx(tmp_path):
    holder: dict[str, FakeEngine] = {}

    def factory(config, on_event, on_state=None):
        engine = FakeEngine(config, on_event, on_state)
        holder["engine"] = engine
        return engine

    app = create_app(tmp_path / "api.db", engine_factory=factory)
    with TestClient(app) as client:
        yield client, holder


def _mk_session(client, lote: str, close: bool):
    r = client.post("/api/sessions", json={"lote": lote})
    assert r.status_code == 201
    sid = r.json()["id"]
    if close:
        assert client.post(f"/api/sessions/{sid}/close", json={}).status_code == 200
    return sid


def test_uso_reporta_tamano_y_contadores(ctx):
    client, _ = ctx
    _mk_session(client, "L-1", close=True)
    _mk_session(client, "L-2", close=False)
    uso = client.get("/api/mantenimiento/uso").json()
    assert uso["db_bytes"] > 0
    assert uso["pesajes_cerrados"] == 1
    assert uso["pesajes_abiertos"] == 1
    assert uso["pesaje_mas_viejo"] is not None
    assert {"lecturas_total", "lecturas_borrables"} <= set(uso)


def test_limpiar_lecturas_respeta_sesion_abierta(ctx, tmp_path):
    client, _ = ctx
    from porcipeso.db.repo import Repo

    # sembrar lecturas directamente en la MISMA DB del app
    cerrada = _mk_session(client, "L-cerrada", close=True)
    abierta = _mk_session(client, "L-abierta", close=False)
    seed = Repo(tmp_path / "api.db")
    for i in range(10):
        seed.insert_reading(cerrada, 1000 + i, 100.0)
        seed.insert_reading(abierta, 2000 + i, 50.0)
        seed.insert_reading(None, 3000 + i, 0.0)  # huérfanas
    seed.close()

    uso = client.get("/api/mantenimiento/uso").json()
    assert uso["lecturas_total"] == 30
    assert uso["lecturas_borrables"] == 20  # cerrada + huérfanas

    r = client.post("/api/mantenimiento/limpiar", json={"accion": "lecturas"})
    assert r.status_code == 200
    assert r.json()["borrado"]["lecturas"] == 20
    assert r.json()["lecturas_total"] == 10  # las de la abierta sobreviven

    check = Repo(tmp_path / "api.db")
    assert check.count_readings(abierta) == 10
    assert check.count_readings(cerrada) == 0
    check.close()


def test_limpiar_pesajes_dry_run_y_borrado_real(ctx, tmp_path):
    client, _ = ctx
    from porcipeso.db.repo import Repo

    vieja = _mk_session(client, "L-vieja", close=True)
    nueva = _mk_session(client, "L-nueva", close=True)
    abierta = _mk_session(client, "L-abierta", close=False)

    # la "vieja" queda con fecha 2020; la abierta también ES vieja pero no se toca
    seed = Repo(tmp_path / "api.db")
    seed._conn.execute("UPDATE sesiones SET hora_entrada = '2020-01-15T10:00:00+00:00' "
                       "WHERE id IN (?, ?)", (vieja, abierta))
    seed._conn.commit()
    for i in range(5):
        seed.insert_reading(vieja, 1000 + i, 80.0)
    seed.close()

    # dry_run: cuenta sin borrar (para el mensaje "se borrarán N pesajes…")
    dry = client.post("/api/mantenimiento/limpiar",
                      json={"accion": "pesajes", "antes": "2021-01-01",
                            "dry_run": True}).json()
    assert dry["borrado"] == {"pesajes": 1, "eventos": 0, "lecturas": 5,
                              "dry_run": True}
    assert client.get(f"/api/sessions/{vieja}").status_code == 200  # sigue viva

    # borrado real
    real = client.post("/api/mantenimiento/limpiar",
                       json={"accion": "pesajes", "antes": "2021-01-01"}).json()
    assert real["borrado"]["pesajes"] == 1
    assert real["borrado"]["dry_run"] is False
    assert client.get(f"/api/sessions/{vieja}").status_code == 404
    assert client.get(f"/api/sessions/{nueva}").status_code == 200
    # la ABIERTA vieja jamás se borra
    assert client.get(f"/api/sessions/{abierta}").status_code == 200
    assert client.get("/api/mantenimiento/uso").json()["pesajes_abiertos"] == 1


def test_limpiar_valida_accion_y_fecha(ctx):
    client, _ = ctx
    assert client.post("/api/mantenimiento/limpiar",
                       json={"accion": "todo"}).status_code == 422
    r = client.post("/api/mantenimiento/limpiar", json={"accion": "pesajes"})
    assert r.status_code == 422
    assert "YYYY-MM-DD" in r.json()["detail"]
    r2 = client.post("/api/mantenimiento/limpiar",
                     json={"accion": "pesajes", "antes": "15/01/2020"})
    assert r2.status_code == 422
