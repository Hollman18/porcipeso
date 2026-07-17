"""Cliente de autenticación contra PorciPeso Cloud (escritorio).

La app de escritorio habla con la nube SIEMPRE desde el proceso Python
(la UI llama a /api/cloud/* del mismo origen): así no hay CORS y los
tokens viven en un solo dueño — el :class:`TokenBox` del sync worker.

Contrato del cloud (porcipeso/cloud/app.py):

- ``POST /auth/login {email, password}`` →
  ``{access_token (JWT 30 min, claims sub/tenant_id/rol/nombre),
     refresh_token (30 d, rotativo), expires_in, token_type}``
- ``POST /auth/refresh {refresh_token}`` → mismo par (el refresh viejo
  queda revocado: UN uso).
- ``POST /auth/logout {refresh_token}`` → revoca (idempotente).
- ``GET /health`` · ``GET /config/app?tenant=slug`` (públicos).

Seguridad: NUNCA se loguean tokens; el access va solo en Authorization.
Los claims del JWT se decodifican SIN verificar firma — son solo UX
(nombre/rol en pantalla); la autorización real la hace la nube en cada
request.
"""
from __future__ import annotations

import base64
import json
import threading
import time
from typing import Any, Optional

import httpx

#: Timeout corto: la nube es opcional, la báscula no puede esperarla.
HTTP_TIMEOUT_S = 6.0

#: Margen para refrescar ANTES de que expire el access (segundos).
REFRESH_SKEW_S = 60.0


class CloudError(Exception):
    """Error de la nube con status HTTP (4xx/5xx con respuesta)."""

    def __init__(self, status: int, detail: str = "") -> None:
        super().__init__(f"HTTP {status}: {detail}" if detail else f"HTTP {status}")
        self.status = status
        self.detail = detail


class CloudOffline(CloudError):
    """No hubo respuesta (red caída / servidor apagado / timeout)."""

    def __init__(self, detail: str = "sin conexión con la nube") -> None:
        super().__init__(0, detail)


class SessionExpired(CloudError):
    """El refresh token ya no sirve: hay que iniciar sesión de nuevo."""

    def __init__(self, detail: str = "sesión vencida") -> None:
        super().__init__(401, detail)


def _base(cloud_url: str) -> str:
    return str(cloud_url or "").strip().rstrip("/")


def _request(
    method: str, url: str, json_body: Optional[dict[str, Any]] = None,
    headers: Optional[dict[str, str]] = None,
) -> httpx.Response:
    try:
        return httpx.request(
            method, url, json=json_body, headers=headers, timeout=HTTP_TIMEOUT_S
        )
    except httpx.HTTPError as exc:
        raise CloudOffline(f"{type(exc).__name__}") from exc


def _detail(resp: httpx.Response) -> str:
    try:
        return str(resp.json().get("detail", ""))
    except Exception:
        return ""


# ------------------------------------------------------------------ claims

def decode_claims(access_token: str) -> dict[str, Any]:
    """Payload del JWT SIN verificar firma (solo para mostrar nombre/rol)."""
    try:
        part = access_token.split(".")[1]
        part += "=" * (-len(part) % 4)
        data = json.loads(base64.urlsafe_b64decode(part.encode("ascii")))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def perfil_from_token(access_token: str, email: str = "") -> dict[str, Any]:
    """Perfil de UX {email, nombre, rol, tenant_id} desde los claims."""
    claims = decode_claims(access_token)
    return {
        "email": email,
        "nombre": claims.get("nombre"),
        "rol": claims.get("rol"),
        "tenant_id": claims.get("tenant_id"),
    }


# ------------------------------------------------------------- operaciones

def cloud_probe(cloud_url: str, tenant: str = "") -> dict[str, Any]:
    """GET /health + GET /config/app?tenant=… → {ok, health, config, error}."""
    base = _base(cloud_url)
    out: dict[str, Any] = {"ok": False, "health": False, "config": None, "error": None}
    try:
        r = _request("GET", f"{base}/health")
        out["health"] = r.status_code == 200
        q = f"?tenant={tenant.strip().lower()}" if tenant else ""
        rc = _request("GET", f"{base}/config/app{q}")
        if rc.status_code == 200:
            out["config"] = rc.json()
        out["ok"] = bool(out["health"] and rc.status_code == 200)
        if not out["ok"]:
            out["error"] = f"health={r.status_code} config={rc.status_code}"
    except CloudOffline as exc:
        out["error"] = exc.detail
    return out


