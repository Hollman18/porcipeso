"""Generador de llaves de activación por dispositivo (lado del DUEÑO).

Espejo EXACTO del algoritmo que corre en la app (`app.js`) y en la herramienta
visual (`emitir_llave.html`). Cambiar algo aquí obliga a cambiarlo en los tres
lugares (los tests de paridad fallarán si divergen).

Flujo:
    device_code(device_id)        -> "PORCI-XXXX-XXXX"   (lo dicta el cliente)
    activation_key_from_code(code)-> "XXXX-XXXX-XXXX-XXXX" (lo emite el dueño)
    activation_key(device_id)     -> atajo = key desde el device_id crudo

===================== MODELO DE SEGURIDAD (LÉELO) =====================
Candado de CONVENIENCIA, no DRM. `MASTER_SECRET` viaja EMBEBIDO en la app, así
que un experto con el APK podría extraerlo y fabricar llaves. Suficiente para el
mercado objetivo (evita la copia casual de un teléfono a otro y ata la venta a un
equipo). Fuente de verdad del secreto: ~/porcipeso_secrets/README.md. Si se
filtra, se rota ahí y en app.js + emitir_llave.html y se publica versión nueva.
=======================================================================
"""
from __future__ import annotations

import hashlib
import hmac

# Secreto maestro — MISMO valor en app.js (LIC_SECRET), emitir_llave.html
# (SECRET) y ~/porcipeso_secrets/README.md (fuente de verdad).
# Generado con: openssl rand -hex 32
MASTER_SECRET = "fc437ab3333024f51ca8cbb1d323882d3e7d43dcabbe7252748bb4a161b9d40b"

# Alfabeto base32 tipo Crockford: sin I, L, O, U (se confunden al dictar por
# teléfono). El mismo alfabeto se usa en JS.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ALPHASET = set(_ALPHABET)

# Mapeo de caracteres ambiguos al escribir/dictar (decode Crockford): la persona
# puede escribir la letra O donde va un 0, o I/L donde va un 1.
_AMBIGUOUS = {"O": "0", "I": "1", "L": "1"}


def _b32(data: bytes, length: int) -> str:
    """Codifica `data` en base32 (alfabeto Crockford) y devuelve `length`
    caracteres. Implementación por buffer de bits idéntica a la de JS (el
    acumulador se enmascara a los bits pendientes para no desbordar los 32 bits
    de JS y garantizar paridad exacta)."""
    bits = 0
    value = 0
    out: list[str] = []
    for b in data:
        value = (value << 8) | b
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append(_ALPHABET[(value >> bits) & 31])
            if len(out) >= length:
                return "".join(out)
        value &= (1 << bits) - 1
    if bits > 0 and len(out) < length:
        out.append(_ALPHABET[(value << (5 - bits)) & 31])
    return "".join(out)[:length]


def device_code(device_id: str) -> str:
    """CÓDIGO DE DISPOSITIVO legible derivado del deviceId (público; es el que el
    cliente dicta). base32(SHA-256(deviceId))[:8] -> "PORCI-XXXX-XXXX"."""
    digest = hashlib.sha256((device_id or "").encode("utf-8")).digest()
    p = _b32(digest, 8)
    return f"PORCI-{p[0:4]}-{p[4:8]}"


def normalize_device_code(code: str) -> str:
    """Reconstruye el CÓDIGO canónico "PORCI-XXXX-XXXX" a partir de lo que dicte
    el cliente (mayúsculas/minúsculas, con o sin el prefijo, con espacios o
    guiones, y con O/I/L confundidos)."""
    s = (code or "").upper()
    # quitar el prefijo PORCI si viene (antes de mapear ambiguos, porque
    # "PORCI" contiene O e I que si no se corromperían)
    import re
    s = re.sub(r"^\s*PORCI[\s-]*", "", s)
    s = "".join(_AMBIGUOUS.get(c, c) for c in s)
    payload = "".join(c for c in s if c in _ALPHASET)[:8]
    return f"PORCI-{payload[0:4]}-{payload[4:8]}"


def activation_key_from_code(code: str) -> str:
    """LLAVE DE ACTIVACIÓN a partir del CÓDIGO DE DISPOSITIVO que dicta el
    cliente. HMAC-SHA256(secreto, codigo_canonico) -> "XXXX-XXXX-XXXX-XXXX"."""
    canon = normalize_device_code(code)
    mac = hmac.new(
        MASTER_SECRET.encode("utf-8"), canon.encode("utf-8"), hashlib.sha256
    ).digest()
    p = _b32(mac, 16)
    return f"{p[0:4]}-{p[4:8]}-{p[8:12]}-{p[12:16]}"


def activation_key(device_id: str) -> str:
    """Atajo: LLAVE desde el deviceId crudo (útil en tests). Equivale a
    activation_key_from_code(device_code(device_id))."""
    return activation_key_from_code(device_code(device_id))


def normalize_key(key: str) -> str:
    """Normaliza una llave escrita a mano a sus 16 caracteres base32 (sin
    guiones, mayúsculas, O/I/L corregidos) para comparar sin ambigüedad."""
    s = (key or "").upper()
    s = "".join(_AMBIGUOUS.get(c, c) for c in s)
    return "".join(c for c in s if c in _ALPHASET)


def verify_key(device_id: str, key: str) -> bool:
    """True si `key` es la llave de activación válida para ese `device_id`."""
    expected = normalize_key(activation_key(device_id))
    got = normalize_key(key)
    return bool(got) and hmac.compare_digest(got, expected)
