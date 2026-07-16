"""Simulador físico de plataforma porcina + emisor TCP de tramas de indicador.

Módulo standalone (Task 5 del plan MVP): NO depende de drivers/ ni engine/.
Emula un indicador serial-sobre-TCP real:

- Un ``Scenario`` declarativo evoluciona el peso físico de la plataforma
  (cerdos que suben/bajan) con rampa exponencial + jitter decreciente,
  igual que una plataforma real que se asienta tras cada perturbación.
- Un ``FrameEncoder`` convierte el peso instantáneo en la trama binaria del
  protocolo elegido (``matrix`` / ``xk3190_a12e`` / ``sics``).
- Un ``IndicatorSimServer`` (TCP, threading) emite la trama a N clientes a
  ``hz`` (10 Hz por defecto). Durante ``("silence", s)`` NO emite nada —
  sirve para probar el watchdog SIN_SENAL del engine.

CLI: ``python -m porcipeso.sim --port 9999 --encoder matrix --demo``
"""
from __future__ import annotations

import random
import socket
import threading
import time
from typing import Optional, Sequence, Union

__all__ = ["Scenario", "FrameEncoder", "IndicatorSimServer", "demo_scenario"]

# Un paso del guion es una tupla:
#   ("wait", segundos)
#   ("pigs_on", n, kg_each)   kg_each: None | float | secuencia de n pesos
#   ("pig_off", None)
#   ("nervous", segundos)
#   ("silence", segundos)
Step = tuple


