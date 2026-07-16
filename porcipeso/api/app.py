"""API FastAPI de PorciPeso.

``create_app(db_path)`` arma la aplicación completa: REST + WebSocket +
estáticos de la UI. El motor de pesaje y los drivers se importan de
forma DIFERIDA (dentro de funciones) para que la API sea testeable con
un motor falso inyectado vía ``engine_factory``.

Firma de la fábrica de motor::

    engine_factory(config: EngineConfig,
                   on_event: Callable[[WeighEvent], None],
                   on_state: Callable[[str], None] | None) -> Engine
"""
from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import io
import json
import threading
import time
from pathlib import Path
from typing import Any, Callable, Literal, Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from porcipeso.api.simlive import SimLiveScale
from porcipeso.core.interfaces import Engine
from porcipeso.core.models import EngineConfig, Reading, ScaleProfile, WeighEvent
from porcipeso.db.repo import Repo

#: perfil sintético que reporta scale/status cuando manda la báscula simulada
SIM_PROFILE = ScaleProfile(
    id="simulador",
    name="Báscula simulada (interactiva)",
    brand="PorciPeso",
    parser="sim",
    transport="sim",
)

XLSX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)
READING_BROADCAST_MIN_S = 0.2  # throttle ~5 msgs/s hacia los websockets

STATIC_DIR = Path(__file__).resolve().parent.parent / "ui" / "static"


# --------------------------------------------------------------------- WS hub

class Hub:
    """Broadcast thread-safe hacia todos los websockets conectados.

    ``broadcast`` puede llamarse desde cualquier hilo (driver, threadpool
    de FastAPI): agenda el envío en el event loop capturado al arrancar.
    Retorna el JSON serializado (útil para tests).
    """

    def __init__(self) -> None:
        self._sockets: set[Any] = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None

    def register(self, ws: Any) -> None:
        self._sockets.add(ws)

    def unregister(self, ws: Any) -> None:
        self._sockets.discard(ws)

    @property
    def count(self) -> int:
        return len(self._sockets)

    def broadcast(self, payload: dict[str, Any]) -> str:
        msg = json.dumps(payload, default=str)
        loop = self.loop
        if loop is not None and not loop.is_closed():
            for ws in list(self._sockets):
                asyncio.run_coroutine_threadsafe(self._safe_send(ws, msg), loop)
        return msg

    @staticmethod
    async def _safe_send(ws: Any, msg: str) -> None:
        try:
            await ws.send_text(msg)
        except Exception:
            pass


# ------------------------------------------------------------------- payloads

class ConnectBody(BaseModel):
    profile_id: str
    port: Optional[str] = None
    host: Optional[str] = None
    tcp_port: Optional[int] = None


class SessionBody(BaseModel):
    granja: Optional[str] = None
    lote: Optional[str] = None
    corral: Optional[str] = None          # alias de corral_origen (plan Task 3)
    corral_origen: Optional[str] = None
    destino: Optional[str] = None
    placa: Optional[str] = None
    conductor: Optional[str] = None
    operador: Optional[str] = None
    bascula_id: Optional[str] = None
    peso_ref_inicial: Optional[float] = None


class CloseBody(BaseModel):
    conteo_fisico: Optional[int] = None


class ConfirmBody(BaseModel):
    n: int
    confirmado_por: Optional[str] = None


class MotivoBody(BaseModel):
    motivo: str


class SimActionBody(BaseModel):
    action: Literal["pigs_on", "pig_off", "nervous", "silence"]
    n: Optional[int] = None            # pigs_on (default 1)
    kg_each: Optional[float] = None    # pigs_on (default: gauss 102±6)
    seconds: Optional[float] = None    # nervous (default 3.0) / silence (4.0)


# ------------------------------------------------------------------ fábricas

def _default_engine_factory(
    config: EngineConfig,
    on_event: Callable[[WeighEvent], None],
    on_state: Optional[Callable[[str], None]] = None,
) -> Engine:
    # Import diferido: porcipeso.engine se construye en paralelo.
    from porcipeso.engine.engine import WeighingEngine

    return WeighingEngine(config, on_event, on_state=on_state)


