"""Genera packaging/icons/porcipeso.icns y .ico desde el icono PWA (Pillow).

Se invoca desde porcipeso.spec en tiempo de build; tambien puede correrse
a mano: python packaging/make_icons.py
"""
from __future__ import annotations

from pathlib import Path

PACKAGING_DIR = Path(__file__).resolve().parent
REPO_ROOT = PACKAGING_DIR.parent
SOURCE_PNG = REPO_ROOT / "porcipeso" / "ui" / "static" / "icons" / "icon-512.png"
ICONS_DIR = PACKAGING_DIR / "icons"

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def ensure_icons() -> dict[str, Path]:
    """Genera (si faltan o estan viejos) y retorna {'icns': ..., 'ico': ...}."""
    from PIL import Image

    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    icns = ICONS_DIR / "porcipeso.icns"
    ico = ICONS_DIR / "porcipeso.ico"

    src_mtime = SOURCE_PNG.stat().st_mtime
    stale = [
        p for p in (icns, ico) if not p.exists() or p.stat().st_mtime < src_mtime
    ]
    if stale:
        with Image.open(SOURCE_PNG) as img:
            img = img.convert("RGBA")
            if img.size != (512, 512):
                img = img.resize((512, 512), Image.LANCZOS)
            img.save(icns)  # Pillow genera todos los tamanos del icns
            img.save(ico, sizes=ICO_SIZES)
    return {"icns": icns, "ico": ico}


if __name__ == "__main__":
    paths = ensure_icons()
    for kind, path in paths.items():
        print(f"{kind}: {path}")
