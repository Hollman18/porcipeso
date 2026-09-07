"""Motor de pesaje PorciPeso v2 — Capa 2 (SPEC §4 y §4.1, ARQUITECTURA §2).

Máquina de estados pura y determinista sobre el stream de lecturas:
sin threads, sin I/O, sin sleeps. El tiempo viene de Reading.ts_ms; el
reloj de pared (time.time()) solo se consulta en snapshot() para el
watchdog SIN_SENAL.

Reglas centrales (SPEC §4):
- Estable = una RACHA de lecturas dentro de stability_range_kg (max-min)
  sostenida >= min_stable_ms. Es por TIEMPO, no por conteo de lecturas:
  así funciona igual a 3 Hz o a 20 Hz y filtra rebotes / cerdos que pasan
  de largo sin quedarse en la plataforma.
- En cada transición movimiento→estable: nivel = media de la racha;
  delta = nivel - último nivel estable relevante.

MODO "lote" (v2 — calibración con cerdo de prueba que SE BAJA):
- open_session(id, modo="lote") arranca en fase "calibracion".
- El operador sube UN cerdo de prueba. El candidato a referencia es el
  MÁXIMO nivel estable sostenido (peak hold sobre niveles ESTABLES, no
  sobre lecturas crudas: un pico crudo de un cerdo saltando no es peso).
- Con candidato y a la espera de que lo bajen: fase "bajar_prueba".
  Si el nivel estable sube ≥ min_delta_kg por encima del candidato
  (montaron otro sin bajar el primero) se vuelve a "calibracion" con el
  nuevo máximo — tolerante, sin romperse. Subidas estables menores
  (cerdo inquieto acomodándose) solo actualizan el peak.
- Cuando el nivel estable vuelve a casi vacío (< 20% del candidato o
  < min_delta_kg) la calibración termina: se emite UN evento REFERENCIA
  (peso_antes=0, peso_despues=ref, delta_kg=ref, 1 animal — "el cerdo de
  prueba pesó ref"), se fija ref_kg=avg=ref y la fase pasa a "lote".
  La bajada del cerdo de prueba NO genera evento BAJADA y count sigue 0
  (cuando vuelva a subir con el lote se cuenta normal).
- Desde fase "lote" rige el comportamiento clásico:
  n = round(delta / promedio_movil); si el residuo supera la tolerancia
  el evento queda AMBIGUO en cola de confirmación; el promedio se
  auto-corrige (avg = total / count); bidireccional (SPEC §4.1): delta
  negativo = BAJADA, la subida siguiente sin emparejar = REINGRESO.

MODO "unidades" (v2 — pesaje uno a uno):
- open_session(id, modo="unidades") → fase "unidades" siempre. Sin
  calibración ni referencia.
- Ciclo: vacío → nivel estable ≥ min_delta_kg = SUBIDA n=1 con el peso
  del animal → el nivel vuelve a < min_delta_kg = salió (SIN evento) →
  listo para el siguiente.
- SIN REPESAJE (unit_return_to_zero, por defecto): con un cerdo arriba se
  ignora TODO hasta que la plataforma vuelva a ~vacío. Así no se cuenta
  dos veces el mismo cerdo que se reacomoda ni el que se monta encima sin
  bajar el primero. Con la opción apagada vuelve el apilado legado (la
  diferencia ≥ min_delta cuenta como otro).
- BANDA DE TOLERANCIA: una vez hay min_animals_for_band cerdos que fijan
  un promedio confiable, un nivel cuenta como 1 cerdo solo si cae en
  [avg*band_low, avg*band_high]. Por debajo → no cuenta (medio subido u
  objeto); por encima → AMBIGUO (el operario confirma 1 o 2).
"""
from __future__ import annotations

import math
import time
from typing import Callable, Optional

from porcipeso.core.interfaces import Engine
from porcipeso.core.models import (
    EngineConfig,
    EngineSnapshot,
    EngineState,
    EventType,
    Reading,
    WeighEvent,
)