class Scenario:
    """Guion declarativo que evoluciona el peso físico de la plataforma.

    Pasos soportados (tuplas):

    - ``("wait", s)`` — deja correr ``s`` segundos (el peso se asienta).
    - ``("pigs_on", n, kg_each)`` — suben ``n`` cerdos de golpe.
      ``kg_each``: ``None`` → peso aleatorio por cerdo (gauss ``mean_pig_kg`` ±
      ``sd_pig_kg``); ``float`` → todos con ese peso; secuencia de ``n``
      floats → pesos individuales.
    - ``("pig_off", None)`` — se baja el ÚLTIMO cerdo que subió.
    - ``("nervous", s)`` — cerdo inquieto: jitter grande sostenido ``s``
      segundos; el peso nunca es estable durante este paso.
    - ``("silence", s)`` — el indicador enmudece ``s`` segundos
      (``tick()`` retorna ``None``; el servidor no emite tramas).

    Física: el peso mostrado persigue al peso físico objetivo con rampa
    exponencial (``ramp_alpha`` por tick) y un jitter que arranca alto en
    cada perturbación y decae geométricamente (``jitter_decay``), hasta el
    ruido base de la celda (``base_noise_kg``).

    ``tick(dt)`` produce el peso instantáneo (kg) o ``None`` en silencio.
    Pensado para llamarse a 10 Hz desde el hilo del servidor.
    """

    def __init__(
        self,
        steps: Sequence[Step],
        *,
        seed: Optional[int] = 0,
        base_noise_kg: float = 0.05,
        ramp_alpha: float = 0.6,
        disturb_jitter_kg: float = 2.5,
        jitter_decay: float = 0.7,
        nervous_jitter_kg: float = 6.0,
        mean_pig_kg: float = 102.0,
        sd_pig_kg: float = 6.0,
        hold_at_end: bool = True,
    ) -> None:
        self._steps: list[Step] = list(steps)
        self._rng = random.Random(seed)
        self._base_noise = base_noise_kg
        self._alpha = ramp_alpha
        self._disturb_jitter = disturb_jitter_kg
        self._jitter_decay = jitter_decay
        self._nervous_jitter = nervous_jitter_kg
        self._mean_pig = mean_pig_kg
        self._sd_pig = sd_pig_kg
        self._hold_at_end = hold_at_end

        self._pigs: list[float] = []          # pesos físicos sobre plataforma
        self._displayed = 0.0                 # peso que "muestra" el indicador
        self._jitter = 0.0                    # amplitud actual de jitter
        self._idx = 0                         # próximo paso a consumir
        self._mode = "wait"                   # wait | nervous | silence
        self._step_left = 0.0                 # segundos restantes del paso timed
        self._done = False
        self.kg_now: Optional[float] = None   # última muestra producida

    # ------------------------------------------------------------------ API

    @property
    def pigs(self) -> list[float]:
        """Pesos físicos (kg) de los cerdos actualmente sobre la plataforma."""
        return list(self._pigs)

    @property
    def pigs_count(self) -> int:
        return len(self._pigs)

    @property
    def total_physical_kg(self) -> float:
        """Suma física real sobre plataforma (verdad-terreno para asserts)."""
        return sum(self._pigs)

    @property
    def done(self) -> bool:
        """True cuando todos los pasos del guion se consumieron."""
        return self._done

    @property
    def is_settled(self) -> bool:
        """True si el peso mostrado ya se asentó sobre el físico (flag SICS)."""
        return (
            self._mode != "nervous"
            and self._jitter <= self._base_noise * 2.0
            and abs(self._target() - self._displayed) <= 0.3
        )

    def tick(self, dt: float) -> Optional[float]:
        """Avanza ``dt`` segundos y retorna el peso instantáneo (kg).

        Retorna ``None`` durante ``("silence", s)`` (el indicador no emite).
        """
        self._advance_steps()
        if self._step_left > 0.0:
            self._step_left -= dt

        # física: rampa exponencial hacia el objetivo + jitter decreciente
        target = self._target()
        self._displayed += (target - self._displayed) * self._alpha
        self._jitter = max(self._base_noise, self._jitter * self._jitter_decay)

        if self._mode == "silence":
            self.kg_now = None
            return None

        amp = self._nervous_jitter if self._mode == "nervous" else self._jitter
        kg = self._displayed + self._rng.gauss(0.0, amp * 0.5)
        kg = max(0.0, kg)
        self.kg_now = kg
        return kg

    # ------------------------------------------------------------ internos

    def _target(self) -> float:
        return sum(self._pigs)

    def _disturb(self) -> None:
        self._jitter = max(self._jitter, self._disturb_jitter)

    def _pig_weights(self, n: int, kg_each: Union[None, float, int, Sequence[float]]) -> list[float]:
        if kg_each is None:
            return [max(1.0, self._rng.gauss(self._mean_pig, self._sd_pig)) for _ in range(n)]
        if isinstance(kg_each, (int, float)):
            return [float(kg_each)] * n
        weights = [float(w) for w in kg_each]
        if len(weights) != n:
            raise ValueError(f"pigs_on: se esperaban {n} pesos, llegaron {len(weights)}")
        return weights

    def _advance_steps(self) -> None:
        """Consume pasos instantáneos y arma el paso timed vigente."""
        while self._step_left <= 0.0 and not self._done:
            if self._idx >= len(self._steps):
                self._done = True
                self._mode = "wait" if self._hold_at_end else "silence"
                break
            step = self._steps[self._idx]
            self._idx += 1
            kind = step[0]
            if kind == "wait":
                self._mode = "wait"
                self._step_left = float(step[1])
            elif kind == "nervous":
                self._mode = "nervous"
                self._step_left = float(step[1])
            elif kind == "silence":
                self._mode = "silence"
                self._step_left = float(step[1])
            elif kind == "pigs_on":
                n = int(step[1])
                kg_each = step[2] if len(step) > 2 else None
                self._pigs.extend(self._pig_weights(n, kg_each))
                self._disturb()
                self._mode = "wait"
            elif kind == "pig_off":
                if self._pigs:
                    self._pigs.pop()
                self._disturb()
                self._mode = "wait"
            else:
                raise ValueError(f"paso de escenario desconocido: {step!r}")


class FrameEncoder:
    """Codifica un peso (kg) en la trama binaria del protocolo elegido.

    Protocolos soportados (parámetro ``kind``):

    - ``matrix`` — Lexus/Trumax Matrix modo normal (Adr 00):
      ``b'=' + peso 6 chars con punto + b' '``  → ej. 102.5 → ``b'=0102.5 '``.
    - ``xk3190_a12e`` — Yaohua XK3190-A12E: mismo payload pero con los
      caracteres del peso INVERTIDOS → ej. 102.5 → ``b'=5.2010'``.
    - ``sics`` — Mettler-Toledo MT-SICS: ``'S S %10.2f kg\\r\\n'`` estable,
      ``'S D %10.2f kg\\r\\n'`` en movimiento.
    """

    KINDS = ("matrix", "xk3190_a12e", "sics")

    def __init__(self, kind: str = "matrix") -> None:
        if kind not in self.KINDS:
            raise ValueError(f"encoder desconocido: {kind!r} (opciones: {self.KINDS})")
        self.kind = kind

    def encode(self, kg: float, stable: bool = True) -> bytes:
        kg = min(max(kg, 0.0), 9999.9)
        if self.kind == "matrix":
            return b"=" + f"{kg:06.1f}".encode("ascii") + b" "
        if self.kind == "xk3190_a12e":
            return b"=" + f"{kg:06.1f}"[::-1].encode("ascii")
        # sics
        flag = "S" if stable else "D"
        return f"S {flag} {kg:10.2f} kg\r\n".encode("ascii")


