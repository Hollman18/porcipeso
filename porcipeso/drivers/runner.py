"""Loop bloqueante transporte → parser → callback (con watchdog de reintento)."""
from __future__ import annotations

import logging
import time
from typing import Callable

from porcipeso.core.interfaces import ReadingCallback, Transport
from porcipeso.core.models import ScaleProfile

from .parsers import PARSER_REGISTRY
from .transports import make_transport

log = logging.getLogger(__name__)

BACKOFF_S = 1.0
READ_MAX_BYTES = 256
DEFAULT_READ_TIMEOUT_S = 0.2


def _sleep_checking_stop(seconds: float, stop: Callable[[], bool]) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if stop():
            return
        time.sleep(0.05)


def run_driver(profile: ScaleProfile, on_reading: ReadingCallback,
               stop: Callable[[], bool]) -> None:
    """Lee del transporte, alimenta el parser y entrega Readings al callback.

    - Si no llegan bytes (timeout del transporte) sigue intentando.
    - Excepción del transporte/parser → cierra, espera BACKOFF_S y reintenta
      con transporte y parser nuevos.
    - Sale limpiamente cuando stop() es True.
    """
    parser_cls = PARSER_REGISTRY[profile.parser]  # error de config: falla ya
    timeout_s = float(profile.extra.get("read_timeout_s", DEFAULT_READ_TIMEOUT_S))

    while not stop():
        transport: Transport | None = None
        try:
            transport = make_transport(profile)
            parser = parser_cls(profile)
            while not stop():
                data = transport.read(READ_MAX_BYTES, timeout_s)
                if not data:
                    continue  # sin bytes todavía: seguir intentando
                for reading in parser.push(data):
                    on_reading(reading)
        except Exception:
            log.exception("driver %s: error de transporte; reintento en %.1fs",
                          profile.id, BACKOFF_S)
            _sleep_checking_stop(BACKOFF_S, stop)
        finally:
            if transport is not None:
                try:
                    transport.close()
                except Exception:
                    pass
