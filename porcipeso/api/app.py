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
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Literal, Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from porcipeso.api import cloudauth
from porcipeso.api.reports import router as reports_router
from porcipeso.api.simlive import SimLiveScale
from porcipeso.api.syncworker import SyncWorker
from porcipeso.api.updatecheck import router as update_router
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
    # Correcciones de trama (toggle 🔁 del wizard / opción avanzada):
    #  - reverse_frame: los caracteres llegan al revés ("001" = 100) —
    #    lo aplica el parser (drivers/parsers.py:reverse_frame_active).
    #  - invert_bits: polaridad eléctrica TTL invertida — lo aplica el
    #    runner (drivers/runner.py:ingress).
    reverse_frame: Optional[bool] = None
    invert_bits: Optional[bool] = None


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
    modo: Optional[str] = None            # "lote" (default) | "unidades"


class CloseBody(BaseModel):
    conteo_fisico: Optional[int] = None


class ConfirmBody(BaseModel):
    n: int
    confirmado_por: Optional[str] = None


class MotivoBody(BaseModel):
    motivo: str


class MinKgBody(BaseModel):
    """Peso mínimo (kg) para contar un cerdo/escalón (default 2)."""
    kg: float


class EngineTuningBody(BaseModel):
    """Ajustes finos de pesaje. Todos opcionales: solo se aplican los enviados.
      - min_stable_ms: tiempo mínimo (ms) estable para registrar un peso.
      - unit_return_to_zero: unidades, exigir vaciar entre cerdos (SIN REPESAJE).
      - band_low / band_high: banda plausible [avg*low, avg*high] en unidades.
      - min_animals_for_band: nº de cerdos antes de aplicar la banda.
    """
    min_stable_ms: Optional[float] = None
    unit_return_to_zero: Optional[bool] = None
    band_low: Optional[float] = None
    band_high: Optional[float] = None
    min_animals_for_band: Optional[int] = None


class ReturnedBody(BaseModel):
    """Devueltos MANUAL: cerdos que se subieron, se devolvieron por miedo y se
    re-pesarán. Corrige el doble conteo. Es la única vía de descuento — la
    báscula de paso no adivina.
      - kg=None (lote): descuenta n×promedio (peso individual desconocido).
      - kg=peso real (unidades): descuenta el PESO REAL de los cerdos elegidos
        (kg = suma de sus pesos); cuadra exacto cuando re-pasen.
    """
    n: int
    kg: Optional[float] = None


class ReferenceBody(BaseModel):
    """Referencia MANUAL del cerdo de prueba: el operario escribe el peso
    conocido (kg > 0) y el motor lo fija como referencia sin esperar al
    umbral automático (engine.set_reference). Solo aplica en modo lote."""
    kg: float


class LimpiarBody(BaseModel):
    """🧹 Liberar espacio: 'lecturas' (siempre seguro) o 'pesajes' cerrados
    anteriores a una fecha (irreversible; dry_run cuenta sin borrar)."""
    accion: Literal["lecturas", "pesajes"]
    antes: Optional[str] = None       # YYYY-MM-DD (solo accion='pesajes')
    dry_run: bool = False


class CloudProbeBody(BaseModel):
    cloud_url: str
    tenant: Optional[str] = None


class CloudLoginBody(BaseModel):
    cloud_url: str
    tenant: Optional[str] = None
    email: str
    password: str


