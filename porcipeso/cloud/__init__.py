"""PorciPeso Cloud — servidor nube multi-cliente.

Backend central: autenticación con roles (superadmin/admin/operador),
sincronización de pesajes desde las apps, configuración remota
(banners/versiones) y telemetría. Arranque: ``python -m porcipeso.cloud``.

Dependencias extra (``pip install porcipeso[cloud]``): pyjwt, argon2-cffi.
"""
from porcipeso.cloud.app import create_app

__all__ = ["create_app"]
