"""Parsers de tramas de indicadores de peso (todas las marcas).

Cada parser implementa `porcipeso.core.interfaces.FrameParser`:
  - mantiene un buffer interno (tolera fragmentación arbitraria),
  - resincroniza ante basura entre tramas,
  - emite `Reading(ts_ms, kg, scale_id, stable_flag)` con ts_ms = time.time()*1000.

Registro: `PARSER_REGISTRY: dict[str, type[FrameParser]]` — la clave es la que
usa `ScaleProfile.parser` en drivers/profiles.yaml.

Decisión de unidades: `Reading.kg` está SIEMPRE en kg. Los protocolos que
reportan la unidad (SICS, Cardinal, SMA, A&D, Dini, NCI) se convierten de lb
a kg (× 0.45359237) cuando la trama dice lb.
"""
from __future__ import annotations

import re
import time

from porcipeso.core.interfaces import FrameParser
from porcipeso.core.models import Reading, ScaleProfile

_LB_TO_KG = 0.45359237
_MAX_BUFFER = 4096  # tope del buffer interno; ante desborde se conserva la cola


def _now_ms() -> int:
    return int(time.time() * 1000)


def _to_kg(value: float, unit: str | None) -> float:
    if unit and unit.strip().lower() in ("lb", "lbs"):
        return value * _LB_TO_KG
    return value


class _BufferedParser(FrameParser):
    """Base con buffer interno y fábrica de Reading."""

    def __init__(self, profile: ScaleProfile) -> None:
        super().__init__(profile)
        self._buf = bytearray()

    def push(self, data: bytes) -> list[Reading]:
        self._buf.extend(data)
        readings = self._extract()
        if len(self._buf) > _MAX_BUFFER:
            del self._buf[: len(self._buf) - 256]
        return readings

    def _extract(self) -> list[Reading]:  # pragma: no cover - abstracto
        raise NotImplementedError

    def _reading(self, kg: float, stable: bool | None = None) -> Reading:
        return Reading(ts_ms=_now_ms(), kg=kg,
                       scale_id=self.profile.id, stable_flag=stable)


def reverse_frame_active(profile: ScaleProfile, base: bool = False) -> bool:
    """¿Hay que invertir el ORDEN de los caracteres del contenido de la trama?

    ``extra.reverse_frame`` es el mecanismo GENERAL (la báscula manda
    "0.4321" cuando el peso es "1234.0", o "001" cuando es "100").
    Se combina por XOR con lo que el parser ya invierte de fábrica
    (``base`` = _forced_reversed del XK3190, o el ``extra.reversed``
    legado del Matrix Adr 99): activar reverse_frame sobre un parser que
    YA invierte vuelve al orden normal — es un toggle "encima" del
    default del perfil. Independiente de extra.invert_bits (polaridad
    eléctrica, runner.ingress): pueden coexistir.

    Punto único por lado: aquí a nivel parser (los límites de trama viven
    aquí) — espejo móvil en mobile/src/parsers.ts:reverseFrameActive().
    Aplica solo a tramas de TEXTO (matrix-style y protocolos por línea);
    los binarios (modbus, toledo) no tienen "orden de caracteres".
    """
    legacy = base or bool(profile.extra.get("reversed"))
    return legacy != bool(profile.extra.get("reverse_frame"))


class _LineParser(_BufferedParser):
    """Base para protocolos orientados a línea (CR, LF o CRLF)."""

    terminators: bytes = b"\r\n"

    def _extract(self) -> list[Reading]:
        out: list[Reading] = []
        term = set(self.terminators)
        # extra.reverse_frame: el contenido de CADA línea llega con los
        # caracteres al revés ("001" = 100) — se corrige aquí, en el punto
        # único por donde pasan TODOS los parsers de línea, antes de parsear.
        reverse = reverse_frame_active(self.profile)
        while True:
            idx = next((i for i, b in enumerate(self._buf) if b in term), -1)
            if idx < 0:
                break
            line = bytes(self._buf[:idx])
            del self._buf[: idx + 1]
            if not line.strip():
                continue
            reading = self._parse_line(line[::-1] if reverse else line)
            if reading is not None:
                out.append(reading)
        return out

    def _parse_line(self, line: bytes) -> Reading | None:  # pragma: no cover
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Lexus / Trumax Matrix — trama continua de 8 bytes: '=' + 7 chars de peso
# Adr 00: b'= 126.35' (normal).  Adr 99: dígitos invertidos, b'=53.621 '.
# ---------------------------------------------------------------------------
class MatrixParser(_BufferedParser):
    name = "matrix"
    _forced_reversed = False
    FRAME_LEN = 8

    def _is_reversed(self) -> bool:
        # reverse_frame (general) XOR reversed/forzado (legado del perfil):
        # ver reverse_frame_active().
        return reverse_frame_active(self.profile, self._forced_reversed)

    def _extract(self) -> list[Reading]:
        out: list[Reading] = []
        while True:
            start = self._buf.find(b"=")
            if start < 0:
                self._buf.clear()
                break
            if start:
                del self._buf[:start]
            if len(self._buf) < self.FRAME_LEN:
                break
            payload = bytes(self._buf[1:self.FRAME_LEN]).decode("ascii", "replace")
            text = payload.strip()
            if self._is_reversed():
                text = text[::-1]
            try:
                kg = float(text)
            except ValueError:
                del self._buf[:1]  # basura tras '=': resincronizar
                continue
            del self._buf[:self.FRAME_LEN]
            out.append(self._reading(kg))
        return out


