#!/usr/bin/env python3
"""Emisor de LLAVES DE ACTIVACIÓN de PorciPeso por línea de comandos (uso del
DUEÑO). El cliente te dicta su CÓDIGO DE DISPOSITIVO; esto te devuelve la LLAVE.

Uso:
    python packaging/emitir_llave.py PORCI-XXXX-XXXX
    python packaging/emitir_llave.py "porci abcd efgh"   (tolera formato libre)

Equivalente vía módulo (mismo resultado):
    python -m porcipeso.licensing PORCI-XXXX-XXXX

(No uses `python -m packaging.emitir_llave`: el nombre `packaging` choca con la
librería PyPI `packaging` instalada en el entorno.)

Alternativa visual (sin terminal): abre packaging/emitir_llave.html con doble
clic. Da EXACTAMENTE la misma llave.

⚠️  Contiene indirectamente la llave maestra (vía porcipeso.licensing). Úsala
solo tú; no la publiques ni la subas a ningún lado accesible por clientes.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Permite ejecutar este archivo como script suelto (`python packaging/...py`):
# añade la raíz del repo al path para poder importar el módulo de licencias.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from porcipeso.licensing.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
