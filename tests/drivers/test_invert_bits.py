"""extra.invert_bits: corrección de polaridad TTL en el punto único (runner.ingress)."""
from __future__ import annotations

import time

import pytest

import porcipeso.drivers.runner as runner_mod
from porcipeso.core.interfaces import Transport
from porcipeso.core.models import Reading, ScaleProfile
from porcipeso.drivers.runner import ingress, invert_bytes, run_driver


def profile_tuxon(extra: dict | None = None) -> ScaleProfile:
    return ScaleProfile(id="fake", name="Fake", brand="Test",
                        parser="tuxon_ascii", transport="serial",
                        port="/dev/null", extra=extra or {})


class FakeTransport(Transport):
    def __init__(self, chunks: list[bytes]):
        self.chunks = list(chunks)
        self.closed = False

    def read(self, max_bytes: int = 256, timeout_s: float = 0.2) -> bytes:
        if self.chunks:
            return self.chunks.pop(0)
        time.sleep(0.01)
        return b""

    def close(self) -> None:
        self.closed = True


def test_invert_bytes_es_involutiva_y_correcta():
    assert invert_bytes(b"\x00\xff") == b"\xff\x00"
    # ASCII '0' (0x30) invertido es 0xCF y viceversa
    assert invert_bytes(b"0") == b"\xcf"
    data = b"= 126.35\r\n"
    assert invert_bytes(invert_bytes(data)) == data


def test_ingress_sin_flag_no_toca_los_bytes():
    data = b" 126.35\r\n"
    assert ingress(profile_tuxon(), data) == data


def test_ingress_con_flag_invierte():
    data = b" 126.35\r\n"
    assert ingress(profile_tuxon({"invert_bits": True}), data) == invert_bytes(data)


def test_runner_aplica_invert_bits_antes_del_parser(monkeypatch):
    # La trama llega con la polaridad invertida (como el BC04 en campo).
    frames = invert_bytes(b"  126.35\r\n") + invert_bytes(b"  130.10\r\n")
    fake = FakeTransport([frames])
    monkeypatch.setattr(runner_mod, "make_transport", lambda p: fake)

    readings: list[Reading] = []
    run_driver(profile_tuxon({"invert_bits": True}), readings.append,
               stop=lambda: len(readings) >= 2)

    assert [r.kg for r in readings] == pytest.approx([126.35, 130.10])


def test_runner_sin_flag_no_entiende_trama_invertida(monkeypatch):
    fake = FakeTransport([invert_bytes(b"  126.35\r\n")])
    monkeypatch.setattr(runner_mod, "make_transport", lambda p: fake)

    readings: list[Reading] = []
    seen = {"n": 0}

    def stop() -> bool:
        seen["n"] += 1
        return seen["n"] > 50 or bool(readings)

    run_driver(profile_tuxon(), readings.append, stop=stop)
    assert readings == []