# Fases del pesaje (EngineSnapshot.fase)
FASE_CALIBRACION = "calibracion"
FASE_BAJAR_PRUEBA = "bajar_prueba"
FASE_LOTE = "lote"
FASE_UNIDADES = "unidades"

MODOS = ("lote", "unidades")

#: fracción del candidato bajo la cual la plataforma se considera vacía
#: al terminar la calibración (además del umbral absoluto min_delta_kg)
EMPTY_FRACTION = 0.20


class WeighingEngine(Engine):
    """Motor de pesaje por sesión (modos: lote acumulado | unidades)."""

    def __init__(
        self,
        config: EngineConfig,
        on_event: Callable[[WeighEvent], None],
        on_state: Callable[[str], None] | None = None,
    ) -> None:
        self.config = config
        self._on_event = on_event
        self._on_state = on_state

        # stream / estabilidad por TIEMPO (no por conteo de lecturas): una
        # "meseta" es una racha de lecturas dentro de stability_range_kg; se
        # considera ESTABLE cuando la racha lleva >= min_stable_ms sostenida.
        self._state: EngineState = EngineState.IDLE
        self._run_start_ts: Optional[int] = None  # inicio de la racha en curso
        self._run_lo: float = 0.0                 # mínimo de la racha
        self._run_hi: float = 0.0                 # máximo de la racha
        self._run_sum: float = 0.0                # suma (para la media)
        self._run_n: int = 0                      # nº de lecturas de la racha
        self._last_ts_ms: Optional[int] = None
        self._kg_now: float = 0.0
        # inicio del MOVIMIENTO en curso (para estab_ms = cuánto se demoró en
        # asentarse): se fija al ENTRAR en movimiento, no en cada racha nueva.
        self._movement_start_ts: Optional[int] = None

        # sesión
        self._session_id: Optional[int] = None
        self._next_event_id: int = 1
        self._modo: str = "lote"
        self._fase: str = FASE_LOTE
        self._ref_kg: Optional[float] = None
        self._avg_kg: Optional[float] = None
        self._count: int = 0
        self._total_kg: float = 0.0
        self._baseline: Optional[float] = None  # último nivel estable relevante
        self._pending: dict[int, WeighEvent] = {}
        self._unmatched_bajadas: list[int] = []  # ids de BAJADA sin reingreso
        self._links: dict[int, int] = {}  # reingreso_id -> bajada_id (interno)
        # calibración (modo lote)
        self._calib_base: Optional[float] = None   # nivel estable inicial (vacío)
        self._calib_candidate: Optional[float] = None  # peak hold del cerdo de prueba
        # modo unidades
        self._unit_base: Optional[float] = None    # nivel estable de plataforma vacía
        self._unit_level: Optional[float] = None   # nivel registrado del animal arriba

    # ------------------------------------------------------------------ API

    def feed(self, reading: Reading) -> None:
        cfg = self.config

        # Watchdog dentro de feed: hueco entre lecturas > no_signal_after_s.
        if (
            self._last_ts_ms is not None
            and reading.ts_ms - self._last_ts_ms > cfg.no_signal_after_s * 1000.0
        ):
            self._reset_run()  # lo anterior al apagón ya no es comparable
            self._movement_start_ts = reading.ts_ms
            if self._session_id is not None:
                self._set_state(EngineState.SIN_SENAL)

        self._last_ts_ms = reading.ts_ms
        self._kg_now = reading.kg
        self._update_run(reading.ts_ms, reading.kg)
        if self._movement_start_ts is None:
            self._movement_start_ts = reading.ts_ms

        if self._session_id is None:
            return  # sin sesión: solo tracking de peso vivo (estado IDLE)

        if self._run_stable(reading.ts_ms):
            if self._state != EngineState.ESTABLE:
                start = self._movement_start_ts or reading.ts_ms
                estab_ms = max(0, reading.ts_ms - start)
                self._set_state(EngineState.ESTABLE)
                self._handle_stable_level(self._run_mean(), reading.ts_ms,
                                          estab_ms)
        else:
            if self._state != EngineState.MOVIMIENTO:
                self._movement_start_ts = reading.ts_ms
                self._set_state(EngineState.MOVIMIENTO)

    def open_session(self, session_id: int, modo: str = "lote") -> None:
        if modo not in MODOS:
            raise ValueError(f"modo desconocido: {modo!r} (esperado: {MODOS})")
        self._session_id = session_id
        self._reset_session_vars()
        self._modo = modo
        self._fase = FASE_CALIBRACION if modo == "lote" else FASE_UNIDADES
        # La base de la sesión se fija SOLO con lecturas frescas: heredar la
        # racha de la conexión/sesión anterior daría una base falsa (p.ej.
        # 301 kg viejos) y la sesión quedaría muda, porque ningún delta real
        # superaría el umbral contra esa base fantasma.
        self._reset_run()
        self._movement_start_ts = self._last_ts_ms
        self._set_state(EngineState.MOVIMIENTO)

    def set_reference(self, kg: float) -> Optional[WeighEvent]:
        """Fija MANUALMENTE el peso de referencia del cerdo de prueba.

        El operario escribe el peso conocido (ej. 1.5) y el motor lo toma
        como referencia sin depender del umbral automático: ref = avg = kg,
        conteo en 0, y pasa directo a fase "lote". Emite un evento REFERENCIA
        auditado. Solo aplica en modo lote y con sesión abierta.
        """
        if self._session_id is None or self._modo != "lote" or kg <= 0:
            return None
        self._ref_kg = kg
        self._avg_kg = kg
        self._count = 0
        self._total_kg = 0.0
        # base del lote = nivel vacío actual (o 0 si aún no hay uno)
        self._baseline = self._calib_base if self._calib_base is not None else 0.0
        self._calib_candidate = None
        self._fase = FASE_LOTE
        ts = self._last_ts_ms or 0
        ev = self._new_event(ts, 0.0, kg, kg, 1, EventType.REFERENCIA, 0)
        ev.confirmado_por = "manual"
        self._on_event(ev)
        return ev

    def confirm(self, event_id: int, n: int) -> Optional[WeighEvent]:
        ev = self._pending.get(event_id)
        if ev is None or n < 1:
            return None
        del self._pending[event_id]
        ev.ambiguo = False
        ev.animales_confirmados = n
        self._apply(ev, n)
        return ev

    def snapshot(self) -> EngineSnapshot:
        # Watchdog contra reloj de pared: solo aquí (el motor sigue puro
        # respecto al stream; feed jamás consulta time.time()).
        if (
            self._session_id is not None
            and self._last_ts_ms is not None
            and time.time() * 1000.0 - self._last_ts_ms
            > self.config.no_signal_after_s * 1000.0
        ):
            self._set_state(EngineState.SIN_SENAL)
        return EngineSnapshot(
            state=self._state,
            kg_now=self._kg_now,
            ref_kg=self._ref_kg,
            avg_kg=self._avg_kg,
            count=self._count,
            total_kg=self._total_kg,
            pending=len(self._pending),
            fase=self._fase,
        )

    def close_session(self) -> EngineSnapshot:
        final = self.snapshot()
        self._session_id = None
        self._reset_session_vars()
        self._set_state(EngineState.IDLE)
        return final

    # ------------------------------------------------------------ interno

    def _reset_session_vars(self) -> None:
        self._modo = "lote"
        self._fase = FASE_LOTE  # default del contrato; open_session la fija
        self._ref_kg = None
        self._avg_kg = None
        self._count = 0
        self._total_kg = 0.0
        self._baseline = None
        self._pending = {}
        self._unmatched_bajadas = []
        self._links = {}
        self._calib_base = None
        self._calib_candidate = None
        self._unit_base = None
        self._unit_level = None

    def _reset_run(self) -> None:
        self._run_start_ts = None
        self._run_lo = 0.0
        self._run_hi = 0.0
        self._run_sum = 0.0
        self._run_n = 0

    def _start_run(self, ts_ms: int, kg: float) -> None:
        self._run_start_ts = ts_ms
        self._run_lo = kg
        self._run_hi = kg
        self._run_sum = kg
        self._run_n = 1

    def _update_run(self, ts_ms: int, kg: float) -> None:
        """Extiende la racha si la lectura cabe en stability_range_kg; si la
        rompe, arranca una racha nueva desde esta lectura."""
        if self._run_start_ts is None:
            self._start_run(ts_ms, kg)
            return
        lo = kg if kg < self._run_lo else self._run_lo
        hi = kg if kg > self._run_hi else self._run_hi
        if hi - lo <= self.config.stability_range_kg:
            self._run_lo, self._run_hi = lo, hi
            self._run_sum += kg
            self._run_n += 1
        else:
            self._start_run(ts_ms, kg)

    def _run_stable(self, ts_ms: int) -> bool:
        """Estable = la racha lleva >= min_stable_ms sostenida (>= 2 lecturas),
        independiente de la frecuencia del indicador."""
        return (
            self._run_start_ts is not None
            and self._run_n >= 2
            and ts_ms - self._run_start_ts >= self.config.min_stable_ms
        )

    def _run_mean(self) -> float:
        return self._run_sum / self._run_n if self._run_n else 0.0

    def _set_state(self, new_state: EngineState) -> None:
        if new_state != self._state:
            self._state = new_state
            if self._on_state is not None:
                self._on_state(new_state.value)

    # --------------------------------------------------- despacho por fase

    def _handle_stable_level(self, level: float, ts_ms: int,
                             estab_ms: int) -> None:
        """Procesa una transición movimiento→estable con sesión abierta."""
        if self._modo == "unidades":
            self._stable_unidades(level, ts_ms, estab_ms)
        elif self._fase in (FASE_CALIBRACION, FASE_BAJAR_PRUEBA):
            self._stable_calibracion(level, ts_ms, estab_ms)
        else:
            self._stable_lote(level, ts_ms, estab_ms)

    # ------------------------------------------------- calibración (lote)

    def _stable_calibracion(self, level: float, ts_ms: int,
                            estab_ms: int) -> None:
        """Peak hold del cerdo de prueba; termina cuando vuelve a vacío."""
        cfg = self.config
        if self._calib_base is None:
            # primer nivel estable de la sesión: base (vacío), sin evento
            self._calib_base = level
            return
        rel = level - self._calib_base
        cand = self._calib_candidate

        if cand is not None and (
            rel < cfg.min_ref_kg or rel < EMPTY_FRACTION * cand
        ):
            # casi vacío: el cerdo de prueba se bajó → calibración lista.
            # Su bajada NO es evento BAJADA; se emite UN evento REFERENCIA
            # semánticamente "el cerdo de prueba pesó cand".
            self._ref_kg = cand
            self._avg_kg = cand
            self._count = 0
            self._total_kg = 0.0
            self._baseline = level  # base del lote = nivel vacío actual
            self._calib_candidate = None
            self._fase = FASE_LOTE
            ev = self._new_event(ts_ms, 0.0, cand, cand, 1,
                                 EventType.REFERENCIA, estab_ms)
            self._on_event(ev)
            return

        if rel < cfg.min_ref_kg:
            return  # sigue vacío (o vibración): aún no sube el de prueba

        if cand is None:
            # subió el cerdo de prueba: primer candidato
            self._calib_candidate = rel
            self._fase = FASE_BAJAR_PRUEBA
        elif rel > cand:
            # peak hold: solo sube el candidato, nunca baja
            self._calib_candidate = rel
            if rel - cand >= cfg.min_delta_kg:
                # montaron otro sin bajar el primero (A4): se recalibra
                # con el nuevo máximo — tolerante, sin romperse
                self._fase = FASE_CALIBRACION
            else:
                # cerdo inquieto acomodándose: sigue esperando la bajada
                self._fase = FASE_BAJAR_PRUEBA
        # rel <= cand (se acomodó más liviano / bajada parcial): peak hold,
        # ni evento ni cambio de fase

    # -------------------------------------------------------- fase "lote"

    def _stable_lote(self, level: float, ts_ms: int, estab_ms: int) -> None:
        assert self._baseline is not None and self._avg_kg is not None
        delta = level - self._baseline
        if abs(delta) < self.config.min_delta_kg:
            return  # vibración / deriva: no es escalón (baseline NO avanza)
        if delta < 0:
            # BAJADA = el grupo ya pesado avanzó al camión (flujo NORMAL).
            # La báscula de paso NO puede distinguir "avanzó al camión" de
            # "se devolvió por miedo", así que JAMÁS descuenta automáticamente
            # (antes lo hacía y restaba cerdos ya despachados). Los cerdos que
            # se devuelven y se re-pesan los registra el operario a mano con
            # register_returned(). Aquí solo se resetea la base para el
            # siguiente grupo que suba.
            self._baseline = level
            return
        self._step(level, delta, ts_ms, estab_ms)

    def _step(self, level: float, delta: float, ts_ms: int,
              estab_ms: int) -> None:
        # delta > 0 garantizado por _stable_lote (las bajadas no llegan aquí)
        assert self._avg_kg is not None
        n_raw = delta / self._avg_kg
        n = round(n_raw)
        if n == 0:
            # escalón parcial (ej. cerdo a medio subir): se ignora SIN
            # avanzar la base, para que el escalón completo se mida entero
            return
        residuo = abs(n_raw - n)
        peso_antes = self._baseline
        self._baseline = level  # el peso en plataforma cambió de verdad

        if residuo > self.config.tolerance:
            opciones = sorted({
                c for c in (math.floor(n_raw), math.ceil(n_raw)) if c > 0
            })
            ev = self._new_event(ts_ms, peso_antes, level, delta, n,
                                 EventType.SUBIDA, estab_ms,
                                 ambiguo=True, opciones=opciones)
            self._pending[ev.id] = ev  # type: ignore[index]
            self._on_event(ev)
            return

        ev = self._new_event(ts_ms, peso_antes, level, delta, n,
                             EventType.SUBIDA, estab_ms)
        self._apply(ev, n)
        self._on_event(ev)

    def _apply(self, ev: WeighEvent, n: int) -> None:
        """Aplica n cerdos SUBIDOS al estado de sesión (solo positivo)."""
        ev.tipo = EventType.SUBIDA
        self._count += n
        self._total_kg += ev.delta_kg
        if self._count > 0:
            self._avg_kg = self._total_kg / self._count

    def register_returned(self, n: int) -> Optional[WeighEvent]:
        """Descuento MANUAL de cerdos que se devolvieron (rebote por miedo).

        El operario indica cuántos cerdos se subieron, se devolvieron y se
        van a re-pesar; se descuenta n × promedio del conteo y del total para
        corregir el doble conteo. Emite un evento AJUSTE auditado. Nunca deja
        el conteo negativo. Es la ÚNICA vía de descuento (ya no hay bajada
        automática): solo el humano sabe cuántos rebotaron.
        """
        if self._session_id is None or n < 1:
            return None
        n = min(n, self._count)
        if n == 0:
            return None
        avg = self._avg_kg or 0.0
        delta = -avg * n
        peso_antes = self._total_kg
        self._count -= n
        self._total_kg = max(0.0, self._total_kg + delta)
        # el promedio por cerdo no cambia (se resta n×avg): se mantiene estable
        ts = self._last_ts_ms or 0
        ev = self._new_event(ts, peso_antes, self._total_kg, delta, n,
                             EventType.AJUSTE, 0)
        ev.animales_confirmados = n
        ev.motivo_bajada = "devuelto_manual"
        self._on_event(ev)
        return ev

    # ---------------------------------------------------- modo "unidades"

    def _stable_unidades(self, level: float, ts_ms: int,
                         estab_ms: int) -> None:
        """Pesaje uno a uno: cada nivel estable ≥ min_delta = un animal."""
        cfg = self.config
        if self._unit_base is None:
            # primer nivel estable de la sesión: plataforma vacía (base)
            self._unit_base = level
            return
        rel = level - self._unit_base

        if self._unit_level is None:
            # plataforma vacía: ¿subió un animal?
            if rel >= cfg.min_delta_kg:
                self._count_or_flag_unidad(self._unit_base, level, rel,
                                           ts_ms, estab_ms)
            return

        # hay un animal arriba
        if rel < cfg.min_delta_kg:
            # volvió a vacío: el animal salió — listo para el siguiente
            self._unit_level = None
            return
        if not cfg.unit_return_to_zero:
            # LEGADO (opción apagada): apilar cuenta la diferencia ≥ min_delta
            extra = level - self._unit_level
            if extra >= cfg.min_delta_kg:
                self._count_or_flag_unidad(self._unit_level, level, extra,
                                           ts_ms, estab_ms)
        # SIN REPESAJE (por defecto): con un cerdo arriba se ignora TODO hasta
        # que la plataforma vuelva a ~vacío. Así no se cuenta dos veces el
        # mismo cerdo que se reacomoda ni el que se monta encima sin bajar.

    def _count_or_flag_unidad(self, peso_antes: float, level: float,
                              peso: float, ts_ms: int, estab_ms: int) -> None:
        """Aplica la banda de plausibilidad (una vez hay promedio confiable) y
        cuenta / descarta / marca ambiguo. Fija _unit_level cuando el peso se
        acepta o se marca ambiguo (para exigir retorno a vacío antes del
        siguiente cerdo)."""
        cfg = self.config
        avg = self._avg_kg
        if avg and self._count >= cfg.min_animals_for_band:
            lo = avg * cfg.band_low
            hi = avg * cfg.band_high
            if peso < lo:
                # demasiado liviano para ser un cerdo del lote (medio subido u
                # objeto): NO cuenta. No fija _unit_level: si termina de subir
                # y entra en banda, se reevalúa en la próxima meseta estable.
                return
            if peso > hi:
                # demasiado pesado: posible doble → AMBIGUO (el operario
                # confirma 1 o 2, como en lote). Exige vaciar antes del próximo.
                self._unit_level = level
                r = peso / avg
                opciones = sorted({
                    c for c in (math.floor(r), math.ceil(r)) if c > 0
                })
                ev = self._new_event(ts_ms, peso_antes, level, peso, round(r),
                                     EventType.SUBIDA, estab_ms,
                                     ambiguo=True, opciones=opciones)
                self._pending[ev.id] = ev  # type: ignore[index]
                self._on_event(ev)
                return
        # dentro de banda (o banda aún no aplica): cuenta 1
        self._unit_level = level
        self._emit_unidad(peso_antes, level, peso, ts_ms, estab_ms)

    def _emit_unidad(self, peso_antes: float, level: float, peso: float,
                     ts_ms: int, estab_ms: int) -> None:
        self._count += 1
        self._total_kg += peso
        self._avg_kg = self._total_kg / self._count
        ev = self._new_event(ts_ms, peso_antes, level, peso, 1,
                             EventType.SUBIDA, estab_ms)
        self._on_event(ev)

    # ------------------------------------------------------------- eventos

    def _new_event(self, ts_ms: int, peso_antes: float, peso_despues: float,
                   delta: float, n: int, tipo: EventType, estab_ms: int, *,
                   ambiguo: bool = False,
                   opciones: list[int] | None = None) -> WeighEvent:
        assert self._session_id is not None
        ev = WeighEvent(
            id=self._next_event_id,
            session_id=self._session_id,
            ts_ms=ts_ms,
            peso_antes=peso_antes,
            peso_despues=peso_despues,
            delta_kg=delta,
            animales_estimados=n,
            tipo=tipo,
            ambiguo=ambiguo,
            opciones=opciones or [],
            estab_ms=estab_ms,
        )
        self._next_event_id += 1
        return ev
