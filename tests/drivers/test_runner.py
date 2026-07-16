"""Tests de run_driver con transportes fake en memoria."""
from __future__ import annotations

import time

import pytest

import porcipeso.drivers.runner as runner_mod
from porcipeso.core.interfaces import Transport
from porcipeso.core.models import Reading, ScaleProfile
from porcipeso.drivers.runner import run_driver


def profile_tuxon() -> ScaleProfile:
    return ScaleProfile(id="fake", name="Fake", brand="Test",
                        parser="tuxon_ascii", transport="serial",
                        port="/dev/null")


class FakeTransport(Transport):
    """Entrega chunks pre-cargados; luego simula timeouts (b'')."""

    def __init__(self, chunks: list[bytes]):
        self.chunks = list(chunks)
        self.closed = False

    def read(self, max_bytes: int = 256, timeout_s: float = 0.2) -> bytes:
        if self.chunks:
            return self.chunks.pop(0)
        time.sleep(0.01)  # simula timeout sin bytes
        return b""

    def close(self) -> None:
        self.closed = True


class FailingTransport(Transport):
    def read(self, max_bytes: int = 256, timeout_s: float = 0.2) -> bytes:
        raise ConnectionError("cable desconectado")

    def close(self) -> None:
        pass


def test_runner_reads_parses_and_stops(monkeypatch):
    fake = FakeTransport([b"  126.3", b"5\r\n", b"", b"  130.10\r\n"])
    monkeypatch.setattr(runner_mod, "make_transport", lambda p: fake)

    readings: list[Reading] = []
    run_driver(profile_tuxon(), readings.append, stop=lambda: len(readings) >= 2)

    assert [r.kg for r in readings] == pytest.approx([126.35, 130.10])
    assert readings[0].scale_id == "fake"
    assert fake.closed  # el runner cierra el transporte al salir


def test_runner_retries_with_backoff_after_transport_error(monkeypatch):
    transports = [FailingTransport(), FakeTransport([b" 88.50\r\n"])]
    created: list[Transport] = []

    def fake_make(profile):
        t = transports.pop(0)
        created.append(t)
        return t

    monkeypatch.setattr(runner_mod, "make_transport", fake_make)

    readings: list[Reading] = []
    t0 = time.monotonic()
    run_driver(profile_tuxon(), readings.append, stop=lambda: len(readings) >= 1)
    elapsed = time.monotonic() - t0

    assert [r.kg for r in readings] == pytest.approx([88.5])
    assert len(created) == 2                # reintentó con transporte nuevo
    assert elapsed >= runner_mod.BACKOFF_S  # respetó el backoff de 1 s


def test_runner_stop_during_backoff(monkeypatch):
    stop_flag = {"value": False}

    def fake_make(profile):
        stop_flag["value"] = True  # pedir stop justo cuando falla
        raise ConnectionError("puerto inexistente")

    monkeypatch.setattr(runner_mod, "make_transport", fake_make)

    t0 = time.monotonic()
    run_driver(profile_tuxon(), lambda r: None, stop=lambda: stop_flag["value"])
    # no espera el backoff completo si stop() ya es True
    assert time.monotonic() - t0 < runner_mod.BACKOFF_S


def test_runner_unknown_parser_raises():
    bad = ScaleProfile(id="x", name="x", brand="x", parser="no-existe")
    with pytest.raises(KeyError):
        run_driver(bad, lambda r: None, stop=lambda: True)
