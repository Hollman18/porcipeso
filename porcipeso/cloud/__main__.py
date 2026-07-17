"""Arranque del servidor nube: ``python -m porcipeso.cloud``.

Variables de entorno:
  CLOUD_DB                   ruta de la base (default: data/porcipeso_cloud.db)
  CLOUD_JWT_SECRET           OBLIGATORIA: secreto HS256 de los JWT
  CLOUD_HOST                 interfaz de escucha (default: 0.0.0.0)
  CLOUD_PORT                 puerto HTTP (default: 8090)
  CLOUD_SUPERADMIN_EMAIL     bootstrap del primer superadmin…
  CLOUD_SUPERADMIN_PASSWORD  …SOLO si no existe ninguno (idempotente)
"""
from __future__ import annotations

import os
import sys

import uvicorn

from porcipeso.cloud.app import create_app


def main() -> None:
    secret = os.environ.get("CLOUD_JWT_SECRET", "").strip()
    if not secret:
        sys.exit(
            "ERROR: falta CLOUD_JWT_SECRET. El servidor nube no arranca sin "
            "un secreto para firmar los JWT.\n"
            "  ej.: CLOUD_JWT_SECRET=$(openssl rand -hex 32) "
            "python -m porcipeso.cloud"
        )
    db_path = os.environ.get("CLOUD_DB", "data/porcipeso_cloud.db")
    host = os.environ.get("CLOUD_HOST", "0.0.0.0")
    port = int(os.environ.get("CLOUD_PORT", "8090"))
    app = create_app(
        db_path,
        secret,
        superadmin_email=os.environ.get("CLOUD_SUPERADMIN_EMAIL"),
        superadmin_password=os.environ.get("CLOUD_SUPERADMIN_PASSWORD"),
    )
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