def cloud_login(cloud_url: str, email: str, password: str) -> dict[str, Any]:
    """POST /auth/login. Retorna el par de tokens + expires_in.

    Lanza :class:`CloudError` (401 credenciales, 429 rate limit) o
    :class:`CloudOffline`.
    """
    resp = _request(
        "POST", f"{_base(cloud_url)}/auth/login",
        json_body={"email": email, "password": password},
    )
    if resp.status_code != 200:
        raise CloudError(resp.status_code, _detail(resp))
    return resp.json()


def cloud_refresh(cloud_url: str, refresh_token: str) -> dict[str, Any]:
    """POST /auth/refresh (rotativo). 401 → :class:`SessionExpired`."""
    resp = _request(
        "POST", f"{_base(cloud_url)}/auth/refresh",
        json_body={"refresh_token": refresh_token},
    )
    if resp.status_code == 401:
        raise SessionExpired(_detail(resp) or "refresh token inválido")
    if resp.status_code != 200:
        raise CloudError(resp.status_code, _detail(resp))
    return resp.json()


def cloud_logout(cloud_url: str, refresh_token: str) -> None:
    """POST /auth/logout — best-effort: nunca lanza."""
    try:
        _request(
            "POST", f"{_base(cloud_url)}/auth/logout",
            json_body={"refresh_token": refresh_token},
        )
    except CloudError:
        pass


# --------------------------------------------------------------- TokenBox

class TokenBox:
    """Dueño único del par access/refresh con auto-refresh perezoso.

    - ``access`` vive SOLO en memoria.
    - ``refresh`` se persiste vía ``on_refresh_rotated`` (el sync worker
      lo guarda en la tabla ``cloud_state`` para sobrevivir reinicios).
    - Rotación: cada refresh invalida el anterior, por eso el proceso
      API es el ÚNICO que refresca (la UI le pide tokens a /api/cloud/*).
    """

    def __init__(self, on_refresh_rotated=None) -> None:
        self._lock = threading.Lock()
        self.cloud_url: str = ""
        self._access: str = ""
        self._refresh: str = ""
        self._expires_at: float = 0.0
        self._on_rotated = on_refresh_rotated

    # -- estado ----------------------------------------------------------
    @property
    def configured(self) -> bool:
        with self._lock:
            return bool(self.cloud_url and self._refresh)

    def set_session(
        self, cloud_url: str, access_token: str, refresh_token: str,
        expires_in: Optional[float] = None,
    ) -> None:
        with self._lock:
            self.cloud_url = _base(cloud_url)
            self._access = access_token or ""
            self._refresh = refresh_token or ""
            ttl = float(expires_in) if expires_in else (30 * 60 if access_token else 0)
            self._expires_at = time.time() + ttl if access_token else 0.0

    def clear(self) -> str:
        """Borra la sesión y retorna el refresh que había (para revocarlo)."""
        with self._lock:
            old = self._refresh
            self._access = ""
            self._refresh = ""
            self._expires_at = 0.0
            return old

    def snapshot(self) -> dict[str, Any]:
        """Copia del par actual (para GET /api/cloud/token)."""
        with self._lock:
            return {
                "access_token": self._access,
                "refresh_token": self._refresh,
                "expires_in": max(0, int(self._expires_at - time.time())),
            }

    # -- acceso ----------------------------------------------------------
    def get_access(self) -> str:
        """Access vigente; refresca si expiró o está por expirar.

        Lanza SessionExpired / CloudOffline / CloudError.
        """
        with self._lock:
            if self._access and time.time() < self._expires_at - REFRESH_SKEW_S:
                return self._access
        return self.force_refresh()

    def force_refresh(self) -> str:
        """Refresca YA (p. ej. tras un 401 con el access actual)."""
        with self._lock:
            cloud_url, refresh = self.cloud_url, self._refresh
        if not (cloud_url and refresh):
            raise SessionExpired("sin sesión de nube")
        pair = cloud_refresh(cloud_url, refresh)
        access = str(pair.get("access_token") or "")
        new_refresh = str(pair.get("refresh_token") or "")
        expires_in = float(pair.get("expires_in") or 30 * 60)
        with self._lock:
            self._access = access
            if new_refresh:
                self._refresh = new_refresh
            self._expires_at = time.time() + expires_in
        if new_refresh and self._on_rotated is not None:
            try:
                self._on_rotated(new_refresh)
            except Exception:
                pass  # persistir el refresh nunca tumba el flujo
        return access
