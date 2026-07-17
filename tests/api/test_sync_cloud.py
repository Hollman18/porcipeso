"""Tests de LOGIN + SYNC a la nube (escritorio) contra el cloud REAL.

El servidor nube (porcipeso.cloud) corre EN PROCESO con uvicorn en un
hilo y puerto libre: el SyncWorker y los endpoints /api/cloud/* hablan
HTTP de verdad (httpx), igual que en producción.

Cubre:
- configurar + login + ciclo del worker → filas en el cloud
- idempotencia (2 ciclos = mismas filas)
- 401 → refresh → push OK
- offline (cloud caído) → no crashea, reintenta y reanuda
- refresh muerto → sesión vencida (datos locales intactos)
- endpoints /api/cloud/* del escritorio (probe/login/session/token/status)
- modo standalone intacto (sin nube, nada cambia)
"""
from __future__ import annotations

import socket
import threading
import time
import uuid as uuid_mod
from types import SimpleNamespace

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

from porcipeso.api.app import create_app as create_api_app
from porcipeso.api.syncworker import SyncWorker, event_uuid
from porcipeso.cloud.app import create_app as create_cloud_app
from porcipeso.core.models import EventType, WeighEvent
from porcipeso.db.repo import Repo

SECRET = "sync-secret-porcipeso-0123456789abcdef0123456789"
SA_EMAIL = "root@porcipeso.test"
SA_PASS = "superclave-1"
ADMIN_PASS = "clave-admin-1"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ------------------------------------------------------------ cloud vivo

@pytest.fixture(scope="module")
def cloud(tmp_path_factory):
    """Servidor nube REAL (uvicorn en hilo, puerto libre)."""
    db = tmp_path_factory.mktemp("cloud") / "cloud.db"
    app = create_cloud_app(
        str(db), SECRET,
        superadmin_email=SA_EMAIL, superadmin_password=SA_PASS,
    )
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="warning",
    ))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("uvicorn no arrancó")
        time.sleep(0.02)
    yield SimpleNamespace(url=f"http://127.0.0.1:{port}", db=str(db))
    server.should_exit = True
    thread.join(timeout=5)


