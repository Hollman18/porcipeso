"""Persistencia SQLite de PorciPeso Cloud (WAL, multi-tenant).

Sin ORM: sqlite3 stdlib, una conexión con ``check_same_thread=False``
protegida por un ``threading.Lock`` (mismo patrón que porcipeso/db/repo.py;
el TestClient de FastAPI y uvicorn atienden en threadpool).

REGLA DE ORO: toda query sobre datos de cliente filtra por ``tenant_id``.
Ningún método de sync/config/usuarios de tenant acepta "sin tenant".
"""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid as uuid_mod
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

SCHEMA_PATH = Path(__file__).parent / "schema.sql"

#: Campos espejo de `sesiones` (schema local) aceptados en sync_sesiones.
SESION_SYNC_FIELDS = (
    "granja", "lote", "corral_origen", "destino", "placa", "conductor",
    "operador", "bascula_id", "peso_ref_inicial", "hora_entrada",
    "hora_salida", "total_kg", "total_animales", "promedio_final",
    "conteo_fisico", "diferencia_conciliacion", "estado", "modo",
)

#: Campos espejo de `eventos_pesaje` aceptados en sync_eventos.
EVENTO_SYNC_FIELDS = (
    "sesion_uuid", "ts_ms", "peso_antes", "peso_despues", "delta_kg",
    "animales_estimados", "animales_confirmados", "estab_ms", "tipo",
    "ambiguo", "opciones", "motivo_bajada", "evento_relacionado_uuid",
    "confirmado_por",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_db(path: str | Path) -> None:
    """Crea el esquema (idempotente)."""
    path = Path(path)
    if path.parent != Path(""):
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        conn.commit()
    finally:
        conn.close()


class CloudDB:
    """Repositorio del servidor nube."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        init_db(self.path)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        (mode,) = self._conn.execute("PRAGMA journal_mode=WAL").fetchone()
        if str(mode).lower() != "wal":
            raise RuntimeError(
                f"SQLite no pudo activar WAL en {self.path} (journal_mode={mode})"
            )
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute("PRAGMA foreign_keys=ON")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---------------------------------------------------------- primitivas

    def _one(self, sql: str, params: tuple = ()) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def _all(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def _exec(self, sql: str, params: tuple = ()) -> int:
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return int(cur.lastrowid or 0)

    # ------------------------------------------------------------- tenants

    def create_tenant(self, nombre: str, slug: str) -> dict[str, Any]:
        tid = self._exec(
            "INSERT INTO tenants (uuid, nombre, slug, activo, creado_en)"
            " VALUES (?, ?, ?, 1, ?)",
            (str(uuid_mod.uuid4()), nombre, slug, _now_iso()),
        )
        return self.get_tenant(tid)  # type: ignore[return-value]

    def get_tenant(self, tenant_id: int) -> Optional[dict[str, Any]]:
        return self._one("SELECT * FROM tenants WHERE id = ?", (tenant_id,))

    def get_tenant_by_slug(self, slug: str) -> Optional[dict[str, Any]]:
        return self._one("SELECT * FROM tenants WHERE slug = ?", (slug,))

    def list_tenants(self) -> list[dict[str, Any]]:
        return self._all(
            """SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id)
                      AS usuarios
               FROM tenants t ORDER BY t.id"""
        )

    def update_tenant(self, tenant_id: int, fields: dict[str, Any]) -> None:
        allowed = {k: v for k, v in fields.items() if k in ("nombre", "activo")}
        if not allowed:
            return
        sets = ", ".join(f"{k} = ?" for k in allowed)
        self._exec(
            f"UPDATE tenants SET {sets} WHERE id = ?",
            (*allowed.values(), tenant_id),
        )

    # --------------------------------------------------------------- users

    def create_user(
        self,
        *,
        tenant_id: Optional[int],
        email: str,
        nombre: Optional[str],
        password_hash: str,
        rol: str,
        creado_por: Optional[str] = None,
    ) -> dict[str, Any]:
        """Inserta un usuario. Lanza sqlite3.IntegrityError si el email existe."""
        uid = self._exec(
            """INSERT INTO users
                   (uuid, tenant_id, email, nombre, password_hash, rol,
                    activo, creado_en, creado_por)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)""",
            (
                str(uuid_mod.uuid4()), tenant_id, email.strip().lower(),
                nombre, password_hash, rol, _now_iso(), creado_por,
            ),
        )
        return self._one("SELECT * FROM users WHERE id = ?", (uid,))  # type: ignore[return-value]

    def get_user_by_email(self, email: str) -> Optional[dict[str, Any]]:
        return self._one(
            "SELECT * FROM users WHERE email = ?", (email.strip().lower(),)
        )

    def get_user_by_uuid(self, user_uuid: str) -> Optional[dict[str, Any]]:
        return self._one("SELECT * FROM users WHERE uuid = ?", (user_uuid,))

    def get_user(self, user_id: int) -> Optional[dict[str, Any]]:
        return self._one("SELECT * FROM users WHERE id = ?", (user_id,))

    def list_users(self, tenant_id: int) -> list[dict[str, Any]]:
        """SOLO usuarios del tenant dado (aislamiento)."""
        return self._all(
            "SELECT * FROM users WHERE tenant_id = ? ORDER BY id", (tenant_id,)
        )

    def count_superadmins(self) -> int:
        row = self._one(
            "SELECT COUNT(*) AS n FROM users WHERE rol = 'superadmin'"
        )
        return int(row["n"]) if row else 0

    def update_user(self, user_id: int, fields: dict[str, Any]) -> None:
        allowed = {
            k: v for k, v in fields.items()
            if k in ("activo", "rol", "password_hash", "nombre")
        }
        if not allowed:
            return
        sets = ", ".join(f"{k} = ?" for k in allowed)
        self._exec(
            f"UPDATE users SET {sets} WHERE id = ?",
            (*allowed.values(), user_id),
        )

    # ------------------------------------------------------ refresh tokens

    def insert_refresh(
        self, user_id: int, token_hash: str, expira_en: str
    ) -> None:
        self._exec(
            "INSERT INTO refresh_tokens (user_id, token_hash, expira_en, revocado)"
            " VALUES (?, ?, ?, 0)",
            (user_id, token_hash, expira_en),
        )

    def get_refresh(self, token_hash: str) -> Optional[dict[str, Any]]:
        return self._one(
            "SELECT * FROM refresh_tokens WHERE token_hash = ?", (token_hash,)
        )

    def revoke_refresh(self, token_hash: str) -> None:
        self._exec(
            "UPDATE refresh_tokens SET revocado = 1 WHERE token_hash = ?",
            (token_hash,),
        )

    # -------------------------------------------------- rate limit (login)

    def record_login_failure(self, email: str, ts: float) -> None:
        self._exec(
            "INSERT INTO login_fallos (email, ts) VALUES (?, ?)",
            (email.strip().lower(), ts),
        )

    def count_login_failures(self, email: str, since_ts: float) -> int:
        row = self._one(
            "SELECT COUNT(*) AS n FROM login_fallos WHERE email = ? AND ts >= ?",
            (email.strip().lower(), since_ts),
        )
        return int(row["n"]) if row else 0

    def clear_login_failures(self, email: str) -> None:
        self._exec(
            "DELETE FROM login_fallos WHERE email = ?", (email.strip().lower(),)
        )

    # ----------------------------------------------------- config remota

    def set_config(
        self, tenant_id: Optional[int], clave: str, valor: Any
    ) -> None:
        """UPSERT de una clave (tenant_id None = global)."""
        valor_json = json.dumps(valor, ensure_ascii=False)
        now = _now_iso()
        if tenant_id is None:
            self._exec(
                """INSERT INTO config_remota (tenant_id, clave, valor_json, actualizado_en)
                   VALUES (NULL, ?, ?, ?)
                   ON CONFLICT (clave) WHERE tenant_id IS NULL
                   DO UPDATE SET valor_json = excluded.valor_json,
                                 actualizado_en = excluded.actualizado_en""",
                (clave, valor_json, now),
            )
        else:
            self._exec(
                """INSERT INTO config_remota (tenant_id, clave, valor_json, actualizado_en)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT (tenant_id, clave) WHERE tenant_id IS NOT NULL
                   DO UPDATE SET valor_json = excluded.valor_json,
                                 actualizado_en = excluded.actualizado_en""",
                (tenant_id, clave, valor_json, now),
            )

    def get_config_map(self, tenant_id: Optional[int]) -> dict[str, Any]:
        """{clave: valor} del ámbito dado (None = solo las globales)."""
        if tenant_id is None:
            rows = self._all(
                "SELECT clave, valor_json FROM config_remota WHERE tenant_id IS NULL"
            )
        else:
            rows = self._all(
                "SELECT clave, valor_json FROM config_remota WHERE tenant_id = ?",
                (tenant_id,),
            )
        return {r["clave"]: json.loads(r["valor_json"]) for r in rows}

    # ----------------------------------------------------------- telemetría

    def insert_telemetria(
        self,
        *,
        tenant_id: Optional[int],
        device_id: str,
        plataforma: Optional[str],
        version_app: Optional[str],
        payload: dict[str, Any],
    ) -> None:
        self._exec(
            """INSERT INTO telemetria
                   (tenant_id, device_id, plataforma, version_app,
                    payload_json, recibido_en)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                tenant_id, device_id, plataforma, version_app,
                json.dumps(payload, ensure_ascii=False), _now_iso(),
            ),
        )

    def telemetria_resumen(self) -> list[dict[str, Any]]:
        """Resumen por tenant/plataforma/versión (para el superadmin)."""
        return self._all(
            """SELECT t.slug                    AS tenant,
                      tel.plataforma            AS plataforma,
                      tel.version_app           AS version_app,
                      COUNT(DISTINCT tel.device_id) AS dispositivos,
                      COUNT(*)                  AS reportes,
                      MAX(tel.recibido_en)      AS ultimo
               FROM telemetria tel
               LEFT JOIN tenants t ON t.id = tel.tenant_id
               GROUP BY t.slug, tel.plataforma, tel.version_app
               ORDER BY ultimo DESC"""
        )

    # ----------------------------------------------------------------- sync

    def sync_push(
        self,
        tenant_id: int,
        device_id: str,
        sesiones: list[dict[str, Any]],
        eventos: list[dict[str, Any]],
    ) -> tuple[int, int]:
        """UPSERT idempotente por (tenant_id, uuid).

        Retorna ``(aceptadas, duplicadas)``: aceptadas = filas nuevas,
        duplicadas = uuids ya conocidos (se actualizan con el último dato
        — last-write-wins, p. ej. una sesión que se cerró tras el primer push).
        """
        now = _now_iso()
        aceptadas = duplicadas = 0
        with self._lock:
            for s in sesiones:
                cols = {k: s.get(k) for k in SESION_SYNC_FIELDS}
                cols["estado"] = cols.get("estado") or "abierta"
                cols["modo"] = cols.get("modo") or "lote"
                row = self._conn.execute(
                    "SELECT id FROM sync_sesiones WHERE tenant_id = ? AND uuid = ?",
                    (tenant_id, s["uuid"]),
                ).fetchone()
                if row:
                    sets = ", ".join(f"{k} = ?" for k in cols)
                    self._conn.execute(
                        f"UPDATE sync_sesiones SET {sets},"
                        " device_id = ?, actualizado_en = ? WHERE id = ?",
                        (*cols.values(), device_id, now, row["id"]),
                    )
                    duplicadas += 1
                else:
                    names = ", ".join(cols)
                    marks = ", ".join("?" * len(cols))
                    self._conn.execute(
                        f"""INSERT INTO sync_sesiones
                               (tenant_id, device_id, uuid, {names}, actualizado_en)
                           VALUES (?, ?, ?, {marks}, ?)""",
                        (tenant_id, device_id, s["uuid"], *cols.values(), now),
                    )
                    aceptadas += 1
            for e in eventos:
                cols = {k: e.get(k) for k in EVENTO_SYNC_FIELDS}
                if isinstance(cols.get("opciones"), (list, dict)):
                    cols["opciones"] = json.dumps(cols["opciones"])
                cols["ambiguo"] = 1 if cols.get("ambiguo") else 0
                cols["estab_ms"] = cols.get("estab_ms") or 0
                row = self._conn.execute(
                    "SELECT id FROM sync_eventos WHERE tenant_id = ? AND uuid = ?",
                    (tenant_id, e["uuid"]),
                ).fetchone()
                if row:
                    sets = ", ".join(f"{k} = ?" for k in cols)
                    self._conn.execute(
                        f"UPDATE sync_eventos SET {sets},"
                        " device_id = ?, actualizado_en = ? WHERE id = ?",
                        (*cols.values(), device_id, now, row["id"]),
                    )
                    duplicadas += 1
                else:
                    names = ", ".join(cols)
                    marks = ", ".join("?" * len(cols))
                    self._conn.execute(
                        f"""INSERT INTO sync_eventos
                               (tenant_id, device_id, uuid, {names}, actualizado_en)
                           VALUES (?, ?, ?, {marks}, ?)""",
                        (tenant_id, device_id, e["uuid"], *cols.values(), now),
                    )
                    aceptadas += 1
            self._conn.commit()
        return aceptadas, duplicadas

    @staticmethod
    def _sesion_filters(
        tenant_id: int,
        desde: Optional[str],
        hasta: Optional[str],
        q: Optional[str] = None,
    ) -> tuple[str, list[Any]]:
        """WHERE tenant-scoped (réplica de Repo._session_filters + tenant)."""
        conds: list[str] = ["tenant_id = ?"]
        params: list[Any] = [tenant_id]
        if desde:
            conds.append("date(hora_entrada) >= date(?)")
            params.append(desde)
        if hasta:
            conds.append("date(hora_entrada) <= date(?)")
            params.append(hasta)
        if q:
            conds.append("(lote LIKE ? OR corral_origen LIKE ? OR destino LIKE ?)")
            like = f"%{q}%"
            params.extend([like, like, like])
        return " WHERE " + " AND ".join(conds), params

    def list_sync_sesiones(
        self,
        tenant_id: int,
        desde: Optional[str] = None,
        hasta: Optional[str] = None,
        q: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        where, params = self._sesion_filters(tenant_id, desde, hasta, q)
        return self._all(
            f"SELECT * FROM sync_sesiones{where} ORDER BY id DESC", tuple(params)
        )

    def get_sync_sesion(
        self, tenant_id: int, sesion_uuid: str
    ) -> Optional[dict[str, Any]]:
        return self._one(
            "SELECT * FROM sync_sesiones WHERE tenant_id = ? AND uuid = ?",
            (tenant_id, sesion_uuid),
        )

    def list_sync_eventos(
        self, tenant_id: int, sesion_uuid: str
    ) -> list[dict[str, Any]]:
        rows = self._all(
            """SELECT * FROM sync_eventos
               WHERE tenant_id = ? AND sesion_uuid = ?
               ORDER BY ts_ms, id""",
            (tenant_id, sesion_uuid),
        )
        for r in rows:
            r["ambiguo"] = bool(r["ambiguo"])
            r["opciones"] = json.loads(r["opciones"]) if r["opciones"] else []
        return rows

    def sync_stats_global(
        self,
        tenant_id: int,
        desde: Optional[str] = None,
        hasta: Optional[str] = None,
    ) -> dict[str, Any]:
        """Réplica de Repo.stats_global sobre el espejo, tenant-scoped."""
        where, params = self._sesion_filters(tenant_id, desde, hasta)
        with self._lock:
            g = self._conn.execute(
                f"""SELECT COUNT(*)                         AS sesiones,
                           COALESCE(SUM(total_animales), 0) AS total_animales,
                           COALESCE(SUM(total_kg), 0.0)     AS total_kg
                    FROM sync_sesiones{where}""",
                params,
            ).fetchone()
            lotes = self._conn.execute(
                f"""SELECT COALESCE(lote, '(sin lote)')      AS lote,
                           COUNT(*)                          AS sesiones,
                           COALESCE(SUM(total_animales), 0)  AS animales,
                           COALESCE(SUM(total_kg), 0.0)      AS kg,
                           MAX(hora_entrada)                 AS ultima_fecha
                    FROM sync_sesiones{where}
                    GROUP BY COALESCE(lote, '(sin lote)')
                    ORDER BY ultima_fecha DESC""",
                params,
            ).fetchall()

        def _prom(kg: float, animales: int) -> Optional[float]:
            return round(kg / animales, 3) if animales else None

        return {
            "sesiones": int(g["sesiones"]),
            "total_animales": int(g["total_animales"]),
            "total_kg": round(float(g["total_kg"]), 3),
            "promedio_global": _prom(g["total_kg"], g["total_animales"]),
            "por_lote": [
                {
                    "lote": r["lote"],
                    "sesiones": int(r["sesiones"]),
                    "animales": int(r["animales"]),
                    "kg": round(float(r["kg"]), 3),
                    "promedio": _prom(r["kg"], r["animales"]),
                    "ultima_fecha": r["ultima_fecha"],
                }
                for r in lotes
            ],
        }
