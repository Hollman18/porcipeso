"""Sync worker de escritorio: sube sesiones/eventos locales a la nube.

Diseño (offline-first, standalone intacto):

- El worker vive DENTRO del proceso API (hilo daemon) y NO hace nada
  hasta que hay sesión de nube: la UI llama a ``POST /api/cloud/session``
  (o al proxy ``/api/cloud/login``) tras iniciar sesión.
- Estado persistente en la tabla ``cloud_state`` (clave/valor) de la
  MISMA base local: device_id estable, cloud_url, tenant, refresh_token
  (para sobrevivir reinicios), perfil (UX) y last_push_ts.
- Cada ``interval_s`` (60 s) — y al cerrar una sesión de pesaje vía
  ``request_push()`` — junta las sesiones cambiadas (todas las abiertas
  siempre + cerradas/anuladas con ``hora_salida``/``hora_entrada`` ≥
  last_push_ts) con sus eventos, y hace ``POST /sync/push`` por lotes de
  máx 200 sesiones. El push del cloud es UPSERT idempotente por uuid
  (last-write-wins), así que re-subir de más nunca corrompe.
- Los eventos locales no tienen uuid propio: se deriva DETERMINÍSTICO
  ``{uuid_sesion}:ev:{id_local}`` — mismo evento ⇒ mismo uuid ⇒
  idempotencia entre ciclos y reinstalaciones de la fila en la nube.
- Tokens: :class:`porcipeso.api.cloudauth.TokenBox` es el único dueño;
  al rotar el refresh se persiste en ``cloud_state``. Un 401 con el
  access vigente fuerza UN refresh + reintento; si el refresh también
  muere → estado "sesión vencida" (la UI pide login de nuevo; los datos
  locales quedan intactos y el sync se reanuda con la nueva sesión).
- Nunca se loguean tokens.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from porcipeso.api import cloudauth
from porcipeso.api.cloudauth import (
    CloudError,
    CloudOffline,
    SessionExpired,
    TokenBox,
)

#: Máximo de sesiones por POST /sync/push (contrato: ≤500; usamos 200).
PUSH_BATCH_SESIONES = 200
#: Máximo de eventos por POST /sync/push (contrato: ≤5000).
PUSH_BATCH_EVENTOS = 5000

DEFAULT_INTERVAL_S = 60.0

_STATE_DDL = """
CREATE TABLE IF NOT EXISTS cloud_state (
  clave TEXT PRIMARY KEY,
  valor TEXT
);
"""

#: Campos de la sesión local que acepta SesionSync del cloud.
SESION_SYNC_FIELDS = (
    "uuid", "granja", "lote", "corral_origen", "destino", "placa",
    "conductor", "operador", "bascula_id", "peso_ref_inicial",
    "hora_entrada", "hora_salida", "total_kg", "total_animales",
    "promedio_final", "conteo_fisico", "diferencia_conciliacion",
    "estado", "modo",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def event_uuid(sesion_uuid: str, event_id: Any) -> str:
    """uuid determinístico del evento (los locales no tienen uuid)."""
    return f"{sesion_uuid}:ev:{event_id}"


class SyncWorker:
    """Hilo de sincronización local→nube sobre el Repo de la API."""

    def __init__(
        self,
        repo,
        *,
        interval_s: float = DEFAULT_INTERVAL_S,
    ) -> None:
        self.repo = repo
        self.interval_s = interval_s
        # Conexión PROPIA a la misma DB (WAL) solo para cloud_state:
        # no tocamos porcipeso/db/repo.py.
        self._conn = sqlite3.connect(str(Path(repo.path)), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.executescript(_STATE_DDL)
        self._conn.commit()
        self._state_lock = threading.Lock()

        self.tokens = TokenBox(on_refresh_rotated=self._persist_refresh)
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        # Estado observable (GET /api/cloud/status)
        self._status_lock = threading.Lock()
        self._conectado = False
        self._sesion_vencida = False
        self._ultimo_push: Optional[str] = None
        self._ultimo_error: Optional[str] = None

        self._restore()

    # -------------------------------------------------------- cloud_state

    def _get_state(self, clave: str) -> Optional[str]:
        with self._state_lock:
            row = self._conn.execute(
                "SELECT valor FROM cloud_state WHERE clave = ?", (clave,)
            ).fetchone()
        return row["valor"] if row else None

    def _set_state(self, clave: str, valor: Optional[str]) -> None:
        with self._state_lock:
            if valor is None:
                self._conn.execute(
                    "DELETE FROM cloud_state WHERE clave = ?", (clave,)
                )
            else:
                self._conn.execute(
                    "INSERT INTO cloud_state (clave, valor) VALUES (?, ?) "
                    "ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor",
                    (clave, valor),
                )
            self._conn.commit()

    def _persist_refresh(self, refresh_token: str) -> None:
        self._set_state("refresh_token", refresh_token)

    @property
    def device_id(self) -> str:
        """device_id ESTABLE (uuid aleatorio persistido en cloud_state)."""
        did = self._get_state("device_id")
        if not did:
            import uuid as uuid_mod

            did = f"desk-{uuid_mod.uuid4()}"
            self._set_state("device_id", did)
        return did

    def _restore(self) -> None:
        """Rehidrata la sesión de nube persistida (sobrevive reinicios)."""
        cloud_url = self._get_state("cloud_url") or ""
        refresh = self._get_state("refresh_token") or ""
        if cloud_url and refresh:
            self.tokens.set_session(cloud_url, "", refresh)
        self._ultimo_push = self._get_state("ultimo_push")

    # ------------------------------------------------------------ sesión

    def set_session(
        self,
        cloud_url: str,
        tenant: str,
        access_token: str,
        refresh_token: str,
        *,
        expires_in: Optional[float] = None,
        perfil: Optional[dict[str, Any]] = None,
    ) -> None:
        """Configura/renueva la sesión de nube (la llama la UI tras login)."""
        cloud_url = str(cloud_url or "").strip().rstrip("/")
        tenant = str(tenant or "").strip().lower()
        # Cambiar de nube/tenant resetea el marcador: se re-sube todo
        # (idempotente en el cloud, así que es seguro).
        key = f"{cloud_url}|{tenant}"
        if self._get_state("push_key") != key:
            self._set_state("push_key", key)
            self._set_state("last_push_ts", None)
        self._set_state("cloud_url", cloud_url)
        self._set_state("tenant", tenant)
        self._set_state("refresh_token", refresh_token)
        if perfil is not None:
            self._set_state("perfil", json.dumps(perfil, ensure_ascii=False))
        self.tokens.set_session(cloud_url, access_token, refresh_token, expires_in)
        with self._status_lock:
            self._sesion_vencida = False
            self._ultimo_error = None
        self.request_push()

    def clear_session(self) -> None:
        """Logout: revoca el refresh (best-effort) y borra los tokens.

        Los datos locales y el last_push_ts quedan intactos: al volver a
        iniciar sesión en la misma nube, el sync continúa donde iba.
        """
        cloud_url = self.tokens.cloud_url or (self._get_state("cloud_url") or "")
        old_refresh = self.tokens.clear()
        if cloud_url and old_refresh:
            cloudauth.cloud_logout(cloud_url, old_refresh)
        self._set_state("refresh_token", None)
        self._set_state("perfil", None)
        with self._status_lock:
            self._conectado = False
            self._sesion_vencida = False

    @property
    def configured(self) -> bool:
        return self.tokens.configured

    def perfil(self) -> Optional[dict[str, Any]]:
        raw = self._get_state("perfil")
        try:
            return json.loads(raw) if raw else None
        except Exception:
            return None

    # ------------------------------------------------------------ payload

    def _pending_sessions(self, last_push_ts: Optional[str]) -> list[dict[str, Any]]:
        """Sesiones cambiadas desde el último push (heurística documentada).

        - Abiertas: SIEMPRE (el cloud hace UPSERT last-write-wins, así el
          panel ve el progreso y el cierre posterior lo actualiza).
        - Cerradas/anuladas: si ``hora_salida`` o ``hora_entrada`` ≥
          last_push_ts (ISO UTC ⇒ comparable como texto).
        - Sin marcador (primer push / cambio de nube): todas.
        - DEMO (``es_demo=1``, báscula simulada): JAMÁS — se autodestruyen
          localmente en 1 h y el cloud no debe quedarse con datos de
          práctica disfrazados de reales (el payload ni lleva la marca).
        """
        out: list[dict[str, Any]] = []
        for s in self.repo.list_sessions():
            if not s.get("uuid"):
                continue  # filas legado sin uuid: no sincronizables
            if s.get("es_demo"):
                continue  # práctica con la simulada: nunca sube a la nube
            if s.get("estado") == "abierta" or not last_push_ts:
                out.append(s)
                continue
            if (s.get("hora_salida") or "") >= last_push_ts:
                out.append(s)
            elif (s.get("hora_entrada") or "") >= last_push_ts:
                out.append(s)
        return out

    def _sesion_payload(self, s: dict[str, Any]) -> dict[str, Any]:
        return {k: s.get(k) for k in SESION_SYNC_FIELDS}

    def _eventos_payload(self, s: dict[str, Any]) -> list[dict[str, Any]]:
        sesion_uuid = str(s["uuid"])
        out: list[dict[str, Any]] = []
        for ev in self.repo.list_events(int(s["id"])):
            rel = ev.get("evento_relacionado_id")
            out.append({
                "uuid": event_uuid(sesion_uuid, ev["id"]),
                "sesion_uuid": sesion_uuid,
                "ts_ms": ev["ts_ms"],
                "peso_antes": ev["peso_antes"],
                "peso_despues": ev["peso_despues"],
                "delta_kg": ev["delta_kg"],
                "animales_estimados": ev["animales_estimados"],
                "animales_confirmados": ev.get("animales_confirmados"),
                "estab_ms": ev.get("estab_ms") or 0,
                "tipo": ev["tipo"],
                "ambiguo": bool(ev.get("ambiguo")),
                "opciones": ev.get("opciones") or None,
                "motivo_bajada": ev.get("motivo_bajada"),
                "evento_relacionado_uuid": (
                    event_uuid(sesion_uuid, rel) if rel is not None else None
                ),
                "confirmado_por": ev.get("confirmado_por"),
            })
        return out

    # -------------------------------------------------------------- push

    def _post_push(self, payload: dict[str, Any]) -> dict[str, Any]:
        """POST /sync/push autenticado; 401 → un refresh + reintento."""
        import httpx

        cloud_url = self.tokens.cloud_url
        access = self.tokens.get_access()
        for intento in (1, 2):
            try:
                resp = httpx.post(
                    f"{cloud_url}/sync/push",
                    json=payload,
                    headers={"Authorization": f"Bearer {access}"},
                    timeout=cloudauth.HTTP_TIMEOUT_S,
                )
            except httpx.HTTPError as exc:
                raise CloudOffline(type(exc).__name__) from exc
            if resp.status_code == 401 and intento == 1:
                access = self.tokens.force_refresh()  # SessionExpired si muere
                continue
            if resp.status_code != 200:
                raise CloudError(resp.status_code, str(resp.text)[:200])
            return resp.json()
        raise CloudError(401, "no autorizado tras refresh")  # inalcanzable

    def run_cycle(self) -> dict[str, Any]:
        """Un ciclo de sync. Nunca lanza: reporta en el dict de retorno."""
        if not self.configured:
            return {"configurada": False, "pushed": 0}
        cycle_start = _now_iso()
        last_push_ts = self._get_state("last_push_ts")
        try:
            pendientes = self._pending_sessions(last_push_ts)
            aceptadas = duplicadas = 0
            for i in range(0, len(pendientes), PUSH_BATCH_SESIONES):
                lote = pendientes[i:i + PUSH_BATCH_SESIONES]
                sesiones = [self._sesion_payload(s) for s in lote]
                eventos: list[dict[str, Any]] = []
                for s in lote:
                    eventos.extend(self._eventos_payload(s))
                # Contrato: ≤5000 eventos por push → troceo con las
                # mismas sesiones (UPSERT idempotente: repetirlas es ok).
                for j in range(0, max(1, len(eventos)), PUSH_BATCH_EVENTOS):
                    r = self._post_push({
                        "device_id": self.device_id,
                        "sesiones": sesiones if j == 0 else [],
                        "eventos": eventos[j:j + PUSH_BATCH_EVENTOS],
                    })
                    aceptadas += int(r.get("aceptadas") or 0)
                    duplicadas += int(r.get("duplicadas") or 0)
            # Marcador = inicio del ciclo: lo que cambió DURANTE el push
            # se re-evalúa al siguiente ciclo (jamás se pierde).
            self._set_state("last_push_ts", cycle_start)
            self._set_state("ultimo_push", cycle_start)
            with self._status_lock:
                self._conectado = True
                self._sesion_vencida = False
                self._ultimo_push = cycle_start
                self._ultimo_error = None
            return {
                "configurada": True, "ok": True, "pushed": len(pendientes),
                "aceptadas": aceptadas, "duplicadas": duplicadas,
            }
        except SessionExpired as exc:
            with self._status_lock:
                self._conectado = False
                self._sesion_vencida = True
                self._ultimo_error = exc.detail
            return {"configurada": True, "ok": False, "sesion_vencida": True}
        except (CloudOffline, CloudError) as exc:
            with self._status_lock:
                self._conectado = False
                self._ultimo_error = exc.detail or str(exc)
            return {"configurada": True, "ok": False, "error": str(exc)}
        except Exception as exc:  # el sync JAMÁS tumba la API
            with self._status_lock:
                self._conectado = False
                self._ultimo_error = str(exc)
            return {"configurada": True, "ok": False, "error": str(exc)}

    # -------------------------------------------------------------- hilo

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="cloud-sync", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None
        with self._state_lock:
            self._conn.close()

    def request_push(self) -> None:
        """Despierta el hilo YA (p. ej. al cerrar una sesión de pesaje)."""
        self._wake.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(timeout=self.interval_s)
            self._wake.clear()
            if self._stop.is_set():
                return
            with self._status_lock:
                vencida = self._sesion_vencida
            if self.configured and not vencida:
                self.run_cycle()

    # ------------------------------------------------------------- status

    def status(self) -> dict[str, Any]:
        with self._status_lock:
            conectado = self._conectado
            vencida = self._sesion_vencida
            ultimo_push = self._ultimo_push
            error = self._ultimo_error
        configurada = self.configured
        pendientes = 0
        if configurada:
            try:
                pendientes = len(
                    self._pending_sessions(self._get_state("last_push_ts"))
                )
            except Exception:
                pendientes = 0
        return {
            "configurada": configurada,
            "conectado": conectado,
            "sesion_vencida": vencida,
            "ultimo_push": ultimo_push,
            "pendientes": pendientes,
            "device_id": self.device_id if configurada else None,
            "tenant": self._get_state("tenant"),
            "cloud_url": self._get_state("cloud_url"),
            "error": error,
        }