def _sa_token(cloud) -> str:
    r = httpx.post(f"{cloud.url}/auth/login",
                   json={"email": SA_EMAIL, "password": SA_PASS}, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def make_tenant(cloud, slug: str) -> dict:
    """Tenant nuevo con su admin. Retorna {slug, admin_email}."""
    sa = _sa_token(cloud)
    r = httpx.post(
        f"{cloud.url}/admin/tenants",
        json={
            "nombre": slug.title(), "slug": slug,
            "admin_email": f"admin@{slug}.test", "admin_password": ADMIN_PASS,
        },
        headers={"Authorization": f"Bearer {sa}"},
        timeout=10,
    )
    assert r.status_code == 201, r.text
    return {"slug": slug, "admin_email": f"admin@{slug}.test"}


def login(cloud, email: str, password: str = ADMIN_PASS) -> dict:
    r = httpx.post(f"{cloud.url}/auth/login",
                   json={"email": email, "password": password}, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def cloud_sesiones(cloud, access: str) -> list[dict]:
    r = httpx.get(f"{cloud.url}/sync/sesiones",
                  headers={"Authorization": f"Bearer {access}"}, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def cloud_eventos(cloud, access: str, sesion_uuid: str) -> list[dict]:
    r = httpx.get(f"{cloud.url}/sync/sesiones/{sesion_uuid}/eventos",
                  headers={"Authorization": f"Bearer {access}"}, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def _slug() -> str:
    return f"granja-{uuid_mod.uuid4().hex[:8]}"


# --------------------------------------------------------------- locales

@pytest.fixture()
def repo(tmp_path):
    r = Repo(tmp_path / "local.db", store_readings=False)
    yield r
    r.close()


@pytest.fixture()
def worker(repo):
    w = SyncWorker(repo)
    yield w
    w.stop()


def make_local_session(repo: Repo, *, lote: str = "L-42", close: bool = True,
                       n_eventos: int = 2) -> dict:
    """Sesión local con eventos (y cierre opcional). Retorna la fila."""
    sid = repo.create_session({"lote": lote, "granja": "La Esperanza",
                               "modo": "lote"})
    for i in range(n_eventos):
        repo.insert_event(WeighEvent(
            id=None, session_id=sid, ts_ms=1_000 + i,
            peso_antes=0.0 + i, peso_despues=104.2 + i, delta_kg=104.2,
            animales_estimados=1, tipo=EventType.SUBIDA, estab_ms=800,
        ))
    if close:
        repo.close_session(
            sid, {"total_kg": 104.2 * n_eventos, "count": n_eventos,
                  "avg_kg": 104.2}, None,
        )
    session = repo.get_session(sid)
    assert session is not None
    return session


# ================================================================== tests

def test_configura_login_y_un_ciclo_sube_todo(cloud, repo, worker):
    """Flujo completo: tenant + login + sesiones locales → run_cycle →
    las filas (sesión Y eventos) quedan en el cloud con sus totales."""
    t = make_tenant(cloud, _slug())
    pair = login(cloud, t["admin_email"])
    s1 = make_local_session(repo, lote="L-1", n_eventos=3)
    s2 = make_local_session(repo, lote="L-2", close=False, n_eventos=1)

    worker.set_session(cloud.url, t["slug"],
                       pair["access_token"], pair["refresh_token"],
                       expires_in=pair.get("expires_in"))
    out = worker.run_cycle()
    assert out["ok"] is True, out
    assert out["pushed"] == 2

    filas = cloud_sesiones(cloud, pair["access_token"])
    por_uuid = {f["uuid"]: f for f in filas}
    assert set(por_uuid) == {s1["uuid"], s2["uuid"]}
    assert por_uuid[s1["uuid"]]["estado"] == "cerrada"
    assert por_uuid[s1["uuid"]]["total_kg"] == pytest.approx(104.2 * 3)
    assert por_uuid[s2["uuid"]]["estado"] == "abierta"

    evs = cloud_eventos(cloud, pair["access_token"], s1["uuid"])
    assert len(evs) == 3
    assert {e["uuid"] for e in evs} == {
        event_uuid(s1["uuid"], i) for i in (1, 2, 3)
    }
    assert all(e["tipo"] == "subida" for e in evs)

    st = worker.status()
    assert st["configurada"] and st["conectado"] and not st["sesion_vencida"]
    assert st["ultimo_push"] is not None
    assert st["device_id"].startswith("desk-")


def test_idempotencia_dos_ciclos_mismas_filas(cloud, repo, worker):
    t = make_tenant(cloud, _slug())
    pair = login(cloud, t["admin_email"])
    s = make_local_session(repo, n_eventos=2)

    worker.set_session(cloud.url, t["slug"],
                       pair["access_token"], pair["refresh_token"])
    assert worker.run_cycle()["ok"] is True
    assert worker.run_cycle()["ok"] is True  # segundo ciclo

    filas = cloud_sesiones(cloud, pair["access_token"])
    assert len(filas) == 1
    assert len(cloud_eventos(cloud, pair["access_token"], s["uuid"])) == 2


def test_cierre_posterior_actualiza_el_cloud(cloud, repo, worker):
    """Sesión abierta subida en el ciclo 1; se cierra; el ciclo 2 la
    actualiza (UPSERT last-write-wins) — sin duplicarla."""
    t = make_tenant(cloud, _slug())
    pair = login(cloud, t["admin_email"])
    s = make_local_session(repo, close=False, n_eventos=1)

    worker.set_session(cloud.url, t["slug"],
                       pair["access_token"], pair["refresh_token"])
    assert worker.run_cycle()["ok"] is True
    assert cloud_sesiones(cloud, pair["access_token"])[0]["estado"] == "abierta"

    repo.close_session(int(s["id"]), {"total_kg": 104.2, "count": 1,
                                      "avg_kg": 104.2}, 1)
    assert worker.run_cycle()["ok"] is True
    filas = cloud_sesiones(cloud, pair["access_token"])
    assert len(filas) == 1
    assert filas[0]["estado"] == "cerrada"
    assert filas[0]["conteo_fisico"] == 1


def test_401_refresca_y_sube(cloud, repo, worker):
    """Access token basura → 401 → el worker refresca UNA vez y el push
    sale bien (además el refresh rotado queda persistido)."""
    t = make_tenant(cloud, _slug())
    pair = login(cloud, t["admin_email"])
    make_local_session(repo)

    worker.set_session(cloud.url, t["slug"],
                       "token-basura", pair["refresh_token"],
                       expires_in=9999)  # "vigente" para el TokenBox → 401 real
    out = worker.run_cycle()
    assert out["ok"] is True, out
    assert len(cloud_sesiones(cloud, login(cloud, t["admin_email"])["access_token"])) == 1
    # el refresh rotó y quedó persistido en cloud_state
    assert worker._get_state("refresh_token") not in (None, "", pair["refresh_token"])


def test_offline_no_crashea_y_reanuda(cloud, repo, worker):
    """Cloud caído → ciclo falla SIN excepción; al volver (nueva sesión
    contra el cloud vivo) el push reanuda con los mismos datos."""
    t = make_tenant(cloud, _slug())
    pair = login(cloud, t["admin_email"])
    make_local_session(repo)

    dead = f"http://127.0.0.1:{_free_port()}"
    worker.set_session(dead, t["slug"], "x", "refresh-que-no-se-usa")
    out = worker.run_cycle()
    assert out["ok"] is False and "sesion_vencida" not in out
    st = worker.status()
    assert st["configurada"] is True and st["conectado"] is False
    assert st["pendientes"] == 1  # sigue pendiente, nada se perdió

    # reintento (sigue caído): tampoco crashea
    assert worker.run_cycle()["ok"] is False

    # vuelve la nube: mismo worker, sesión válida → sube
    worker.set_session(cloud.url, t["slug"],
                       pair["access_token"], pair["refresh_token"])
    assert worker.run_cycle()["ok"] is True
    assert len(cloud_sesiones(cloud, pair["access_token"])) == 1


def test_refresh_muerto_es_sesion_vencida(cloud, repo, worker):
    t = make_tenant(cloud, _slug())
    make_local_session(repo)
    worker.set_session(cloud.url, t["slug"], "", "refresh-invalido-xxxxxxxx")
    out = worker.run_cycle()
    assert out.get("sesion_vencida") is True
    st = worker.status()
    assert st["sesion_vencida"] is True
    # los datos locales quedan intactos y pendientes
    assert st["pendientes"] == 1


def test_refresh_sobrevive_reinicio(cloud, repo, tmp_path):
    """El refresh persiste en cloud_state: un worker NUEVO sobre la misma
    DB retoma la sesión sin re-login (access vacío → refresca solo)."""
    t = make_tenant(cloud, _slug())
    pair = login(cloud, t["admin_email"])
    make_local_session(repo)

    w1 = SyncWorker(repo)
    w1.set_session(cloud.url, t["slug"],
                   pair["access_token"], pair["refresh_token"])
    assert w1.run_cycle()["ok"] is True
    w1.stop()

    make_local_session(repo, lote="L-99")
    w2 = SyncWorker(repo)  # "reinicio" del proceso API
    try:
        assert w2.configured is True
        assert w2.run_cycle()["ok"] is True
        filas = cloud_sesiones(cloud, login(cloud, t["admin_email"])["access_token"])
        assert len(filas) == 2
    finally:
        w2.stop()


# ---------------------------------------------------- endpoints /api/cloud

def test_endpoints_api_cloud_del_escritorio(cloud, tmp_path):
    """probe → login (proxy, sin CORS) → status → token → logout."""
    t = make_tenant(cloud, _slug())
    app = create_api_app(tmp_path / "desk.db", store_readings=False)
    with TestClient(app) as c:
        # standalone intacto: sin nube nada está configurado
        st = c.get("/api/cloud/status").json()
        assert st["configurada"] is False

        # probe
        p = c.post("/api/cloud/probe",
                   json={"cloud_url": cloud.url, "tenant": t["slug"]}).json()
        assert p["ok"] is True and p["health"] is True
        assert "banners" in p["config"]

        # login proxy: configura el worker y retorna el perfil
        r = c.post("/api/cloud/login", json={
            "cloud_url": cloud.url, "tenant": t["slug"],
            "email": t["admin_email"], "password": ADMIN_PASS,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["perfil"]["rol"] == "admin"
        assert body["perfil"]["email"] == t["admin_email"]
        assert body["access_token"] and body["refresh_token"]

        # credenciales malas → 401 limpio
        bad = c.post("/api/cloud/login", json={
            "cloud_url": cloud.url, "tenant": t["slug"],
            "email": t["admin_email"], "password": "nop-nop-nop",
        })
        assert bad.status_code == 401

        # un pesaje cerrado se sube (request_push + ciclo directo)
        sid = c.post("/api/sessions", json={"lote": "L-e2e"}).json()["id"]
        c.post(f"/api/sessions/{sid}/close", json={})
        app.state.sync_worker.run_cycle()

        st = c.get("/api/cloud/status").json()
        assert st["configurada"] and st["conectado"]
        assert st["perfil"]["rol"] == "admin"

        filas = cloud_sesiones(cloud, body["access_token"])
        assert any(f["lote"] == "L-e2e" for f in filas)

        # token vigente para la UI
        tk = c.get("/api/cloud/token").json()
        assert tk["access_token"] and tk["refresh_token"]

        # logout: revoca y desconfigura; el refresh viejo ya no sirve
        assert c.delete("/api/cloud/session").json()["ok"] is True
        assert c.get("/api/cloud/status").json()["configurada"] is False
        assert c.get("/api/cloud/token").status_code == 409
        rr = httpx.post(f"{cloud.url}/auth/refresh",
                        json={"refresh_token": tk["refresh_token"]}, timeout=10)
        assert rr.status_code == 401  # revocado en el logout


def test_standalone_sin_nube_intacto(tmp_path):
    """Sin nube configurada la API funciona igual que siempre y el sync
    worker duerme (run_cycle es un no-op)."""
    app = create_api_app(tmp_path / "solo.db", store_readings=False)
    with TestClient(app) as c:
        sid = c.post("/api/sessions", json={"lote": "L-solo"}).json()["id"]
        r = c.post(f"/api/sessions/{sid}/close", json={})
        assert r.status_code == 200
        assert app.state.sync_worker.run_cycle() == {
            "configurada": False, "pushed": 0,
        }
        assert c.get("/api/cloud/status").json()["configurada"] is False
