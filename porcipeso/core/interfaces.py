"""Interfaces compartidas (CONTRATO CONGELADO — ver models.py)."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Callable, Iterator, Optional

from .models import EngineSnapshot, Reading, ScaleProfile, WeighEvent


class FrameParser(ABC):
    """Convierte bytes crudos del indicador en valores de peso (kg).

    Implementaciones en porcipeso/drivers/parsers.py, registradas en
    PARSER_REGISTRY: dict[str, type[FrameParser]] con la clave usada por
    ScaleProfile.parser.
    """

    #: clave única del parser (ej. "matrix", "xk3190_a12e", "sics", "generic_regex")
    name: str = ""

    def __init__(self, profile: ScaleProfile) -> None:
        self.profile = profile

    @abstractmethod
    def push(self, data: bytes) -> list[Reading]:
        """Alimenta bytes crudos; retorna las lecturas completas encontradas.

        Debe tolerar fragmentación arbitraria (una trama puede llegar en
        varios chunks) y basura entre tramas (resincronización).
        """


class Transport(ABC):
    """Fuente de bytes: puerto serial, socket TCP o simulador."""

    @abstractmethod
    def read(self, max_bytes: int = 256, timeout_s: float = 0.2) -> bytes: ...

    @abstractmethod
    def close(self) -> None: ...


def make_transport(profile: ScaleProfile) -> Transport:
    """Fábrica implementada en porcipeso/drivers/transports.py (re-export allí)."""
    raise NotImplementedError("usar porcipeso.drivers.transports.make_transport")


class Engine(ABC):
    """Motor de pesaje (implementado en porcipeso/engine/engine.py como WeighingEngine).

    Constructor: WeighingEngine(config: EngineConfig,
                                on_event: Callable[[WeighEvent], None],
                                on_state: Callable[[str], None] | None = None)
    """

    @abstractmethod
    def feed(self, reading: Reading) -> None: ...

    @abstractmethod
    def open_session(self, session_id: int, modo: str = "lote") -> None:
        """modo: 'lote' (acumulado con cerdo de prueba) | 'unidades' (uno a uno,
        cada peso estable es un animal; sin calibración)."""

    @abstractmethod
    def confirm(self, event_id: int, n: int) -> Optional[WeighEvent]: ...

    def register_returned(self, n: int) -> Optional[WeighEvent]:
        """Descuento manual de cerdos devueltos (rebote). Default no-op para
        motores que no lo soporten; WeighingEngine lo implementa."""
        return None

    def set_reference(self, kg: float) -> Optional[WeighEvent]:
        """Fija a mano el peso de referencia del cerdo de prueba (kg > 0).
        Default no-op para motores que no lo soporten; WeighingEngine lo
        implementa (ref = avg = kg, conteo 0, fase → 'lote')."""
        return None

    @abstractmethod
    def snapshot(self) -> EngineSnapshot: ...

    @abstractmethod
    def close_session(self) -> EngineSnapshot: ...


ReadingCallback = Callable[[Reading], None]


def run_driver(profile: ScaleProfile, on_reading: ReadingCallback,
               stop: Callable[[], bool]) -> None:
    """Loop bloqueante transporte→parser→callback.

    Implementación real: porcipeso.drivers.runner.run_driver (misma firma).
    """
    raise NotImplementedError("usar porcipeso.drivers.runner.run_driver")