def _snapshot_dict(snap: Any) -> dict[str, Any]:
    d = dataclasses.asdict(snap) if dataclasses.is_dataclass(snap) else dict(snap)
    state = d.get("state")
    d["state"] = getattr(state, "value", state)
    return d


# ------------------------------------------------------------------------ app

def create_app(
    db_path: str | Path = "data/porcipeso.db",
    *,
    engine_factory: Optional[Callable[..., Engine]] = None,
    store_readings: bool = True,
) -> FastAPI:
    repo = Repo(db_path, store_readings=store_readings)
    hub = Hub()

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        hub.loop = asyncio.get_running_loop()
        yield
        stop_driver()
        repo.close()

    app = FastAPI(title="PorciPeso", version="0.1.0", lifespan=lifespan)
    st = app.state
    st.repo = repo
    st.hub = hub
    st.engine = None
    st.engine_factory = engine_factory or _default_engine_factory
    st.engine_lock = threading.Lock()
    st.current_session_id = None
    st.driver_thread = None
    st.driver_stop = None
    st.driver_profile = None
    st.driver_error = None
    st.last_reading = None
    st.last_reading_broadcast = 0.0
    st.sim = None                 # SimLiveScale activa (o None)
    st.event_id_map = {}          # id de DB -> id interno del engine

    # ----------------------------------------------------------- wiring motor

    def broadcast_snapshot() -> None:
        engine = st.engine
        if engine is None:
            return
        try:
            snap = _snapshot_dict(engine.snapshot())
        except Exception:
            return
        hub.broadcast({"type": "snapshot", **snap})

    def on_engine_event(event: WeighEvent) -> None:
        if event.session_id is None and st.current_session_id is not None:
            event.session_id = st.current_session_id
        # NO se pisa event.id: el engine usa su id interno en confirm();
        # el mapa traduce el id de DB (el que ve la API) al del engine.
        db_id = repo.insert_event(event)
        st.event_id_map[db_id] = event.id if event.id is not None else db_id
        stored = repo.get_event(db_id)
        if stored is not None:
            hub.broadcast({"type": "event", **stored})
        broadcast_snapshot()

    def on_engine_state(_state: str) -> None:
        broadcast_snapshot()

    def ensure_engine() -> Engine:
        with st.engine_lock:
            if st.engine is None:
                st.engine = st.engine_factory(
                    EngineConfig(), on_engine_event, on_engine_state
                )
            return st.engine

    # ----------------------------------------------------------- hilo driver

    def on_reading(reading: Reading) -> None:
        st.last_reading = reading
        engine = st.engine
        if engine is not None:
            try:
                engine.feed(reading)
            except Exception:
                pass
        if st.current_session_id is not None:
            repo.insert_reading(st.current_session_id, reading.ts_ms, reading.kg)
        now = time.monotonic()
        if now - st.last_reading_broadcast >= READING_BROADCAST_MIN_S:
            st.last_reading_broadcast = now
            state = "idle"
            if engine is not None:
                with contextlib.suppress(Exception):
                    state = _snapshot_dict(engine.snapshot())["state"]
            hub.broadcast(
                {"type": "reading", "kg": reading.kg,
                 "ts_ms": reading.ts_ms, "state": state}
            )

    def stop_driver() -> None:
        """Detiene lo que esté alimentando lecturas (driver real o sim)."""
        if st.sim is not None:
            st.sim.stop()
            st.sim = None
        if st.driver_stop is not None:
            st.driver_stop.set()
        if st.driver_thread is not None and st.driver_thread.is_alive():
            st.driver_thread.join(timeout=2.0)
        st.driver_thread = None
        st.driver_stop = None
        st.driver_profile = None

    # -------------------------------------------------------------- endpoints

    @app.get("/api/profiles")
    def get_profiles() -> list[dict[str, Any]]:
        try:
            # Import diferido: porcipeso.drivers se construye en paralelo.
            from porcipeso.drivers.catalog import load_profiles
        except Exception as exc:  # módulo aún no disponible
            raise HTTPException(503, f"catálogo de drivers no disponible: {exc}")
        return [dataclasses.asdict(p) for p in load_profiles()]

    @app.post("/api/scale/connect")
    def scale_connect(body: ConnectBody) -> dict[str, Any]:
        try:
            # Imports diferidos (ver nota arriba).
            from porcipeso.drivers.catalog import get_profile
            from porcipeso.drivers.runner import run_driver
        except Exception as exc:
            raise HTTPException(503, f"drivers no disponibles: {exc}")

        try:
            profile = get_profile(body.profile_id)
        except Exception:
            profile = None
        if profile is None:
            raise HTTPException(404, f"perfil desconocido: {body.profile_id}")

        overrides: dict[str, Any] = {}
        if body.port:
            overrides["port"] = body.port
        if body.host:
            overrides["host"] = body.host
        if body.tcp_port:
            overrides["tcp_port"] = body.tcp_port
        if overrides:
            profile = dataclasses.replace(profile, **overrides)

        needs_hardware = (
            profile.transport == "serial" and body.profile_id != "sim"
        )
        if needs_hardware and not profile.port:
            raise HTTPException(400, "el perfil serial requiere 'port'")

        stop_driver()
        ensure_engine()
        stop_event = threading.Event()

        def loop() -> None:
            try:
                run_driver(profile, on_reading, stop_event.is_set)
            except Exception as exc:
                st.driver_error = str(exc)

        st.driver_error = None
        st.driver_stop = stop_event
        st.driver_profile = profile
        st.driver_thread = threading.Thread(
            target=loop, name=f"driver-{profile.id}", daemon=True
        )
        st.driver_thread.start()
        return {"connected": True, "profile_id": profile.id,
                "transport": profile.transport}

    @app.get("/api/scale/status")
    def scale_status() -> dict[str, Any]:
        thread = st.driver_thread
        connected = bool(thread is not None and thread.is_alive())
        reading: Optional[Reading] = st.last_reading
        state = "idle"
        if st.engine is not None:
            with contextlib.suppress(Exception):
                state = _snapshot_dict(st.engine.snapshot())["state"]
        return {
            "connected": connected,
            "profile_id": st.driver_profile.id if st.driver_profile else None,
            "last_kg": reading.kg if reading else None,
            "last_ts_ms": reading.ts_ms if reading else None,
            "state": state,
            "error": st.driver_error,
        }

    # ------------------------------------------------------- simulador vivo

    @app.post("/api/sim/start")
    def sim_start() -> dict[str, Any]:
        """Conecta la báscula SIMULADA (detiene un driver real si lo había).

        Equivale a scale/connect con el perfil "simulador": las lecturas
        entran por el mismo on_reading (engine + lecturas_crudas + WS) y
        scale/status refleja connected=true / profile_id="simulador".
        """
        stop_driver()
        ensure_engine()
        sim = SimLiveScale(on_reading).start()
        st.sim = sim
        st.driver_error = None
        st.driver_profile = SIM_PROFILE
        st.driver_thread = sim.thread
        return {"connected": True, "profile_id": SIM_PROFILE.id,
                "transport": SIM_PROFILE.transport, **sim.status()}

    @app.post("/api/sim/action")
    def sim_action(body: SimActionBody) -> dict[str, Any]:
        sim: Optional[SimLiveScale] = st.sim
        if sim is None or not sim.running:
            raise HTTPException(
                409,
                "el simulador no está iniciado: llama primero a POST /api/sim/start",
            )
        try:
            if body.action == "pigs_on":
                estado = sim.pigs_on(body.n or 1, body.kg_each)
            elif body.action == "pig_off":
                estado = sim.pig_off()
            elif body.action == "nervous":
                estado = sim.nervous(body.seconds if body.seconds is not None else 3.0)
            else:  # silence
                estado = sim.silence(body.seconds if body.seconds is not None else 4.0)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"action": body.action, **estado}

    @app.post("/api/sim/stop")
    def sim_stop() -> dict[str, Any]:
        was_running = st.sim is not None
        stop_driver()
        return {"connected": False, "stopped": was_running}

    # --------------------------------------------------------------- sesiones

    @app.post("/api/sessions", status_code=201)
    def create_session(body: SessionBody) -> dict[str, Any]:
        data = body.model_dump(exclude_none=True)
        if "corral" in data and "corral_origen" not in data:
            data["corral_origen"] = data.pop("corral")
        data.pop("corral", None)
        session_id = repo.create_session(data)
        engine = ensure_engine()
        engine.open_session(session_id)
        st.current_session_id = session_id
        broadcast_snapshot()
        session = repo.get_session(session_id)
        assert session is not None
        return session

    @app.get("/api/sessions")
    def list_sessions(
        desde: Optional[str] = None,
        hasta: Optional[str] = None,
        q: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Lista sesiones; filtros opcionales desde/hasta (fecha ISO,
        inclusivas sobre hora_entrada) y q (busca en lote/corral/destino)."""
        return repo.list_sessions(desde=desde, hasta=hasta, q=q)

    @app.get("/api/stats/global")
    def stats_global(
        desde: Optional[str] = None, hasta: Optional[str] = None
    ) -> dict[str, Any]:
        return repo.stats_global(desde=desde, hasta=hasta)

    @app.get("/api/sessions/{session_id}")
    def get_session(session_id: int) -> dict[str, Any]:
        session = repo.get_session(session_id)
        if session is None:
            raise HTTPException(404, "sesión no encontrada")
        return session

    @app.post("/api/sessions/{session_id}/close")
    def close_session(session_id: int, body: CloseBody) -> dict[str, Any]:
        session = repo.get_session(session_id)
        if session is None:
            raise HTTPException(404, "sesión no encontrada")
        if session["estado"] != "abierta":
            raise HTTPException(409, f"la sesión está {session['estado']}")

        if st.engine is not None and st.current_session_id == session_id:
            snap = _snapshot_dict(st.engine.close_session())
            st.current_session_id = None
            st.event_id_map = {}  # los ids internos del engine se resetean
        else:
            stats = repo.stats(session_id)
            snap = {
                "total_kg": stats["total_kg"],
                "count": stats["total_animales"],
                "avg_kg": stats["promedio"],
            }
        closed = repo.close_session(session_id, snap, body.conteo_fisico)
        assert closed is not None
        hub.broadcast({"type": "snapshot", "state": "idle",
                       "kg_now": 0.0, "ref_kg": None,
                       "avg_kg": closed["promedio_final"],
                       "count": closed["total_animales"] or 0,
                       "total_kg": closed["total_kg"] or 0.0,
                       "pending": 0})
        return closed

    @app.get("/api/sessions/{session_id}/events")
    def list_events(session_id: int) -> list[dict[str, Any]]:
        if repo.get_session(session_id) is None:
            raise HTTPException(404, "sesión no encontrada")
        return repo.list_events(session_id)

    @app.post("/api/events/{event_id}/confirm")
    def confirm_event(event_id: int, body: ConfirmBody) -> dict[str, Any]:
        if repo.get_event(event_id) is None:
            raise HTTPException(404, "evento no encontrado")
        if st.engine is not None:
            # el engine indexa por SU id de evento, no por el rowid de DB
            engine_event_id = st.event_id_map.get(event_id, event_id)
            with contextlib.suppress(Exception):
                st.engine.confirm(engine_event_id, body.n)
        repo.update_event_confirm(event_id, body.n, body.confirmado_por)
        updated = repo.get_event(event_id)
        assert updated is not None
        hub.broadcast({"type": "event", **updated})
        broadcast_snapshot()
        return updated

    @app.post("/api/events/{event_id}/motivo")
    def set_event_motivo(event_id: int, body: MotivoBody) -> dict[str, Any]:
        if repo.get_event(event_id) is None:
            raise HTTPException(404, "evento no encontrado")
        repo.set_event_motivo(event_id, body.motivo)
        updated = repo.get_event(event_id)
        assert updated is not None
        hub.broadcast({"type": "event", **updated})
        return updated

    @app.get("/api/sessions/{session_id}/stats")
    def session_stats(session_id: int) -> dict[str, Any]:
        if repo.get_session(session_id) is None:
            raise HTTPException(404, "sesión no encontrada")
        return repo.stats(session_id)

    @app.get("/api/sessions/{session_id}/export.xlsx")
    def export_xlsx(session_id: int) -> Response:
        session = repo.get_session(session_id)
        if session is None:
            raise HTTPException(404, "sesión no encontrada")
        content = build_xlsx(session, repo.list_events(session_id),
                             repo.stats(session_id))
        return Response(
            content=content,
            media_type=XLSX_MEDIA_TYPE,
            headers={
                "Content-Disposition":
                    f'attachment; filename="sesion_{session_id}.xlsx"'
            },
        )

    # -------------------------------------------------------------- websocket

    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        hub.register(ws)
        if hub.loop is None:
            hub.loop = asyncio.get_running_loop()
        try:
            while True:
                await ws.receive_text()  # keepalive; se ignora el contenido
        except WebSocketDisconnect:
            pass
        finally:
            hub.unregister(ws)

    # UI estática del operador (Task 4); puede no existir aún.
    if STATIC_DIR.is_dir():
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True),
                  name="static")

    return app


# ------------------------------------------------------------------ export

EVENT_COLUMNS = [
    "id", "ts_ms", "tipo", "peso_antes", "peso_despues", "delta_kg",
    "animales_estimados", "animales_confirmados", "estab_ms", "ambiguo",
    "opciones", "motivo_bajada", "evento_relacionado_id", "confirmado_por",
]

RESUMEN_ROWS = [
    ("Granja", "granja"), ("Lote", "lote"), ("Corral origen", "corral_origen"),
    ("Destino", "destino"), ("Placa", "placa"), ("Conductor", "conductor"),
    ("Operador", "operador"), ("Báscula", "bascula_id"),
    ("Peso ref. inicial (kg)", "peso_ref_inicial"),
    ("Hora entrada", "hora_entrada"), ("Hora salida", "hora_salida"),
    ("Total kg", "total_kg"), ("Total animales", "total_animales"),
    ("Promedio final (kg)", "promedio_final"),
    ("Conteo físico", "conteo_fisico"),
    ("Diferencia conciliación", "diferencia_conciliacion"),
    ("Estado", "estado"),
]

STATS_ROWS = [
    ("Desviación estándar (kg)", "desviacion_std"),
    ("CV %", "cv_pct"),
    ("Uniformidad ±10% (%)", "uniformidad_pct"),
    ("Delta mínimo (kg)", "min_delta"),
    ("Delta máximo (kg)", "max_delta"),
]


def build_xlsx(session: dict[str, Any], events: list[dict[str, Any]],
               stats: dict[str, Any]) -> bytes:
    """Construye el .xlsx (hoja Resumen + hoja Eventos). Retorna bytes."""
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Resumen"
    ws.append(["Sesión", session["id"]])
    ws.append(["UUID", session.get("uuid")])
    for label, key in RESUMEN_ROWS:
        ws.append([label, session.get(key)])
    ws.append([])
    ws.append(["— Estadística —", ""])
    for label, key in STATS_ROWS:
        ws.append([label, stats.get(key)])

    we = wb.create_sheet("Eventos")
    we.append(EVENT_COLUMNS)
    for ev in events:
        row = []
        for col in EVENT_COLUMNS:
            value = ev.get(col)
            if col == "opciones":
                value = json.dumps(value) if value else None
            elif col == "ambiguo":
                value = 1 if value else 0
            row.append(value)
        we.append(row)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
