"""Activación por dispositivo de PorciPeso (licencia offline atada a un equipo).

Este paquete es la herramienta del DUEÑO (Hollman) para emitir llaves de
activación. El cliente abre la app, dicta su CÓDIGO DE DISPOSITIVO y el dueño le
devuelve la LLAVE DE ACTIVACIÓN que solo sirve en ese teléfono.

El algoritmo (device_code / activation_key) es idéntico bit a bit al de la app
(`porcipeso/ui/static/app.js`) y al de la herramienta visual
(`packaging/emitir_llave.html`); los tests de `tests/licensing/` verifican la
paridad py<->js.

Modelo de seguridad: es un candado de CONVENIENCIA, no DRM militar. El secreto
maestro viaja embebido en la app, así que un experto podría extraerlo. Es
suficiente para el mercado objetivo (evita la copia casual entre teléfonos).
"""
from .keygen import (
    MASTER_SECRET,
    activation_key,
    activation_key_from_code,
    device_code,
    normalize_device_code,
    normalize_key,
    verify_key,
)

__all__ = [
    "MASTER_SECRET",
    "device_code",
    "activation_key",
    "activation_key_from_code",
    "normalize_device_code",
    "normalize_key",
    "verify_key",
]
