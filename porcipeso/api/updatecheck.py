"""Chequeo de actualización — GET /api/update/status.

Un SOLO lugar donde los clientes (UI de escritorio y, por paridad de
contrato, el shim del APK) preguntan si hay versión nueva y qué banners
remotos mostrar.

Contrato del cloud (en construcción)::

    GET {cloud}/config/app?tenant=slug
    → {latest_version, min_version, apk_url,
       banners: [{id, texto, boton, url, desde, hasta, solo_sin_nube}]}

Configuración (un solo lugar por cliente):
  - PORCIPESO_CLOUD_URL  URL base de la nube; vacía (default) = las
                         features remotas quedan APAGADAS en silencio.
  - PORCIPESO_TENANT     slug del tenant (opcional).
  - PORCIPESO_VERSION    override de la versión local (tests/empaques).

Tolerante a fallo: cualquier error de red/JSON degrada a
``{update_available: false}`` — la app local nunca se rompe por la nube.
"""
from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter

router = APIRouter()

#: URL base de la nube por defecto. Vacía = features remotas apagadas.
DEFAULT_CLOUD_URL = ""

FETCH_TIMEOUT_S = 3.0
CACHE_TTL_S = 6 * 3600  # 6 horas

#: cache en memoria: (cloud_url, tenant) -> (monotonic_ts, config dict)
_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}


# ------------------------------------------------------------------ versión

def read_local_version() -> str:
    """Versión local: env > archivo VERSION (repo o bundle PyInstaller)."""
    env = os.environ.get("PORCIPESO_VERSION")
    if env:
        return env.strip()
    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "VERSION")
    # porcipeso/api/updatecheck.py -> raíz del repo
    candidates.append(Path(__file__).resolve().parents[2] / "VERSION")
    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8").strip()
            if text:
                return text
        except OSError:
            continue
    return "0.0.0"


_SEMVER_RE = re.compile(r"^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?")


def parse_semver(version: str) -> tuple[int, int, int]:
    """'2.1.0' -> (2, 1, 0). Lo no parseable cuenta como (0, 0, 0)."""
    m = _SEMVER_RE.match(str(version or ""))
    if not m:
        return (0, 0, 0)
    return tuple(int(g or 0) for g in m.groups())  # type: ignore[return-value]


def semver_cmp(a: str, b: str) -> int:
    """-1 si a < b, 0 si iguales, 1 si a > b (comparación numérica)."""
    ta, tb = parse_semver(a), parse_semver(b)
    return (ta > tb) - (ta < tb)


# ------------------------------------------------------------------- fetch

def _cloud_url() -> str:
    return os.environ.get("PORCIPESO_CLOUD_URL", DEFAULT_CLOUD_URL).strip()


def _tenant() -> str:
    return os.environ.get("PORCIPESO_TENANT", "").strip()


def fetch_remote_config(cloud_url: str, tenant: str) -> Optional[dict[str, Any]]:
    """GET {cloud}/config/app (timeout 3 s, cache 6 h). None si falla."""
    key = (cloud_url, tenant)
    cached = _cache.get(key)
    if cached is not None and time.monotonic() - cached[0] < CACHE_TTL_S:
        return cached[1]
    params = {"tenant": tenant} if tenant else None
    try:
        resp = httpx.get(
            cloud_url.rstrip("/") + "/config/app",
            params=params,
            timeout=FETCH_TIMEOUT_S,
        )
        resp.raise_for_status()
        config = resp.json()
        if not isinstance(config, dict):
            raise ValueError("config remota no es un objeto JSON")
    except Exception:
        # Falla de red/timeout/JSON: se degrada; se conserva un cache
        # vencido si existía (mejor config vieja que nada).
        return cached[1] if cached is not None else None
    _cache[key] = (time.monotonic(), config)
    return config


def clear_cache() -> None:
    """Limpia el cache (tests)."""
    _cache.clear()


# ---------------------------------------------------------------- endpoint

def build_status() -> dict[str, Any]:
    current = read_local_version()
    disabled = {
        "current": current,
        "latest": None,
        "update_available": False,
        "min_version_ok": True,
        "apk_url": None,
        "banners": [],
    }
    cloud = _cloud_url()
    if not cloud:
        return disabled  # sin nube configurada: apagado silencioso
    config = fetch_remote_config(cloud, _tenant())
    if config is None:
        return disabled  # nube caída: degradación silenciosa
    latest = config.get("latest_version") or None
    min_version = config.get("min_version") or None
    banners = config.get("banners")
    return {
        "current": current,
        "latest": latest,
        "update_available": bool(latest) and semver_cmp(current, str(latest)) < 0,
        "min_version_ok": (
            True if not min_version else semver_cmp(current, str(min_version)) >= 0
        ),
        "apk_url": config.get("apk_url") or None,
        "banners": banners if isinstance(banners, list) else [],
    }


@router.get("/api/update/status")
def update_status() -> dict[str, Any]:
    return build_status()
