"""CLI compartida del emisor de llaves (uso del DUEÑO).

Una sola implementación, dos puntos de entrada:
  - `python -m porcipeso.licensing PORCI-XXXX-XXXX`   (vía __main__.py)
  - `python packaging/emitir_llave.py PORCI-XXXX-XXXX` (delega aquí)

(No se usa `python -m packaging.emitir_llave` porque el nombre `packaging`
choca con la librería PyPI `packaging` instalada en el entorno.)
"""
from __future__ import annotations

import sys

from .keygen import activation_key_from_code, normalize_device_code

_USAGE = """\
PorciPeso — Emisor de llaves de activación (uso del dueño)

Uso:
    python -m porcipeso.licensing PORCI-XXXX-XXXX
    python packaging/emitir_llave.py PORCI-XXXX-XXXX
    python packaging/emitir_llave.py "porci abcd efgh"   (tolera formato libre)

El código del cliente se pega con o sin prefijo "PORCI-", en minúsculas, con
espacios/guiones y con O/I/L confundidos: se normaliza solo.

Alternativa visual (sin terminal): abrir packaging/emitir_llave.html con doble
clic. Da EXACTAMENTE la misma llave.
"""


def emitir(codigo: str) -> tuple[str, str]:
    """Devuelve (codigo_canonico, llave) para un código de dispositivo."""
    canon = normalize_device_code(codigo)
    return canon, activation_key_from_code(canon)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(_USAGE)
        return 0 if argv else 2

    canon, llave = emitir(" ".join(argv))  # tolera código pegado con espacios
    print()
    print("  PorciPeso — Emisor de llaves de activación")
    print("  ------------------------------------------")
    print(f"  Código de dispositivo : {canon}")
    print(f"  LLAVE DE ACTIVACIÓN   : {llave}")
    print()
    print("  Dictásela al cliente para que la escriba en la pantalla de")
    print("  activación. Solo funciona en ESE teléfono.")
    print()
    return 0