# ---------------------------------------------------------------------------
# Yaohua XK3190-A12E / A9 / A27 — stream ASCII continuo: '=' + 7 chars con el
# peso invertido (display 0126.35 -> b'=53.6210'). Paridad la maneja el
# transporte serial (típicamente E).
# ---------------------------------------------------------------------------
class Xk3190A12eParser(MatrixParser):
    name = "xk3190_a12e"
    _forced_reversed = True


# ---------------------------------------------------------------------------
# GMT Tuxon S — líneas ASCII con el peso decimal. Patrón configurable con
# extra.pattern (grupo 1 = peso); por defecto captura el primer número.
# ---------------------------------------------------------------------------
class TuxonAsciiParser(_LineParser):
    name = "tuxon_ascii"
    DEFAULT_PATTERN = r"([-+]?\d+\.?\d*)"

    def __init__(self, profile: ScaleProfile) -> None:
        super().__init__(profile)
        self._re = re.compile(profile.extra.get("pattern", self.DEFAULT_PATTERN))
        term = profile.extra.get("line_terminator")
        if term:
            self.terminators = term.encode("ascii") if isinstance(term, str) else term

    def _parse_line(self, line: bytes) -> Reading | None:
        m = self._re.search(line.decode("ascii", "replace"))
        if not m:
            return None
        try:
            kg = float(m.group(1))
        except ValueError:
            return None
        return self._reading(kg)


# ---------------------------------------------------------------------------
# Genérico regex — extra.pattern (grupo 1 = peso), extra.line_terminator
# opcional. Misma mecánica que tuxon_ascii; clave separada para el catálogo.
# ---------------------------------------------------------------------------
class GenericRegexParser(TuxonAsciiParser):
    name = "generic_regex"


# ---------------------------------------------------------------------------
# Modbus RTU — respuesta a Read Holding Registers (función 0x03) con CRC16.
# extra: slave_addr (opcional), register (índice del registro, def. 0),
#        word_count (1|2, def. 1), signed (def. True), scale_divisor (def. 1).
# ---------------------------------------------------------------------------
def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc


class ModbusRtuParser(_BufferedParser):
    name = "modbus_rtu"

    def _extract(self) -> list[Reading]:
        out: list[Reading] = []
        slave = self.profile.extra.get("slave_addr")
        while len(self._buf) >= 5:
            addr, func, count = self._buf[0], self._buf[1], self._buf[2]
            plausible = (func == 0x03 and count and count % 2 == 0 and count <= 250
                         and (slave is None or addr == slave))
            if plausible:
                total = 3 + count + 2
                if len(self._buf) < total:
                    break  # trama incompleta: esperar más bytes
                frame = bytes(self._buf[:total])
                crc_rx = frame[-2] | (frame[-1] << 8)
                if crc16_modbus(frame[:-2]) == crc_rx:
                    del self._buf[:total]
                    reading = self._decode(frame[3:3 + count])
                    if reading is not None:
                        out.append(reading)
                    continue
            del self._buf[:1]  # basura: resincronizar byte a byte
        return out

    def _decode(self, data: bytes) -> Reading | None:
        extra = self.profile.extra
        idx = int(extra.get("register", 0))
        words = int(extra.get("word_count", 1))
        raw_bytes = data[idx * 2: idx * 2 + words * 2]
        if len(raw_bytes) != words * 2:
            return None
        raw = int.from_bytes(raw_bytes, "big",
                             signed=bool(extra.get("signed", True)))
        divisor = float(extra.get("scale_divisor", 1)) or 1.0
        return self._reading(raw / divisor)


