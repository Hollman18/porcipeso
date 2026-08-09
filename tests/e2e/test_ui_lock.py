"""E2E del CANDADO DE ACCESO (pantalla de bloqueo) en la UI real.

Cubre el candado local de conveniencia (Playwright + FastAPI):
  1. Apagado por defecto: sin contraseña configurada la app abre directo,
     sin overlay de bloqueo (no rompe a los usuarios actuales).
  2. Configurar contraseña en ⚙ Báscula → 🔒 Seguridad → al reabrir la app
     aparece la pantalla de bloqueo; contraseña incorrecta muestra error y
     sigue bloqueada; la correcta (con Enter) desbloquea y marca la sesión.
  3. Cambiar y quitar la contraseña desde Ajustes (pidiendo la actual).
  4. Rate limit: tras 5 intentos fallidos se bloquea el input unos segundos.

Modelo de seguridad verificado: en localStorage se guarda {salt, hash}
(SHA-256 con salt aleatorio por dispositivo), NUNCA la contraseña en claro.

Si playwright no está instalado, la suite se salta (mismo patrón
importorskip del resto de tests e2e).
"""
from __future__ import annotations

import socket
import threading
import time

import pytest

pw = pytest.importorskip("playwright.sync_api", reason="playwright no instalado")
uvicorn = pytest.importorskip("uvicorn")

from porcipeso.api.app import create_app  # noqa: E402

EXPECT = pw.expect


# ------------------------------------------------------------- infraestructura

def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server_url(tmp_path_factory):
    """FastAPI real (con la UI estática montada) en un hilo."""
    db = tmp_path_factory.mktemp("e2e_lock") / "lock.db"
    port = _free_port()
    app = create_app(db)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    assert server.started, "uvicorn no arrancó"
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture(scope="module")
def browser():
    with pw.sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        yield b
        b.close()


@pytest.fixture()
def page(browser):
    # contexto nuevo por test → localStorage/sessionStorage limpios (candado
    # apagado de fábrica en cada prueba).
    ctx = browser.new_context(viewport={"width": 1100, "height": 850})
    pg = ctx.new_page()
    # sin onboarding: el diálogo de bienvenida no tapa los tests
    pg.add_init_script("try{localStorage.setItem('porcipeso_onboard','1')}catch(e){}")
    # la app ya activada: el candado de contraseña es la capa que se prueba aquí
    from ._preactivate import PREACTIVATE_JS
    pg.add_init_script(PREACTIVATE_JS)
    yield pg
    ctx.close()


# ------------------------------------------------------------------- helpers

def _open_seguridad(page, server_url):
    """Abre ⚙ Báscula y despliega la sección 🔒 Seguridad."""
    page.goto(server_url + "/#bascula")
    EXPECT(page.locator("#secBox")).to_be_visible()
    if page.locator("#secBox").get_attribute("open") is None:
        page.click("#secBox summary")
    EXPECT(page.locator("#secEstado")).to_be_visible()


def _configurar(page, server_url, clave="1234"):
    """Configura una contraseña nueva desde Ajustes."""
    _open_seguridad(page, server_url)
    EXPECT(page.locator("#secProtegerRow")).to_be_visible()
    page.click("#bSecProteger")
    page.fill("#secNew1", clave)
    page.fill("#secNew2", clave)
    page.click("#bSecGuardar")
    EXPECT(page.locator("#secResult")).to_contain_text("activada")


def _is_locked(page) -> bool:
    return page.evaluate("document.documentElement.classList.contains('is-locked')")


def _reopen(page, server_url):
    """Simula reabrir la app: borra la marca de sesión y recarga."""
    page.evaluate("try{sessionStorage.removeItem('porcipeso_unlocked')}catch(e){}")
    page.goto(server_url + "/")


# --------------------------------------------------------------------- tests

def test_sin_contrasena_abre_directo(page, server_url):
    """(1) Apagado por defecto: la app abre sin overlay de bloqueo."""
    page.goto(server_url + "/")
    EXPECT(page.locator("#pvHome")).to_be_visible()
    assert not _is_locked(page)
    EXPECT(page.locator("#lockScreen")).to_be_hidden()


