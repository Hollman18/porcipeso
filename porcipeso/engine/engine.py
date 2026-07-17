"""Motor de pesaje PorciPeso v2 — Capa 2 (SPEC §4 y §4.1, ARQUITECTURA §2).

Máquina de estados pura y determinista sobre el stream de lecturas:
sin threads, sin I/O, sin sleeps. El tiempo viene de Reading.ts_ms; el
reloj de pared (time.time()) solo se consulta en snapshot() para el
watchdog SIN_SENAL.

Reglas centrales (SPEC §4):
- Estable = ventana llena de `window_readings` lecturas con
  (max - min) <= stability_range_kg.
- En cada transición movimiento→estable: nivel = media de la ventana;
  delta = nivel - último nivel estable relevante.

MODO "lote" (v2 — calibración con cerdo de prueba que SE BAJA):
- open_session(id, modo="lote") arranca en fase "calibracion".
- El operador sube UN cerdo de prueba. El candidato a referencia es el
  MÁXIMO nivel estable sostenido (peak hold sobre niveles ESTABLES, no
  sobre lecturas crudas: un pico crudo de un cerdo saltando no es peso).
- Con candidato y a la espera de que lo bajen: fase "bajar_prueba".
  Si el nivel estable sube ≥ min_delta_kg por encima del candidato
  (montaron otro sin bajar el primero) se vuelve a "calibracion" con el
  nuevo máximo — tolerante, sin romperse. Subidas estables menores
  (cerdo inquieto acomodándose) solo actualizan el peak.
- Cuando el nivel estable vuelve a casi vacío (< 20% del candidato o
  < min_delta_kg) la calibración termina: se emite UN evento REFERENCIA
  (peso_antes=0, peso_despues=ref, delta_kg=ref, 1 animal — "el cerdo de
  prueba pesó ref"), se fija ref_kg=avg=ref y la fase pasa a "lote".
  La bajada del cerdo de prueba NO genera evento BAJADA y count sigue 0
  (cuando vuelva a subir con el lote se cuenta normal).
- Desde fase "lote" rige el comportamiento clásico:
  n = round(delta / promedio_movil); si el residuo supera la tolerancia
  el evento queda AMBIGUO en cola de confirmación; el promedio se
  auto-corrige (avg = total / count); bidireccional (SPEC §4.1): delta
  negativo = BAJADA, la subida siguiente sin emparejar = REINGRESO.

MODO "unidades" (v2 — pesaje uno a uno):
- open_session(id, modo="unidades") → fase "unidades" siempre. Sin
  calibración ni referencia.
- Ciclo: vacío → nivel estable ≥ min_delta_kg = SUBIDA n=1 con el peso
  del animal → el nivel vuelve a < min_delta_kg = salió (SIN evento) →
  listo para el siguiente.
- Con animal arriba, si el nivel estable SUBE ≥ min_delta_kg sin pasar
  por vacío (se montó otro encima) la diferencia es otra SUBIDA n=1.
  Bajadas parciales extrañas (baja a medias sin vaciar) se ignoran
  hasta vaciar. Sin eventos ambiguos en este modo.
"""
from __future__ import annotations

import math
import time
from collections import deque
from typing import Callable, Deque, Optional

from porcipeso.core.interfaces import Engine
from porcipeso.core.models import (
    EngineConfig,
    EngineSnapshot,
    EngineState,
    EventType,
    Reading,
    WeighEvent,
)

# Fases del pesaje (EngineSnapshot.fase)
FASE_CALIBRACION = "calibracion"
FASE_BAJAR_PRUEBA = "bajar_prueba"
FASE_LOTE = "lote"
FASE_UNIDADES = "unidades"

MODOS = ("lote", "unidades")

#: fracción del candidato bajo la cual la plataforma se considera vacía
#: al terminar la calibración (además del umbral absoluto min_delta_kg)
EMPTY_FRACTION = 0.20