class CloudSessionBody(BaseModel):
    cloud_url: str
    tenant: Optional[str] = None
    access_token: Optional[str] = None
    refresh_token: str
    expires_in: Optional[float] = None
    perfil: Optional[dict[str, Any]] = None


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
    sync_worker = SyncWorker(repo)

    async def demo_reaper() -> None:
        """Autodestrucción de sesiones DEMO: al abrir y cada hora.

        Borra las sesiones de práctica (es_demo=1) con más de
        Repo.DEMO_TTL_MINUTES de cerradas — jamás las reales ni las
        abiertas (la regla vive en repo.cleanup_demo_sessions).
        """
        while True:
            try:
                await asyncio.to_thread(repo.cleanup_demo_sessions)
            except Exception:
                pass  # la limpieza jamás tumba la app
            await asyncio.sleep(3600)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        hub.loop = asyncio.get_running_loop()
        sync_worker.start()
        reaper = asyncio.create_task(demo_reaper())
        yield
        reaper.cancel()
        stop_driver()
        sync_worker.stop()
        repo.close()

    app = FastAPI(title="PorciPeso", version="0.1.0", lifespan=lifespan)
    st = app.state
    st.repo = repo
    st.hub = hub
    st.engine = None
    st.engine_factory = engine_factory or _default_engine_factory
    st.engine_lock = threading.Lock()
    # Peso mínimo (kg) para contar un cerdo/escalón. 2 kg por defecto: a partir
    # de 2 kg la báscula empieza a buscar el peak-hold del animal (lechones
    # incluidos; antes 40 kg / 5 kg los ignoraba). Ajustable vía POST
    # /api/config/min-kg.
    st.min_kg = 2.0
    # Ajustes finos de pesaje (v2.9) — se inyectan en EngineConfig al crear el
    # motor y se cambian vía POST /api/config/engine (rebuild si no hay sesión):
    #  - min_stable_ms: tiempo mínimo estable para registrar (anti-rebote).
    #  - unit_return_to_zero: unidades, exigir vaciar entre cerdos (SIN REPESAJE).
    #  - band_low/band_high/min_animals_for_band: banda de plausibilidad unidades.
    from porcipeso.core.models import EngineConfig as _EC  # defaults canónicos
    _dc = _EC()
    st.min_stable_ms = _dc.min_stable_ms
    st.unit_return_to_zero = _dc.unit_return_to_zero
    st.band_low = _dc.band_low
    st.band_high = _dc.band_high
    st.min_animals_for_band = _dc.min_animals_for_band
    st.current_session_id = None
    st.driver_thread = None
    st.driver_stop = None
    st.driver_profile = None
    st.driver_error = None
    st.last_reading = None
    st.last_reading_broadcast = 0.0
    st.sim = None                 # SimLiveScale activa (o None)
    st.event_id_map = {}          # id de DB -> id interno del engine
    st.sync_worker = sync_worker  # sync a la nube (dormido sin sesión)

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
                # El mismo "peso mínimo" gobierna el conteo (min_delta_kg) y el
                # piso de captura de referencia en calibración/lote (min_ref_kg):
                # a partir de st.min_kg la báscula empieza a buscar el peak-hold.
                # Los ajustes finos (tiempo estable, retorno-a-cero, banda) se
                # inyectan aquí desde el estado editable de la app.
                st.engine = st.engine_factory(
                    EngineConfig(
                        min_delta_kg=st.min_kg,
                        min_ref_kg=st.min_kg,
                        min_stable_ms=st.min_stable_ms,
                        unit_return_to_zero=st.unit_return_to_zero,
                        band_low=st.band_low,
                        band_high=st.band_high,
                        min_animals_for_band=st.min_animals_for_band,
                    ),
                    on_engine_event, on_engine_state
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
            fase = "lote"
            cand_kg = None
            if engine is not None:
                with contextlib.suppress(Exception):
                    snap = _snapshot_dict(engine.snapshot())
                    state = snap["state"]
                    fase = snap.get("fase", "lote")
                    cand_kg = snap.get("cand_kg")
            hub.broadcast(
                {"type": "reading", "kg": reading.kg,
                 "ts_ms": reading.ts_ms, "state": state, "fase": fase,
                 "cand_kg": cand_kg,
                 # string crudo tal como lo muestra el indicador (LED de la
                 # UI lo pinta tal cual; null → la UI degrada a formato plano)
                 "raw": getattr(reading, "raw", None)}
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
        if body.reverse_frame is not None or body.invert_bits is not None:
            extra = dict(profile.extra)
            if body.reverse_frame is not None:
                extra["reverse_frame"] = bool(body.reverse_frame)
            if body.invert_bits is not None:
                extra["invert_bits"] = bool(body.invert_bits)
            overrides["extra"] = extra
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

    @app.post("/api/scale/disconnect")
    def scale_disconnect() -> dict[str, Any]:
        """Corta el driver activo (real o simulado) SIN tocar la config guardada.

        La configuración vive en el cliente (localStorage): desconectar solo
        detiene el hilo del driver; reconectar es POST /api/scale/connect de
        nuevo. Idempotente: sin driver activo responde igual.
        """
        was_connected = bool(
            st.driver_thread is not None and st.driver_thread.is_alive()
        )
        stop_driver()
        st.driver_error = None
        return {"connected": False, "disconnected": was_connected}

    @app.get("/api/config/min-kg")
    def get_min_kg() -> dict[str, Any]:
        return {"kg": st.min_kg}

    @app.post("/api/config/min-kg")
    def set_min_kg(body: MinKgBody) -> dict[str, Any]:
        """Peso mínimo por cerdo. Reconstruye el motor si no hay sesión abierta
        (EngineConfig es inmutable tras crear el motor)."""
        if not body.kg > 0:
            raise HTTPException(status_code=400, detail="kg debe ser mayor a 0")
        st.min_kg = float(body.kg)
        if st.current_session_id is None:
            with st.engine_lock:
                st.engine = None
        return {"kg": st.min_kg}

    def _engine_tuning() -> dict[str, Any]:
        return {
            "min_stable_ms": st.min_stable_ms,
            "unit_return_to_zero": st.unit_return_to_zero,
            "band_low": st.band_low,
            "band_high": st.band_high,
            "min_animals_for_band": st.min_animals_for_band,
        }

    @app.get("/api/config/engine")
    def get_engine_tuning() -> dict[str, Any]:
        return _engine_tuning()

    @app.post("/api/config/engine")
    def set_engine_tuning(body: EngineTuningBody) -> dict[str, Any]:
        """Ajustes finos de pesaje. Reconstruye el motor si no hay sesión
        abierta (EngineConfig es inmutable tras crear el motor)."""
        if body.min_stable_ms is not None:
            if not body.min_stable_ms >= 0:
                raise HTTPException(status_code=400,
                                    detail="min_stable_ms debe ser >= 0")
            st.min_stable_ms = float(body.min_stable_ms)
        if body.unit_return_to_zero is not None:
            st.unit_return_to_zero = bool(body.unit_return_to_zero)
        if body.band_low is not None:
            if not 0 < body.band_low <= 1:
                raise HTTPException(status_code=400,
                                    detail="band_low debe estar en (0, 1]")
            st.band_low = float(body.band_low)
        if body.band_high is not None:
            if not body.band_high >= 1:
                raise HTTPException(status_code=400,
                                    detail="band_high debe ser >= 1")
            st.band_high = float(body.band_high)
        if body.min_animals_for_band is not None:
            if not body.min_animals_for_band >= 1:
                raise HTTPException(status_code=400,
                                    detail="min_animals_for_band debe ser >= 1")
            st.min_animals_for_band = int(body.min_animals_for_band)
        if st.current_session_id is None:
            with st.engine_lock:
                st.engine = None
        return _engine_tuning()

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
        modo = data.get("modo") or "lote"
        if modo not in ("lote", "unidades"):
            # mismo contrato que engine.open_session (ValueError → 400),
            # validado ANTES de insertar la fila para no dejar huérfanas
            raise HTTPException(
                400, f"modo desconocido: {modo!r} (esperado: ('lote', 'unidades'))"
            )
        data["modo"] = modo
        # DEMO: toda sesión creada con la báscula SIMULADA conectada se
        # marca es_demo=1 (chip DEMO, fuera de stats, autodestruible).
        # Lo decide el backend por el perfil activo — la UI no lo manda.
        profile = st.driver_profile
        data["es_demo"] = 1 if (
            st.sim is not None
            or (profile is not None and profile.id in ("simulador", "sim"))
        ) else 0
        engine = ensure_engine()
        session_id = repo.create_session(data)
        try:
            engine.open_session(session_id, modo=modo)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
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

    # ------------------------------------------------ 🧹 liberar espacio
    # Mismo contrato que el shim móvil (mobile/src/apishim.ts): la UI
    # de "Liberar espacio" funciona idéntica en escritorio y en el APK.

    @app.get("/api/mantenimiento/uso")
    def mantenimiento_uso() -> dict[str, Any]:
        return repo.storage_usage()

    @app.post("/api/mantenimiento/limpiar")
    def mantenimiento_limpiar(body: LimpiarBody) -> dict[str, Any]:
        if body.accion == "lecturas":
            # Siempre seguro: solo lecturas crudas de pesajes NO abiertos.
            borradas = repo.cleanup_readings()
            return {"borrado": {"lecturas": borradas}, **repo.storage_usage()}
        if body.accion == "pesajes":
            antes = (body.antes or "").strip()
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", antes):
                raise HTTPException(
                    422, "falta 'antes' con formato YYYY-MM-DD "
                         "(se borran pesajes cerrados anteriores a esa fecha)")
            result = repo.cleanup_sessions(antes, dry_run=body.dry_run)
            return {"borrado": result, **repo.storage_usage()}
        raise HTTPException(422, f"acción desconocida: {body.accion!r} "
                                 "(esperado: 'lecturas' o 'pesajes')")

    @app.get("/api/sessions/{session_id}")
    def get_session(session_id: int) -> dict[str, Any]:
        session = repo.get_session(session_id)
        if session is None:
            raise HTTPException(404, "sesión no encontrada")
        return session

    @app.delete("/api/sessions/{session_id}")
    def delete_session(session_id: int) -> dict[str, Any]:
        """Elimina un lote (sesión) con sus eventos y lecturas crudas en
        cascada. 404 si no existe; 409 si está ABIERTA (hay que cerrar el
        pesaje antes de borrarlo). Las sesiones DEMO se borran igual. Un
        pesaje cerrado nunca es el activo del motor, así que no hay estado
        vivo que tocar."""
        session = repo.get_session(session_id)
        if session is None:
            raise HTTPException(404, "sesión no encontrada")
        if session["estado"] == "abierta":
            raise HTTPException(409, "cierra el pesaje antes de borrarlo")
        n_eventos = repo.delete_session(session_id)
        return {"deleted": True, "id": session_id, "eventos": n_eventos}

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
                       "pending": 0, "fase": "lote"})
        sync_worker.request_push()  # sube el cierre a la nube sin esperar 60 s
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

    @app.post("/api/session/returned")
    def session_returned(body: ReturnedBody) -> dict[str, Any]:
        """Registra n cerdos devueltos (rebote) en la sesión activa. Con `kg`
        descuenta el PESO REAL de los cerdos elegidos (unidades); sin `kg` usa
        el promedio (lote). El evento AJUSTE lo persiste y difunde el wiring
        on_engine_event."""
        if body.n < 1:
            raise HTTPException(400, "n debe ser ≥ 1")
        if body.kg is not None and body.kg < 0:
            raise HTTPException(400, "kg no puede ser negativo")
        if st.engine is None or st.current_session_id is None:
            raise HTTPException(409, "no hay un pesaje activo")
        ev = st.engine.register_returned(body.n, body.kg)
        if ev is None:
            raise HTTPException(409, "no hay cerdos que descontar")
        snap = _snapshot_dict(st.engine.snapshot())
        return {"ok": True, "descontados": ev.animales_confirmados,
                "count": snap["count"], "total_kg": snap["total_kg"]}

    @app.post("/api/session/reference")
    def session_reference(body: ReferenceBody) -> dict[str, Any]:
        """Fija a mano el peso del cerdo de prueba en la sesión activa. El
        evento REFERENCIA (confirmado_por='manual') lo persiste y difunde el
        wiring on_engine_event; aquí solo validamos y devolvemos el estado."""
        if body.kg <= 0:
            raise HTTPException(400, "kg debe ser > 0")
        if st.engine is None or st.current_session_id is None:
            raise HTTPException(409, "no hay un pesaje activo")
        ev = st.engine.set_reference(body.kg)
        if ev is None:
            raise HTTPException(
                409, "no se pudo fijar la referencia (¿la sesión es modo lote?)"
            )
        snap = _snapshot_dict(st.engine.snapshot())
        return {"ok": True, "ref_kg": snap["ref_kg"],
                "fase": snap.get("fase", "lote")}

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

    # ------------------------------------------------------- nube (opcional)
    # La UI habla con la nube SIEMPRE a través de estos endpoints locales
    # (mismo origen ⇒ sin CORS) y el TokenBox del worker es el único
    # dueño del refresh (rotativo: dos refrescadores se pisarían).

    @app.post("/api/cloud/probe")
    def cloud_probe(body: CloudProbeBody) -> dict[str, Any]:
        """Prueba GET /health + GET /config/app?tenant=… de la nube."""
        return cloudauth.cloud_probe(body.cloud_url, body.tenant or "")

    @app.post("/api/cloud/login")
    def cloud_login(body: CloudLoginBody) -> dict[str, Any]:
        """Proxy de login: autentica, configura el sync worker y retorna
        {perfil, access_token, refresh_token, expires_in} a la UI."""
        try:
            pair = cloudauth.cloud_login(body.cloud_url, body.email, body.password)
        except cloudauth.CloudOffline as exc:
            raise HTTPException(504, f"sin conexión con la nube: {exc.detail}")
        except cloudauth.CloudError as exc:
            raise HTTPException(exc.status or 502, exc.detail or "error de la nube")
        access = str(pair.get("access_token") or "")
        refresh = str(pair.get("refresh_token") or "")
        expires_in = float(pair.get("expires_in") or 1800)
        perfil = cloudauth.perfil_from_token(access, email=body.email)
        sync_worker.set_session(
            body.cloud_url, body.tenant or "", access, refresh,
            expires_in=expires_in, perfil=perfil,
        )
        return {
            "perfil": perfil,
            "access_token": access,
            "refresh_token": refresh,
            "expires_in": expires_in,
        }

    @app.post("/api/cloud/session")
    def cloud_session(body: CloudSessionBody) -> dict[str, Any]:
        """La UI entrega los tokens al worker (p. ej. login hecho aparte
        o re-siembra tras un reinicio con refresh cacheado)."""
        sync_worker.set_session(
            body.cloud_url, body.tenant or "",
            body.access_token or "", body.refresh_token,
            expires_in=body.expires_in, perfil=body.perfil,
        )
        return {"ok": True, "device_id": sync_worker.device_id}

    @app.delete("/api/cloud/session")
    def cloud_logout() -> dict[str, Any]:
        """Logout: revoca el refresh en la nube (best-effort) y lo borra.
        Los pesajes locales y el marcador de sync quedan intactos."""
        sync_worker.clear_session()
        return {"ok": True}

    @app.get("/api/cloud/token")
    def cloud_token() -> dict[str, Any]:
        """Access vigente para la UI (refresca el worker si hace falta)."""
        if not sync_worker.configured:
            raise HTTPException(409, "nube sin sesión")
        try:
            sync_worker.tokens.get_access()
        except cloudauth.SessionExpired:
            raise HTTPException(401, "sesión vencida: inicia sesión de nuevo")
        except cloudauth.CloudOffline:
            raise HTTPException(504, "sin conexión con la nube")
        except cloudauth.CloudError as exc:
            raise HTTPException(exc.status or 502, exc.detail or "error de la nube")
        snap = sync_worker.tokens.snapshot()
        return {**snap, "perfil": sync_worker.perfil()}

    @app.get("/api/cloud/status")
    def cloud_status() -> dict[str, Any]:
        return {**sync_worker.status(), "perfil": sync_worker.perfil()}

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

    app.include_router(update_router)  # GET /api/update/status
    app.include_router(reports_router)  # informes PDF con marca ELEIA

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
    ("Modo", "modo"),
    ("Peso ref. inicial (kg)", "peso_ref_inicial"),
    ("Hora entrada", "hora_entrada"), ("Hora salida", "hora_salida"),
    ("Total kg", "total_kg"), ("Total animales", "total_animales"),
    ("Promedio final (kg)", "promedio_final"),
    ("Conteo físico", "conteo_fisico"),
    ("Diferencia conciliación", "diferencia_conciliacion"),
    ("Estado", "estado"),
]