def test_configurar_recargar_pide_contrasena(page, server_url):
    """(2) Configurar → reabrir muestra el candado; clave mala falla, la
    correcta (Enter) desbloquea y marca la sesión."""
    _configurar(page, server_url, "1234")

    # no debe guardarse en claro: solo {salt, hash}
    rec = page.evaluate("JSON.parse(localStorage.getItem('porcipeso_lock'))")
    assert rec and rec.get("salt") and rec.get("hash")
    assert "1234" not in (rec.get("hash") or "")
    assert "1234" != rec.get("salt")

    # reabrir → aparece el candado
    _reopen(page, server_url)
    EXPECT(page.locator("#lockScreen")).to_be_visible()
    assert _is_locked(page)
    EXPECT(page.locator("#lockTitle")).to_contain_text("Ingresa tu contraseña")

    # incorrecta → error y sigue bloqueada
    page.fill("#lockPass", "0000")
    page.click("#lockSubmit")
    EXPECT(page.locator("#lockError")).to_contain_text("incorrecta")
    assert _is_locked(page)

    # correcta con Enter → desbloquea + sesión marcada
    page.fill("#lockPass", "1234")
    page.locator("#lockPass").press("Enter")
    EXPECT(page.locator("#lockScreen")).to_be_hidden()
    assert not _is_locked(page)
    assert page.evaluate("sessionStorage.getItem('porcipeso_unlocked')") == "1"

    # recargar en la MISMA sesión → ya no vuelve a pedir
    page.goto(server_url + "/")
    assert not _is_locked(page)


def test_cambiar_contrasena(page, server_url):
    """(3a) Cambiar contraseña pide la actual; la nueva pasa a valer."""
    _configurar(page, server_url, "1234")
    _open_seguridad(page, server_url)
    page.click("#bSecCambiar")
    # con la actual equivocada → falla
    page.fill("#secCurCh", "0000")
    page.fill("#secNewCh1", "9999")
    page.fill("#secNewCh2", "9999")
    page.click("#bSecChSave")
    EXPECT(page.locator("#secResult")).to_contain_text("actual no es correcta")

    # con la actual correcta → cambia
    page.fill("#secCurCh", "1234")
    page.fill("#secNewCh1", "9999")
    page.fill("#secNewCh2", "9999")
    page.click("#bSecChSave")
    EXPECT(page.locator("#secResult")).to_contain_text("actualizada")

    assert page.evaluate("(async () => await lockVerify('9999'))()") is True
    assert page.evaluate("(async () => await lockVerify('1234'))()") is False


def test_quitar_contrasena(page, server_url):
    """(3b) Quitar contraseña pide la actual; luego la app abre sin candado."""
    _configurar(page, server_url, "1234")
    _open_seguridad(page, server_url)
    page.click("#bSecQuitar")
    # clave equivocada → no la quita
    page.fill("#secCurRm", "0000")
    page.click("#bSecRmSave")
    EXPECT(page.locator("#secResult")).to_contain_text("no es correcta")
    assert page.evaluate("!!localStorage.getItem('porcipeso_lock')") is True

    # clave correcta → la quita
    page.fill("#secCurRm", "1234")
    page.click("#bSecRmSave")
    EXPECT(page.locator("#secResult")).to_contain_text("quitado")
    assert page.evaluate("localStorage.getItem('porcipeso_lock')") is None

    # reabrir → sin candado
    _reopen(page, server_url)
    assert not _is_locked(page)
    EXPECT(page.locator("#lockScreen")).to_be_hidden()


def test_rate_limit_tras_cinco_fallos(page, server_url):
    """(4) Tras 5 intentos fallidos se bloquea el input con aviso."""
    _configurar(page, server_url, "1234")
    _reopen(page, server_url)
    EXPECT(page.locator("#lockScreen")).to_be_visible()

    for _ in range(5):
        page.fill("#lockPass", "xxxx")
        page.click("#lockSubmit")

    EXPECT(page.locator("#lockError")).to_contain_text("Demasiados intentos")
    assert page.evaluate("document.getElementById('lockPass').disabled") is True
    assert page.evaluate("document.getElementById('lockSubmit').disabled") is True
    assert _is_locked(page)
