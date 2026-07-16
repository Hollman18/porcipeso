"""Arranque del servidor PorciPeso: ``python -m porcipeso.api``.

Variables de entorno opcionales:
  PORCIPESO_DB    ruta de la base (default: data/porcipeso.db)
  PORCIPESO_HOST  interfaz de escucha (default: 0.0.0.0)
  PORCIPESO_PORT  puerto HTTP (default: 8000)
"""
from __future__ import annotations

import os

import uvicorn

from porcipeso.api.app import create_app


def main() -> None:
    db_path = os.environ.get("PORCIPESO_DB", "data/porcipeso.db")
    host = os.environ.get("PORCIPESO_HOST", "0.0.0.0")
    port = int(os.environ.get("PORCIPESO_PORT", "8000"))
    uvicorn.run(create_app(db_path), host=host, port=port)


if __name__ == "__main__":
    main()
