"""Reading.raw — el string CRUDO del peso, fiel a lo que MUESTRA el indicador.

Regla (evidencia de campo): si el indicador transmite "-7143.0" el LED de la
app debe mostrar "-7143.0" — sin locale, sin separador de miles. Cada parser
llena `raw` con el token del peso tal como lo muestra el display físico:
  - texto (matrix, líneas, regex): el token transmitido, con reverse_frame
    ya CORREGIDO (el raw es el legible, ej. "1234.0", NO "0.4321");
  - binarios (modbus, toledo): reconstrucción sin artefactos de float.
"""
from __future__ import annotations

import pytest

from porcipeso.core.models import Reading, ScaleProfile
from porcipeso.drivers.parsers import PARSER_REGISTRY, MatrixParser


def feed(parser, *chunks: bytes) -> list[Reading]:
    out: list[Reading] = []
    for chunk in chunks:
        out.extend(parser.push(chunk))
    return out


def make(make_profile, key: str, **extra):
    return PARSER_REGISTRY[key](make_profile(key, **extra))


def crc16(data: bytes) -> bytes:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return bytes([crc & 0xFF, crc >> 8])


def test_reading_default_raw_none():
    # contrato: campo opcional agregado, nada existente cambia
    r = Reading(ts_ms=0, kg=1.0)
    assert r.raw is None


# ------------------------------------------------------------------ matrix
def test_matrix_caso_de_campo_menos_7143():
    # el video del cliente: indicador muestra -7143.0 → raw idéntico
    p = MatrixParser(ScaleProfile(id="t", name="T", brand="T",
                                  parser="matrix", extra={}))
    (r,) = p.push(b"=-7143.0")
    assert r.kg == pytest.approx(-7143.0)
    assert r.raw == "-7143.0"


def test_matrix_normal(make_profile):
    (r,) = feed(make(make_profile, "matrix"), b"= 126.35")
    assert r.raw == "126.35"


def test_matrix_adr99_reversed_raw_corregido(make_profile):
    # la trama llega al revés, pero raw es lo que el display MUESTRA
    (r,) = feed(make(make_profile, "matrix", reversed=True), b"=53.621 ")
    assert r.kg == pytest.approx(126.35)
    assert r.raw == "126.35"


def test_matrix_reverse_frame_raw_corregido(make_profile):
    # reverse_frame general: manda "0.4321", el display muestra "1234.0"
    (r,) = feed(make(make_profile, "matrix", reverse_frame=True), b"= 0.4321")
    assert r.kg == pytest.approx(1234.0)
    assert r.raw == "1234.0"


def test_xk3190_raw_corregido(make_profile):
    (r,) = feed(make(make_profile, "xk3190_a12e"), b"=53.6210")
    assert r.kg == pytest.approx(126.35)
    assert r.raw == "0126.35"  # tal cual el display del XK3190


# ------------------------------------------------------- líneas de texto
def test_tuxon_ascii_raw(make_profile):
    (r,) = feed(make(make_profile, "tuxon_ascii"), b"  126.35 kg\r\n")
    assert r.raw == "126.35"


def test_generic_regex_raw(make_profile):
    (r,) = feed(make(make_profile, "generic_regex"), b"-7143.0\r\n")
    assert r.raw == "-7143.0"


def test_generic_regex_reverse_frame_raw_corregido(make_profile):
    (r,) = feed(make(make_profile, "generic_regex", reverse_frame=True),
                b"001\r\n")
    assert r.kg == pytest.approx(100.0)
    assert r.raw == "100"


def test_sics_raw_es_el_token_transmitido(make_profile):
    (r,) = feed(make(make_profile, "sics"), b"S S     -7143.0 kg\r\n")
    assert r.raw == "-7143.0"


def test_sics_lb_raw_sin_convertir(make_profile):
    # kg se convierte, pero el display físico muestra el número en lb
    (r,) = feed(make(make_profile, "sics"), b"S S     278.55 lb\r\n")
    assert r.kg == pytest.approx(278.55 * 0.45359237)
    assert r.raw == "278.55"


def test_cardinal_raw(make_profile):
    (r,) = feed(make(make_profile, "cardinal_738"), b" -10.50 kg N\r")
    assert r.raw == "-10.50"


def test_sma_raw(make_profile):
    (r,) = feed(make(make_profile, "sma"), b"\nS      126.35 kg\r")
    assert r.raw == "126.35"


def test_and_stream_raw_token_verbatim(make_profile):
    (r,) = feed(make(make_profile, "and_stream"), b"ST,+00126.35  kg\r\n")
    assert r.raw == "+00126.35"


def test_dini_argeo_raw(make_profile):
    (r,) = feed(make(make_profile, "dini_argeo"), b"ST,GS,   126.35,kg\r\n")
    assert r.raw == "126.35"


def test_rinstrum_raw_con_signo(make_profile):
    (r,) = feed(make(make_profile, "rinstrum_r320"), b"\x02-0012.50N\x03")
    assert r.raw == "-0012.50"


def test_nci_raw(make_profile):
    (r,) = feed(make(make_profile, "nci"), b"\n   126.35 kg\r\n20\r\x03")
    assert r.raw == "126.35"


def test_nci_raw_peso_sin_status(make_profile):
    # dos pesos seguidos sin status: el primero se emite con SU raw
    rs = feed(make(make_profile, "nci"),
              b"\n   126.35 kg\r\n   127.44 kg\r\n00\r\x03")
    assert [r.raw for r in rs] == ["126.35", "127.44"]


# ------------------------------------------------------------- binarios
def test_modbus_raw_reconstruido_sin_locale(make_profile):
    body = bytes([1, 0x03, 0x02]) + (1265).to_bytes(2, "big", signed=True)
    p = make(make_profile, "modbus_rtu", slave_addr=1, scale_divisor=10)
    (r,) = feed(p, body + crc16(body))
    assert r.kg == pytest.approx(126.5)
    assert r.raw == "126.5"


def test_modbus_raw_negativo(make_profile):
    # -7143.0 con divisor 10 necesita 2 words (fuera de rango int16)
    body = bytes([1, 0x03, 0x04]) + (-71430).to_bytes(4, "big", signed=True)
    p = make(make_profile, "modbus_rtu", slave_addr=1, word_count=2,
             scale_divisor=10)
    (r,) = feed(p, body + crc16(body))
    assert r.kg == pytest.approx(-7143.0)
    assert r.raw == "-7143.0"


def _toledo_frame(weight: str, swa: int = 0x2C, swb: int = 0x20) -> bytes:
    return b"\x02" + bytes([swa, swb, 0x20]) + weight.encode() + \
        b"000000" + b"\r"


def test_toledo_raw_dos_decimales(make_profile):
    p = make(make_profile, "toledo_cont")
    (r,) = feed(p, _toledo_frame("012635"))
    assert r.kg == pytest.approx(126.35)
    assert r.raw == "126.35"  # sin ceros a la izquierda, como el display


def test_toledo_raw_negativo_un_decimal(make_profile):
    p = make(make_profile, "toledo_cont")
    (r,) = feed(p, _toledo_frame("071430", swa=0x2B, swb=0x22))  # bits=3 → 1 dec
    assert r.kg == pytest.approx(-7143.0)
    assert r.raw == "-7143.0"


def test_toledo_raw_multiplicador_x100_sin_float(make_profile):
    p = make(make_profile, "toledo_cont")
    (r,) = feed(p, _toledo_frame("012635", swa=0x28))  # bits=0 → ×100
    assert r.kg == pytest.approx(1263500.0)
    assert r.raw == "1263500"  # reconstrucción decimal, sin ".0" de float
