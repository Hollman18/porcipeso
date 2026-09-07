"""Modelos compartidos de PorciPeso.

CONTRATO CONGELADO: los módulos drivers/engine/db/api/ui/sim codifican contra
estas formas exactas. No renombrar campos sin actualizar el plan.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class EventType(str, Enum):
    REFERENCIA = "referencia"
    SUBIDA = "subida"
    BAJADA = "bajada"
    REINGRESO = "reingreso"
    AJUSTE = "ajuste"


class EngineState(str, Enum):
    IDLE = "idle"          # sin sesión abierta
    ESTABLE = "estable"
    MOVIMIENTO = "movimiento"
    SIN_SENAL = "sin_senal"


@dataclass
class Reading:
    """Una lectura normalizada del indicador (cualquier marca)."""
    ts_ms: int
    kg: float
    scale_id: str = "default"
    stable_flag: Optional[bool] = None  # solo si el protocolo lo trae (SICS, SMA…)
    # String CRUDO del peso tal como lo muestra el indicador físico
    # (ej. "-7143.0"): sin locale, sin separador de miles. Lo llenan los
    # parsers de texto (con reverse_frame ya CORREGIDO: es lo que el display
    # muestra, no los bytes al revés). None en fuentes sin token textual
    # (sim, binarios sin reconstrucción) → la UI degrada a formato plano.
    raw: Optional[str] = None


@dataclass
class WeighEvent:
    """Un escalón estable detectado (o ajuste manual)."""
    id: Optional[int]
    session_id: int
    ts_ms: int
    peso_antes: float
    peso_despues: float
    delta_kg: float
    animales_estimados: int
    tipo: EventType
    ambiguo: bool = False
    opciones: list[int] = field(default_factory=list)  # candidatos si ambiguo
    animales_confirmados: Optional[int] = None
    estab_ms: int = 0
    motivo_bajada: Optional[str] = None
    confirmado_por: Optional[str] = None


@dataclass
class EngineConfig:
    window_readings: int = 20        # legado: mínimo de lecturas informativo;
    #: la estabilidad la gobierna min_stable_ms (por TIEMPO), no este conteo.
    stability_range_kg: float = 2.0  # max-min tolerado dentro de una meseta
    min_delta_kg: float = 40.0       # escalón mínimo para contar cerdos (lote)
    #: peso mínimo (kg) para CAPTURAR la referencia del cerdo de prueba —
    #: antes se exigían 40 kg y no tomaba pesos pequeños; ahora desde 1 kg
    #: apenas la báscula se estabiliza. Separado del umbral de conteo.
    min_ref_kg: float = 1.0
    tolerance: float = 0.20          # residuo máximo antes de marcar ambiguo
    no_signal_after_s: float = 3.0   # watchdog SIN_SENAL
    #: TIEMPO mínimo (ms) que un peso debe sostenerse ESTABLE para registrarse.
    #: Independiente de la velocidad del indicador (a 3 Hz o a 20 Hz da igual):
    #: filtra rebotes y cerdos que pasan de largo sin quedarse en la plataforma.
    min_stable_ms: float = 2000.0
    #: MODO UNIDADES — exigir que la plataforma vuelva a ~vacío entre cerdos.
    #: True (por defecto): un cerdo montado encima de otro NO se cuenta hasta
    #: que baje el primero (evita el doble pesaje del mismo cerdo que se
    #: reacomoda). False: comportamiento legado de apilado (cuenta la diferencia).
    unit_return_to_zero: bool = True
    #: MODO UNIDADES — banda de plausibilidad alrededor del promedio, una vez
    #: hay al menos min_animals_for_band cerdos que fijan un promedio confiable.
    #: Un nivel cuenta como 1 cerdo solo si cae en [avg*band_low, avg*band_high].
    #: Por debajo → no cuenta (cerdo a medio subir / objeto). Por encima →
    #: AMBIGUO: el operario confirma 1 o 2 (posible doble).
    band_low: float = 0.65
    band_high: float = 1.50
    min_animals_for_band: int = 3


@dataclass
class EngineSnapshot:
    state: EngineState
    kg_now: float
    ref_kg: Optional[float]
    avg_kg: Optional[float]
    count: int
    total_kg: float
    pending: int                     # eventos ambiguos sin confirmar
    # Fase del pesaje (v2, flujo cerdo de prueba):
    #   calibracion    → esperando que suba el cerdo de prueba (solo)
    #   bajar_prueba   → referencia capturada (peak estable); esperando que se baje
    #   lote           → plataforma vacía de nuevo; "sube todo el lote"
    fase: str = "lote"


@dataclass
class ScaleProfile:
    """Perfil de conexión + trama de un indicador. Catálogo en drivers/profiles.yaml."""
    id: str                          # ej. "matrix-normal"
    name: str                        # ej. "Lexus/Trumax Matrix (Adr 00)"
    brand: str
    parser: str                      # clave del parser registrado en drivers
    transport: str = "serial"        # serial | tcp | sim
    port: Optional[str] = None       # /dev/ttyUSB0, COM3…
    baudrate: int = 9600
    bytesize: int = 8
    parity: str = "N"                # N | E | O
    stopbits: int = 1
    host: Optional[str] = None       # transporte tcp
    tcp_port: Optional[int] = None
    extra: dict[str, Any] = field(default_factory=dict)  # regex, registro modbus, etc.
