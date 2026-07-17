"""API FastAPI de PorciPeso Cloud (servidor nube multi-cliente).

``create_app(db_path, jwt_secret)`` arma la aplicación completa:
autenticación con roles, sincronización de pesajes, configuración
remota y telemetría. Un solo proceso: ``python -m porcipeso.cloud``.

Seguridad (fail-closed):

- Cada request autenticado recarga el usuario desde la DB: un usuario
  desactivado (o cuyo tenant fue desactivado) pierde acceso aunque su
  JWT siga vigente, y el rol efectivo es el de la DB, no el del token.
- Todo endpoint de datos filtra por el ``tenant_id`` del usuario: un
  token del tenant A jamás ve datos del tenant B.
- El superadmin NO tiene tenant: no puede usar /tenant/* ni /sync/*.
- Errores de login genéricos (sin enumeración de emails) + rate limit.
- CORS abierto SOLO para GET /config/app (endpoint público de solo lectura).
"""
from __future__ import annotations

import json
import re
import sqlite3
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Literal, Optional

import jwt
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field

from porcipeso.cloud import security
from porcipeso.cloud.db import CloudDB
from porcipeso.cloud.security import LoginRateLimiter

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")

#: Tope del payload de telemetría (datos serializados), anti-abuso.
MAX_TELEMETRY_BYTES = 8_192

PasswordStr = Field(min_length=security.MIN_PASSWORD_LEN, max_length=256)
RolTenant = Literal["admin", "operador"]


# ------------------------------------------------------------------ modelos

class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)


class RefreshIn(BaseModel):
    refresh_token: str = Field(min_length=8, max_length=512)


class TenantCreate(BaseModel):
    nombre: str = Field(min_length=1, max_length=120)
    slug: str = Field(min_length=2, max_length=63)
    admin_email: str = Field(min_length=3, max_length=254)
    admin_password: str = PasswordStr


class TenantPatch(BaseModel):
    nombre: Optional[str] = Field(default=None, min_length=1, max_length=120)
    activo: Optional[bool] = None