STATS_ROWS = [
    ("N muestras", "n_muestras"),
    ("Tipo de muestra", "tipo_muestra"),
    ("Mediana (kg)", "mediana"),
    ("Desviación estándar muestral (kg)", "desviacion_std"),
    ("Varianza muestral (kg²)", "varianza"),
    ("CV %", "cv_pct"),
    ("Uniformidad ±10% (%)", "uniformidad_pct"),
    ("Delta mínimo (kg)", "min_delta"),
    ("Delta máximo (kg)", "max_delta"),
]


def build_xlsx(session: dict[str, Any], events: list[dict[str, Any]],
               stats: dict[str, Any]) -> bytes:
    """Construye el .xlsx con diseño de marca (hoja Resumen + hoja Eventos).

    Resumen: banda verde Eleia con el lockup, "Datos del lote" como tabla
    clave-valor con bordes finos y zebra, tarjetas de totales combinadas,
    estadística, tabla de movimientos en español y pie de marca.
    Eventos: datos crudos del motor (mismas columnas de siempre) con
    encabezado verde, zebra, freeze panes y autofiltro.

    Toda la marca sale de ``porcipeso.branding`` — nada de strings sueltos.
    """
    from datetime import datetime as _dt

    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    from porcipeso import branding
    from porcipeso.api.reports import TIPO_HUMANO

    GREEN = branding.ELEIA_GREEN.lstrip("#")
    GREEN_DARK = branding.ELEIA_GREEN_DARK.lstrip("#")
    CHARCOAL = branding.ELEIA_CHARCOAL.lstrip("#")
    PP_GREEN = branding.PORCIPESO_GREEN.lstrip("#")
    CARD_BG = branding.REPORT_CARD_BG.lstrip("#")
    NOTE_BG = branding.REPORT_NOTE_BG.lstrip("#")
    ZEBRA = branding.REPORT_ZEBRA.lstrip("#")
    BORDER = branding.REPORT_BORDER.lstrip("#")

    fill_green = PatternFill("solid", fgColor=GREEN)
    fill_green_dark = PatternFill("solid", fgColor=GREEN_DARK)
    fill_card = PatternFill("solid", fgColor=CARD_BG)
    fill_note = PatternFill("solid", fgColor=NOTE_BG)
    fill_zebra = PatternFill("solid", fgColor=ZEBRA)

    side_thin = Side(style="thin", color=BORDER)
    border_thin = Border(left=side_thin, right=side_thin,
                         top=side_thin, bottom=side_thin)
    side_green = Side(style="thin", color=GREEN)
    border_card = Border(left=side_green, right=side_green,
                         top=side_green, bottom=side_green)

    right = Alignment(horizontal="right", vertical="center")
    center = Alignment(horizontal="center", vertical="center")
    left_top = Alignment(horizontal="left", vertical="center",
                         wrap_text=True)

    KG_FMT = "#,##0.0"
    STAT_FMT = "#,##0.00"
    LAST_COL = 6  # A..F

    wb = Workbook()
    ws = wb.active
    ws.title = "Resumen"
    for col, width in zip("ABCDEF", (34, 14, 13, 13, 13, 16)):
        ws.column_dimensions[col].width = width

    def _merge_row(row: int, value: Any, *, fill=None, font=None,
                   align=None, height=None, border=None,
                   first: int = 1, last: int = LAST_COL) -> None:
        ws.cell(row=row, column=first, value=value)
        ws.merge_cells(start_row=row, start_column=first,
                       end_row=row, end_column=last)
        for c in range(first, last + 1):
            cell = ws.cell(row=row, column=c)
            if fill is not None:
                cell.fill = fill
            if font is not None:
                cell.font = font
            if align is not None:
                cell.alignment = align
            if border is not None:
                cell.border = border
        if height is not None:
            ws.row_dimensions[row].height = height

    # --------- banda de marca (verde Eleia + tipografía blanca) ---------
    _merge_row(1, f"{branding.PRODUCT_NAME} — Informe de pesaje",
               fill=fill_green,
               font=Font(bold=True, color="FFFFFF", size=16),
               align=Alignment(horizontal="left", vertical="center"),
               height=30)
    _merge_row(2, f"una solución {branding.COMPANY} · {branding.TAGLINE_COMPANY}",
               fill=fill_green,
               font=Font(bold=True, color="FFFFFF", size=10),
               align=Alignment(horizontal="left", vertical="center"),
               height=16)
    _merge_row(3, None, fill=fill_green_dark, height=4)
    logo = branding.get_logo_path()
    if logo is not None:
        try:
            from openpyxl.drawing.image import Image as XlsxImage

            ws.add_image(XlsxImage(str(logo)), "E1")
        except Exception:
            pass  # sin Pillow (u otro fallo) queda el wordmark tipográfico

    r = 5  # fila 4 en blanco como respiro

    def _section(title: str) -> None:
        nonlocal r
        _merge_row(r, title.upper(),
                   font=Font(bold=True, size=11, color=CHARCOAL))
        side = Side(style="medium", color=GREEN)
        for c in range(1, LAST_COL + 1):
            cell = ws.cell(row=r, column=c)
            cell.border = Border(bottom=side)
        ws.row_dimensions[r].height = 18
        r += 1

    def _kv_block(rows: list[tuple[str, Any, Optional[str]]]) -> None:
        """Pares clave-valor: clave bold gris carbón, zebra sutil,
        bordes finos; valor combinado B:F con formato numérico."""
        nonlocal r
        for i, (label, value, num_fmt) in enumerate(rows):
            key_cell = ws.cell(row=r, column=1, value=label)
            key_cell.font = Font(bold=True, size=10, color=CHARCOAL)
            key_cell.alignment = Alignment(vertical="center")
            _merge_row(r, value, first=2)
            val_cell = ws.cell(row=r, column=2)
            val_cell.font = Font(size=10, color=CHARCOAL)
            if num_fmt and isinstance(value, (int, float)):
                val_cell.number_format = num_fmt
                val_cell.alignment = Alignment(horizontal="left",
                                               vertical="center")
            zebra = (i % 2) == 1
            for c in range(1, LAST_COL + 1):
                cell = ws.cell(row=r, column=c)
                cell.border = border_thin
                if zebra:
                    cell.fill = fill_zebra
            r += 1

    # -------- aviso DEMO (sesión de práctica con la báscula simulada) --------
    # El archivo lo DICE: jamás debe circular como pesaje real.
    if session.get("es_demo"):
        _merge_row(
            r,
            "PESAJE DE PRÁCTICA (DEMO) — báscula simulada: no es un pesaje "
            "real, no cuenta en las estadísticas y se borra solo tras 1 h.",
            fill=fill_note,
            font=Font(bold=True, italic=True, size=10, color=CHARCOAL),
            align=left_top, height=18,
            border=Border(left=Side(style="thick", color=GREEN)),
        )
        r += 2

    # ------------------------------------------------------ datos del lote
    _section("Datos del lote")
    kv_rows: list[tuple[str, Any, Optional[str]]] = [
        ("Sesión", session["id"], None),
        ("UUID", session.get("uuid"), None),
    ]
    for label, key in RESUMEN_ROWS:
        fmt = KG_FMT if key in (
            "peso_ref_inicial", "total_kg", "promedio_final") else None
        value = session.get(key)
        if key in ("hora_entrada", "hora_salida") and value:
            try:  # ISO → fecha legible dd/mm/aaaa hh:mm
                value = _dt.fromisoformat(str(value)).strftime("%d/%m/%Y %H:%M")
            except ValueError:
                pass
        kv_rows.append((label, value, fmt))
    _kv_block(kv_rows)
    r += 1

    # ------------------- tarjetas de totales (celdas combinadas) -------------------
    total_kg = session.get("total_kg") or stats.get("total_kg") or 0.0
    animales = session.get("total_animales")
    if animales is None:
        animales = stats.get("total_animales") or 0
    promedio = session.get("promedio_final") or stats.get("promedio")

    _section("Totales")
    cards = [
        (1, 2, int(animales), "CERDOS", "#,##0"),
        (3, 4, float(total_kg), "PESO TOTAL (KG)", KG_FMT),
        (5, 6, float(promedio) if promedio is not None else None,
         "PROMEDIO POR CERDO (KG)", KG_FMT),
    ]
    row_v, row_k = r, r + 1
    ws.row_dimensions[row_v].height = 34
    ws.row_dimensions[row_k].height = 16
    for first, last, value, label, fmt in cards:
        _merge_row(row_v, value if value is not None else "—",
                   first=first, last=last, fill=fill_card,
                   font=Font(bold=True, size=20, color=PP_GREEN),
                   align=center, border=border_card)
        if value is not None:
            ws.cell(row=row_v, column=first).number_format = fmt
        _merge_row(row_k, label, first=first, last=last, fill=fill_card,
                   font=Font(bold=True, size=8, color=CHARCOAL),
                   align=center, border=border_card)
    r += 3

    # ---------------------------------------------------------- estadística
    _section("Estadística del lote")
    stat_rows: list[tuple[str, Any, Optional[str]]] = []
    for label, key in STATS_ROWS:
        value = stats.get(key)
        fmt = STAT_FMT if isinstance(value, float) else None
        stat_rows.append((label, value, fmt))
    _kv_block(stat_rows)

    # nota "en cristiano" como callout suave
    from porcipeso.api.reports import _nota_humana

    _merge_row(r, f"En cristiano: {_nota_humana(stats)}", fill=fill_note,
               font=Font(italic=True, size=10, color=CHARCOAL),
               align=left_top, height=18,
               border=Border(left=Side(style="thick", color=GREEN)))
    r += 2

    # ---------------------------------------------------------- movimientos
    _section("Movimientos")
    mov_header = ["Hora", "Movimiento", "Peso (kg)", "Animales",
                  "Motivo / detalle"]
    for c, title in enumerate(mov_header, start=1):
        cell = ws.cell(row=r, column=c, value=title)
        cell.fill = fill_green
        cell.font = Font(bold=True, size=10, color="FFFFFF")
        cell.alignment = center if c in (3, 4) else Alignment(
            vertical="center")
        cell.border = border_thin
    ws.cell(row=r, column=5).alignment = Alignment(vertical="center")
    ws.merge_cells(start_row=r, start_column=5, end_row=r, end_column=6)
    ws.cell(row=r, column=6).fill = fill_green
    ws.cell(row=r, column=6).border = border_thin
    r += 1
    for i, ev in enumerate(events):
        n = ev.get("animales_confirmados")
        if n is None:
            n = ev.get("animales_estimados")
        detalle = str(ev.get("motivo_bajada") or "")
        if ev.get("animales_confirmados") is not None:
            por = str(ev.get("confirmado_por") or "").strip()
            extra = f"confirmado por {por}" if por else "confirmado"
            detalle = f"{detalle} · {extra}" if detalle else extra
        elif ev.get("ambiguo"):
            extra = "peso ambiguo (sin confirmar)"
            detalle = f"{detalle} · {extra}" if detalle else extra
        try:
            hora = _dt.fromtimestamp(
                float(ev.get("ts_ms") or 0) / 1000.0).strftime("%H:%M:%S")
        except (ValueError, OSError):
            hora = "—"
        tipo = TIPO_HUMANO.get(str(ev.get("tipo")), str(ev.get("tipo")))
        ws.cell(row=r, column=1, value=hora).alignment = Alignment(
            vertical="center")
        ws.cell(row=r, column=2, value=tipo)
        delta = ws.cell(row=r, column=3, value=ev.get("delta_kg"))
        delta.number_format = KG_FMT
        delta.alignment = right
        ncell = ws.cell(row=r, column=4, value=n)
        ncell.alignment = right
        ws.cell(row=r, column=5, value=detalle or None)
        ws.merge_cells(start_row=r, start_column=5, end_row=r, end_column=6)
        for c in range(1, LAST_COL + 1):
            cell = ws.cell(row=r, column=c)
            cell.border = border_thin
            if not cell.font.bold:
                cell.font = Font(size=10, color=CHARCOAL)
            if (i % 2) == 1:
                cell.fill = fill_zebra
        r += 1
    if not events:
        _merge_row(r, "Sin movimientos registrados.",
                   font=Font(italic=True, size=10, color=CHARCOAL))
        r += 1
    r += 1

    # ----------------------------- pie de marca -----------------------------
    generado = _dt.now().strftime("%d/%m/%Y %H:%M")
    ws.append([])
    ws.cell(row=r, column=1, value=(
        f"Generado por {branding.PRODUCT_NAME} v{branding.get_version()}"
        f" · {branding.COMPANY} · {generado}"
    )).font = Font(size=9, color=CHARCOAL, italic=True)

    # ------------------- hoja Eventos (datos crudos, estilizados) -------------------
    we = wb.create_sheet("Eventos")
    we.append(EVENT_COLUMNS)
    for c in range(1, len(EVENT_COLUMNS) + 1):
        cell = we.cell(row=1, column=c)
        cell.fill = fill_green
        cell.font = Font(bold=True, size=10, color="FFFFFF")
        cell.border = border_thin
    kg_cols = {EVENT_COLUMNS.index(k) + 1
               for k in ("peso_antes", "peso_despues", "delta_kg")}
    num_cols = kg_cols | {EVENT_COLUMNS.index(k) + 1 for k in (
        "id", "ts_ms", "animales_estimados", "animales_confirmados",
        "estab_ms", "ambiguo", "evento_relacionado_id")}
    for i, ev in enumerate(events):
        row = []
        for col in EVENT_COLUMNS:
            value = ev.get(col)
            if col == "opciones":
                value = json.dumps(value) if value else None
            elif col == "ambiguo":
                value = 1 if value else 0
            row.append(value)
        we.append(row)
        row_idx = i + 2
        for c in range(1, len(EVENT_COLUMNS) + 1):
            cell = we.cell(row=row_idx, column=c)
            cell.border = border_thin
            cell.font = Font(size=10, color=CHARCOAL)
            if (i % 2) == 1:
                cell.fill = fill_zebra
            if c in kg_cols:
                cell.number_format = KG_FMT
            if c in num_cols:
                cell.alignment = right
    widths = {
        "id": 7, "ts_ms": 15, "tipo": 12, "peso_antes": 12,
        "peso_despues": 13, "delta_kg": 11, "animales_estimados": 18,
        "animales_confirmados": 20, "estab_ms": 10, "ambiguo": 9,
        "opciones": 12, "motivo_bajada": 20, "evento_relacionado_id": 20,
        "confirmado_por": 16,
    }
    for idx, name in enumerate(EVENT_COLUMNS, start=1):
        we.column_dimensions[get_column_letter(idx)].width = widths.get(
            name, 12)
    # encabezado congelado + autofiltro sobre toda la tabla
    we.freeze_panes = "A2"
    we.auto_filter.ref = (
        f"A1:{get_column_letter(len(EVENT_COLUMNS))}{len(events) + 1}"
    )

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