class IndicatorSimServer:
    """Servidor TCP que emite las tramas del peso actual a N clientes.

    - ``port=0`` elige un puerto libre; el puerto real queda en ``self.port``
      tras ``start()``.
    - ``encoder`` acepta un ``FrameEncoder`` o la clave del protocolo (str).
    - El escenario corre en su propio hilo emisor a ``hz``; durante
      ``("silence", s)`` no se emite NADA (prueba de watchdog SIN_SENAL).
    - ``start()`` / ``stop()`` idempotentes para usar en tests y CLI.
    """

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 0,
        encoder: Union[str, FrameEncoder] = "matrix",
        scenario: Optional[Scenario] = None,
        hz: int = 10,
    ) -> None:
        self.host = host
        self._requested_port = port
        self.encoder = FrameEncoder(encoder) if isinstance(encoder, str) else encoder
        self.scenario = scenario if scenario is not None else Scenario([("wait", 3600.0)])
        self.hz = hz
        self.port: Optional[int] = None

        self._server_sock: Optional[socket.socket] = None
        self._clients: list[socket.socket] = []
        self._clients_lock = threading.Lock()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._started = False

    # ------------------------------------------------------------------ API

    def start(self) -> "IndicatorSimServer":
        if self._started:
            return self
        self._stop.clear()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.host, self._requested_port))
        sock.listen(8)
        self._server_sock = sock
        self.port = sock.getsockname()[1]

        t_accept = threading.Thread(target=self._accept_loop, name="sim-accept", daemon=True)
        t_emit = threading.Thread(target=self._emit_loop, name="sim-emit", daemon=True)
        self._threads = [t_accept, t_emit]
        for t in self._threads:
            t.start()
        self._started = True
        return self

    def stop(self) -> None:
        if not self._started:
            return
        self._stop.set()
        if self._server_sock is not None:
            try:
                self._server_sock.close()
            except OSError:
                pass
        with self._clients_lock:
            for c in self._clients:
                try:
                    c.close()
                except OSError:
                    pass
            self._clients.clear()
        for t in self._threads:
            t.join(timeout=2.0)
        self._threads = []
        self._started = False

    # ------------------------------------------------------------ internos

    def _accept_loop(self) -> None:
        assert self._server_sock is not None
        while not self._stop.is_set():
            try:
                conn, _addr = self._server_sock.accept()
            except OSError:
                break  # socket cerrado por stop()
            try:
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            with self._clients_lock:
                self._clients.append(conn)

    def _emit_loop(self) -> None:
        period = 1.0 / self.hz
        next_t = time.monotonic()
        while not self._stop.is_set():
            kg = self.scenario.tick(period)
            if kg is not None:
                frame = self.encoder.encode(kg, stable=self.scenario.is_settled)
                self._broadcast(frame)
            next_t += period
            delay = next_t - time.monotonic()
            if delay > 0:
                self._stop.wait(delay)
            else:
                next_t = time.monotonic()  # nos atrasamos: resincronizar

    def _broadcast(self, frame: bytes) -> None:
        dead: list[socket.socket] = []
        with self._clients_lock:
            clients = list(self._clients)
        for c in clients:
            try:
                c.sendall(frame)
            except OSError:
                dead.append(c)
        if dead:
            with self._clients_lock:
                for c in dead:
                    if c in self._clients:
                        self._clients.remove(c)
                    try:
                        c.close()
                    except OSError:
                        pass


def demo_scenario(seed: int = 0) -> Scenario:
    """Guion demo del CLI: ref 1 cerdo, suben 2, se devuelve 1, reingresa,
    suben 3, cierre (el peso final queda estable en plataforma)."""
    return Scenario(
        [
            ("wait", 2.0),
            ("pigs_on", 1, 102.5),          # seteo de referencia
            ("wait", 4.0),
            ("pigs_on", 2, (104.0, 99.5)),  # suben 2
            ("wait", 4.0),
            ("pig_off", None),              # se devuelve el último (99.5)
            ("wait", 4.0),
            ("pigs_on", 1, 99.5),           # reingresa el mismo
            ("wait", 4.0),
            ("pigs_on", 3, None),           # suben 3 (pesos aleatorios)
            ("wait", 5.0),                  # cierre: estable para el tiquete
        ],
        seed=seed,
    )
