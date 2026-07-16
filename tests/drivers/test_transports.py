"""Tests de transports: fábrica y TcpTransport contra un servidor real."""
from __future__ import annotations

import socket
import threading

import pytest

from porcipeso.core.models import ScaleProfile
from porcipeso.drivers.transports import SerialTransport, TcpTransport, make_transport


def tcp_profile(host: str, port: int) -> ScaleProfile:
    return ScaleProfile(id="t", name="t", brand="t", parser="generic_regex",
                        transport="tcp", host=host, tcp_port=port)


class OneShotServer:
    """Servidor TCP que acepta conexiones y envía un payload por conexión."""

    def __init__(self, payloads: list[bytes]):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.port = self.sock.getsockname()[1]
        self.payloads = payloads
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        for payload in self.payloads:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                conn.sendall(payload)
        self.sock.close()

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def test_make_transport_serial_requires_port():
    profile = ScaleProfile(id="s", name="s", brand="s", parser="matrix")
    with pytest.raises(ValueError):
        make_transport(profile)


def test_make_transport_tcp_requires_host():
    profile = ScaleProfile(id="s", name="s", brand="s", parser="matrix",
                           transport="tcp")
    with pytest.raises(ValueError):
        make_transport(profile)


def test_make_transport_unknown_kind():
    profile = ScaleProfile(id="s", name="s", brand="s", parser="matrix",
                           transport="zigbee")
    with pytest.raises(ValueError):
        make_transport(profile)


def test_make_transport_tcp_and_sim_return_tcp_transport():
    for kind in ("tcp", "sim"):
        profile = ScaleProfile(id="s", name="s", brand="s", parser="matrix",
                               transport=kind, host="127.0.0.1", tcp_port=9)
        assert isinstance(make_transport(profile), TcpTransport)


def test_tcp_transport_reads_bytes():
    server = OneShotServer([b"= 126.35"])
    transport = TcpTransport(tcp_profile("127.0.0.1", server.port))
    try:
        data = b""
        for _ in range(20):
            data += transport.read(64, timeout_s=0.2)
            if len(data) >= 8:
                break
        assert data == b"= 126.35"
    finally:
        transport.close()
        server.close()


def test_tcp_transport_peer_close_returns_empty_then_reconnects():
    server = OneShotServer([b"AAA", b"BBB"])
    transport = TcpTransport(tcp_profile("127.0.0.1", server.port))
    transport.RECONNECT_MIN_S = 0.0  # acelerar el test
    try:
        got = b""
        for _ in range(60):
            got += transport.read(16, timeout_s=0.1)
            if b"AAA" in got and b"BBB" in got:
                break
        assert b"AAA" in got and b"BBB" in got  # reconexión suave funcionó
    finally:
        transport.close()
        server.close()


def test_tcp_transport_connection_refused_is_soft():
    # puerto cerrado: read no lanza, devuelve b''
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()  # el puerto queda libre/cerrado
    transport = TcpTransport(tcp_profile("127.0.0.1", port))
    assert transport.read(16, timeout_s=0.1) == b""
    transport.close()


def test_serial_transport_requires_port():
    profile = ScaleProfile(id="s", name="s", brand="s", parser="matrix",
                           transport="serial", port=None)
    with pytest.raises(ValueError):
        SerialTransport(profile)
