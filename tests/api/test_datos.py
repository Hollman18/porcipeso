"""Módulo Datos: filtros de GET /api/sessions y GET /api/stats/global."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from porcipeso.api.app import create_app
from porcipeso.db.repo import Repo

from .fake_engine import FakeEngine


def _seed(db_path) -> dict[str, int]:
    """4 sesiones: 3 cerradas (L-1 x2, L-2) y 1 abierta (L-3)."""
    repo = Repo(db_path)
    ids = {}
    ids["s1"] = repo.create_session({
        "lote": "L-1", "corral_origen": "C1", "destino": "Planta Norte",
        "hora_entrada": "2026-07-10T08:00:00+00:00",
    })
    repo.close_session(ids["s1"], {"total_kg": 500.0, "count": 5, "avg_kg": 100.0})
    ids["s2"] = repo.create_session({
        "lote": "L-1", "corral_origen": "C2", "destino": "Planta Sur",
        "hora_entrada": "2026-07-12T09:30:00+00:00",
    })
    repo.close_session(ids["s2"], {"total_kg": 300.0, "count": 3, "avg_kg": 100.0})
    ids["s3"] = repo.create_session({
        "lote": "L-2", "corral_origen": "C1", "destino": "Frigorífico Sur",
        "hora_entrada": "2026-07-14T07:15:00+00:00",
    })
    repo.close_session(ids["s3"], {"total_kg": 400.0, "count": 4, "avg_kg": 100.0})
    ids["s4"] = repo.create_session({
        "lote": "L-3", "corral_origen": "C9", "destino": "Planta Norte",
        "hora_entrada": "2026-07-15T10:00:00+00:00",
    })  # queda abierta (sin totales)
    repo.close()
    return ids


@pytest.fixture()
def ctx(tmp_path):
    db_path = tmp_path / "datos.db"
    ids = _seed(db_path)
    app = create_app(
        db_path,
        engine_factory=lambda cfg, on_event, on_state=None: FakeEngine(
            cfg, on_event, on_state
        ),
    )
    with TestClient(app) as client:
        yield client, ids


def _ids(resp) -> set[int]:
    return {s["id"] for s in resp.json()}


def test_filtro_desde(ctx):
    client, ids = ctx
    resp = client.get("/api/sessions", params={"desde": "2026-07-12"})
    assert _ids(resp) == {ids["s2"], ids["s3"], ids["s4"]}


def test_filtro_hasta(ctx):
    client, ids = ctx
    resp = client.get("/api/sessions", params={"hasta": "2026-07-12"})
    assert _ids(resp) == {ids["s1"], ids["s2"]}


def test_filtro_rango(ctx):
    client, ids = ctx
    resp = client.get("/api/sessions",
                      params={"desde": "2026-07-11", "hasta": "2026-07-14"})
    assert _ids(resp) == {ids["s2"], ids["s3"]}


def test_filtro_q_busca_lote_corral_destino(ctx):
    client, ids = ctx
    assert _ids(client.get("/api/sessions", params={"q": "L-1"})) == \
        {ids["s1"], ids["s2"]}
    assert _ids(client.get("/api/sessions", params={"q": "Frigo"})) == \
        {ids["s3"]}
    assert _ids(client.get("/api/sessions", params={"q": "C9"})) == \
        {ids["s4"]}
    assert _ids(client.get("/api/sessions", params={"q": "Norte"})) == \
        {ids["s1"], ids["s4"]}


def test_filtros_combinados(ctx):
    client, ids = ctx
    resp = client.get("/api/sessions",
                      params={"desde": "2026-07-11", "q": "Planta"})
    assert _ids(resp) == {ids["s2"], ids["s4"]}


def test_stats_global_sin_filtros(ctx):
    client, _ = ctx
    g = client.get("/api/stats/global").json()
    assert g["sesiones"] == 4
    assert g["total_animales"] == 12          # 5 + 3 + 4 (la abierta no suma)
    assert g["total_kg"] == pytest.approx(1200.0)
    assert g["promedio_global"] == pytest.approx(100.0)

    por_lote = {r["lote"]: r for r in g["por_lote"]}
    assert set(por_lote) == {"L-1", "L-2", "L-3"}
    l1 = por_lote["L-1"]
    assert l1["sesiones"] == 2
    assert l1["animales"] == 8
    assert l1["kg"] == pytest.approx(800.0)
    assert l1["promedio"] == pytest.approx(100.0)
    assert l1["ultima_fecha"].startswith("2026-07-12")
    l3 = por_lote["L-3"]
    assert l3["animales"] == 0
    assert l3["promedio"] is None
    # ordenado por última fecha DESC
    assert [r["lote"] for r in g["por_lote"]] == ["L-3", "L-2", "L-1"]


def test_stats_global_con_rango(ctx):
    client, _ = ctx
    g = client.get("/api/stats/global", params={"desde": "2026-07-13"}).json()
    assert g["sesiones"] == 2                  # s3 cerrada + s4 abierta
    assert g["total_animales"] == 4
    assert g["total_kg"] == pytest.approx(400.0)
    assert g["promedio_global"] == pytest.approx(100.0)
    assert {r["lote"] for r in g["por_lote"]} == {"L-2", "L-3"}
