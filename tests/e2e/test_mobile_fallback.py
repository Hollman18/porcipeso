"""Degradación con GRACIA del backend embebido en la app móvil (www build).

Sirve el bundle real ``mobile/www`` (UI + shim.js) como lo haría el WebView de
Android y fuerza el fallo del driver SQLite con el gancho de prueba
``?__dbfail=…`` que expone main.ts. NO hace falta backend Python: el shim
intercepta ``/api/*`` y ``/ws`` dentro del navegador.

Verifica lo que el teléfono real no nos deja reproducir:
  · el plugin nativo cae   → la app usa el respaldo sql.js y SIGUE operable;
  · el WebView no soporta WASM → cae a memoria (asm.js) y avisa que no guarda;
  · ni eso levanta         → banner HONESTO móvil (NO el de "computador").

Requiere ``playwright`` (+ chromium) y el build ``mobile/www``; si falta algo,
la suite se salta.
"""
from __future__ import annotations

import functools
import http.server
import socket
import threading
from pathlib import Path

import pytest

pw = pytest.importorskip("playwright.sync_api", reason="playwright no instalado")

WWW = Path(__file__).resolve().parents[2] / "mobile" / "www"

if not (WWW / "shim.js").exists():
    pytest.skip(
        "mobile/www no construido (corre `cd mobile && npm run build`)",
        allow_module_level=True,
    )


# ------------------------------------------------------------------ servidor

class _Handler(http.server.SimpleHTTPRequestHandler):
    # .wasm con el MIME correcto para instantiateStreaming de sql.js.
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm"}

    def log_message(self, *args):  # silencio en la salida de pytest
        pass


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server_url():
    handler = functools.partial(_Handler, directory=str(WWW))
    port = _free_port()
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()
    thread.join(timeout=5)


@pytest.fixture(scope="module")
def context():
    with pw.sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Exception:
            browser = p.chromium.launch(headless=True, channel="chromium")
        ctx = browser.new_context(viewport={"width": 1100, "height": 850})
        # sin onboarding / overlay "¿cómo funciona?" que intercepten clics
        ctx.add_init_script(
            "localStorage.setItem('porcipeso_onboard','1');"
            "localStorage.setItem('porcipeso_howto','1');"
        )
        yield ctx
        browser.close()


@pytest.fixture()
def page(context):
    pg = context.new_page()
    yield pg
    pg.close()


# --------------------------------------------------------------- nivel 2

def test_plugin_nativo_cae_usa_respaldo_y_sigue_operable(page, server_url):
    """`?__dbfail=native`: el SQLite nativo LANZA → la app usa sql.js. NO sale
    el banner de "computador" y se puede pesar con la simulada."""
    expect = pw.expect
    page.goto(server_url + "/?__dbfail=native")

    # el shim está presente y eligió el respaldo
    assert page.evaluate("!!window.__PORCIPESO_SHIM__") is True
    page.wait_for_function(
        "window.__PORCIPESO_SHIM__ && window.__PORCIPESO_SHIM__.dbBackend === 'sqljs-fallback'",
        timeout=15_000,
    )

    # diagnóstico de campo: "respaldo"
    expect(page.locator("#dbDiag")).to_contain_text("respaldo")

    # NO aparece el banner de escritorio (el backend embebido SÍ levantó)
    expect(page.locator("#apiBanner")).not_to_be_visible()
    expect(page.locator("#dbWarnBanner")).not_to_be_visible()

    # operable de verdad: arrancar la báscula simulada
    page.click("#bUseSim")
    expect(page.locator("#scaleChip")).to_have_text("Báscula simulada")


# --------------------------------------------------------------- nivel 3

def test_sin_webassembly_cae_a_memoria_y_avisa(page, server_url):
    """`?__dbfail=wasm-off`: el WebView no soporta WebAssembly → sql.js asm.js
    EN MEMORIA. La app abre, avisa que no guarda y sigue operable."""
    expect = pw.expect
    page.goto(server_url + "/?__dbfail=wasm-off")

    page.wait_for_function(
        "window.__PORCIPESO_SHIM__ && window.__PORCIPESO_SHIM__.dbBackend === 'memoria-degradada'",
        timeout=20_000,
    )

    # aviso HONESTO de que los pesajes no se guardan
    expect(page.locator("#dbWarnBanner")).to_be_visible()
    expect(page.locator("#dbWarnTxt")).to_contain_text("no se guardar", ignore_case=True)

    # diagnóstico: "memoria"
    expect(page.locator("#dbDiag")).to_contain_text("memoria")

    # el backend embebido SÍ levantó → NO se muestra el banner de "computador"
    expect(page.locator("#apiBanner")).not_to_be_visible()
    # operable (la simulada pesa aunque no persista)
    page.click("#bUseSim")
    expect(page.locator("#scaleChip")).to_have_text("Báscula simulada")


# --------------------------------------------------- caso extremo (banner)

def test_banner_movil_difiere_del_de_escritorio(page, server_url):
    """`?__dbfail=fatal`: ni el nivel 3 levanta → banner HONESTO móvil. Debe
    hablar del teléfono / Android System WebView y NUNCA de un "computador"
    (así se distingue del texto de escritorio)."""
    expect = pw.expect
    page.goto(server_url + "/?__dbfail=fatal")

    banner = page.locator("#apiBanner")
    expect(banner).to_be_visible(timeout=15_000)

    txt = page.locator("#apiBannerTxt")
    expect(txt).to_contain_text("Android System WebView")
    expect(txt).not_to_contain_text("computador")

    # detalle técnico con el motivo real de la caída (por qué degradó)
    expect(page.locator("#apiBannerDetail")).to_contain_text("asm.js")
