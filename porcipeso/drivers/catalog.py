"""Catálogo de perfiles de indicadores (drivers/profiles.yaml)."""
from __future__ import annotations

from importlib import resources
from pathlib import Path

import yaml

from porcipeso.core.models import ScaleProfile


def _yaml_text() -> str:
    try:
        res = resources.files("porcipeso.drivers") / "profiles.yaml"
        return res.read_text(encoding="utf-8")
    except Exception:
        # fallback: ruta relativa al archivo (ej. ejecución sin instalación)
        return (Path(__file__).parent / "profiles.yaml").read_text(encoding="utf-8")


def load_profiles() -> list[ScaleProfile]:
    """Carga todos los perfiles del catálogo profiles.yaml."""
    data = yaml.safe_load(_yaml_text())
    profiles: list[ScaleProfile] = []
    for item in data.get("profiles", []):
        profiles.append(ScaleProfile(**item))
    return profiles


def get_profile(profile_id: str, *, port: str | None = None,
                host: str | None = None,
                tcp_port: int | None = None) -> ScaleProfile:
    """Devuelve el perfil `profile_id` con overrides opcionales de conexión.

    Lanza KeyError si el id no existe en el catálogo.
    """
    for profile in load_profiles():
        if profile.id == profile_id:
            if port is not None:
                profile.port = port
            if host is not None:
                profile.host = host
            if tcp_port is not None:
                profile.tcp_port = tcp_port
            return profile
    raise KeyError(f"perfil desconocido: {profile_id!r}")
