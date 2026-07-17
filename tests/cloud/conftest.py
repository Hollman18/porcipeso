"""Fixtures y helpers de los tests del servidor nube (porcipeso.cloud)."""
from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from porcipeso.cloud.app import create_app

# ≥32 bytes: PyJWT exige/recomienda claves HMAC de al menos 256 bits.
SECRET = "test-secret-porcipeso-cloud-0123456789abcdef"
SA_EMAIL = "root@porcipeso.test"
SA_PASS = "superclave-1"


@pytest.fixture()
def db_path(tmp_path):
    return tmp_path / "cloud.db"


@pytest.fixture()
def app(db_path):
    return create_app(
        str(db_path), SECRET,
        superadmin_email=SA_EMAIL, superadmin_password=SA_PASS,
    )


@pytest.fixture()
def client(app):
    with TestClient(app) as c:
        yield c


def login(client: TestClient, email: str, password: str) -> dict[str, Any]:
    r = client.post("/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def sa_token(client) -> str:
    return login(client, SA_EMAIL, SA_PASS)["access_token"]


def make_tenant(
    client: TestClient,
    sa_token: str,
    slug: str = "granja-a",
    *,
    nombre: str | None = None,
    admin_email: str | None = None,
    admin_password: str = "clave-admin-1",
) -> dict[str, Any]:
    r = client.post(
        "/admin/tenants",
        json={
            "nombre": nombre or slug.title(),
            "slug": slug,
            "admin_email": admin_email or f"admin@{slug}.test",
            "admin_password": admin_password,
        },
        headers=auth(sa_token),
    )
    assert r.status_code == 201, r.text
    return r.json()


def sesion_payload(uuid: str, **extra: Any) -> dict[str, Any]:
    base = {
        "uuid": uuid,
        "granja": "La Esperanza",
        "lote": "L-42",
        "corral_origen": "C3",
        "destino": "Planta Norte",
        "operador": "Pedro",
        "hora_entrada": "2026-07-16T08:00:00+00:00",
        "estado": "cerrada",
        "modo": "lote",
        "total_kg": 1250.5,
        "total_animales": 12,
        "promedio_final": 104.208,
    }
    base.update(extra)
    return base


def evento_payload(uuid: str, sesion_uuid: str, **extra: Any) -> dict[str, Any]:
    base = {
        "uuid": uuid,
        "sesion_uuid": sesion_uuid,
        "ts_ms": 1_000,
        "peso_antes": 0.0,
        "peso_despues": 104.2,
        "delta_kg": 104.2,
        "animales_estimados": 1,
        "estab_ms": 800,
        "tipo": "subida",
    }
    base.update(extra)
    return base
