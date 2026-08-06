"""Genera el ícono oficial de la app (co-branding ELEIA + PorciPeso).

Composición: elefante blanco de ELEIA (extraído de
porcipeso/branding/assets/eleia-logo.png) como protagonista sobre un
degradado verde Eleia (#76B82A) → verde PorciPeso (#178A50), con el
cerdito PorciPeso como badge en la esquina inferior derecha.

Salidas:
  - porcipeso/ui/static/icons/icon-192.png / icon-512.png  (PWA, maskable)
  - mobile/android/app/src/main/res/mipmap-*/ic_launcher.png,
    ic_launcher_round.png, ic_launcher_foreground.png,
    ic_launcher_background.png                              (Android)
  - packaging/icons/porcipeso.icns / .ico  (vía make_icons.py)

Correr:  ./.venv/bin/python packaging/make_app_icon.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

PACKAGING_DIR = Path(__file__).resolve().parent
REPO_ROOT = PACKAGING_DIR.parent
LOGO_PATH = REPO_ROOT / "porcipeso" / "branding" / "assets" / "eleia-logo.png"
PWA_ICONS_DIR = REPO_ROOT / "porcipeso" / "ui" / "static" / "icons"
ANDROID_RES = REPO_ROOT / "mobile" / "android" / "app" / "src" / "main" / "res"

MASTER = 1024  # tamaño de trabajo (supersampleado; todo se exporta desde acá)

# Paleta (porcipeso.branding)
ELEIA_GREEN = (0x76, 0xB8, 0x2A)
PORCIPESO_GREEN = (0x17, 0x8A, 0x50)
PIG_PINK = (0xF6, 0xA8, 0xBB)
PIG_PINK_DARK = (0xE8, 0x7F, 0xA0)
PIG_NOSTRIL = (0xA8, 0x3E, 0x63)
PIG_EYE = (0x40, 0x26, 0x2E)

# Densidades Android: legacy (dp 48) y foreground adaptativo (dp 108)
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}


# ------------------------------------------------------------- elefante


def extract_elephant_mask() -> Image.Image:
    """Máscara (L) del elefante blanco del logo Eleia, recortada al bbox.

    El logo es "elefante + wordmark ELEIA" blancos sobre verde. El
    elefante vive en el tercio izquierdo; se separa del fondo verde por
    el canal mínimo RGB (el verde lima tiene B≈42; el blanco, 255).
    """
    logo = Image.open(LOGO_PATH).convert("RGBA")
    w, h = logo.size
    px = logo.load()
    mask = Image.new("L", logo.size, 0)
    mp = mask.load()
    lo, hi = 110, 235  # rampa anti-alias: verde→blanco
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            m = min(r, g, b)
            v = 0 if m <= lo else 255 if m >= hi else int(255 * (m - lo) / (hi - lo))
            mp[x, y] = v * a // 255

    # corte elefante/wordmark: primer hueco de columnas vacías tras el 25%
    cols = [
        any(mp[x, y] > 8 for y in range(h)) for x in range(w)
    ]
    cut = w
    gap = 0
    for x in range(int(w * 0.25), w):
        if not cols[x]:
            gap += 1
            if gap >= 6:
                cut = x - gap + 1
                break
        else:
            gap = 0
    elephant = mask.crop((0, 0, cut, h))
    return elephant.crop(elephant.getbbox())


# ------------------------------------------------------------- fondos


def build_background(size: int) -> Image.Image:
    """Degradado vertical verde Eleia → verde PorciPeso + brillo sutil."""
    grad = Image.new("RGB", (1, 256))
    gp = grad.load()
    for i in range(256):
        t = i / 255.0
        gp[0, i] = tuple(
            round(ELEIA_GREEN[c] + (PORCIPESO_GREEN[c] - ELEIA_GREEN[c]) * t)
            for c in range(3)
        )
    bg = grad.resize((size, size), Image.BILINEAR).convert("RGBA")

    # brillo radial suave arriba-izquierda (profundidad, sin estridencia)
    glow = Image.new("L", (size, size), 0)
    gd = ImageDraw.Draw(glow)
    r = int(size * 0.75)
    gd.ellipse((-r // 2, -r // 2, r, r), fill=46)
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.12))
    bg.paste(Image.new("RGBA", (size, size), (255, 255, 255, 255)), (0, 0), glow)
    return bg


# ------------------------------------------------------------- cerdito


def draw_pig_badge(layer: Image.Image, cx: float, cy: float, radius: float) -> None:
    """Badge circular blanco con carita de cerdito PorciPeso."""
    d = ImageDraw.Draw(layer)
    r = radius

    # sombra suave del badge
    sh = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse(
        (cx - r, cy - r + r * 0.08, cx + r, cy + r + r * 0.08), fill=(0, 40, 20, 90)
    )
    layer.alpha_composite(sh.filter(ImageFilter.GaussianBlur(r * 0.10)))

    # disco blanco
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255, 255))

    hr = r * 0.72  # radio de la cabeza
    # orejas (triángulos redondeados, detrás de la cabeza)
    for sx in (-1, 1):
        ex, ey = cx + sx * hr * 0.72, cy - hr * 0.74
        d.polygon(
            [
                (ex - sx * hr * 0.42, ey + hr * 0.34),
                (ex + sx * hr * 0.30, ey - hr * 0.42),
                (ex + sx * hr * 0.52, ey + hr * 0.52),
            ],
            fill=PIG_PINK_DARK + (255,),
        )
    # cabeza
    d.ellipse((cx - hr, cy - hr, cx + hr, cy + hr), fill=PIG_PINK + (255,))
    # ojos
    er = hr * 0.10
    for sx in (-1, 1):
        ex, ey = cx + sx * hr * 0.42, cy - hr * 0.18
        d.ellipse((ex - er, ey - er, ex + er, ey + er), fill=PIG_EYE + (255,))
    # trompa
    sw, shh = hr * 0.62, hr * 0.44
    sy = cy + hr * 0.30
    d.ellipse((cx - sw, sy - shh, cx + sw, sy + shh), fill=PIG_PINK_DARK + (255,))
    nr_w, nr_h = hr * 0.09, hr * 0.16
    for sx in (-1, 1):
        nx = cx + sx * sw * 0.42
        d.ellipse((nx - nr_w, sy - nr_h, nx + nr_w, sy + nr_h), fill=PIG_NOSTRIL + (255,))


# ------------------------------------------------------------- contenido


def build_content(size: int, scale: float) -> Image.Image:
    """Capa transparente con elefante + badge cerdito, escalada.

    ``scale=1.0`` = layout full-bleed (PWA/legacy, zona segura maskable
    ~80%); para el foreground adaptativo se usa un scale menor (zona
    segura 66/108 dp).
    """
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = extract_elephant_mask()

    # elefante blanco, protagonista, apenas arriba-izquierda del centro
    ew = int(size * 0.580 * scale)
    eh = int(ew * mask.height / mask.width)
    m = mask.resize((ew, eh), Image.LANCZOS)
    ex = int(size * 0.462 - ew / 2)
    ey = int(size * 0.435 - eh / 2)

    # sombra sutil del elefante para despegarlo del fondo
    sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sh.paste((0, 45, 22, 110), (ex + int(size * 0.008), ey + int(size * 0.012)), m)
    layer.alpha_composite(sh.filter(ImageFilter.GaussianBlur(size * 0.008)))
    layer.paste((255, 255, 255, 255), (ex, ey), m)

    # cerdito badge, esquina inferior derecha (dentro de zona segura)
    draw_pig_badge(
        layer,
        cx=size * (0.5 + 0.205 * scale),
        cy=size * (0.5 + 0.210 * scale),
        radius=size * 0.125 * scale,
    )
    return layer


def circle_crop(img: Image.Image) -> Image.Image:
    """Versión circular (para ic_launcher_round)."""
    size = img.width
    big = 4 * size
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def save_resized(img: Image.Image, size: int, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.resize((size, size), Image.LANCZOS).save(dest, "PNG")
    print(f"  {dest.relative_to(REPO_ROOT)}  ({size}x{size})")


# ------------------------------------------------------------- main


def main() -> None:
    bg = build_background(MASTER)

    icon = bg.copy()
    icon.alpha_composite(build_content(MASTER, scale=1.0))

    fg = build_content(MASTER, scale=0.80)  # zona segura adaptive (66/108dp)

    print("PWA:")
    save_resized(icon, 512, PWA_ICONS_DIR / "icon-512.png")
    save_resized(icon, 192, PWA_ICONS_DIR / "icon-192.png")

    print("Android:")
    round_icon = circle_crop(icon)
    for density, mult in DENSITIES.items():
        legacy = int(48 * mult)
        adaptive = int(108 * mult)
        mip = ANDROID_RES / f"mipmap-{density}"
        save_resized(icon, legacy, mip / "ic_launcher.png")
        save_resized(round_icon, legacy, mip / "ic_launcher_round.png")
        save_resized(fg, adaptive, mip / "ic_launcher_foreground.png")
        save_resized(bg, adaptive, mip / "ic_launcher_background.png")

    print("Escritorio (icns/ico):")
    import make_icons  # noqa: PLC0415 — vive junto a este script

    for kind, path in make_icons.ensure_icons().items():
        print(f"  {kind}: {path.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    import sys

    sys.path.insert(0, str(PACKAGING_DIR))
    main()
