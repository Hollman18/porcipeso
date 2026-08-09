"""Helper de e2e: pre-activa la app antes de navegar.

Desde v2.6.0 la ACTIVACIÓN POR DISPOSITIVO es el gate PRINCIPAL: sin una licencia
válida, la app queda bloqueada. Los tests e2e que ejercitan el resto de la UI
(conexión, pesaje, candado de contraseña…) deben abrir la app ya activada.

`PREACTIVATE_JS` siembra en localStorage un deviceId fijo y su licencia válida
(llave calculada con el MISMO algoritmo de la app, vía porcipeso.licensing). Se
inyecta con `page.add_init_script(...)`, que corre en cada navegación ANTES del
script del <head>, así el gate ve la app como activada.
"""
from __future__ import annotations

import json

from porcipeso.licensing import keygen

# deviceId fijo para las pruebas (la app lo respeta si ya está en localStorage).
DEVICE_ID = "e2e-fixed-device-0001"
ACTIVATION_KEY = keygen.activation_key(DEVICE_ID)
DEVICE_CODE = keygen.device_code(DEVICE_ID)

_LICENSE = json.dumps({"deviceId": DEVICE_ID, "key": ACTIVATION_KEY, "activated_at": 0})

PREACTIVATE_JS = (
    "try{"
    f"localStorage.setItem('porcipeso_device', {json.dumps(DEVICE_ID)});"
    f"localStorage.setItem('porcipeso_license', {json.dumps(_LICENSE)});"
    "}catch(e){}"
)