# ---------------------------------------------------------------------------
# Mettler-Toledo MT-SICS — respuestas 'S S     123.45 kg' (estable) /
# 'S D     123.45 kg' (dinámico), CRLF-terminadas.
# ---------------------------------------------------------------------------
class SicsParser(_LineParser):
    name = "sics"
    _RE = re.compile(r"^S\s+([SD])\s+([-+]?\d+(?:\.\d+)?)\s*(\S+)?")

    def _parse_line(self, line: bytes) -> Reading | None:
        m = self._RE.match(line.decode("ascii", "replace").strip())
        if not m:
            return None
        kg = _to_kg(float(m.group(2)), m.group(3))
        return self._reading(kg, stable=m.group(1) == "S")


# ---------------------------------------------------------------------------
# Toledo continuo — STX + 3 status bytes + 6 dígitos peso + 6 dígitos tara +
# CR (17 bytes). SWA bits 0-2 = posición del punto decimal; SWB bit1 = signo,
# bit3 = movimiento.
# ---------------------------------------------------------------------------
class ToledoContParser(_BufferedParser):
    name = "toledo_cont"
    FRAME_LEN = 17
    _FACTORS = {0: 100.0, 1: 10.0, 2: 1.0, 3: 0.1,
                4: 0.01, 5: 0.001, 6: 0.0001, 7: 0.00001}

    def _extract(self) -> list[Reading]:
        out: list[Reading] = []
        while True:
            start = self._buf.find(b"\x02")
            if start < 0:
                self._buf.clear()
                break
            if start:
                del self._buf[:start]
            if len(self._buf) < self.FRAME_LEN:
                break
            frame = bytes(self._buf[:self.FRAME_LEN])
            if frame[16] != 0x0D or not frame[4:16].isdigit():
                del self._buf[:1]
                continue
            swa, swb = frame[1], frame[2]
            kg = int(frame[4:10]) * self._FACTORS[swa & 0x07]
            if swb & 0x02:
                kg = -kg
            stable = not (swb & 0x08)
            del self._buf[:self.FRAME_LEN]
            out.append(self._reading(kg, stable))
        return out


# ---------------------------------------------------------------------------
# Cardinal 738 (y 205) — líneas CR-terminadas: peso + unidad + estado G/N.
# Ej.: b' 126.35 kg G\r'. Sin bandera de estabilidad en la trama.
# ---------------------------------------------------------------------------
class Cardinal738Parser(_LineParser):
    name = "cardinal_738"
    _RE = re.compile(
        r"([-+]?\d+\.?\d*)\s*(kg|lb|KG|LB|Kg|Lb)?\s*([GNgn])?", re.ASCII)

    def _parse_line(self, line: bytes) -> Reading | None:
        m = self._RE.search(line.decode("ascii", "replace"))
        if not m or not m.group(1):
            return None
        try:
            kg = _to_kg(float(m.group(1)), m.group(2))
        except ValueError:
            return None
        return self._reading(kg)


# ---------------------------------------------------------------------------
# SMA (Scale Manufacturers Association) — líneas con status Z/M/S y peso.
# Z = centro de cero, S = estable, M = en movimiento.
# ---------------------------------------------------------------------------
class SmaParser(_LineParser):
    name = "sma"
    _RE = re.compile(r"^\s*([ZMS])\s+([-+]?\d+(?:\.\d+)?)\s*(\S+)?")

    def _parse_line(self, line: bytes) -> Reading | None:
        m = self._RE.match(line.decode("ascii", "replace"))
        if not m:
            return None
        status = m.group(1)
        kg = _to_kg(float(m.group(2)), m.group(3))
        return self._reading(kg, stable=status in ("Z", "S"))


# ---------------------------------------------------------------------------
# A&D stream (FS / HW / HV) — 'ST,+00123.4  kg' estable, 'US,…' inestable,
# 'OL,…' sobrecarga (descartada). CRLF-terminado.
# ---------------------------------------------------------------------------
class AndStreamParser(_LineParser):
    name = "and_stream"
    _RE = re.compile(r"^(ST|US|WT|QT|OL)\s*,\s*([-+]?[0-9.]+)\s*(\S+)?")

    def _parse_line(self, line: bytes) -> Reading | None:
        m = self._RE.match(line.decode("ascii", "replace").strip())
        if not m or m.group(1) == "OL":
            return None
        try:
            kg = _to_kg(float(m.group(2)), m.group(3))
        except ValueError:
            return None
        stable = {"ST": True, "US": False}.get(m.group(1))
        return self._reading(kg, stable)


