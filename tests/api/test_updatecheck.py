"""Tests de porcipeso/api/updatecheck.py — GET /api/update/status.

httpx se monkeypatchea (sin red): config remota OK, timeout →
degradación silenciosa, cache 6 h, semver y min_version.
"""
from __future__ import annotations

import httpx
import pathlib
import pytest
from fastapi.testclient import TestClient

from porcipeso.api import updatecheck
from porcipeso.api.app import create_app

LOCAL_VERSION = (pathlib.Path(__file__).resolve().parents[2] / "VERSION").read_text().strip()

REMOTE = {
    "latest_version": "99.0.0",  # siempre mayor que la local: garantiza update_available
    "min_version": "2.0.0",
    "apk_url": "https://cdn.example.com/porcipeso-2.2.0.apk",
    "banners": [
        {
            "id": "promo1",
            "texto": "Nueva función de nube",
            "boton": "Ver más",
            "url": "https://example.com",
            "desde": None,
            "hasta": None,
            "solo_sin_nube": True,
        }
    ],
}


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    """Cache limpio y entorno neutro en cada test."""
    updatecheck.clear_cache()
    monkeypatch.delenv("PORCIPESO_CLOUD_URL", raising=False)
    monkeypatch.delenv("PORCIPESO_TENANT", raising=False)
    monkeypatch.delenv("PORCIPESO_VERSION", raising=False)
    yield
    updatecheck.clear_cache()


def _fake_get(payload, calls=None):
    def fake(url, params=None, timeout=None):
        if calls is not None:
            calls.append({"url": url, "params": params, "timeout": timeout})
        request = httpx.Request("GET", url)
        return httpx.Response(200, json=payload, request=request)

    return fake


# ------------------------------------------------------------------ semver

@pytest.mark.parametrize(
    "raw, expected",
    [
        ("2.1.0", (2, 1, 0)),
        ("v2.1", (2, 1, 0)),
        ("3", (3, 0, 0)),
        ("2.10.1", (2, 10, 1)),
        ("basura", (0, 0, 0)),
        ("", (0, 0, 0)),
    ],
)
def test_parse_semver(raw, expected):
    assert updatecheck.parse_semver(raw) == expected


@pytest.mark.parametrize(
    "a, b, expected",
    [
        ("2.1.0", "2.2.0", -1),
        ("2.2.0", "2.1.0", 1),
        ("2.1.0", "2.1.0", 0),
        ("2.10.0", "2.2.0", 1),   # numérico, no lexicográfico
        ("2.1", "2.1.0", 0),
    ],
)
def test_semver_cmp(a, b, expected):
    assert updatecheck.semver_cmp(a, b) == expected


def test_read_local_version_from_file_and_env(monkeypatch):
    # el archivo VERSION de la raíz del repo existe (lo define release)
    assert updatecheck.read_local_version() == LOCAL_VERSION
    monkeypatch.setenv("PORCIPESO_VERSION", "9.9.9")
    assert updatecheck.read_local_version() == "9.9.9"


# ------------------------------------------------------------- sin nube

def test_sin_cloud_url_apagado_silencioso():
    status = updatecheck.build_status()
    assert status == {
        "current": LOCAL_VERSION,
        "latest": None,
        "update_available": False,
        "min_version_ok": True,
        "apk_url": None,
        "banners": [],
    }


# -------------------------------------------------------- config remota OK

