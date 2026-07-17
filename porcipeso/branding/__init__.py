"""Marca centralizada de PorciPeso — co-branding "una solución ELEIA".

Decisión de marca: PRODUCTO adelante, EMPRESA de respaldo.
El lockup es "🐷 PorciPeso" grande + "una solución ELEIA" en el verde
Eleia. La paleta propia de la app NO cambia (el verde PorciPeso
``#178A50`` se queda): Eleia entra como acento del lockup y como
protagonista en los INFORMES (PDF/Excel).

Toda superficie con marca (UI, Excel, PDF, print-view móvil) debe usar
estas constantes — nada de strings sueltos.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

# ------------------------------------------------------------------ textos

PRODUCT_NAME = "PorciPeso"
COMPANY = "ELEIA"
TAGLINE_PRODUCT = "la báscula que te habla claro"
TAGLINE_COMPANY = "Soluciones robustas en Industria 4.0"
LOCKUP = "PorciPeso · una solución ELEIA"

# ------------------------------------------------------------------ colores

#: verde lima industrial de Eleia (token CSS: --eleia-green)
ELEIA_GREEN = "#76B82A"
#: gris carbón Eleia (tipografía de respaldo en informes)
ELEIA_CHARCOAL = "#3A3A3A"
#: verde PorciPeso — paleta EXISTENTE de la app; no se toca
PORCIPESO_GREEN = "#178A50"

# ------------------------------------------------------------------- assets

ASSETS_DIR = Path(__file__).resolve().parent / "assets"
#: logo opcional de Eleia; si el archivo existe se usa en los informes,
#: si no, los informes caen al wordmark tipográfico ("ELEIA" en verde).
ELEIA_LOGO = ASSETS_DIR / "eleia-logo.png"


def get_logo_path() -> Optional[Path]:
    """Ruta del logo Eleia si está disponible, o ``None`` (wordmark)."""
    return ELEIA_LOGO if ELEIA_LOGO.is_file() else None


def get_version() -> str:
    """Versión de la app para los pies de página de informes."""
    try:
        from porcipeso.api.updatecheck import read_local_version

        return read_local_version()
    except Exception:
        return "0.0.0"