class UserCreate(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    nombre: Optional[str] = Field(default=None, max_length=120)
    password: str = PasswordStr
    rol: RolTenant  # JAMÁS superadmin: 422 por contrato de tipo


class UserPatch(BaseModel):
    activo: Optional[bool] = None
    rol: Optional[RolTenant] = None
    password: Optional[str] = Field(
        default=None, min_length=security.MIN_PASSWORD_LEN, max_length=256
    )
    nombre: Optional[str] = Field(default=None, max_length=120)


class ConfigPut(BaseModel):
    valor: Any


class SesionSync(BaseModel):
    """Espejo de la tabla local `sesiones` (+ uuid obligatorio)."""

    model_config = ConfigDict(extra="ignore")

    uuid: str = Field(min_length=8, max_length=64)
    granja: Optional[str] = None
    lote: Optional[str] = None
    corral_origen: Optional[str] = None
    destino: Optional[str] = None
    placa: Optional[str] = None
    conductor: Optional[str] = None
    operador: Optional[str] = None
    bascula_id: Optional[str] = None
    peso_ref_inicial: Optional[float] = None
    hora_entrada: Optional[str] = None
    hora_salida: Optional[str] = None
    total_kg: Optional[float] = None
    total_animales: Optional[int] = None
    promedio_final: Optional[float] = None
    conteo_fisico: Optional[int] = None
    diferencia_conciliacion: Optional[int] = None
    estado: Literal["abierta", "cerrada", "anulada"] = "abierta"
    modo: Literal["lote", "unidades"] = "lote"


class EventoSync(BaseModel):
    """Espejo de la tabla local `eventos_pesaje` (referencia por uuid)."""

    model_config = ConfigDict(extra="ignore")

    uuid: str = Field(min_length=8, max_length=64)
    sesion_uuid: str = Field(min_length=8, max_length=64)
    ts_ms: int
    peso_antes: float
    peso_despues: float
    delta_kg: float
    animales_estimados: int
    animales_confirmados: Optional[int] = None
    estab_ms: int = 0
    tipo: Literal["referencia", "subida", "bajada", "reingreso", "ajuste"]
    ambiguo: bool = False
    opciones: Optional[list[int]] = None
    motivo_bajada: Optional[str] = None
    evento_relacionado_uuid: Optional[str] = None
    confirmado_por: Optional[str] = None


class SyncPushIn(BaseModel):
    device_id: str = Field(min_length=1, max_length=128)
    sesiones: list[SesionSync] = Field(default_factory=list, max_length=500)
    eventos: list[EventoSync] = Field(default_factory=list, max_length=5000)


class TelemetryIn(BaseModel):
    device_id: str = Field(min_length=1, max_length=128)
    plataforma: Optional[str] = Field(default=None, max_length=64)
    version_app: Optional[str] = Field(default=None, max_length=32)
    tenant: Optional[str] = Field(default=None, max_length=63)
    datos: dict[str, Any] = Field(default_factory=dict)


# --------------------------------------------------------------- auth deps

@dataclass
class AuthUser:
    id: int
    uuid: str
    tenant_id: Optional[int]
    email: str
    nombre: Optional[str]
    rol: str


_bearer = HTTPBearer(auto_error=False)


def _unauthorized(detail: str = "no autorizado") -> HTTPException:
    return HTTPException(
        status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"}
    )


def current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> AuthUser:
    if credentials is None or not credentials.credentials:
        raise _unauthorized()
    try:
        claims = security.decode_access_token(
            request.app.state.jwt_secret, credentials.credentials
        )
    except jwt.InvalidTokenError:  # expirado, firma alterada, malformado…
        raise _unauthorized("token inválido o expirado")
    db: CloudDB = request.app.state.db
    user = db.get_user_by_uuid(str(claims.get("sub", "")))
    if not user or not user["activo"]:
        raise _unauthorized()
    if user["tenant_id"] is not None:
        tenant = db.get_tenant(user["tenant_id"])
        if not tenant or not tenant["activo"]:
            raise _unauthorized()
    # Rol y tenant EFECTIVOS = los de la DB (no los claims del token).
    return AuthUser(
        id=user["id"], uuid=user["uuid"], tenant_id=user["tenant_id"],
        email=user["email"], nombre=user["nombre"], rol=user["rol"],
    )


def require_superadmin(user: AuthUser = Depends(current_user)) -> AuthUser:
    if user.rol != "superadmin":
        raise HTTPException(status_code=403, detail="requiere superadmin")
    return user


def require_tenant_admin(user: AuthUser = Depends(current_user)) -> AuthUser:
    if user.rol != "admin" or user.tenant_id is None:
        raise HTTPException(status_code=403, detail="requiere admin del tenant")
    return user


def require_tenant_member(user: AuthUser = Depends(current_user)) -> AuthUser:
    """Cualquier rol CON tenant (admin/operador). Superadmin no sincroniza."""
    if user.tenant_id is None:
        raise HTTPException(status_code=403, detail="requiere usuario de tenant")
    return user


def get_db(request: Request) -> CloudDB:
    return request.app.state.db


def get_limiter(request: Request) -> LoginRateLimiter:
    return request.app.state.login_limiter


# ------------------------------------------------------------------- helpers

def _public_user(u: dict[str, Any]) -> dict[str, Any]:
    return {
        "uuid": u["uuid"], "email": u["email"], "nombre": u["nombre"],
        "rol": u["rol"], "activo": bool(u["activo"]), "creado_en": u["creado_en"],
    }


def _public_tenant(t: dict[str, Any]) -> dict[str, Any]:
    out = {
        "id": t["id"], "uuid": t["uuid"], "nombre": t["nombre"],
        "slug": t["slug"], "activo": bool(t["activo"]), "creado_en": t["creado_en"],
    }
    if "usuarios" in t:
        out["usuarios"] = int(t["usuarios"])
    return out


def _token_pair(db: CloudDB, secret: str, user: dict[str, Any]) -> dict[str, Any]:
    access = security.make_access_token(
        secret,
        user_uuid=user["uuid"], tenant_id=user["tenant_id"],
        rol=user["rol"], nombre=user["nombre"],
    )
    refresh, refresh_hash, expira = security.new_refresh_token()
    db.insert_refresh(user["id"], refresh_hash, expira)
    return {
        "access_token": access,
        "token_type": "bearer",
        "expires_in": int(security.ACCESS_TTL.total_seconds()),
        "refresh_token": refresh,
    }


# -------------------------------------------------------------------- /auth

def _auth_router() -> APIRouter:
    router = APIRouter(prefix="/auth", tags=["auth"])

    @router.post("/login")
    def login(
        body: LoginIn,
        request: Request,
        db: CloudDB = Depends(get_db),
        limiter: LoginRateLimiter = Depends(get_limiter),
    ) -> dict[str, Any]:
        email = body.email.strip().lower()
        if limiter.blocked(email):
            raise HTTPException(
                status_code=429, detail="demasiados intentos; espera 15 minutos"
            )
        user = db.get_user_by_email(email)
        # Verificación SIEMPRE (contra hash dummy si no existe): tiempo
        # constante ≈ sin enumeración de emails.
        ok = security.verify_password(
            user["password_hash"] if user else None, body.password
        )
        valid = bool(user and ok and user["activo"])
        if valid and user["tenant_id"] is not None:
            tenant = db.get_tenant(user["tenant_id"])
            valid = bool(tenant and tenant["activo"])
        if not valid:
            limiter.record_failure(email)
            raise _unauthorized("credenciales inválidas")
        limiter.clear(email)
        return _token_pair(db, request.app.state.jwt_secret, user)

    @router.post("/refresh")
    def refresh(
        body: RefreshIn, request: Request, db: CloudDB = Depends(get_db)
    ) -> dict[str, Any]:
        token_hash = security.hash_refresh_token(body.refresh_token)
        row = db.get_refresh(token_hash)
        if not row or row["revocado"] or security.refresh_expired(row["expira_en"]):
            raise _unauthorized("refresh token inválido")
        user = db.get_user(row["user_id"])
        if not user or not user["activo"]:
            raise _unauthorized()
        if user["tenant_id"] is not None:
            tenant = db.get_tenant(user["tenant_id"])
            if not tenant or not tenant["activo"]:
                raise _unauthorized()
        db.revoke_refresh(token_hash)  # rotación: un refresh = un uso
        return _token_pair(db, request.app.state.jwt_secret, user)

    @router.post("/logout")
    def logout(body: RefreshIn, db: CloudDB = Depends(get_db)) -> dict[str, Any]:
        db.revoke_refresh(security.hash_refresh_token(body.refresh_token))
        return {"ok": True}  # idempotente: no revela si el token existía

    return router


# ------------------------------------------------------------------- /admin

def _admin_router() -> APIRouter:
    router = APIRouter(
        prefix="/admin", tags=["admin"],
        dependencies=[Depends(require_superadmin)],
    )

    @router.post("/tenants", status_code=201)
    def create_tenant(
        body: TenantCreate,
        db: CloudDB = Depends(get_db),
        user: AuthUser = Depends(require_superadmin),
    ) -> dict[str, Any]:
        slug = body.slug.strip().lower()
        if not SLUG_RE.match(slug):
            raise HTTPException(
                status_code=422,
                detail="slug inválido (minúsculas, dígitos y guiones)",
            )
        if db.get_tenant_by_slug(slug):
            raise HTTPException(status_code=409, detail="slug ya existe")
        if db.get_user_by_email(body.admin_email):
            raise HTTPException(status_code=409, detail="email ya registrado")
        tenant = db.create_tenant(body.nombre.strip(), slug)
        try:
            admin = db.create_user(
                tenant_id=tenant["id"],
                email=body.admin_email,
                nombre=None,
                password_hash=security.hash_password(body.admin_password),
                rol="admin",
                creado_por=user.uuid,
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="email ya registrado")
        return {"tenant": _public_tenant(tenant), "admin": _public_user(admin)}

    @router.get("/tenants")
    def list_tenants(db: CloudDB = Depends(get_db)) -> list[dict[str, Any]]:
        return [_public_tenant(t) for t in db.list_tenants()]

    @router.patch("/tenants/{tenant_id}")
    def patch_tenant(
        tenant_id: int, body: TenantPatch, db: CloudDB = Depends(get_db)
    ) -> dict[str, Any]:
        tenant = db.get_tenant(tenant_id)
        if not tenant:
            raise HTTPException(status_code=404, detail="tenant no existe")
        fields = body.model_dump(exclude_none=True)
        if "activo" in fields:
            fields["activo"] = 1 if fields["activo"] else 0
        db.update_tenant(tenant_id, fields)
        return _public_tenant(db.get_tenant(tenant_id))

    @router.put("/config/{clave}")
    def put_global_config(
        clave: str, body: ConfigPut, db: CloudDB = Depends(get_db)
    ) -> dict[str, Any]:
        db.set_config(None, clave, body.valor)
        return {"clave": clave, "valor": body.valor, "ambito": "global"}

    @router.get("/telemetria")
    def telemetria(db: CloudDB = Depends(get_db)) -> list[dict[str, Any]]:
        return db.telemetria_resumen()

    return router


# ------------------------------------------------------------------ /tenant

def _tenant_router() -> APIRouter:
    router = APIRouter(prefix="/tenant", tags=["tenant"])

    @router.post("/users", status_code=201)
    def create_user(
        body: UserCreate,
        db: CloudDB = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ) -> dict[str, Any]:
        if db.get_user_by_email(body.email):
            raise HTTPException(status_code=409, detail="email ya registrado")
        try:
            created = db.create_user(
                tenant_id=user.tenant_id,  # SIEMPRE el tenant propio
                email=body.email,
                nombre=body.nombre,
                password_hash=security.hash_password(body.password),
                rol=body.rol,
                creado_por=user.uuid,
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="email ya registrado")
        return _public_user(created)

    @router.get("/users")
    def list_users(
        db: CloudDB = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ) -> list[dict[str, Any]]:
        return [_public_user(u) for u in db.list_users(user.tenant_id)]

    @router.patch("/users/{user_uuid}")
    def patch_user(
        user_uuid: str,
        body: UserPatch,
        db: CloudDB = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ) -> dict[str, Any]:
        target = db.get_user_by_uuid(user_uuid)
        if not target:
            raise HTTPException(status_code=404, detail="usuario no existe")
        if target["tenant_id"] != user.tenant_id:
            # Contrato: tocar otro tenant = 403 (aislamiento explícito).
            raise HTTPException(status_code=403, detail="usuario de otro tenant")
        fields: dict[str, Any] = {}
        data = body.model_dump(exclude_none=True)
        if "activo" in data:
            fields["activo"] = 1 if data["activo"] else 0
        if "rol" in data:
            fields["rol"] = data["rol"]  # tipado: solo admin|operador
        if "nombre" in data:
            fields["nombre"] = data["nombre"]
        if "password" in data:
            fields["password_hash"] = security.hash_password(data["password"])
        db.update_user(target["id"], fields)
        return _public_user(db.get_user(target["id"]))

    @router.put("/config/{clave}")
    def put_tenant_config(
        clave: str,
        body: ConfigPut,
        db: CloudDB = Depends(get_db),
        user: AuthUser = Depends(require_tenant_admin),
    ) -> dict[str, Any]:
        db.set_config(user.tenant_id, clave, body.valor)
        return {"clave": clave, "valor": body.valor, "ambito": "tenant"}

    return router


# -------------------------------------------------------------------- /sync

def _sync_router() -> APIRouter:
    router = APIRouter(prefix="/sync", tags=["sync"])

    @router.post("/push")
    def push(
        body: SyncPushIn,
        db: CloudDB = Depends(get_db),
        user: AuthUser = Depends(require_tenant_member),
    ) -> dict[str, Any]:
        aceptadas, duplicadas = db.sync_push(
            user.tenant_id,
            body.device_id,
            [s.model_dump() for s in body.sesiones],
            [e.model_dump() for e in body.eventos],
        )
        return {"aceptadas": aceptadas, "duplicadas": duplicadas}

    @router.get("/sesiones")
    def sesiones(
        desde: Optional[str] = None,
        hasta: Optional[str] = None,
        q: Optional[str] = None,
        db: CloudDB = Depends(get_db),
        user: AuthUser = Depends(require_tenant_member),
    ) -> list[dict[str, Any]]:
        return db.list_sync_sesiones(user.tenant_id, desde, hasta, q)

    @router.get("/sesiones/{sesion_uuid}/eventos")
    def eventos(
        sesion_uuid: str,
        db: CloudDB = Depends(get_db),
        user: AuthUser = Depends(require_tenant_member),
    ) -> list[dict[str, Any]]:
        if not db.get_sync_sesion(user.tenant_id, sesion_uuid):
            raise HTTPException(status_code=404, detail="sesión no existe")
        return db.list_sync_eventos(user.tenant_id, sesion_uuid)

    @router.get("/stats/global")
    def stats_global(
        desde: Optional[str] = None,
        hasta: Optional[str] = None,
        db: CloudDB = Depends(get_db),
        user: AuthUser = Depends(require_tenant_member),
    ) -> dict[str, Any]:
        return db.sync_stats_global(user.tenant_id, desde, hasta)

    return router


# ------------------------------------------------------------------ público

def _public_router() -> APIRouter:
    router = APIRouter(tags=["publico"])

    @router.get("/config/app")
    def config_app(
        tenant: Optional[str] = None, db: CloudDB = Depends(get_db)
    ) -> dict[str, Any]:
        """Config efectiva para las apps: global ⊕ overrides del tenant.

        - Claves escalares: el valor del tenant PISA el global.
        - ``banners``: se CONCATENAN (globales primero, luego los del
          tenant) — un aviso de plataforma no debe desaparecer porque el
          tenant tenga los suyos.
        - Slug desconocido o tenant inactivo → solo config global (la
          app sigue funcionando; no es error).
        """
        merged = db.get_config_map(None)
        global_banners = merged.get("banners") or []
        tenant_banners: list[Any] = []
        if tenant:
            t = db.get_tenant_by_slug(tenant.strip().lower())
            if t and t["activo"]:
                tcfg = db.get_config_map(t["id"])
                tenant_banners = tcfg.pop("banners", None) or []
                merged.update(tcfg)
        return {
            "latest_version": merged.get("latest_version"),
            "min_version": merged.get("min_version"),
            "apk_url": merged.get("apk_url"),
            "banners": list(global_banners) + list(tenant_banners),
        }

    @router.post("/telemetry", status_code=202)
    def telemetry(
        body: TelemetryIn, db: CloudDB = Depends(get_db)
    ) -> dict[str, Any]:
        payload = json.dumps(body.datos, ensure_ascii=False)
        if len(payload.encode("utf-8")) > MAX_TELEMETRY_BYTES:
            raise HTTPException(status_code=413, detail="datos demasiado grandes")
        tenant_id = None
        if body.tenant:
            t = db.get_tenant_by_slug(body.tenant.strip().lower())
            tenant_id = t["id"] if t else None  # slug desconocido → anónimo
        db.insert_telemetria(
            tenant_id=tenant_id,
            device_id=body.device_id,
            plataforma=body.plataforma,
            version_app=body.version_app,
            payload=body.datos,
        )
        return {"ok": True}

    @router.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "service": "porcipeso-cloud"}

    return router


