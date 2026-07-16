"""Persistencia SQLite de PorciPeso (append-only, WAL).

Sin ORM: sqlite3 stdlib. Una conexión por Repo con
``check_same_thread=False`` protegida por un ``threading.Lock`` (el hilo
del driver y los handlers HTTP comparten el Repo).
"""
from __future__ import annotations

import json
import sqlite3
import statistics
import threading
import uuid as uuid_mod
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from porcipeso.core.models import WeighEvent

SCHEMA_PATH = Path(__file__).parent / "schema.sql"

# Campos que POST /api/sessions puede fijar en la cabecera.
SESSION_FIELDS = (
    "granja", "lote", "corral_origen", "destino", "placa",
    "conductor", "operador", "bascula_id", "peso_ref_inicial",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_db(path: str | Path) -> None:
    """Crea (o migra en vacío) el esquema. Idempotente."""
    path = Path(path)
    if path.parent != Path(""):
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        conn.commit()
    finally:
        conn.close()


class Repo:
    """Repositorio de sesiones/eventos/lecturas.

    ``store_readings`` activa/desactiva la persistencia de lecturas
    crudas (SPEC §5: opcional, a 10 Hz solo para auditoría/replay).
    """

    def __init__(self, path: str | Path, store_readings: bool = True) -> None:
        self.path = Path(path)
        self.store_readings = store_readings
        init_db(self.path)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------- sesiones

    def create_session(self, data: dict[str, Any]) -> int:
        cols = {k: data.get(k) for k in SESSION_FIELDS}
        cols["uuid"] = data.get("uuid") or str(uuid_mod.uuid4())
        cols["hora_entrada"] = data.get("hora_entrada") or _now_iso()
        cols["estado"] = "abierta"
        names = ", ".join(cols)
        marks = ", ".join("?" * len(cols))
        with self._lock:
            cur = self._conn.execute(
                f"INSERT INTO sesiones ({names}) VALUES ({marks})",
                tuple(cols.values()),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def get_session(self, session_id: int) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM sesiones WHERE id = ?", (session_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_sessions(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM sesiones ORDER BY id DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def close_session(
        self,
        session_id: int,
        snapshot: dict[str, Any],
        conteo_fisico: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        """Cierra la sesión con el snapshot final del motor.

        ``snapshot`` espera claves ``total_kg``, ``count`` (o
        ``total_animales``) y ``avg_kg`` (o ``promedio_final``).
        ``diferencia_conciliacion = conteo_fisico - total_animales``.
        """
        total_kg = snapshot.get("total_kg")
        total_animales = snapshot.get("count", snapshot.get("total_animales"))
        promedio = snapshot.get("avg_kg", snapshot.get("promedio_final"))
        diferencia = None
        if conteo_fisico is not None and total_animales is not None:
            diferencia = int(conteo_fisico) - int(total_animales)
        with self._lock:
            self._conn.execute(
                """UPDATE sesiones SET hora_salida = ?, total_kg = ?,
                       total_animales = ?, promedio_final = ?,
                       conteo_fisico = ?, diferencia_conciliacion = ?,
                       estado = 'cerrada'
                   WHERE id = ? AND estado = 'abierta'""",
                (
                    _now_iso(), total_kg, total_animales, promedio,
                    conteo_fisico, diferencia, session_id,
                ),
            )
            self._conn.commit()
        return self.get_session(session_id)

    # -------------------------------------------------------------- eventos

    def insert_event(self, event: WeighEvent) -> int:
        with self._lock:
            cur = self._conn.execute(
                """INSERT INTO eventos_pesaje
                       (sesion_id, ts_ms, peso_antes, peso_despues, delta_kg,
                        animales_estimados, animales_confirmados, estab_ms,
                        tipo, ambiguo, opciones, motivo_bajada,
                        evento_relacionado_id, confirmado_por)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    event.session_id,
                    event.ts_ms,
                    event.peso_antes,
                    event.peso_despues,
                    event.delta_kg,
                    event.animales_estimados,
                    event.animales_confirmados,
                    event.estab_ms,
                    event.tipo.value if hasattr(event.tipo, "value") else str(event.tipo),
                    1 if event.ambiguo else 0,
                    json.dumps(event.opciones) if event.opciones else None,
                    event.motivo_bajada,
                    getattr(event, "evento_relacionado_id", None),
                    event.confirmado_por,
                ),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def get_event(self, event_id: int) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM eventos_pesaje WHERE id = ?", (event_id,)
            ).fetchone()
        return self._event_row(row) if row else None

    def update_event_confirm(
        self, event_id: int, n: int, confirmado_por: Optional[str] = None
    ) -> None:
        with self._lock:
            self._conn.execute(
                """UPDATE eventos_pesaje
                   SET animales_confirmados = ?, ambiguo = 0, confirmado_por = ?
                   WHERE id = ?""",
                (n, confirmado_por, event_id),
            )
            self._conn.commit()

    def set_event_motivo(self, event_id: int, motivo: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE eventos_pesaje SET motivo_bajada = ? WHERE id = ?",
                (motivo, event_id),
            )
            self._conn.commit()

    def list_events(self, session_id: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM eventos_pesaje WHERE sesion_id = ? ORDER BY ts_ms, id",
                (session_id,),
            ).fetchall()
        return [self._event_row(r) for r in rows]

    @staticmethod
    def _event_row(row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        d["ambiguo"] = bool(d["ambiguo"])
        d["opciones"] = json.loads(d["opciones"]) if d["opciones"] else []
        return d

    # ------------------------------------------------------------- lecturas

    def insert_reading(self, sesion_id: Optional[int], ts_ms: int, kg: float) -> None:
        if not self.store_readings:
            return
        with self._lock:
            self._conn.execute(
                "INSERT INTO lecturas_crudas (ts_ms, kg, sesion_id) VALUES (?, ?, ?)",
                (ts_ms, kg, sesion_id),
            )
            self._conn.commit()

    def count_readings(self, sesion_id: int) -> int:
        with self._lock:
            (n,) = self._conn.execute(
                "SELECT COUNT(*) FROM lecturas_crudas WHERE sesion_id = ?",
                (sesion_id,),
            ).fetchone()
        return int(n)

    # ---------------------------------------------------------------- stats

    def stats(self, session_id: int) -> dict[str, Any]:
        """Estadística de la sesión (SPEC §6, por sesión).

        Totales sobre TODOS los eventos (con signo: las bajadas
        descuentan). La dispersión (desviación estándar, CV%,
        uniformidad ±10 %) se calcula sobre los deltas de subidas de
        exactamente 1 animal — los únicos pesos individuales conocidos.
        """
        events = self.list_events(session_id)
        total_kg = 0.0
        total_animales = 0
        singles: list[float] = []
        for ev in events:
            if ev["tipo"] == "ajuste" and ev["delta_kg"] == 0:
                continue
            n = ev["animales_confirmados"]
            if n is None:
                n = ev["animales_estimados"]
            n = abs(int(n))
            sign = -1 if ev["delta_kg"] < 0 else 1
            total_kg += ev["delta_kg"]
            total_animales += sign * n
            if sign > 0 and n == 1:
                singles.append(float(ev["delta_kg"]))

        promedio = (total_kg / total_animales) if total_animales else None

        desviacion_std = cv_pct = uniformidad_pct = None
        if singles:
            media_singles = statistics.fmean(singles)
            desviacion_std = statistics.pstdev(singles)
            if media_singles:
                cv_pct = desviacion_std / media_singles * 100.0
                dentro = [
                    kg for kg in singles
                    if abs(kg - media_singles) <= 0.10 * media_singles
                ]
                uniformidad_pct = len(dentro) / len(singles) * 100.0

        return {
            "total_kg": round(total_kg, 3),
            "total_animales": total_animales,
            "promedio": round(promedio, 3) if promedio is not None else None,
            "n_eventos": len(events),
            "n_muestras_individuales": len(singles),
            "min_delta": min(singles) if singles else None,
            "max_delta": max(singles) if singles else None,
            "desviacion_std": round(desviacion_std, 3) if desviacion_std is not None else None,
            "cv_pct": round(cv_pct, 2) if cv_pct is not None else None,
            "uniformidad_pct": round(uniformidad_pct, 2) if uniformidad_pct is not None else None,
        }
