"""Motor de pesaje PorciPeso — Capa 2 (SPEC §4 y §4.1, ARQUITECTURA §2).

Máquina de estados pura y determinista sobre el stream de lecturas:
sin threads, sin I/O, sin sleeps. El tiempo viene de Reading.ts_ms; el
reloj de pared (time.time()) solo se consulta en snapshot() para el
watchdog SIN_SENAL.

Reglas centrales (SPEC §4):
- Estable = ventana llena de `window_readings` lecturas con
  (max - min) <= stability_range_kg.
- En cada transición movimiento→estable: nivel = media de la ventana;
  delta = nivel - último nivel estable relevante.
- Primer escalón positivo de la sesión = REFERENCIA (fija ref/avg/count/total).
- Escalones siguientes: n = round(delta / promedio_movil); si el residuo
  supera la tolerancia el evento queda AMBIGUO en cola de confirmación.
- El promedio móvil se auto-corrige: avg = total / count tras cada
  evento aplicado.
- Bidireccional (SPEC §4.1): delta negativo = BAJADA (descuenta); la
  subida siguiente a una bajada sin emparejar = REINGRESO (vinculado
  internamente). El conteo refleja el peso neto en plataforma → doble
  conteo imposible por diseño.
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


class WeighingEngine(Engine):
    """Motor de pesaje por sesión (Modo A — lote acumulado)."""

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
        self._ref_kg: Optional[float] = None
        self._avg_kg: Optional[float] = None
        self._count: int = 0
        self._total_kg: float = 0.0
        self._baseline: Optional[float] = None  # último nivel estable relevante
        self._pending: dict[int, WeighEvent] = {}
        self._unmatched_bajadas: list[int] = []  # ids de BAJADA sin reingreso
        self._links: dict[int, int] = {}  # reingreso_id -> bajada_id (interno)

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

    def open_session(self, session_id: int) -> None:
        self._session_id = session_id
        self._reset_session_vars()
        if self._window_stable():
            # la báscula ya está estable: ese nivel es la base de la sesión
            self._baseline = self._window_mean()
            self._set_state(EngineState.ESTABLE)
        else:
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
        )

    def close_session(self) -> EngineSnapshot:
        final = self.snapshot()
        self._session_id = None
        self._reset_session_vars()
        self._set_state(EngineState.IDLE)
        return final

    # ------------------------------------------------------------ interno

    def _reset_session_vars(self) -> None:
        self._ref_kg = None
        self._avg_kg = None
        self._count = 0
        self._total_kg = 0.0
        self._baseline = None
        self._pending = {}
        self._unmatched_bajadas = []
        self._links = {}

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

    def _handle_stable_level(self, level: float, ts_ms: int,
                             estab_ms: int) -> None:
        """Procesa una transición movimiento→estable con sesión abierta."""
        if self._baseline is None:
            # primer nivel estable de la sesión: base, sin evento
            self._baseline = level
            return
        delta = level - self._baseline
        if abs(delta) < self.config.min_delta_kg:
            return  # vibración / deriva: no es escalón (baseline NO avanza)
        if self._ref_kg is None:
            self._set_reference(level, delta, ts_ms, estab_ms)
        else:
            self._step(level, delta, ts_ms, estab_ms)

    def _set_reference(self, level: float, delta: float, ts_ms: int,
                       estab_ms: int) -> None:
        peso_antes = self._baseline
        # el nivel físico cambió: la base avanza aunque no haya referencia
        self._baseline = level
        if delta <= 0:
            return  # la referencia debe ser positiva; se ignora
        self._ref_kg = delta
        self._avg_kg = delta
        self._count = 1
        self._total_kg = delta
        ev = self._new_event(ts_ms, peso_antes, level, delta, 1,
                             EventType.REFERENCIA, estab_ms)
        self._on_event(ev)

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
