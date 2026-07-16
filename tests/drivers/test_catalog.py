"""Tests del catálogo profiles.yaml."""
from __future__ import annotations

import pytest

from porcipeso.core.models import ScaleProfile
from porcipeso.drivers.catalog import get_profile, load_profiles
from porcipeso.drivers.parsers import PARSER_REGISTRY


def test_loads_at_least_20_profiles():
    profiles = load_profiles()
    assert len(profiles) >= 20
    assert all(isinstance(p, ScaleProfile) for p in profiles)


def test_ids_unique():
    ids = [p.id for p in load_profiles()]
    assert len(ids) == len(set(ids))


def test_all_parsers_exist_in_registry():
    for p in load_profiles():
        assert p.parser in PARSER_REGISTRY, f"{p.id}: parser {p.parser!r} no registrado"


def test_every_registry_key_used_by_some_profile():
    used = {p.parser for p in load_profiles()}
    assert used == set(PARSER_REGISTRY), (
        "parsers sin perfil en el catálogo: "
        f"{set(PARSER_REGISTRY) - used}")


def test_profiles_have_metadata():
    for p in load_profiles():
        assert p.name and p.brand
        assert p.transport in ("serial", "tcp", "sim")
        assert "notes" in p.extra, f"{p.id}: falta extra.notes"
        if p.transport == "serial":
            assert p.parity in ("N", "E", "O")
            assert p.bytesize in (7, 8)


def test_expected_commercial_ids_present():
    ids = {p.id for p in load_profiles()}
    expected = {
        "matrix-adr00", "matrix-adr99", "yaohua-xk3190-a12e",
        "yaohua-xk3190-a9", "yaohua-xk3190-a27", "gmt-tuxon-s-ascii",
        "gmt-tuxon-s-modbus", "rhino-iqy", "tscale-qw", "ricelake-380",
        "ricelake-480", "cardinal-205", "cardinal-738", "mt-ind-sics",
        "mt-toledo-continuo", "ohaus-defender-sics", "and-fs-hw",
        "dini-argeo-dfw", "rinstrum-r320", "sensocar-sca31",
        "avery-zm201-nci", "prometalicos-generic", "generic-serial-regex",
        "generic-tcp", "generic-sma",
    }
    assert expected <= ids


def test_matrix_adr99_reversed_flag():
    assert get_profile("matrix-adr99").extra.get("reversed") is True
    assert not get_profile("matrix-adr00").extra.get("reversed")


def test_get_profile_overrides():
    p = get_profile("matrix-adr00", port="/dev/ttyUSB7")
    assert p.port == "/dev/ttyUSB7"
    t = get_profile("generic-tcp", host="10.0.0.5", tcp_port=4001)
    assert t.host == "10.0.0.5"
    assert t.tcp_port == 4001


def test_get_profile_unknown_raises():
    with pytest.raises(KeyError):
        get_profile("no-existe")