def test_config_remota_ok(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setenv("PORCIPESO_CLOUD_URL", "https://nube.example.com/")
    monkeypatch.setenv("PORCIPESO_TENANT", "granja1")
    monkeypatch.setattr(updatecheck.httpx, "get", _fake_get(REMOTE, calls))

    status = updatecheck.build_status()
    assert status["current"] == LOCAL_VERSION
    assert status["latest"] == "99.0.0"
    assert status["update_available"] is True
    assert status["min_version_ok"] is True       # 2.1.0 >= 2.0.0
    assert status["apk_url"] == REMOTE["apk_url"]
    assert status["banners"] == REMOTE["banners"]  # passthrough intacto

    # contrato del cloud: GET {cloud}/config/app?tenant=slug, timeout 3 s
    assert calls[0]["url"] == "https://nube.example.com/config/app"
    assert calls[0]["params"] == {"tenant": "granja1"}
    assert calls[0]["timeout"] == updatecheck.FETCH_TIMEOUT_S


def test_min_version_no_cumplida(monkeypatch):
    monkeypatch.setenv("PORCIPESO_CLOUD_URL", "https://nube.example.com")
    monkeypatch.setenv("PORCIPESO_VERSION", "1.5.0")
    monkeypatch.setattr(updatecheck.httpx, "get", _fake_get(REMOTE))
    status = updatecheck.build_status()
    assert status["update_available"] is True
    assert status["min_version_ok"] is False      # 1.5.0 < 2.0.0


def test_ya_en_la_ultima_version(monkeypatch):
    monkeypatch.setenv("PORCIPESO_CLOUD_URL", "https://nube.example.com")
    monkeypatch.setenv("PORCIPESO_VERSION", "99.0.0")  # = latest del REMOTE
    monkeypatch.setattr(updatecheck.httpx, "get", _fake_get(REMOTE))
    status = updatecheck.build_status()
    assert status["update_available"] is False
    assert status["min_version_ok"] is True


# ------------------------------------------------------ fallos → degradación

def test_timeout_degrada_a_sin_update(monkeypatch):
    monkeypatch.setenv("PORCIPESO_CLOUD_URL", "https://nube.example.com")

    def timeout_get(url, params=None, timeout=None):
        raise httpx.TimeoutException("timed out")

    monkeypatch.setattr(updatecheck.httpx, "get", timeout_get)
    status = updatecheck.build_status()
    assert status["update_available"] is False
    assert status["min_version_ok"] is True
    assert status["latest"] is None
    assert status["banners"] == []


def test_http_500_degrada(monkeypatch):
    monkeypatch.setenv("PORCIPESO_CLOUD_URL", "https://nube.example.com")

    def bad_get(url, params=None, timeout=None):
        request = httpx.Request("GET", url)
        return httpx.Response(500, text="boom", request=request)

    monkeypatch.setattr(updatecheck.httpx, "get", bad_get)
    assert updatecheck.build_status()["update_available"] is False


# ---------------------------------------------------------------- cache 6 h

def test_cache_6h_no_refetchea(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setenv("PORCIPESO_CLOUD_URL", "https://nube.example.com")
    monkeypatch.setattr(updatecheck.httpx, "get", _fake_get(REMOTE, calls))

    updatecheck.build_status()
    updatecheck.build_status()
    assert len(calls) == 1  # segunda llamada sale del cache

    # cache vencido → refetch; si el refetch falla, sirve el cache viejo
    key = ("https://nube.example.com", "")
    ts, config = updatecheck._cache[key]
    updatecheck._cache[key] = (ts - updatecheck.CACHE_TTL_S - 1, config)

    def timeout_get(url, params=None, timeout=None):
        raise httpx.TimeoutException("timed out")

    monkeypatch.setattr(updatecheck.httpx, "get", timeout_get)
    status = updatecheck.build_status()
    assert status["latest"] == "99.0.0"  # config vieja mejor que nada


# ---------------------------------------------------------------- endpoint

def test_endpoint_wired_en_app(tmp_path, monkeypatch):
    monkeypatch.setenv("PORCIPESO_CLOUD_URL", "https://nube.example.com")
    monkeypatch.setattr(updatecheck.httpx, "get", _fake_get(REMOTE))
    app = create_app(tmp_path / "t.db")
    with TestClient(app) as client:
        resp = client.get("/api/update/status")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data) == {
        "current", "latest", "update_available",
        "min_version_ok", "apk_url", "banners",
    }
    assert data["update_available"] is True


def test_endpoint_sin_nube(tmp_path):
    app = create_app(tmp_path / "t.db")
    with TestClient(app) as client:
        resp = client.get("/api/update/status")
    assert resp.status_code == 200
    assert resp.json()["update_available"] is False
