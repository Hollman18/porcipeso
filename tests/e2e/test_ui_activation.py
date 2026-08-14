"""E2E de la ACTIVACIÓN POR DISPOSITIVO en la UI real.

Por defecto el gate está APAGADO (el cliente quiere que la app abra directo):
`test_por_defecto_abre_directo_sin_activacion` lo verifica. El resto de tests
ENCIENDE el flag `porcipeso_requiere_activacion` para seguir cubriendo la
lógica del gate (que se conserva íntegra para reactivarla al vender con nube).

Cubre (Playwright + FastAPI real):
  0. Por defecto (sin flag): la app abre directo, sin pantalla de activación.
  1. Con el flag y sin licencia: la app está BLOQUEADA -> se ve la pantalla de
     activación con el CÓDIGO DE DISPOSITIVO grande; la app (appshell) no se ve.
  2. El código mostrado coincide con keygen.device_code(deviceId) del equipo.
  3. Llave incorrecta -> error claro y sigue bloqueada.
  4. Llave correcta (calculada en el test con el secreto vía keygen) -> activa y
     DESBLOQUEA; se guarda porcipeso_license {deviceId,key,activated_at}.
  5. Recargar -> sigue activada (permanente en el equipo).
  6. Convivencia: tras activar, el candado de contraseña OPCIONAL sigue
     funcionando (activación primero, contraseña después).
  7. Paridad app.js <-> keygen.py: window.PorciLicense produce las mismas
     device_code / activation_key que Python para los mismos device_id.
  8. Paridad emitir_llave.html (herramienta del dueño, file://) <-> keygen.py.

Si playwright no está instalado, la suite se salta (importorskip).
"""
from __future__ import annotations

import socket
import threading
import time
from pathlib import Path

import pytest

pw = pytest.importorskip("playwright.sync_api", reason="playwright no instalado")
uvicorn = pytest.importorskip("uvicorn")

from porcipeso.api.app import create_app  # noqa: E402
from porcipeso.licensing import keygen  # noqa: E402

EXPECT = pw.expect
_EMITTER_HTML = Path(__file__).resolve().parents[2] / "packaging" / "emitir_llave.html"

# Desde que el cliente pidió "que abra directo" (sin muros), la ACTIVACIÓN POR
# DISPOSITIVO queda APAGADA por defecto: la app arranca sin pantalla de
# activación. El núcleo de licencia sigue intacto y se puede reactivar con el
# flag localStorage 'porcipeso_requiere_activacion'. Estos tests encienden el
# flag para seguir cubriendo la lógica del gate cuando se reactive.
_REQUIRE_ACT_JS = (
    "try{localStorage.setItem('porcipeso_requiere_activacion','1')}catch(e){}"
)


# ------------------------------------------------------------- infraestructura

def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server_url(tmp_path_factory):
    db = tmp_path_factory.mktemp("e2e_act") / "act.db"
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
    # contexto nuevo por test → sin licencia de fábrica (arranca sin activar)
    ctx = browser.new_context(viewport={"width": 1100, "height": 850})
    pg = ctx.new_page()
    pg.add_init_script("try{localStorage.setItem('porcipeso_onboard','1')}catch(e){}")
    yield pg
    ctx.close()


# --------------------------------------------------------------------- helpers

def _device_id(page) -> str:
    return page.evaluate("localStorage.getItem('porcipeso_device')")


def _is_unactivated(page) -> bool:
    return page.evaluate("document.documentElement.classList.contains('is-unactivated')")


# --------------------------------------------------------------------- tests

def test_por_defecto_abre_directo_sin_activacion(page, server_url):
    """NUEVO DEFAULT: sin el flag, la app abre directo (sin pantalla de
    activación) aunque no haya licencia — se descarga, se instala y abre."""
    page.goto(server_url + "/")
    EXPECT(page.locator("#pvHome")).to_be_visible()
    EXPECT(page.locator("#activationScreen")).to_be_hidden()
    assert not _is_unactivated(page)


def test_sin_licencia_bloquea_y_muestra_codigo(page, server_url):
    """(1)(2) Con el gate ENCENDIDO (flag): sin licencia la app está bloqueada;
    se ve la pantalla de activación con el código, y coincide con keygen."""
    page.add_init_script(_REQUIRE_ACT_JS)
    page.goto(server_url + "/")
    EXPECT(page.locator("#activationScreen")).to_be_visible()
    EXPECT(page.locator("#actTitle")).to_contain_text("Activa tu PorciPeso")
    # la app real no se ve mientras no esté activada
    EXPECT(page.locator("#pvHome")).to_be_hidden()
    assert _is_unactivated(page)

    dev = _device_id(page)
    assert dev, "la app debe generar y persistir un deviceId"
    EXPECT(page.locator("#actCode")).to_have_text(keygen.device_code(dev))


