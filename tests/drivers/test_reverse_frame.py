"""extra.reverse_frame — orden de caracteres del contenido de la trama al revés.

Es INDEPENDIENTE de extra.invert_bits (polaridad eléctrica) y combinable
con él; con el `extra.reversed` legado del Matrix / el forzado del XK3190
se combina por XOR (toggle encima del default del perfil).
"""
from __future__ import annotations

import pytest

from porcipeso.core.models import ScaleProfile
from porcipeso.drivers.parsers import (
    GenericRegexParser,
    MatrixParser,
    TuxonAsciiParser,
    Xk3190A12eParser,
    reverse_frame_active,
)
from porcipeso.drivers.runner import invert_bytes, ingress


def profile(parser: str, extra: dict | None = None) -> ScaleProfile:
    return ScaleProfile(id="t", name="T", brand="T", parser=parser,
                        transport="serial", extra=extra or {})


def test_reverse_frame_active_es_xor_con_lo_legado():
    assert reverse_frame_active(profile("x")) is False
    assert reverse_frame_active(profile("x", {"reverse_frame": True})) is True
    assert reverse_frame_active(profile("x", {"reversed": True})) is True
    # reverse_frame sobre un perfil que YA invierte → vuelve al orden normal
    assert reverse_frame_active(
        profile("x", {"reversed": True, "reverse_frame": True})) is False
    assert reverse_frame_active(profile("x"), base=True) is True
    assert reverse_frame_active(
        profile("x", {"reverse_frame": True}), base=True) is False


def test_matrix_reverse_frame_decimal_en_otra_posicion():
    # la báscula manda '= 0.4321' pero el peso real es 1234.0: la reversa
    # de la cadena completa respeta sola el punto decimal
    p = MatrixParser(profile("matrix", {"reverse_frame": True}))
    (r,) = p.push(b"= 0.4321")
    assert r.kg == pytest.approx(1234.0)


def test_matrix_estilo_adr99_via_reverse_frame_general():
    # el clásico Adr 99 ('=53.621 ' = 126.35) por el mecanismo nuevo
    p = MatrixParser(profile("matrix", {"reverse_frame": True}))
    (r,) = p.push(b"=53.621 ")
    assert r.kg == pytest.approx(126.35)


def test_xk3190_forzado_xor_reverse_frame_vuelve_a_normal():
    # XK3190 invierte de fábrica; si el stream llega en orden normal,
    # reverse_frame lo corrige (XOR) en vez de invertir dos veces
    p = Xk3190A12eParser(profile("xk3190_a12e", {"reverse_frame": True}))
    (r,) = p.push(b"= 126.35")
    assert r.kg == pytest.approx(126.35)


def test_linea_ceros_a_la_izquierda_001_es_100():
    p = TuxonAsciiParser(profile("tuxon_ascii", {"reverse_frame": True}))
    (r,) = p.push(b"001\r\n")
    assert r.kg == pytest.approx(100.0)


def test_linea_generic_regex_reversa_de_linea_completa():
    p = GenericRegexParser(profile("generic_regex", {"reverse_frame": True}))
    (r,) = p.push(b"0.4321\r\n")
    assert r.kg == pytest.approx(1234.0)


def test_sin_flag_no_cambia_nada():
    p = TuxonAsciiParser(profile("tuxon_ascii"))
    (r,) = p.push(b"  126.35\r\n")
    assert r.kg == pytest.approx(126.35)


def test_coexiste_con_invert_bits():
    # el cable llega con la POLARIDAD invertida Y los caracteres al revés:
    # ingress() corrige los bits (runner) y el parser corrige el orden
    prof = profile("tuxon_ascii", {"invert_bits": True, "reverse_frame": True})
    cable = invert_bytes(b"0.4321\r\n")
    p = TuxonAsciiParser(prof)
    (r,) = p.push(ingress(prof, cable))
    assert r.kg == pytest.approx(1234.0)
