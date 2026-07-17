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
    """Crea (o migra en vacío) el esquema. Idempotente.

    Migración v2: DBs creadas antes del motor v2 no tienen la columna
    ``sesiones.modo`` (el CREATE usa IF NOT EXISTS y no la agrega); se
    detecta con PRAGMA table_info y se agrega con ALTER TABLE.
    """
    path = Path(path)
    if path.parent != Path(""):
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        cols = {row[1] for row in conn.execute("PRAGMA table_info(sesiones)")}
        if "modo" not in cols:
            conn.execute(
                "ALTER TABLE sesiones ADD COLUMN modo TEXT NOT NULL DEFAULT 'lote'"
            )
        conn.commit()
    finally:
        conn.close()


class Repo:
    """Repositorio de sesiones/eventos/lecturas.

    ``store_readings`` activa/desactiva la persistencia de lecturas
    crudas (SPEC §5: opcional, a 10 Hz solo para auditoría/replay).
    """

    #: Tope de filas en lecturas_crudas (a 10 Hz ≈ 5.5 h de stream).
    #: Al superarlo se borran las más VIEJAS pero SOLO de sesiones no
    #: abiertas (cerradas/anuladas o sin sesión): la sesión en curso
    #: nunca pierde su replay. El chequeo corre cada
    #: ``prune_check_every`` inserciones para no pagar un COUNT(*) por
    #: cada lectura a 10 Hz.
    DEFAULT_MAX_RAW_READINGS = 200_000
    DEFAULT_PRUNE_CHECK_EVERY = 500

    def __init__(
        self,
        path: str | Path,
        store_readings: bool = True,
        *,
        max_raw_readings: int = DEFAULT_MAX_RAW_READINGS,
        prune_check_every: int = DEFAULT_PRUNE_CHECK_EVERY,
    ) -> None:
        self.path = Path(path)
        self.store_readings = store_readings
        self.max_raw_readings = max_raw_readings
        self.prune_check_every = max(1, prune_check_every)
        self._inserts_since_prune = 0
        init_db(self.path)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        # WAL verificado en runtime: si el FS no lo soporta, fallar claro.
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

    # ------------------------------------------------------------- sesiones

    def create_session(self, data: dict[str, Any]) -> int:
        cols = {k: data.get(k) for k in SESSION_FIELDS}
        cols["modo"] = data.get("modo") or "lote"
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

    @staticmethod
    def _session_filters(
        desde: Optional[str], hasta: Optional[str], q: Optional[str] = None
    ) -> tuple[str, list[Any]]:
        """WHERE compartido por list_sessions y stats_global.

        ``desde``/``hasta`` son fechas ISO (YYYY-MM-DD) inclusivas sobre
        ``hora_entrada``; ``q`` busca subcadena en lote/corral/destino.
        """
        conds: list[str] = []
        params: list[Any] = []
        if desde:
            conds.append("date(hora_entrada) >= date(?)")
            params.append(desde)
        if hasta:
            conds.append("date(hora_entrada) <= date(?)")
            params.append(hasta)
        if q:
            conds.append(
                "(lote LIKE ? OR corral_origen LIKE ? OR destino LIKE ?)"
            )
            like = f"%{q}%"
            params.extend([like, like, like])
        where = f" WHERE {' AND '.join(conds)}" if conds else ""
        return where, params

    def list_sessions(
        self,
        desde: Optional[str] = None,
        hasta: Optional[str] = None,
        q: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        where, params = self._session_filters(desde, hasta, q)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT * FROM sesiones{where} ORDER BY id DESC", params
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
        self._inserts_since_prune += 1
        if self._inserts_since_prune >= self.prune_check_every:
            self._inserts_since_prune = 0
            self.prune_readings()

    def prune_readings(self) -> int:
        """Retención de lecturas crudas (ver DEFAULT_MAX_RAW_READINGS).

        Si el total supera ``max_raw_readings`` borra el excedente
        empezando por las lecturas más viejas de sesiones NO abiertas
        (incluye lecturas sin sesión). Las lecturas de sesiones abiertas
        jamás se tocan, aunque el tope quede excedido temporalmente.
        Retorna cuántas filas se borraron.
        """
        with self._lock:
            (total,) = self._conn.execute(
                "SELECT COUNT(*) FROM lecturas_crudas"
            ).fetchone()
            excess = int(total) - self.max_raw_readings
            if excess <= 0:
                return 0
            cur = self._conn.execute(
                """DELETE FROM lecturas_crudas WHERE rowid IN (
                       SELECT lc.rowid FROM lecturas_crudas lc
                       LEFT JOIN sesiones s ON s.id = lc.sesion_id
                       WHERE s.id IS NULL OR s.estado != 'abierta'
                       ORDER BY lc.ts_ms, lc.rowid
                       LIMIT ?
                   )""",
                (excess,),
            )
            self._conn.commit()
            return int(cur.rowcount)

    def count_readings(self, sesion_id: int) -> int:
        with self._lock:
            (n,) = self._conn.execute(
                "SELECT COUNT(*) FROM lecturas_crudas WHERE sesion_id = ?",
                (sesion_id,),
            ).fetchone()
        return int(n)

    # ---------------------------------------------------------------- stats

    def stats_global(
        self, desde: Optional[str] = None, hasta: Optional[str] = None
    ) -> dict[str, Any]:
        """Agregado global + por lote (Módulo Datos), calculado en SQL.

        Cuenta TODAS las sesiones del rango; los kg/animales solo suman
        donde hay totales (es decir, sesiones cerradas — las abiertas
        aún no tienen snapshot final y SUM ignora sus NULL).
        """
        where, params = self._session_filters(desde, hasta)
        with self._lock:
            g = self._conn.execute(
                f"""SELECT COUNT(*)                        AS sesiones,
                           COALESCE(SUM(total_animales), 0) AS total_animales,
                           COALESCE(SUM(total_kg), 0.0)     AS total_kg
                    FROM sesiones{where}""",
                params,
            ).fetchone()
            lotes = self._conn.execute(
                f"""SELECT COALESCE(lote, '(sin lote)')      AS lote,
                           COUNT(*)                          AS sesiones,
                           COALESCE(SUM(total_animales), 0)  AS animales,
                           COALESCE(SUM(total_kg), 0.0)      AS kg,
                           MAX(hora_entrada)                 AS ultima_fecha
                    FROM sesiones{where}
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

    def stats(self, session_id: int) -> dict[str, Any]:
        """Estadística de la sesión (SPEC §6 + docs/ESTADISTICA.md).

        Totales sobre TODOS los eventos (con signo: las bajadas
        descuentan). La dispersión (desviación estándar MUESTRAL n-1,
        varianza muestral, mediana, CV%, uniformidad ±10 %) se calcula
        sobre los pesos individuales conocidos:

        - modo "unidades": TODOS los eventos son SUBIDA n=1 con el peso
          exacto de cada animal → la muestra es COMPLETA (censo del
          lote pesado; máxima precisión).
        - modo "lote": la muestra son los deltas de subidas de
          exactamente 1 animal (incluida la REFERENCIA del cerdo de
          prueba) → es una ESTIMACIÓN (los animales que subieron en
          grupo no aportan pesos individuales).
        """
        session = self.get_session(session_id)
        modo = (session or {}).get("modo") or "lote"
        events = self.list_events(session_id)
        total_kg = 0.0
        total_animales = 0
        singles: list[float] = []
        for ev in events:
            if ev["tipo"] == "ajuste" and ev["delta_kg"] == 0:
                continue
            if ev["tipo"] == "referencia":
                # Motor v2: la REFERENCIA es el cerdo de prueba que se
                # BAJÓ al terminar la calibración — no integra los
                # totales del lote (count arranca en 0), pero su peso SÍ
                # es una muestra individual conocida.
                singles.append(float(ev["delta_kg"]))
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

        n_muestras = len(singles)
        # Desviación estándar / varianza MUESTRALES (n-1, Bessel):
        # 0 si n < 2 (con una sola muestra no hay dispersión medible).
        if n_muestras >= 2:
            desviacion_std = statistics.stdev(singles)
            varianza = statistics.variance(singles)
        else:
            desviacion_std = 0.0
            varianza = 0.0
        mediana = statistics.median(singles) if singles else None

        cv_pct = uniformidad_pct = None
        if singles:
            media_singles = statistics.fmean(singles)
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
            "n_muestras": n_muestras,
            # alias legado (pre-v2); mismo valor que n_muestras
            "n_muestras_individuales": n_muestras,
            "min_delta": min(singles) if singles else None,
            "max_delta": max(singles) if singles else None,
            "mediana": round(mediana, 3) if mediana is not None else None,
            "varianza": round(varianza, 3),
            "desviacion_std": round(desviacion_std, 3),
            "cv_pct": round(cv_pct, 2) if cv_pct is not None else None,
            "uniformidad_pct": round(uniformidad_pct, 2) if uniformidad_pct is not None else None,
            "modo": modo,
            # completa = cada animal pesado individualmente (unidades);
            # estimada = solo las subidas de 1 animal aportan muestra (lote)
            "tipo_muestra": "completa" if modo == "unidades" else "estimada",
        }