# --------------------------------------------------------------- create_app

def create_app(
    db_path: str,
    jwt_secret: str,
    *,
    superadmin_email: Optional[str] = None,
    superadmin_password: Optional[str] = None,
) -> FastAPI:
    """Construye la app. ``jwt_secret`` es OBLIGATORIO (falla claro).

    Si se pasan ``superadmin_email``/``superadmin_password`` se crea el
    primer superadmin SOLO si no existe ninguno (bootstrap idempotente).
    """
    if not jwt_secret or not str(jwt_secret).strip():
        raise RuntimeError(
            "CLOUD_JWT_SECRET es obligatorio: el servidor nube no arranca "
            "sin un secreto para firmar los JWT."
        )

    db = CloudDB(db_path)

    if superadmin_email and superadmin_password:
        if db.count_superadmins() == 0:
            if len(superadmin_password) < security.MIN_PASSWORD_LEN:
                raise RuntimeError(
                    "CLOUD_SUPERADMIN_PASSWORD debe tener al menos "
                    f"{security.MIN_PASSWORD_LEN} caracteres."
                )
            db.create_user(
                tenant_id=None,
                email=superadmin_email,
                nombre="Superadmin",
                password_hash=security.hash_password(superadmin_password),
                rol="superadmin",
                creado_por="bootstrap",
            )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        db.close()

    app = FastAPI(title="PorciPeso Cloud", version="0.1.0", lifespan=lifespan)
    app.state.db = db
    app.state.jwt_secret = str(jwt_secret)
    app.state.login_limiter = LoginRateLimiter(db)

    # CORS abierto SOLO para los endpoints públicos que consume el navegador
    # de la app de escritorio: GET /config/app y POST /telemetry (anónimo,
    # validado y limitado en tamaño). El resto de la API no emite cabeceras
    # CORS (fail-closed).
    _CORS_PUBLIC = {"/config/app": "GET, OPTIONS", "/telemetry": "POST, OPTIONS"}

    @app.middleware("http")
    async def cors_config_app(request: Request, call_next):
        methods = _CORS_PUBLIC.get(request.url.path)
        if methods is not None:
            if request.method == "OPTIONS":
                return Response(
                    status_code=204,
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": methods,
                        "Access-Control-Allow-Headers": "*",
                    },
                )
            response = await call_next(request)
            response.headers["Access-Control-Allow-Origin"] = "*"
            return response
        return await call_next(request)

    app.include_router(_auth_router())
    app.include_router(_admin_router())
    app.include_router(_tenant_router())
    app.include_router(_sync_router())
    app.include_router(_public_router())

    _mount_webui(app)

    return app


