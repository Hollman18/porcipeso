"""Transportes de bytes: puerto serial (pyserial) y socket TCP.

El transporte del simulador (perfil `transport: sim`) es un servidor TCP del
módulo porcipeso.sim, así que aquí se mapea a TcpTransport. Para tests de
parsers se usan bytes en memoria (sin transporte).
"""
from __future__ import annotations

import socket
import time

import serial

from porcipeso.core.interfaces import Transport
from porcipeso.core.models import ScaleProfile

_PARITY = {
    "N": serial.PARITY_NONE,
    "E": serial.PARITY_EVEN,
    "O": serial.PARITY_ODD,
}
_BYTESIZE = {
    5: serial.FIVEBITS,
    6: serial.SIXBITS,
    7: serial.SEVENBITS,
    8: serial.EIGHTBITS,
}
_STOPBITS = {
    1: serial.STOPBITS_ONE,
    2: serial.STOPBITS_TWO,
}


class SerialTransport(Transport):
    """Puerto serial RS-232/RS-485 configurado desde el ScaleProfile."""

    def __init__(self, profile: ScaleProfile) -> None:
        if not profile.port:
            raise ValueError(
                f"perfil '{profile.id}': falta el puerto serial (port)")
        self.profile = profile
        self._ser = serial.Serial(
            port=profile.port,
            baudrate=profile.baudrate,
            bytesize=_BYTESIZE.get(profile.bytesize, serial.EIGHTBITS),
            parity=_PARITY.get(profile.parity.upper(), serial.PARITY_NONE),
            stopbits=_STOPBITS.get(profile.stopbits, serial.STOPBITS_ONE),
            timeout=0.2,
        )

    def read(self, max_bytes: int = 256, timeout_s: float = 0.2) -> bytes:
        if self._ser.timeout != timeout_s:
            self._ser.timeout = timeout_s
        data = self._ser.read(1)  # bloquea hasta 1 byte o timeout
        if data:
            waiting = self._ser.in_waiting
            if waiting:
                data += self._ser.read(min(max_bytes - 1, waiting))
        return data

    def close(self) -> None:
        try:
            self._ser.close()
        except Exception:
            pass


class TcpTransport(Transport):
    """Socket TCP con timeout y reconexión suave.

    Conecta perezosamente en el primer read(); si el peer cierra o hay error
    de red, descarta el socket y reintenta la conexión en lecturas siguientes
    (con una pausa mínima para no ciclar en caliente). Nunca lanza desde
    read(): devuelve b'' y deja el backoff duro al runner.
    """

    RECONNECT_MIN_S = 0.5

    def __init__(self, profile: ScaleProfile, connect_timeout_s: float = 3.0) -> None:
        if not profile.host or not profile.tcp_port:
            raise ValueError(
                f"perfil '{profile.id}': faltan host/tcp_port para transporte tcp")
        self.profile = profile
        self._connect_timeout_s = connect_timeout_s
        self._sock: socket.socket | None = None
        self._last_attempt = 0.0

    def _connect(self) -> None:
        self._sock = socket.create_connection(
            (self.profile.host, self.profile.tcp_port),
            timeout=self._connect_timeout_s,
        )

    def _drop(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    def read(self, max_bytes: int = 256, timeout_s: float = 0.2) -> bytes:
        if self._sock is None:
            now = time.monotonic()
            if now - self._last_attempt < self.RECONNECT_MIN_S:
                time.sleep(timeout_s)
                return b""
            self._last_attempt = now
            try:
                self._connect()
            except OSError:
                self._sock = None
                return b""
        try:
            self._sock.settimeout(timeout_s)
            data = self._sock.recv(max_bytes)
        except TimeoutError:
            return b""
        except OSError:
            self._drop()
            return b""
        if data == b"":  # el peer cerró: reconexión suave en el próximo read
            self._drop()
        return data

    def close(self) -> None:
        self._drop()


def make_transport(profile: ScaleProfile) -> Transport:
    """Fábrica de transporte según ScaleProfile.transport."""
    kind = (profile.transport or "serial").lower()
    if kind == "serial":
        return SerialTransport(profile)
    if kind in ("tcp", "sim"):  # el simulador es un servidor TCP
        return TcpTransport(profile)
    raise ValueError(f"transporte desconocido: {profile.transport!r}")
