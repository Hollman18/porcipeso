# -*- mode: python ; coding: utf-8 -*-
"""Spec de PyInstaller para PorciPeso (ONEDIR — arranque rapido).

Uso:  pyinstaller packaging/porcipeso.spec
Genera:
  dist/PorciPeso/           carpeta onedir (todas las plataformas)
  dist/PorciPeso.app        bundle de macOS (solo en macOS)
"""
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

SPEC_DIR = Path(SPECPATH).resolve()  # SPECPATH la define PyInstaller
REPO_ROOT = SPEC_DIR.parent
PKG = REPO_ROOT / "porcipeso"

# Iconos .icns/.ico generados desde el icono PWA con Pillow
sys.path.insert(0, str(SPEC_DIR))
from make_icons import ensure_icons  # noqa: E402

ICONS = ensure_icons()
ICON_FILE = str(ICONS["icns"] if sys.platform == "darwin" else ICONS["ico"])

datas = [
    (str(PKG / "ui" / "static"), "porcipeso/ui/static"),
    (str(PKG / "drivers" / "profiles.yaml"), "porcipeso/drivers"),
    (str(PKG / "db" / "schema.sql"), "porcipeso/db"),
]

hiddenimports = (
    collect_submodules("porcipeso")
    + collect_submodules("uvicorn")
    + [
        "serial",
        "serial.tools.list_ports",
        "yaml",
        "openpyxl",
    ]
)

a = Analysis(
    [str(SPEC_DIR / "desktop_launcher.py")],
    pathex=[str(REPO_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "pytest", "PIL"],  # Pillow solo se usa en build
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PorciPeso",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # consola con logs; cerrarla apaga el servidor (Windows)
    icon=ICON_FILE,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="PorciPeso",
)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="PorciPeso.app",
        icon=ICON_FILE,
        bundle_identifier="com.porcipeso.desktop",
        info_plist={
            "CFBundleName": "PorciPeso",
            "CFBundleDisplayName": "PorciPeso",
            "CFBundleShortVersionString": "0.1.0",
            "NSHighResolutionCapable": True,
        },
    )
