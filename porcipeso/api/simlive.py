"""Báscula simulada INTERACTIVA del backend (el usuario manda por API).

Diferencia con ``porcipeso.sim.indicator_sim``: aquel sigue un guion
declarativo y emite TRAMAS binarias por TCP (para probar transporte y
parsers); esta clase la controla el usuario en vivo (``pigs_on`` /
``pig_off`` / ``nervous`` / ``silence``) y produce ``Reading`` ya
normalizados que entran EXACTAMENTE por el mismo camino que un driver
real: ``on_reading`` → ``engine.feed`` + ``repo.insert_reading`` +
broadcast WS. La data queda en SQLite de verdad.

La física replica la de ``indicator_sim.Scenario`` (mismas constantes):
el peso mostrado persigue al físico con rampa exponencial
(``ramp_alpha`` por tick a 10 Hz) y un jitter que arranca alto en cada
perturbación y decae geométricamente (``jitter_decay``) hasta el ruido
base de la celda. ``nervous`` sostiene jitter alto (nunca estabiliza);
``silence`` enmudece el indicador (no se emiten lecturas → dispara el
watchdog SIN_SENAL del engine).
"""
from __future__ import annotations

import random
import threading
import time
from typing import Callable, Optional, Sequence, Union

from porcipeso.core.models import Reading

__all__ = ["SimLiveScale"]


class SimLiveScale:
    """Plataforma simulada corriendo a ``hz`` en su propio hilo."""

    def __init__(
        self,
        on_reading: Callable[[Reading], None],
        *,
        hz: int = 10,
        scale_id: str = "simulador",
        seed: Optional[int] = None,
        base_noise_kg: float = 0.05,
        ramp_alpha: float = 0.6,
        disturb_jitter_kg: float = 2.5,
        jitter_decay: float = 0.7,
        nervous_jitter_kg: float = 6.0,
        mean_pig_kg: float = 102.0,
        sd_pig_kg: float = 6.0,
    ) -> None:
        self._on_reading = on_reading
        self.hz = hz
        self.scale_id = scale_id
        self._rng = random.Random(seed)
        self._base_noise = base_noise_kg
        self._alpha = ramp_alpha
        self._disturb_jitter = disturb_jitter_kg
        self._jitter_decay = jitter_decay
        self._nervous_jitter = nervous_jitter_kg
        self._mean_pig = mean_pig_kg
        self._sd_pig = sd_pig_kg

        self._pigs: list[float] = []      # pesos físicos sobre plataforma
        self._displayed = 0.0             # peso que "muestra" el indicador
        self._jitter = 0.0                # amplitud actual de jitter
        self._nervous_until = 0.0         # time.monotonic() límite
        self._silence_until = 0.0
        self.kg_now: Optional[float] = None

        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------ ciclo vida

    def start(self) -> "SimLiveScale":
        if self.running:
            return self
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="simlive", daemon=True
        )
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self._thread = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def thread(self) -> Optional[threading.Thread]:
        return self._thread

    # -------------------------------------------------------------- comandos

    def pigs_on(
        self,
        n: int = 1,
        kg_each: Union[None, float, int, Sequence[float]] = None,
    ) -> dict:
        """Suben ``n`` cerdos de golpe (efecto inmediato + perturbación)."""
        if n < 1:
            raise ValueError("pigs_on: n debe ser >= 1")
        weights = self._pig_weights(n, kg_each)
        with self._lock:
            self._pigs.extend(weights)
            self._disturb()
        return self.status()

    def pig_off(self) -> dict:
        """Se baja el ÚLTIMO cerdo que subió (si hay alguno)."""
        with self._lock:
            if self._pigs:
                self._pigs.pop()
            self._disturb()
        return self.status()

    def nervous(self, seconds: float = 3.0) -> dict:
        """Cerdo inquieto: jitter grande sostenido; no estabiliza."""
        with self._lock:
            self._nervous_until = time.monotonic() + max(0.0, seconds)
        return self.status()

    def silence(self, seconds: float = 4.0) -> dict:
        """El indicador enmudece (sin lecturas → watchdog SIN_SENAL)."""
        with self._lock:
            self._silence_until = time.monotonic() + max(0.0, seconds)
        return self.status()

    def status(self) -> dict:
        """Estado físico actual de la plataforma simulada."""
        with self._lock:
            kg_now = self.kg_now
            return {
                "running": self.running,
                "kg_target": round(sum(self._pigs), 2),
                "pigs_fisicos": len(self._pigs),
                "kg_now": round(kg_now, 2) if kg_now is not None else None,
            }

    # ------------------------------------------------------------- internos

    def _disturb(self) -> None:
        self._jitter = max(self._jitter, self._disturb_jitter)

    def _pig_weights(
        self, n: int, kg_each: Union[None, float, int, Sequence[float]]
    ) -> list[float]:
        if kg_each is None:
            return [
                max(1.0, self._rng.gauss(self._mean_pig, self._sd_pig))
                for _ in range(n)
            ]
        if isinstance(kg_each, (int, float)):
            return [float(kg_each)] * n
        weights = [float(w) for w in kg_each]
        if len(weights) != n:
            raise ValueError(
                f"pigs_on: se esperaban {n} pesos, llegaron {len(weights)}"
            )
        return weights

    def _tick(self) -> Optional[float]:
        """Un paso de física a 1/hz. Retorna kg o None (silencio)."""
        with self._lock:
            now = time.monotonic()
            target = sum(self._pigs)
            self._displayed += (target - self._displayed) * self._alpha
            self._jitter = max(self._base_noise, self._jitter * self._jitter_decay)
            if now < self._silence_until:
                self.kg_now = None
                return None
            amp = self._nervous_jitter if now < self._nervous_until else self._jitter
            kg = max(0.0, self._displayed + self._rng.gauss(0.0, amp * 0.5))
            self.kg_now = kg
            return kg

    def _loop(self) -> None:
        period = 1.0 / self.hz
        next_t = time.monotonic()
        while not self._stop.is_set():
            kg = self._tick()
            if kg is not None:
                reading = Reading(
                    ts_ms=int(time.time() * 1000.0),
                    kg=round(kg, 2),
                    scale_id=self.scale_id,
                )
                try:
                    self._on_reading(reading)
                except Exception:
                    pass  # un consumidor roto no tumba la báscula
            next_t += period
            delay = next_t - time.monotonic()
            if delay > 0:
                self._stop.wait(delay)
            else:
                next_t = time.monotonic()  # nos atrasamos: resincronizar
