"""Tests del hub de broadcast WS (función pequeña y testeable)."""
from __future__ import annotations

import asyncio
import json
import threading
import time

from porcipeso.api.app import Hub


class _FakeWS:
    def __init__(self):
        self.sent: list[str] = []

    async def send_text(self, msg: str) -> None:
        self.sent.append(msg)


class _BrokenWS:
    async def send_text(self, msg: str) -> None:
        raise RuntimeError("socket muerto")


def test_broadcast_sin_loop_no_falla_y_serializa():
    hub = Hub()
    msg = hub.broadcast({"type": "reading", "kg": 100.5,
                         "ts_ms": 123, "state": "estable"})
    assert json.loads(msg) == {"type": "reading", "kg": 100.5,
                               "ts_ms": 123, "state": "estable"}


def test_broadcast_desde_otro_hilo_llega_a_todos():
    hub = Hub()
    ws1, ws2 = _FakeWS(), _FakeWS()
    hub.register(ws1)
    hub.register(ws2)
    hub.register(_BrokenWS())  # un socket roto no tumba el broadcast

    loop = asyncio.new_event_loop()
    t = threading.Thread(target=loop.run_forever, daemon=True)
    t.start()
    hub.loop = loop
    try:
        sent = hub.broadcast({"type": "snapshot", "count": 3})
        deadline = time.monotonic() + 2.0
        while (not ws1.sent or not ws2.sent) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ws1.sent == [sent]
        assert ws2.sent == [sent]
    finally:
        loop.call_soon_threadsafe(loop.stop)
        t.join(timeout=2.0)
        loop.close()


def test_register_unregister():
    hub = Hub()
    ws = _FakeWS()
    hub.register(ws)
    assert hub.count == 1
    hub.unregister(ws)
    hub.unregister(ws)  # idempotente
    assert hub.count == 0
