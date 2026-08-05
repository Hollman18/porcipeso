"""/api/scale/connect — overrides de corrección de trama (toggle 🔁 del wizard).

reverse_frame (orden de caracteres) e invert_bits (polaridad eléctrica)
viajan en el body y deben llegar al ScaleProfile.extra que recibe el
driver, sin pisar el resto del extra del perfil.
"""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

import porcipeso.drivers.runner as runner_mod
from porcipeso.api.app import create_app


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    captured: dict = {}

    def fake_run_driver(profile, on_reading, stop):
        captured["profile"] = profile
        while not stop():
            time.sleep(0.01)

    monkeypatch.setattr(runner_mod, "run_driver", fake_run_driver)
    app = create_app(tmp_path / "api.db")
    with TestClient(app) as client:
        yield client, captured


def test_connect_pasa_reverse_frame_e_invert_bits_al_perfil(ctx):
    client, captured = ctx
    resp = client.post("/api/scale/connect", json={
        "profile_id": "matrix-adr00",
        "port": "COM3",
        "reverse_frame": True,
        "invert_bits": True,
    })
    assert resp.status_code == 200
    for _ in range(100):
        if "profile" in captured:
            break
        time.sleep(0.01)
    profile = captured["profile"]
    assert profile.extra.get("reverse_frame") is True
    assert profile.extra.get("invert_bits") is True
    assert profile.port == "COM3"
    # el extra original del catálogo no se pierde
    assert "notes" in profile.extra


def test_connect_sin_flags_no_toca_el_extra(ctx):
    client, captured = ctx
    resp = client.post("/api/scale/connect", json={
        "profile_id": "matrix-adr00",
        "port": "COM3",
    })
    assert resp.status_code == 200
    for _ in range(100):
        if "profile" in captured:
            break
        time.sleep(0.01)
    extra = captured["profile"].extra
    assert "reverse_frame" not in extra
    assert "invert_bits" not in extra