def test_flujo_completo_activacion(page, server_url):
    """(3)(4)(5) Con el gate ENCENDIDO: llave mala -> error; llave correcta ->
    activa y desbloquea; recargar sigue activa."""
    page.add_init_script(_REQUIRE_ACT_JS)
    page.goto(server_url + "/")
    EXPECT(page.locator("#activationScreen")).to_be_visible()
    dev = _device_id(page)

    # (3) llave incorrecta -> error y sigue bloqueada
    page.fill("#actKey", "AAAA-AAAA-AAAA-AAAA")
    page.click("#actSubmit")
    EXPECT(page.locator("#actError")).to_contain_text("no es válida")
    assert _is_unactivated(page)

    # (4) llave correcta (calculada con el secreto) -> activa
    good = keygen.activation_key(dev)
    page.fill("#actKey", good)
    page.click("#actSubmit")
    EXPECT(page.locator("#activationScreen")).to_be_hidden()
    EXPECT(page.locator("#pvHome")).to_be_visible()
    assert not _is_unactivated(page)

    lic = page.evaluate("JSON.parse(localStorage.getItem('porcipeso_license'))")
    assert lic and lic["deviceId"] == dev
    assert keygen.normalize_key(lic["key"]) == keygen.normalize_key(good)

    # (5) recargar -> sigue activada, sin volver a pedir llave
    page.goto(server_url + "/")
    EXPECT(page.locator("#pvHome")).to_be_visible()
    assert not _is_unactivated(page)
    EXPECT(page.locator("#activationScreen")).to_be_hidden()


def test_llave_de_otro_equipo_no_activa(page, server_url):
    """Con el gate ENCENDIDO: la llave de OTRO deviceId no sirve en este equipo."""
    page.add_init_script(_REQUIRE_ACT_JS)
    page.goto(server_url + "/")
    ajena = keygen.activation_key("otro-telefono-distinto-999")
    page.fill("#actKey", ajena)
    page.click("#actSubmit")
    EXPECT(page.locator("#actError")).to_contain_text("no es válida")
    assert _is_unactivated(page)


def test_rate_limit_tras_cinco_fallos(page, server_url):
    """Con el gate ENCENDIDO: rate limit suave: tras 5 intentos fallidos se
    bloquea el input."""
    page.add_init_script(_REQUIRE_ACT_JS)
    page.goto(server_url + "/")
    EXPECT(page.locator("#activationScreen")).to_be_visible()
    for _ in range(5):
        page.fill("#actKey", "ZZZZ-ZZZZ-ZZZZ-ZZZZ")
        page.click("#actSubmit")
    EXPECT(page.locator("#actError")).to_contain_text("Demasiados intentos")
    assert page.evaluate("document.getElementById('actKey').disabled") is True
    assert page.evaluate("document.getElementById('actSubmit').disabled") is True


def test_convivencia_con_candado_de_contrasena(page, server_url):
    """(6) Con el gate ENCENDIDO: activación primero, contraseña opcional
    después: con ambas puestas, al reabrir se pide la contraseña (ya activada,
    no re-pide llave)."""
    page.add_init_script(_REQUIRE_ACT_JS)
    # activar
    page.goto(server_url + "/")
    dev = _device_id(page)
    page.fill("#actKey", keygen.activation_key(dev))
    page.click("#actSubmit")
    EXPECT(page.locator("#pvHome")).to_be_visible()

    # poner contraseña opcional desde ⚙ Báscula → 🔒 Seguridad
    # (cambiar de módulo con la navegación real, no con goto de hash)
    page.click('.navbtn[data-mod="bascula"]')
    EXPECT(page.locator("#secBox")).to_be_visible()
    if page.locator("#secBox").get_attribute("open") is None:
        page.click("#secBox summary")
    # el estado de licencia se ve en Seguridad
    EXPECT(page.locator("#licEstado")).to_contain_text("Activado")
    EXPECT(page.locator("#licDeviceCode")).to_have_text(keygen.device_code(dev))
    page.click("#bSecProteger")
    page.fill("#secNew1", "1234")
    page.fill("#secNew2", "1234")
    page.click("#bSecGuardar")
    EXPECT(page.locator("#secResult")).to_contain_text("activada")

    # reabrir: NO re-pide llave (sigue activada) pero SÍ pide la contraseña
    page.evaluate("try{sessionStorage.removeItem('porcipeso_unlocked')}catch(e){}")
    page.goto(server_url + "/")
    EXPECT(page.locator("#activationScreen")).to_be_hidden()
    assert not _is_unactivated(page)
    EXPECT(page.locator("#lockScreen")).to_be_visible()

    # contraseña correcta -> entra
    page.fill("#lockPass", "1234")
    page.click("#lockSubmit")
    EXPECT(page.locator("#lockScreen")).to_be_hidden()
    EXPECT(page.locator("#pvHome")).to_be_visible()


def test_paridad_appjs_vs_keygen(page, server_url):
    """(7) window.PorciLicense (mismo núcleo que app.js) == keygen.py."""
    page.goto(server_url + "/")
    for d in ("11111111-2222-3333-4444-555555555555", "abc", "x-ñ-🐷"):
        js_code = page.evaluate("(id) => window.PorciLicense.deviceCode(id)", d)
        js_key = page.evaluate("(id) => window.PorciLicense.activationKey(id)", d)
        assert js_code == keygen.device_code(d), d
        assert js_key == keygen.activation_key(d), d


def test_paridad_emitir_llave_html_vs_keygen(page, server_url):
    """(8) La herramienta del dueño (emitir_llave.html, abierta con file://)
    emite la MISMA llave que keygen.py."""
    assert _EMITTER_HTML.exists(), _EMITTER_HTML
    page.goto(_EMITTER_HTML.as_uri())
    dev = "11111111-2222-3333-4444-555555555555"
    code = keygen.device_code(dev)
    page.fill("#code", code)
    page.click("#gen")
    EXPECT(page.locator("#out")).to_be_visible()
    key_html = page.locator("#key").inner_text()
    assert key_html == keygen.activation_key_from_code(code) == keygen.activation_key(dev)
