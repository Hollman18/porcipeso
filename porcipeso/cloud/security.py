"""Seguridad de PorciPeso Cloud: hashing, JWT y rate limit de login.

Decisiones (documentadas para los demás agentes):

- **Hashing de contraseñas: argon2-cffi (Argon2id)** — se eligió sobre
  passlib[bcrypt] porque passlib está sin mantenimiento y da problemas
  con Python 3.13+ (este venv corre 3.14); argon2id es el estándar
  actual (OWASP) y la API de ``PasswordHasher`` es directa.
- **Access token: JWT HS256 (PyJWT), 30 min** con claims
  ``sub`` (uuid del usuario), ``tenant_id``, ``rol``, ``nombre``.
- **Refresh token: opaco** (``secrets.token_urlsafe``), 30 días; en la DB
  solo se guarda su SHA-256 (robo de DB no expone tokens vivos). Rotación
  en cada refresh: el viejo queda revocado.
- **Rate limit de login: casero** (sin slowapi): máx 5 fallos por email
  en 15 min; espejo en memoria + tabla ``login_fallos`` (sobrevive
  reinicios del proceso).
"""
from __future__ import annotations

import hashlib
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error, InvalidHashError, VerifyMismatchError

ACCESS_TTL = timedelta(minutes=30)
REFRESH_TTL = timedelta(days=30)
JWT_ALG = "HS256"

MIN_PASSWORD_LEN = 8

_ph = PasswordHasher()

#: Hash de sacrificio: cuando el email no existe igual se verifica una
#: contraseña contra ESTE hash para que el tiempo de respuesta no
#: delate si el email está registrado (anti-enumeración).
_DUMMY_HASH = _ph.hash("porcipeso-dummy-password")


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password_hash: Optional[str], password: str) -> bool:
    try:
        return _ph.verify(password_hash or _DUMMY_HASH, password)
    except (VerifyMismatchError, InvalidHashError, Argon2Error):
        return False


# ------------------------------------------------------------------ JWT

def make_access_token(
    secret: str,
    *,
    user_uuid: str,
    tenant_id: Optional[int],
    rol: str,
    nombre: Optional[str],
    now: Optional[datetime] = None,
) -> str:
    now = now or datetime.now(timezone.utc)
    payload = {
        "sub": user_uuid,
        "tenant_id": tenant_id,
        "rol": rol,
        "nombre": nombre,
        "iat": now,
        "exp": now + ACCESS_TTL,
    }
    return jwt.encode(payload, secret, algorithm=JWT_ALG)


def decode_access_token(secret: str, token: str) -> dict[str, Any]:
    """Decodifica y valida firma+expiración. Lanza jwt.InvalidTokenError."""
    return jwt.decode(token, secret, algorithms=[JWT_ALG])


# -------------------------------------------------------- refresh tokens

def new_refresh_token() -> tuple[str, str, str]:
    """Retorna ``(token, token_hash, expira_en_iso)``."""
    token = secrets.token_urlsafe(48)
    expira = datetime.now(timezone.utc) + REFRESH_TTL
    return token, hash_refresh_token(token), expira.isoformat(timespec="seconds")


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def refresh_expired(expira_en_iso: str) -> bool:
    try:
        expira = datetime.fromisoformat(expira_en_iso)
    except ValueError:
        return True  # fecha corrupta → fail-closed
    if expira.tzinfo is None:
        expira = expira.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) >= expira


# ------------------------------------------------------------ rate limit

class LoginRateLimiter:
    """Máx ``max_fails`` fallos por email por ventana de ``window_s``.

    Memoria (rápido, por proceso) + tabla ``login_fallos`` (persistente:
    un reinicio no resetea el contador). El login exitoso limpia ambos.
    """

    def __init__(self, db, *, max_fails: int = 5, window_s: float = 15 * 60) -> None:
        self._db = db
        self.max_fails = max_fails
        self.window_s = window_s
        self._mem: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, email: str, now: float) -> list[float]:
        hits = [t for t in self._mem.get(email, []) if t >= now - self.window_s]
        if hits:
            self._mem[email] = hits
        else:
            self._mem.pop(email, None)
        return hits

    def blocked(self, email: str) -> bool:
        email = email.strip().lower()
        now = time.time()
        with self._lock:
            hits = self._prune(email, now)
        if len(hits) >= self.max_fails:
            return True
        # Persistencia: cuenta también fallos previos al arranque.
        return self._db.count_login_failures(email, now - self.window_s) >= self.max_fails

    def record_failure(self, email: str) -> None:
        email = email.strip().lower()
        now = time.time()
        with self._lock:
            self._prune(email, now)
            self._mem.setdefault(email, []).append(now)
        self._db.record_login_failure(email, now)

    def clear(self, email: str) -> None:
        email = email.strip().lower()
        with self._lock:
            self._mem.pop(email, None)
        self._db.clear_login_failures(email)
