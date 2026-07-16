"""E2E del simulador SOLO (sin drivers ni engine).

Un cliente TCP crudo se conecta al IndicatorSimServer y verifica:
- tramas 'matrix' bien formadas (b'=' + 6 chars con punto + b' ') a ~10 Hz,
- que el peso evoluciona según el guion (sube al subir cerdos, baja al bajar),
- que durante ("silence", s) no se emite NADA (hueco en el stream).
"""
from __future__ import annotations

import re
import socket
import time

from porcipeso.sim.indicator_sim import IndicatorSimServer, Scenario

FRAME_LEN = 8  # b'=' + 6 chars + b' '
FRAME_RE = re.compile(rb"^=(\d{4}\.\d) $")


def _collect_frames(port: int, seconds: float) -> list[tuple[float, float]]:
    """Lee el stream crudo y retorna [(t_monotonic, kg), ...] de tramas completas."""
    out: list[tuple[float, float]] = []
    buf = b""
    with socket.create_connection(("127.0.0.1", port), timeout=2.0) as s:
        s.settimeout(0.3)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                chunk = s.recv(4096)
            except socket.timeout:
                continue
            if not chunk:
                break
            now = time.monotonic()
            buf += chunk
            while len(buf) >= FRAME_LEN:
                frame, buf = buf[:FRAME_LEN], buf[FRAME_LEN:]
                m = FRAME_RE.match(frame)
                assert m, f"trama matrix mal formada: {frame!r}"
                out.append((now, float(m.group(1))))
    return out


def test_tramas_bien_formadas_a_10hz():
    scenario = Scenario([("wait", 30.0)], seed=1)  # plataforma vacía, estable en 0
    server = IndicatorSimServer(port=0, encoder="matrix", scenario=scenario, hz=10)
    server.start()
    try:
        frames = _collect_frames(server.port, seconds=2.5)
    finally:
        server.stop()

    assert len(frames) >= 15, f"muy pocas tramas: {len(frames)}"
    # tasa ~10 Hz medida entre primera y última trama
    span = frames[-1][0] - frames[0][0]
    rate = (len(frames) - 1) / span if span > 0 else 0.0
    assert 7.0 <= rate <= 13.0, f"tasa fuera de rango: {rate:.1f} Hz"
    # plataforma vacía: peso ~0
    assert all(kg < 2.0 for _, kg in frames), "peso no-cero con plataforma vacía"


def test_peso_evoluciona_sube_y_baja():
    scenario = Scenario(
        [
            ("wait", 1.0),
            ("pigs_on", 1, 100.0),
            ("wait", 3.0),
            ("pig_off", None),
            ("wait", 3.0),
        ],
        seed=2,
    )
    server = IndicatorSimServer(port=0, encoder="matrix", scenario=scenario, hz=10)
    server.start()
    try:
        frames = _collect_frames(server.port, seconds=7.5)
    finally:
        server.stop()

    assert len(frames) >= 50
    t0 = frames[0][0]
    inicio = [kg for t, kg in frames if t - t0 < 0.8]
    meseta = [kg for t, kg in frames if 2.5 <= t - t0 <= 3.8]
    final = [kg for t, kg in frames if t - t0 > 6.5]
    assert inicio and meseta and final
    # arranca vacío, sube a ~100 y vuelve a ~0 cuando el cerdo se baja
    assert max(inicio) < 10.0, f"inicio no vacío: max={max(inicio):.1f}"
    assert any(abs(kg - 100.0) < 2.0 for kg in meseta), \
        f"nunca se asentó en ~100 kg (meseta: {min(meseta):.1f}–{max(meseta):.1f})"
    assert max(final) < 10.0, f"no bajó tras pig_off: max={max(final):.1f}"


def test_silencio_no_emite_tramas():
    scenario = Scenario(
        [("wait", 1.5), ("silence", 2.0), ("wait", 1.5)],
        seed=3,
    )
    server = IndicatorSimServer(port=0, encoder="matrix", scenario=scenario, hz=10)
    server.start()
    try:
        frames = _collect_frames(server.port, seconds=5.0)
    finally:
        server.stop()

    assert len(frames) >= 20
    gaps = [b[0] - a[0] for a, b in zip(frames, frames[1:])]
    assert max(gaps) >= 1.5, f"no hubo hueco de silencio (gap máx {max(gaps):.2f}s)"
