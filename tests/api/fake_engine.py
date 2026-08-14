"""Motor falso para los tests de la API (no depende de porcipeso.engine)."""
from __future__ import annotations

import dataclasses
from typing import Callable, Optional

from porcipeso.core.interfaces import Engine
from porcipeso.core.models import (
    EngineConfig,
    EngineSnapshot,
    EngineState,
    EventType,
    Reading,
    WeighEvent,
)


class FakeEngine(Engine):
    """Implementación mínima de core.interfaces.Engine para inyectar en la API.

    ``emit(...)`` dispara ``on_event`` igual que lo haría el motor real,
    de modo que el pipeline persistencia+broadcast de la API se ejercita
    completo sin importar porcipeso.engine.
    """

    def __init__(
        self,
        config: EngineConfig,
        on_event: Callable[[WeighEvent], None],
        on_state: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.config = config
        self.on_event = on_event
        self.on_state = on_state
        self.session_id: Optional[int] = None
        self.modo: Optional[str] = None
        self.fed: list[Reading] = []
        self.confirmed: list[tuple[int, int]] = []
        self.closed = False
        self._snapshot = EngineSnapshot(
            state=EngineState.IDLE, kg_now=0.0, ref_kg=None,
            avg_kg=None, count=0, total_kg=0.0, pending=0,
        )

    # --- contrato Engine ---------------------------------------------------

    def feed(self, reading: Reading) -> None:
        self.fed.append(reading)

    def open_session(self, session_id: int, modo: str = "lote") -> None:
        if modo not in ("lote", "unidades"):
            raise ValueError(f"modo desconocido: {modo!r}")
        self.session_id = session_id
        self.modo = modo
        fase = "calibracion" if modo == "lote" else "unidades"
        self.set_snapshot(state=EngineState.ESTABLE, fase=fase)

    def confirm(self, event_id: int, n: int) -> Optional[WeighEvent]:
        self.confirmed.append((event_id, n))
        return None

    def register_returned(self, n: int) -> Optional[WeighEvent]:
        if self.session_id is None or n < 1 or self._snapshot.count < 1:
            return None
        n = min(n, self._snapshot.count)
        avg = self._snapshot.avg_kg or 0.0
        new_count = self._snapshot.count - n
        new_total = max(0.0, self._snapshot.total_kg - avg * n)
        self.set_snapshot(count=new_count, total_kg=new_total)
        ev = WeighEvent(
            id=None, session_id=self.session_id, ts_ms=1,
            peso_antes=0.0, peso_despues=0.0, delta_kg=-avg * n,
            animales_estimados=n, tipo=EventType.AJUSTE,
            animales_confirmados=n, motivo_bajada="devuelto_manual",
        )
        self.on_event(ev)
        return ev

    def set_reference(self, kg: float) -> Optional[WeighEvent]:
        if self.session_id is None or self.modo != "lote" or kg <= 0:
            return None
        self.set_snapshot(ref_kg=kg, avg_kg=kg, count=0, total_kg=0.0,
                          fase="lote")
        ev = WeighEvent(
            id=None, session_id=self.session_id, ts_ms=1,
            peso_antes=0.0, peso_despues=kg, delta_kg=kg,
            animales_estimados=1, tipo=EventType.REFERENCIA,
            confirmado_por="manual",
        )
        self.on_event(ev)
        return ev

    def snapshot(self) -> EngineSnapshot:
        return self._snapshot

    def close_session(self) -> EngineSnapshot:
        self.closed = True
        snap = self._snapshot
        self.session_id = None
        return snap

    # --- helpers de test ----------------------------------------------------

    def set_snapshot(self, **kwargs) -> EngineSnapshot:
        self._snapshot = dataclasses.replace(self._snapshot, **kwargs)
        return self._snapshot

    def emit(
        self,
        *,
        ts_ms: int,
        peso_antes: float,
        peso_despues: float,
        animales_estimados: int,
        tipo: EventType,
        ambiguo: bool = False,
        opciones: Optional[list[int]] = None,
        estab_ms: int = 800,
    ) -> WeighEvent:
        event = WeighEvent(
            id=None,
            session_id=self.session_id,
            ts_ms=ts_ms,
            peso_antes=peso_antes,
            peso_despues=peso_despues,
            delta_kg=round(peso_despues - peso_antes, 3),
            animales_estimados=animales_estimados,
            tipo=tipo,
            ambiguo=ambiguo,
            opciones=opciones or [],
            estab_ms=estab_ms,
        )
        self.on_event(event)
        return event
