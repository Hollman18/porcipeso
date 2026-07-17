"""Auth: bootstrap, login/refresh/rotación/logout, rate limit, JWT roto."""
from __future__ import annotations

import time

import jwt as pyjwt
import pytest
from fastapi.testclient import TestClient

from porcipeso.cloud.app import create_app

from .conftest import SA_EMAIL, SA_PASS, SECRET, auth, login


def test_bootstrap_superadmin_y_claims(client):
    data = login(client, SA_EMAIL, SA_PASS)
    assert data["token_type"] == "bearer"
    assert data["expires_in"] == 30 * 60
    assert data["refresh_token"]
    claims = pyjwt.decode(data["access_token"], SECRET, algorithms=["HS256"])
    assert claims["rol"] == "superadmin"
    assert claims["tenant_id"] is None
    assert claims["sub"]  # uuid del usuario
    assert "nombre" in claims


def test_bootstrap_solo_si_no_existe_superadmin(db_path):
    app1 = create_app(
        str(db_path), SECRET,
        superadmin_email=SA_EMAIL, superadmin_password=SA_PASS,
    )
    # Segundo arranque con OTRO email: no debe crear nada.
    app2 = create_app(
        str(db_path), SECRET,
        superadmin_email="otro@porcipeso.test", superadmin_password="otraclave-1",
    )
    with TestClient(app2) as c:
        assert c.post(
            "/auth/login",
            json={"email": "otro@porcipeso.test", "password": "otraclave-1"},
        ).status_code == 401
        login(c, SA_EMAIL, SA_PASS)  # el original sigue siendo el único
    app1.state.db.close()


def test_jwt_secret_obligatorio(tmp_path):
    with pytest.raises(RuntimeError, match="CLOUD_JWT_SECRET"):
        create_app(str(tmp_path / "x.db"), "")


def test_login_generico_sin_enumeracion(client):
    r1 = client.post(
        "/auth/login", json={"email": "noexiste@x.test", "password": "loquesea1"}
    )
    r2 = client.post(
        "/auth/login", json={"email": SA_EMAIL, "password": "incorrecta1"}
    )
    assert r1.status_code == r2.status_code == 401
    # Mismo mensaje: no delata si el email está registrado.
    assert r1.json()["detail"] == r2.json()["detail"]


def test_refresh_rota_el_token(client):
    pair = login(client, SA_EMAIL, SA_PASS)
    r = client.post("/auth/refresh", json={"refresh_token": pair["refresh_token"]})
    assert r.status_code == 200
    pair2 = r.json()
    assert pair2["refresh_token"] != pair["refresh_token"]
    assert pair2["access_token"]
    # El refresh viejo quedó revocado (un refresh = un uso).
    r = client.post("/auth/refresh", json={"refresh_token": pair["refresh_token"]})
    assert r.status_code == 401
    # El nuevo sigue vivo.
    r = client.post("/auth/refresh", json={"refresh_token": pair2["refresh_token"]})
    assert r.status_code == 200


def test_logout_revoca_refresh(client):
    pair = login(client, SA_EMAIL, SA_PASS)
    r = client.post("/auth/logout", json={"refresh_token": pair["refresh_token"]})
    assert r.status_code == 200 and r.json() == {"ok": True}
    r = client.post("/auth/refresh", json={"refresh_token": pair["refresh_token"]})
    assert r.status_code == 401
    # Idempotente: logout de un token desconocido no revela nada.
    r = client.post("/auth/logout", json={"refresh_token": "x" * 32})
    assert r.status_code == 200


def test_refresh_invalido(client):
    r = client.post("/auth/refresh", json={"refresh_token": "no-existe" * 4})
    assert r.status_code == 401


def test_rate_limit_login(client):
    email = SA_EMAIL
    for _ in range(5):
        r = client.post(
            "/auth/login", json={"email": email, "password": "malamala1"}
        )
        assert r.status_code == 401
    # Sexto intento: bloqueado AUNQUE la contraseña sea la correcta.
    r = client.post("/auth/login", json={"email": email, "password": SA_PASS})
    assert r.status_code == 429


def test_rate_limit_no_afecta_otros_emails(client, sa_token):
    for _ in range(5):
        client.post(
            "/auth/login", json={"email": "victima@x.test", "password": "mala1234"}
        )
    assert client.post(
        "/auth/login", json={"email": "victima@x.test", "password": "mala1234"}
    ).status_code == 429
    # El superadmin (otro email) entra normal.
    login(client, SA_EMAIL, SA_PASS)


def test_jwt_expirado_401(client):
    now = int(time.time())
    expired = pyjwt.encode(
        {
            "sub": "cualquiera", "tenant_id": None, "rol": "superadmin",
            "nombre": None, "iat": now - 3600, "exp": now - 1800,
        },
        SECRET,
        algorithm="HS256",
    )
    r = client.get("/admin/tenants", headers=auth(expired))
    assert r.status_code == 401


def test_jwt_alterado_401(client, sa_token):
    tampered = sa_token[:-4] + ("AAAA" if not sa_token.endswith("AAAA") else "BBBB")
    assert client.get("/admin/tenants", headers=auth(tampered)).status_code == 401
    # Firmado con OTRO secreto → 401.
    forged = pyjwt.encode(
        {"sub": "x", "tenant_id": None, "rol": "superadmin", "nombre": None,
         "iat": int(time.time()), "exp": int(time.time()) + 600},
        "otro-secreto",
        algorithm="HS256",
    )
    assert client.get("/admin/tenants", headers=auth(forged)).status_code == 401


def test_sin_token_401(client):
    assert client.get("/admin/tenants").status_code == 401
    assert client.get("/sync/sesiones").status_code == 401
    assert client.get("/tenant/users").status_code == 401
