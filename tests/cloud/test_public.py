"""Endpoints públicos: /config/app (merge + CORS), /telemetry, /health."""
from __future__ import annotations

from .conftest import auth, login, make_tenant


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_config_app_vacia(client):
    r = client.get("/config/app")
    assert r.status_code == 200
    assert r.json() == {
        "latest_version": None, "min_version": None,
        "apk_url": None, "banners": [],
    }


def test_config_app_merge_global_tenant(client, sa_token):
    make_tenant(client, sa_token, "granja-a")
    admin = login(client, "admin@granja-a.test", "clave-admin-1")["access_token"]
    # Config global.
    client.put("/admin/config/latest_version", json={"valor": "2.0.0"},
               headers=auth(sa_token))
    client.put("/admin/config/min_version", json={"valor": "1.0.0"},
               headers=auth(sa_token))
    client.put("/admin/config/apk_url",
               json={"valor": "https://cdn.porcipeso.app/app.apk"},
               headers=auth(sa_token))
    banner_global = {
        "id": "g1", "texto": "Mantenimiento el sábado", "boton": None,
        "url": None, "desde": "2026-07-01", "hasta": "2026-07-31",
        "solo_sin_nube": False,
    }
    client.put("/admin/config/banners", json={"valor": [banner_global]},
               headers=auth(sa_token))
    # Overrides del tenant: min_version propia + banner propio.
    client.put("/tenant/config/min_version", json={"valor": "1.5.0"},
               headers=auth(admin))
    banner_tenant = {
        "id": "t1", "texto": "Bienvenidos Granja A", "boton": "Ver",
        "url": "https://granja-a.test", "desde": None, "hasta": None,
        "solo_sin_nube": True,
    }
    client.put("/tenant/config/banners", json={"valor": [banner_tenant]},
               headers=auth(admin))

    # Sin tenant: solo lo global.
    cfg = client.get("/config/app").json()
    assert cfg["min_version"] == "1.0.0"
    assert cfg["banners"] == [banner_global]

    # Con tenant: escalares del tenant PISAN, banners se CONCATENAN.
    cfg = client.get("/config/app", params={"tenant": "granja-a"}).json()
    assert cfg["latest_version"] == "2.0.0"      # global (sin override)
    assert cfg["min_version"] == "1.5.0"         # override del tenant
    assert cfg["apk_url"] == "https://cdn.porcipeso.app/app.apk"
    assert cfg["banners"] == [banner_global, banner_tenant]

    # Slug desconocido → config global (la app no se rompe).
    cfg = client.get("/config/app", params={"tenant": "no-existe"}).json()
    assert cfg["min_version"] == "1.0.0"
    assert cfg["banners"] == [banner_global]


def test_config_app_tenant_inactivo_cae_a_global(client, sa_token):
    data = make_tenant(client, sa_token, "granja-a")
    admin = login(client, "admin@granja-a.test", "clave-admin-1")["access_token"]
    client.put("/tenant/config/min_version", json={"valor": "3.0.0"},
               headers=auth(admin))
    client.patch(f"/admin/tenants/{data['tenant']['id']}",
                 json={"activo": False}, headers=auth(sa_token))
    cfg = client.get("/config/app", params={"tenant": "granja-a"}).json()
    assert cfg["min_version"] is None  # ya no aplica el override


def test_cors_solo_en_config_app(client):
    r = client.get("/config/app", headers={"Origin": "https://cualquiera.test"})
    assert r.headers.get("access-control-allow-origin") == "*"
    r = client.options("/config/app")
    assert r.status_code == 204
    assert r.headers.get("access-control-allow-origin") == "*"
    assert "GET" in r.headers.get("access-control-allow-methods", "")
    # El resto de la API NO emite CORS (fail-closed).
    r = client.get("/health", headers={"Origin": "https://cualquiera.test"})
    assert "access-control-allow-origin" not in r.headers


def test_telemetry_anonima_y_con_tenant(client, sa_token):
    make_tenant(client, sa_token, "granja-a")
    r = client.post(
        "/telemetry",
        json={
            "device_id": "dev-1", "plataforma": "android",
            "version_app": "1.0.0", "tenant": "granja-a",
            "datos": {"pesajes_mes": 42, "nube_activa": True},
        },
    )
    assert r.status_code == 202 and r.json() == {"ok": True}
    # Anónima (sin tenant) y con slug desconocido: también entra.
    assert client.post(
        "/telemetry",
        json={"device_id": "dev-2", "plataforma": "desktop",
              "version_app": "1.0.0"},
    ).status_code == 202
    assert client.post(
        "/telemetry",
        json={"device_id": "dev-3", "plataforma": "android",
              "version_app": "1.0.0", "tenant": "slug-inventado"},
    ).status_code == 202
    resumen = client.get("/admin/telemetria", headers=auth(sa_token)).json()
    assert sum(r["reportes"] for r in resumen) == 3


def test_telemetry_payload_gigante_413(client):
    r = client.post(
        "/telemetry",
        json={"device_id": "dev-1", "datos": {"blob": "x" * 20_000}},
    )
    assert r.status_code == 413


def test_telemetry_valida_campos(client):
    assert client.post("/telemetry", json={"datos": {}}).status_code == 422
    assert client.post(
        "/telemetry", json={"device_id": "", "datos": {}}
    ).status_code == 422
