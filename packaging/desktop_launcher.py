"""Entrypoint de escritorio de PorciPeso.

Arranca el servidor FastAPI (uvicorn) en 127.0.0.1 sobre un puerto libre,
con la base de datos en el directorio de datos del usuario, espera a que
el servidor responda y abre el navegador predeterminado en la app.

Ciclo de vida simple: el proceso queda corriendo mientras la app/terminal
siga abierta; SIGINT/SIGTERM (cerrar terminal, Cmd-Q en el Dock, cerrar la
consola en Windows) apagan el servidor limpiamente.

Variables de entorno respetadas (mismas del modo servidor):
  PORCIPESO_DB    ruta de la base (default: <datos del usuario>/porcipeso.db)
  PORCIPESO_HOST  interfaz de escucha (default: 127.0.0.1)
  PORCIPESO_PORT  puerto HTTP (default: uno libre elegido por el SO)
"""
from __future__ import annotations

import json
import os
import signal
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn

from porcipeso.api.app import create_app

APP_NAME = "PorciPeso"
READY_TIMEOUT_S = 30.0


def user_data_dir() -> Path:
    """Directorio de datos por plataforma (se crea si no existe)."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / APP_NAME
    elif sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        base = (Path(appdata) if appdata else Path.home() / "AppData" / "Roaming") / APP_NAME
    else:
        xdg = os.environ.get("XDG_DATA_HOME")
        base = (Path(xdg) if xdg else Path.home() / ".local" / "share") / APP_NAME
    base.mkdir(parents=True, exist_ok=True)
    return base


def pick_free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((host, 0))
        return s.getsockname()[1]


def log(msg: str) -> None:
    """print seguro aun sin consola (apps windowed: sys.stdout puede ser None)."""
    if sys.stdout is not None:
        try:
            print(msg, flush=True)
        except Exception:
            pass


def check_update_url(url: str) -> str:
    """Consulta /api/update/status del propio servidor tras readiness.

    Si hay versión nueva, loguea y retorna la URL con ?update=1 (la UI
    ya muestra el banner por su cuenta; el parámetro es solo una señal).
    En escritorio NO hay auto-descarga (decisión: menos riesgo).
    Cualquier fallo degrada a la URL original.
    """
    try:
        probe = url.rstrip("/") + "/api/update/status"
        with urllib.request.urlopen(probe, timeout=5) as resp:
            status = json.load(resp)
        if status.get("update_available"):
            log(
                f"[{APP_NAME}] hay una versión nueva: {status.get('latest')} "
                f"(instalada: {status.get('current')})"
            )
            if not status.get("min_version_ok", True):
                log(f"[{APP_NAME}] la versión instalada quedó por debajo de la mínima soportada")
            return url + ("&" if "?" in url else "?") + "update=1"
    except Exception:
        pass  # sin nube / sin red: la app abre normal
    return url


def wait_ready_and_open(url: str, url_file: Path, server: uvicorn.Server) -> None:
    """Espera readiness del servidor, persiste la URL y abre el navegador."""
    deadline = time.monotonic() + READY_TIMEOUT_S
    probe = url.rstrip("/") + "/api/profiles"
    while time.monotonic() < deadline:
        if server.should_exit:
            return
        try:
            with urllib.request.urlopen(probe, timeout=1) as resp:
                if resp.status == 200:
                    break
        except Exception:
            time.sleep(0.15)
    else:
        log(f"[{APP_NAME}] el servidor no respondio en {READY_TIMEOUT_S:.0f}s")
        return

    try:
        url_file.write_text(url + "\n", encoding="utf-8")
    except OSError as exc:
        log(f"[{APP_NAME}] no se pudo escribir {url_file}: {exc}")
    log(f"[{APP_NAME}] listo — {url}")
    open_url = check_update_url(url)
    if os.environ.get("PORCIPESO_NO_BROWSER") != "1":
        try:
            webbrowser.open(open_url)
        except Exception as exc:
            log(f"[{APP_NAME}] no se pudo abrir el navegador: {exc}. Abra {url} manualmente.")


def main() -> int:
    data_dir = user_data_dir()
    db_path = os.environ.get("PORCIPESO_DB", str(data_dir / "porcipeso.db"))
    host = os.environ.get("PORCIPESO_HOST", "127.0.0.1")
    port_env = os.environ.get("PORCIPESO_PORT")
    port = int(port_env) if port_env else pick_free_port(host)

    url = f"http://{host}:{port}/"
    url_file = data_dir / "current_url.txt"

    log(f"[{APP_NAME}] base de datos: {db_path}")
    log(f"[{APP_NAME}] puerto: {port}")
    log(f"[{APP_NAME}] url: {url}")

    app = create_app(db_path)
    config = uvicorn.Config(app, host=host, port=port, log_level="info")
    server = uvicorn.Server(config)

    # uvicorn instala sus propios handlers de SIGINT/SIGTERM mientras sirve y,
    # al terminar, RE-EMITE la senal capturada con los handlers originales
    # restaurados (capture_signals). Con el handler default de SIGTERM eso
    # mataria el proceso antes del cleanup, asi que instalamos handlers
    # propios "graceful" antes de arrancar. SIGHUP cubre el cierre de la
    # terminal en macOS/Linux.
    def _graceful(*_args: object) -> None:
        server.should_exit = True

    for sig_name in ("SIGTERM", "SIGHUP"):
        sig = getattr(signal, sig_name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, _graceful)
        except (ValueError, OSError):
            pass  # no estamos en el hilo principal

    opener = threading.Thread(
        target=wait_ready_and_open, args=(url, url_file, server), daemon=True
    )
    opener.start()

    try:
        server.run()  # bloquea hasta SIGINT/SIGTERM/should_exit
    finally:
        try:
            url_file.unlink(missing_ok=True)
        except OSError:
            pass
        log(f"[{APP_NAME}] servidor detenido")
    return 0


if __name__ == "__main__":
    sys.exit(main())