class WeighingEngine(Engine):
    """Motor de pesaje por sesión (modos: lote acumulado | unidades)."""

    def __init__(
        self,
        config: EngineConfig,
        on_event: Callable[[WeighEvent], None],
        on_state: Callable[[str], None] | None = None,
    ) -> None:
        self.config = config
        self._on_event = on_event
        self._on_state = on_state

        # stream / ventana
        self._state: EngineState = EngineState.IDLE
        self._window: Deque[float] = deque(maxlen=config.window_readings)
        self._last_ts_ms: Optional[int] = None
        self._kg_now: float = 0.0
        self._movement_start_ts: Optional[int] = None

        # sesión
        self._session_id: Optional[int] = None
        self._next_event_id: int = 1
        self._modo: str = "lote"
        self._fase: str = FASE_LOTE
        self._ref_kg: Optional[float] = None
        self._avg_kg: Optional[float] = None
        self._count: int = 0
        self._total_kg: float = 0.0
        self._baseline: Optional[float] = None  # último nivel estable relevante
        self._pending: dict[int, WeighEvent] = {}
        self._unmatched_bajadas: list[int] = []  # ids de BAJADA sin reingreso
        self._links: dict[int, int] = {}  # reingreso_id -> bajada_id (interno)
        # calibración (modo lote)
        self._calib_base: Optional[float] = None   # nivel estable inicial (vacío)
        self._calib_candidate: Optional[float] = None  # peak hold del cerdo de prueba
        # modo unidades
        self._unit_base: Optional[float] = None    # nivel estable de plataforma vacía
        self._unit_level: Optional[float] = None   # nivel registrado del animal arriba

    # ------------------------------------------------------------------ API

    def feed(self, reading: Reading) -> None:
        cfg = self.config

        # Watchdog dentro de feed: hueco entre lecturas > no_signal_after_s.
        if (
            self._last_ts_ms is not None
            and reading.ts_ms - self._last_ts_ms > cfg.no_signal_after_s * 1000.0
        ):
            self._window.clear()  # lo anterior al apagón ya no es comparable
            self._movement_start_ts = reading.ts_ms
            if self._session_id is not None:
                self._set_state(EngineState.SIN_SENAL)

        self._last_ts_ms = reading.ts_ms
        self._kg_now = reading.kg
        self._window.append(reading.kg)
        if self._movement_start_ts is None:
            self._movement_start_ts = reading.ts_ms

        if self._session_id is None:
            return  # sin sesión: solo tracking de peso vivo (estado IDLE)

        if self._window_stable():
            if self._state != EngineState.ESTABLE:
                estab_ms = max(0, reading.ts_ms - self._movement_start_ts)
                self._set_state(EngineState.ESTABLE)
                self._handle_stable_level(self._window_mean(), reading.ts_ms,
                                          estab_ms)
        else:
            if self._state != EngineState.MOVIMIENTO:
                self._movement_start_ts = reading.ts_ms
                self._set_state(EngineState.MOVIMIENTO)

    def open_session(self, session_id: int, modo: str = "lote") -> None:
        if modo not in MODOS:
            raise ValueError(f"modo desconocido: {modo!r} (esperado: {MODOS})")
        self._session_id = session_id
        self._reset_session_vars()
        self._modo = modo
        self._fase = FASE_CALIBRACION if modo == "lote" else FASE_UNIDADES
        # La base de la sesión se fija SOLO con lecturas frescas: heredar la
        # ventana de la conexión/sesión anterior daría una base falsa (p.ej.
        # 301 kg viejos) y la sesión quedaría muda, porque ningún delta real
        # superaría el umbral contra esa base fantasma.
        self._window.clear()
        self._movement_start_ts = self._last_ts_ms
        self._set_state(EngineState.MOVIMIENTO)

    def confirm(self, event_id: int, n: int) -> Optional[WeighEvent]:
        ev = self._pending.get(event_id)
        if ev is None or n < 1:
            return None
        del self._pending[event_id]
        ev.ambiguo = False
        ev.animales_confirmados = n
        self._apply(ev, n)
        return ev

    def snapshot(self) -> EngineSnapshot:
        # Watchdog contra reloj de pared: solo aquí (el motor sigue puro
        # respecto al stream; feed jamás consulta time.time()).
        if (
            self._session_id is not None
            and self._last_ts_ms is not None
            and time.time() * 1000.0 - self._last_ts_ms
            > self.config.no_signal_after_s * 1000.0
        ):
            self._set_state(EngineState.SIN_SENAL)
        return EngineSnapshot(
            state=self._state,
            kg_now=self._kg_now,
            ref_kg=self._ref_kg,
            avg_kg=self._avg_kg,
            count=self._count,
            total_kg=self._total_kg,
            pending=len(self._pending),
            fase=self._fase,
        )

    def close_session(self) -> EngineSnapshot:
        final = self.snapshot()
        self._session_id = None
        self._reset_session_vars()
        self._set_state(EngineState.IDLE)
        return final

    # ------------------------------------------------------------ interno

    def _reset_session_vars(self) -> None:
        self._modo = "lote"
        self._fase = FASE_LOTE  # default del contrato; open_session la fija
        self._ref_kg = None
        self._avg_kg = None
        self._count = 0
        self._total_kg = 0.0
        self._baseline = None
        self._pending = {}
        self._unmatched_bajadas = []
        self._links = {}
        self._calib_base = None
        self._calib_candidate = None
        self._unit_base = None
        self._unit_level = None

    def _window_stable(self) -> bool:
        return (
            len(self._window) == self.config.window_readings
            and max(self._window) - min(self._window)
            <= self.config.stability_range_kg
        )

    def _window_mean(self) -> float:
        return sum(self._window) / len(self._window)

    def _set_state(self, new_state: EngineState) -> None:
        if new_state != self._state:
            self._state = new_state
            if self._on_state is not None:
                self._on_state(new_state.value)

    # --------------------------------------------------- despacho por fase

    def _handle_stable_level(self, level: float, ts_ms: int,
                             estab_ms: int) -> None:
        """Procesa una transición movimiento→estable con sesión abierta."""
        if self._modo == "unidades":
            self._stable_unidades(level, ts_ms, estab_ms)
        elif self._fase in (FASE_CALIBRACION, FASE_BAJAR_PRUEBA):
            self._stable_calibracion(level, ts_ms, estab_ms)
        else:
            self._stable_lote(level, ts_ms, estab_ms)

    # ------------------------------------------------- calibración (lote)

    def _stable_calibracion(self, level: float, ts_ms: int,
                            estab_ms: int) -> None:
        """Peak hold del cerdo de prueba; termina cuando vuelve a vacío."""
        cfg = self.config
        if self._calib_base is None:
            # primer nivel estable de la sesión: base (vacío), sin evento
            self._calib_base = level
            return
        rel = level - self._calib_base
        cand = self._calib_candidate

        if cand is not None and (
            rel < cfg.min_delta_kg or rel < EMPTY_FRACTION * cand
        ):
            # casi vacío: el cerdo de prueba se bajó → calibración lista.
            # Su bajada NO es evento BAJADA; se emite UN evento REFERENCIA
            # semánticamente "el cerdo de prueba pesó cand".
            self._ref_kg = cand
            self._avg_kg = cand
            self._count = 0
            self._total_kg = 0.0
            self._baseline = level  # base del lote = nivel vacío actual
            self._calib_candidate = None
            self._fase = FASE_LOTE
            ev = self._new_event(ts_ms, 0.0, cand, cand, 1,
                                 EventType.REFERENCIA, estab_ms)
            self._on_event(ev)
            return

        if rel < cfg.min_delta_kg:
            return  # sigue vacío (o vibración): aún no sube el de prueba

        if cand is None:
            # subió el cerdo de prueba: primer candidato
            self._calib_candidate = rel
            self._fase = FASE_BAJAR_PRUEBA
        elif rel > cand:
            # peak hold: solo sube el candidato, nunca baja
            self._calib_candidate = rel
            if rel - cand >= cfg.min_delta_kg:
                # montaron otro sin bajar el primero (A4): se recalibra
                # con el nuevo máximo — tolerante, sin romperse
                self._fase = FASE_CALIBRACION
            else:
                # cerdo inquieto acomodándose: sigue esperando la bajada
                self._fase = FASE_BAJAR_PRUEBA
        # rel <= cand (se acomodó más liviano / bajada parcial): peak hold,
        # ni evento ni cambio de fase

    # -------------------------------------------------------- fase "lote"

    def _stable_lote(self, level: float, ts_ms: int, estab_ms: int) -> None:
        assert self._baseline is not None and self._avg_kg is not None
        delta = level - self._baseline
        if abs(delta) < self.config.min_delta_kg:
            return  # vibración / deriva: no es escalón (baseline NO avanza)
        self._step(level, delta, ts_ms, estab_ms)

    def _step(self, level: float, delta: float, ts_ms: int,
              estab_ms: int) -> None:
        assert self._avg_kg is not None
        n_raw = delta / self._avg_kg
        n_signed = round(n_raw)
        if n_signed == 0:
            # escalón parcial (ej. cerdo a medio subir): se ignora SIN
            # avanzar la base, para que el escalón completo se mida entero
            return
        n = abs(n_signed)
        residuo = abs(n_raw - n_signed)
        peso_antes = self._baseline
        self._baseline = level  # el peso en plataforma cambió de verdad

        if residuo > self.config.tolerance:
            opciones = sorted({
                c for c in (math.floor(abs(n_raw)), math.ceil(abs(n_raw)))
                if c > 0
            })
            tipo = EventType.SUBIDA if delta > 0 else EventType.BAJADA
            ev = self._new_event(ts_ms, peso_antes, level, delta, n, tipo,
                                 estab_ms, ambiguo=True, opciones=opciones)
            self._pending[ev.id] = ev  # type: ignore[index]
            self._on_event(ev)
            return

        tipo = EventType.SUBIDA if delta > 0 else EventType.BAJADA
        ev = self._new_event(ts_ms, peso_antes, level, delta, n, tipo,
                             estab_ms)
        self._apply(ev, n)
        self._on_event(ev)

    def _apply(self, ev: WeighEvent, n: int) -> None:
        """Aplica n animales (con el signo del delta) al estado de sesión."""
        if ev.delta_kg > 0:
            if self._unmatched_bajadas:
                # SPEC §4.1: subida tras bajada sin emparejar = reingreso
                ev.tipo = EventType.REINGRESO
                self._links[ev.id] = self._unmatched_bajadas.pop(0)  # type: ignore[index]
            else:
                ev.tipo = EventType.SUBIDA
            self._count += n
        else:
            ev.tipo = EventType.BAJADA
            self._unmatched_bajadas.append(ev.id)  # type: ignore[arg-type]
            self._count -= n
        self._total_kg += ev.delta_kg
        if self._count > 0:
            self._avg_kg = self._total_kg / self._count

    # ---------------------------------------------------- modo "unidades"

    def _stable_unidades(self, level: float, ts_ms: int,
                         estab_ms: int) -> None:
        """Pesaje uno a uno: cada nivel estable ≥ min_delta = un animal."""
        cfg = self.config
        if self._unit_base is None:
            # primer nivel estable de la sesión: plataforma vacía (base)
            self._unit_base = level
            return
        rel = level - self._unit_base

        if self._unit_level is None:
            # plataforma vacía: ¿subió un animal?
            if rel >= cfg.min_delta_kg:
                self._unit_level = level
                self._emit_unidad(self._unit_base, level, rel, ts_ms,
                                  estab_ms)
            return

        # hay un animal arriba
        if rel < cfg.min_delta_kg:
            # volvió a vacío: el animal salió — NO es evento
            self._unit_level = None
            return
        extra = level - self._unit_level
        if extra >= cfg.min_delta_kg:
            # se montó otro encima sin pasar por vacío: cuenta como otro
            peso_antes = self._unit_level
            self._unit_level = level
            self._emit_unidad(peso_antes, level, extra, ts_ms, estab_ms)
        # bajada parcial extraña (o ajuste menor): se ignora hasta vaciar

    def _emit_unidad(self, peso_antes: float, level: float, peso: float,
                     ts_ms: int, estab_ms: int) -> None:
        self._count += 1
        self._total_kg += peso
        self._avg_kg = self._total_kg / self._count
        ev = self._new_event(ts_ms, peso_antes, level, peso, 1,
                             EventType.SUBIDA, estab_ms)
        self._on_event(ev)

    # ------------------------------------------------------------- eventos

    def _new_event(self, ts_ms: int, peso_antes: float, peso_despues: float,
                   delta: float, n: int, tipo: EventType, estab_ms: int, *,
                   ambiguo: bool = False,
                   opciones: list[int] | None = None) -> WeighEvent:
        assert self._session_id is not None
        ev = WeighEvent(
            id=self._next_event_id,
            session_id=self._session_id,
            ts_ms=ts_ms,
            peso_antes=peso_antes,
            peso_despues=peso_despues,
            delta_kg=delta,
            animales_estimados=n,
            tipo=tipo,
            ambiguo=ambiguo,
            opciones=opciones or [],
            estab_ms=estab_ms,
        )
        self._next_event_id += 1
        return ev