# ---------------------------------------------------------------------------
# Dini Argeo (DFW/DGT, formato REPE/estándar) — 'ST,GS,   123.45,kg' CRLF.
# Campo 1: ST/US; campo 2: GS/NT (bruto/neto); campo 3: peso; campo 4: unidad.
# ---------------------------------------------------------------------------
class DiniArgeoParser(_LineParser):
    name = "dini_argeo"

    def _parse_line(self, line: bytes) -> Reading | None:
        parts = [p.strip() for p in line.decode("ascii", "replace").split(",")]
        if len(parts) < 3 or parts[0] not in ("ST", "US"):
            return None
        try:
            value = float(parts[2])
        except ValueError:
            return None
        unit = parts[3] if len(parts) > 3 else None
        return self._reading(_to_kg(value, unit), stable=parts[0] == "ST")


# ---------------------------------------------------------------------------
# Rinstrum R320 — formato automático A: STX + signo + peso(7) + status + ETX.
# Status: G/N (bruto/neto, estable), M (movimiento), U/O/E (otros).
# ---------------------------------------------------------------------------
class RinstrumR320Parser(_BufferedParser):
    name = "rinstrum_r320"
    _RE = re.compile(r"([-+]?)\s*(\d+\.?\d*)")

    def _extract(self) -> list[Reading]:
        out: list[Reading] = []
        while True:
            start = self._buf.find(b"\x02")
            if start < 0:
                self._buf.clear()
                break
            if start:
                del self._buf[:start]
            end = self._buf.find(b"\x03", 1)
            if end < 0:
                break
            body = bytes(self._buf[1:end]).decode("ascii", "replace")
            del self._buf[: end + 1]
            m = self._RE.search(body)
            if not m:
                continue
            kg = float((m.group(1) or "") + m.group(2))
            status = body[-1] if body and body[-1].isalpha() else ""
            stable = (False if status == "M"
                      else True if status in ("G", "N") else None)
            out.append(self._reading(kg, stable))
        return out


# ---------------------------------------------------------------------------
# Avery / NCI 3835 (SCP-01) — respuesta: LF + peso + CR, LF + status + CR, ETX.
# Status char 1 = 0x30 | bits (bit0 = en movimiento). El peso trae punto
# decimal; la línea de status son chars 0x30-0x3F.
# ---------------------------------------------------------------------------
class NciParser(_LineParser):
    name = "nci"
    terminators = b"\r\n\x03"
    _W_RE = re.compile(r"([-+]?\d+\.\d+)\s*(\S+)?")

    def __init__(self, profile: ScaleProfile) -> None:
        super().__init__(profile)
        self._pending_kg: float | None = None

    def _extract(self) -> list[Reading]:
        out: list[Reading] = []
        term = set(self.terminators)
        while True:
            idx = next((i for i, b in enumerate(self._buf) if b in term), -1)
            if idx < 0:
                break
            line = bytes(self._buf[:idx]).strip()
            del self._buf[: idx + 1]
            if not line:
                continue
            text = line.decode("ascii", "replace")
            if self._pending_kg is not None and self._is_status(text):
                bits = ord(text[0]) - 0x30
                out.append(self._reading(self._pending_kg,
                                         stable=not (bits & 0x01)))
                self._pending_kg = None
                continue
            m = self._W_RE.search(text)
            if m:
                if self._pending_kg is not None:
                    # llegó otro peso sin status: emitir el anterior sin bandera
                    out.append(self._reading(self._pending_kg, stable=None))
                self._pending_kg = _to_kg(float(m.group(1)), m.group(2))
        return out

    @staticmethod
    def _is_status(text: str) -> bool:
        return 1 <= len(text) <= 4 and all(0x30 <= ord(c) <= 0x3F for c in text)


PARSER_REGISTRY: dict[str, type[FrameParser]] = {
    cls.name: cls
    for cls in (
        MatrixParser,
        Xk3190A12eParser,
        TuxonAsciiParser,
        ModbusRtuParser,
        SicsParser,
        ToledoContParser,
        Cardinal738Parser,
        SmaParser,
        AndStreamParser,
        DiniArgeoParser,
        RinstrumR320Parser,
        NciParser,
        GenericRegexParser,
    )
}
