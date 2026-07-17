"""Admin de tenant: usuarios y config; aislamiento y jerarquía de roles."""
from __future__ import annotations

from .conftest import auth, login, make_tenant


def _admin_token(client, sa_token, slug="granja-a"):
    make_tenant(client, sa_token, slug)
    return login(client, f"admin@{slug}.test", "clave-admin-1")["access_token"]


def test_admin_crea_operador(client, sa_token):
    tok = _admin_token(client, sa_token)
    r = client.post(
        "/tenant/users",
        json={
            "email": "op@granja-a.test", "nombre": "Operario Uno",
            "password": "clave-op-11", "rol": "operador",
        },
        headers=auth(tok),
    )
    assert r.status_code == 201, r.text
    assert r.json()["rol"] == "operador"
    login(client, "op@granja-a.test", "clave-op-11")  # puede entrar


def test_admin_no_puede_crear_superadmin(client, sa_token):
    tok = _admin_token(client, sa_token)
    r = client.post(
        "/tenant/users",
        json={
            "email": "malo@granja-a.test", "password": "clave-mala-1",
            "rol": "superadmin",
        },
        headers=auth(tok),
    )
    assert r.status_code == 422  # rol fuera del contrato admin|operador


def test_admin_puede_crear_otro_admin(client, sa_token):
    tok = _admin_token(client, sa_token)
    r = client.post(
        "/tenant/users",
        json={
            "email": "admin2@granja-a.test", "password": "clave-adm-22",
            "rol": "admin",
        },
        headers=auth(tok),
    )
    assert r.status_code == 201


def test_operador_no_gestiona_usuarios(client, sa_token):
    tok = _admin_token(client, sa_token)
    client.post(
        "/tenant/users",
        json={"email": "op@granja-a.test", "password": "clave-op-11",
              "rol": "operador"},
        headers=auth(tok),
    )
    op_tok = login(client, "op@granja-a.test", "clave-op-11")["access_token"]
    assert client.get("/tenant/users", headers=auth(op_tok)).status_code == 403
    assert client.post(
        "/tenant/users",
        json={"email": "otro@granja-a.test", "password": "clave-otro-1",
              "rol": "operador"},
        headers=auth(op_tok),
    ).status_code == 403
    assert client.put(
        "/tenant/config/banners", json={"valor": []}, headers=auth(op_tok)
    ).status_code == 403


def test_superadmin_no_usa_endpoints_de_tenant(client, sa_token):
    # El superadmin no tiene tenant: fail-closed 403.
    assert client.get("/tenant/users", headers=auth(sa_token)).status_code == 403
    assert client.post(
        "/tenant/users",
        json={"email": "x@x.test", "password": "clave-xx-11", "rol": "operador"},
        headers=auth(sa_token),
    ).status_code == 403


def test_listado_solo_del_propio_tenant(client, sa_token):
    tok_a = _admin_token(client, sa_token, "granja-a")
    tok_b = _admin_token(client, sa_token, "granja-b")
    client.post(
        "/tenant/users",
        json={"email": "op@granja-a.test", "password": "clave-op-11",
              "rol": "operador"},
        headers=auth(tok_a),
    )
    emails_b = [u["email"] for u in
                client.get("/tenant/users", headers=auth(tok_b)).json()]
    assert emails_b == ["admin@granja-b.test"]


def test_admin_no_toca_usuarios_de_otro_tenant(client, sa_token):
    tok_a = _admin_token(client, sa_token, "granja-a")
    tok_b = _admin_token(client, sa_token, "granja-b")
    r = client.post(
        "/tenant/users",
        json={"email": "op@granja-a.test", "password": "clave-op-11",
              "rol": "operador"},
        headers=auth(tok_a),
    )
    uuid_a = r.json()["uuid"]
    # Contrato: usuario de otro tenant → 403; inexistente → 404.
    assert client.patch(
        f"/tenant/users/{uuid_a}", json={"activo": False}, headers=auth(tok_b)
    ).status_code == 403
    assert client.patch(
        "/tenant/users/no-existe-uuid", json={"activo": False},
        headers=auth(tok_b),
    ).status_code == 404
    # Y el usuario de A quedó intacto.
    login(client, "op@granja-a.test", "clave-op-11")


def test_patch_usuario_reset_password_rol_activo(client, sa_token):
    tok = _admin_token(client, sa_token)
    r = client.post(
        "/tenant/users",
        json={"email": "op@granja-a.test", "password": "clave-op-11",
              "rol": "operador"},
        headers=auth(tok),
    )
    uuid_op = r.json()["uuid"]
    # Reset de contraseña.
    r = client.patch(
        f"/tenant/users/{uuid_op}", json={"password": "clave-nueva-9"},
        headers=auth(tok),
    )
    assert r.status_code == 200
    assert client.post(
        "/auth/login",
        json={"email": "op@granja-a.test", "password": "clave-op-11"},
    ).status_code == 401
    login(client, "op@granja-a.test", "clave-nueva-9")
    # Cambio de rol (solo admin|operador; superadmin → 422).
    r = client.patch(
        f"/tenant/users/{uuid_op}", json={"rol": "admin"}, headers=auth(tok)
    )
    assert r.status_code == 200 and r.json()["rol"] == "admin"
    assert client.patch(
        f"/tenant/users/{uuid_op}", json={"rol": "superadmin"}, headers=auth(tok)
    ).status_code == 422
    # Desactivar: login 401 genérico y su token viejo muere.
    op_tok = login(client, "op@granja-a.test", "clave-nueva-9")["access_token"]
    client.patch(f"/tenant/users/{uuid_op}", json={"activo": False},
                 headers=auth(tok))
    assert client.post(
        "/auth/login",
        json={"email": "op@granja-a.test", "password": "clave-nueva-9"},
    ).status_code == 401
    assert client.get("/sync/sesiones", headers=auth(op_tok)).status_code == 401


def test_email_duplicado_409(client, sa_token):
    tok = _admin_token(client, sa_token)
    body = {"email": "op@granja-a.test", "password": "clave-op-11",
            "rol": "operador"}
    assert client.post("/tenant/users", json=body, headers=auth(tok)).status_code == 201
    assert client.post("/tenant/users", json=body, headers=auth(tok)).status_code == 409


def test_config_de_tenant(client, sa_token):
    tok = _admin_token(client, sa_token)
    r = client.put(
        "/tenant/config/min_version", json={"valor": "1.1.0"}, headers=auth(tok)
    )
    assert r.status_code == 200
    assert r.json()["ambito"] == "tenant"
    cfg = client.get("/config/app", params={"tenant": "granja-a"}).json()
    assert cfg["min_version"] == "1.1.0"
