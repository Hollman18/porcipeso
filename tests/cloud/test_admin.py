"""Superadmin: tenants, config global, telemetría; 403 para el resto."""
from __future__ import annotations

import jwt as pyjwt

from .conftest import SECRET, auth, login, make_tenant


def test_crear_tenant_con_admin(client, sa_token):
    data = make_tenant(client, sa_token, "granja-a")
    assert data["tenant"]["slug"] == "granja-a"
    assert data["tenant"]["activo"] is True
    assert data["admin"]["rol"] == "admin"
    # El admin creado puede loguear y su token trae el tenant_id.
    pair = login(client, "admin@granja-a.test", "clave-admin-1")
    claims = pyjwt.decode(pair["access_token"], SECRET, algorithms=["HS256"])
    assert claims["tenant_id"] == data["tenant"]["id"]
    assert claims["rol"] == "admin"


def test_slug_duplicado_409(client, sa_token):
    make_tenant(client, sa_token, "granja-a")
    r = client.post(
        "/admin/tenants",
        json={
            "nombre": "Otra", "slug": "granja-a",
            "admin_email": "otra@x.test", "admin_password": "clave-admin-1",
        },
        headers=auth(sa_token),
    )
    assert r.status_code == 409


def test_email_admin_duplicado_409(client, sa_token):
    make_tenant(client, sa_token, "granja-a")
    r = client.post(
        "/admin/tenants",
        json={
            "nombre": "Otra", "slug": "granja-b",
            "admin_email": "admin@granja-a.test", "admin_password": "clave-admin-1",
        },
        headers=auth(sa_token),
    )
    assert r.status_code == 409


def test_slug_invalido_422(client, sa_token):
    r = client.post(
        "/admin/tenants",
        json={
            "nombre": "X", "slug": "Granja A!",
            "admin_email": "a@x.test", "admin_password": "clave-admin-1",
        },
        headers=auth(sa_token),
    )
    assert r.status_code == 422


def test_password_corta_422(client, sa_token):
    r = client.post(
        "/admin/tenants",
        json={
            "nombre": "X", "slug": "granja-x",
            "admin_email": "a@x.test", "admin_password": "corta",
        },
        headers=auth(sa_token),
    )
    assert r.status_code == 422


def test_listar_y_patch_tenants(client, sa_token):
    data = make_tenant(client, sa_token, "granja-a")
    tid = data["tenant"]["id"]
    tenants = client.get("/admin/tenants", headers=auth(sa_token)).json()
    assert [t["slug"] for t in tenants] == ["granja-a"]
    assert tenants[0]["usuarios"] == 1
    r = client.patch(
        f"/admin/tenants/{tid}",
        json={"nombre": "Granja A renombrada", "activo": False},
        headers=auth(sa_token),
    )
    assert r.status_code == 200
    assert r.json()["nombre"] == "Granja A renombrada"
    assert r.json()["activo"] is False
    assert client.patch(
        "/admin/tenants/9999", json={"activo": True}, headers=auth(sa_token)
    ).status_code == 404


def test_tenant_desactivado_pierde_acceso(client, sa_token):
    data = make_tenant(client, sa_token, "granja-a")
    pair = login(client, "admin@granja-a.test", "clave-admin-1")
    tok = pair["access_token"]
    assert client.get("/tenant/users", headers=auth(tok)).status_code == 200
    client.patch(
        f"/admin/tenants/{data['tenant']['id']}",
        json={"activo": False},
        headers=auth(sa_token),
    )
    # Fail-closed: el JWT sigue firmado y vigente, pero el tenant está
    # inactivo → 401 en el acto, y el login también.
    assert client.get("/tenant/users", headers=auth(tok)).status_code == 401
    r = client.post(
        "/auth/login",
        json={"email": "admin@granja-a.test", "password": "clave-admin-1"},
    )
    assert r.status_code == 401


def test_admin_endpoints_403_para_no_superadmin(client, sa_token):
    make_tenant(client, sa_token, "granja-a")
    tok = login(client, "admin@granja-a.test", "clave-admin-1")["access_token"]
    assert client.get("/admin/tenants", headers=auth(tok)).status_code == 403
    assert client.post(
        "/admin/tenants",
        json={
            "nombre": "Pirata", "slug": "pirata",
            "admin_email": "p@x.test", "admin_password": "clave-pirata-1",
        },
        headers=auth(tok),
    ).status_code == 403
    assert client.put(
        "/admin/config/latest_version", json={"valor": "9.9.9"}, headers=auth(tok)
    ).status_code == 403
    assert client.get("/admin/telemetria", headers=auth(tok)).status_code == 403


def test_config_global_put(client, sa_token):
    r = client.put(
        "/admin/config/latest_version", json={"valor": "1.2.0"},
        headers=auth(sa_token),
    )
    assert r.status_code == 200
    assert r.json() == {
        "clave": "latest_version", "valor": "1.2.0", "ambito": "global",
    }
    # UPSERT: segunda escritura reemplaza.
    client.put(
        "/admin/config/latest_version", json={"valor": "1.3.0"},
        headers=auth(sa_token),
    )
    cfg = client.get("/config/app").json()
    assert cfg["latest_version"] == "1.3.0"


def test_telemetria_resumen(client, sa_token):
    make_tenant(client, sa_token, "granja-a")
    for device in ("dev-1", "dev-2"):
        client.post(
            "/telemetry",
            json={
                "device_id": device, "plataforma": "android",
                "version_app": "1.0.0", "tenant": "granja-a",
                "datos": {"pesajes_mes": 10, "nube_activa": True},
            },
        )
    client.post(
        "/telemetry",
        json={"device_id": "dev-3", "plataforma": "desktop", "version_app": "1.1.0"},
    )
    resumen = client.get("/admin/telemetria", headers=auth(sa_token)).json()
    por_clave = {(r["tenant"], r["plataforma"], r["version_app"]): r for r in resumen}
    fila = por_clave[("granja-a", "android", "1.0.0")]
    assert fila["dispositivos"] == 2 and fila["reportes"] == 2
    anonima = por_clave[(None, "desktop", "1.1.0")]
    assert anonima["dispositivos"] == 1
