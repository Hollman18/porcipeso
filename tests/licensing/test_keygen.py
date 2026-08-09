"""Tests de la ACTIVACIÓN POR DISPOSITIVO (lado del dueño + paridad con la app).

Cubre:
  - Formato del código de dispositivo y de la llave.
  - Validación: la llave correcta valida; una incorrecta no; la llave de OTRO
    deviceId no valida en este (atado al equipo).
  - Normalización tolerante (mayúsc/minúsc, espacios, prefijo, O/I/L confundidos).
  - PARIDAD py<->js: para los MISMOS device_id, keygen.py y el núcleo JS
    (porcipeso/licensing/reference.js, el mismo que corre en app.js y
    emitir_llave.html) producen el MISMO device_code y la MISMA activation_key.
    Si `node` no está instalado, esa prueba se salta.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from porcipeso.licensing import keygen as k

# Vectores COMPARTIDos que alimentan tanto a Python como a JS (node).
VECTORS = [
    "11111111-2222-3333-4444-555555555555",
    "d3adb33f-0000-4000-8000-000000000000",
    "abc",
    "",
    "device-ñ-áé-🐷-unicode",
    "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    "otro-telefono-cualquiera-987654321",
]

_REFERENCE_JS = Path(k.__file__).with_name("reference.js")


# ------------------------------------------------------------------- formatos

@pytest.mark.parametrize("device_id", VECTORS)
def test_device_code_formato(device_id):
    code = k.device_code(device_id)
    assert re.fullmatch(r"PORCI-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}", code), code


@pytest.mark.parametrize("device_id", VECTORS)
def test_activation_key_formato(device_id):
    key = k.activation_key(device_id)
    assert re.fullmatch(r"([0-9A-HJ-NP-TV-Z]{4}-){3}[0-9A-HJ-NP-TV-Z]{4}", key), key


def test_alfabeto_sin_caracteres_ambiguos():
    # ni el código ni la llave usan I, L, O, U (se confunden al dictar)
    for d in VECTORS:
        for s in (k.device_code(d), k.activation_key(d)):
            assert not (set("ILOU") & set(s.replace("PORCI", "").replace("-", "")))


def test_determinista():
    d = VECTORS[0]
    assert k.device_code(d) == k.device_code(d)
    assert k.activation_key(d) == k.activation_key(d)


# ---------------------------------------------------------------- validación

@pytest.mark.parametrize("device_id", VECTORS)
def test_llave_correcta_valida(device_id):
    assert k.verify_key(device_id, k.activation_key(device_id)) is True


def test_llave_incorrecta_no_valida():
    d = VECTORS[0]
    assert k.verify_key(d, "AAAA-AAAA-AAAA-AAAA") is False
    assert k.verify_key(d, "") is False
    assert k.verify_key(d, "no-es-una-llave") is False


def test_llave_de_otro_dispositivo_no_valida():
    d1, d2 = VECTORS[0], VECTORS[1]
    llave_d2 = k.activation_key(d2)
    assert k.verify_key(d2, llave_d2) is True     # sí en su equipo
    assert k.verify_key(d1, llave_d2) is False    # no en otro equipo


def test_activation_key_from_code_equivale_a_activation_key():
    for d in VECTORS:
        code = k.device_code(d)
        assert k.activation_key_from_code(code) == k.activation_key(d)


# --------------------------------------------------------------- normalización

def test_normalize_device_code_tolerante():
    canon = k.device_code(VECTORS[0])          # p.ej. "PORCI-CSQZ-DK5A"
    payload = canon.replace("PORCI-", "").replace("-", "")
    variantes = [
        canon,
        canon.lower(),
        f"  {canon}  ",
        f"porci {payload[:4]} {payload[4:]}",
        payload,                                # sin prefijo ni guiones
    ]
    for v in variantes:
        assert k.normalize_device_code(v) == canon, v


def test_normalize_key_corrige_ambiguos_y_valida():
    d = VECTORS[0]
    llave = k.activation_key(d)
    # el cliente escribe en minúsculas y sin guiones -> igual valida
    assert k.verify_key(d, llave.lower().replace("-", "")) is True
    # y si confunde O->0 / I/L->1 al teclear, se corrige
    ofuscada = llave.replace("0", "O").replace("1", "I")
    assert k.verify_key(d, ofuscada) is True


# ------------------------------------------------------------ paridad py <-> js

@pytest.mark.skipif(shutil.which("node") is None, reason="node no instalado")
def test_paridad_python_vs_js_node():
    """Mismos device_id -> mismo device_code y misma activation_key en py y js."""
    proc = subprocess.run(
        ["node", str(_REFERENCE_JS), *VECTORS],
        capture_output=True, text=True, timeout=30, check=True,
    )
    js = {r["device_id"]: r for r in json.loads(proc.stdout)}
    for d in VECTORS:
        assert js[d]["device_code"] == k.device_code(d), d
        assert js[d]["activation_key"] == k.activation_key(d), d