# -------------------------------------------------------------- panel web

def _mount_webui(app: FastAPI) -> None:
    """Monta el panel web estático en /panel (+ rutas de página).

    - ``/`` redirige a ``/panel/`` (la raíz del servidor ES el panel).
    - ``/panel/session`` (autenticado): quién soy + mi tenant, para que
      el panel sepa qué experiencia mostrar (superadmin/admin/operador)
      y el slug del tenant. Se registra ANTES del mount para ganarle a
      los estáticos.
    - ``/panel`` sirve ``porcipeso/cloud/webui/`` con ``html=True``
      (``/panel/`` → index.html).
    """
    from pathlib import Path

    from fastapi.responses import RedirectResponse
    from fastapi.staticfiles import StaticFiles

    webui_dir = Path(__file__).resolve().parent / "webui"

    @app.get("/", include_in_schema=False)
    def _root() -> RedirectResponse:
        return RedirectResponse(url="/panel/")

    @app.get("/panel/session", tags=["panel"])
    def panel_session(
        db: CloudDB = Depends(get_db),
        user: AuthUser = Depends(current_user),
    ) -> dict[str, Any]:
        tenant = None
        if user.tenant_id is not None:
            t = db.get_tenant(user.tenant_id)
            if t:
                tenant = {"id": t["id"], "slug": t["slug"], "nombre": t["nombre"]}
        return {
            "email": user.email,
            "nombre": user.nombre,
            "rol": user.rol,
            "tenant": tenant,
        }

    app.mount(
        "/panel",
        StaticFiles(directory=str(webui_dir), html=True),
        name="panel",
    )
