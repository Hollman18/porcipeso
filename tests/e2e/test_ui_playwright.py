"""UI real en Chromium (Playwright): chip DEMO visible de punta a punta
y formulario de preparación condicionado por el modo de pesaje.

Levanta la API completa (FastAPI + estáticos + WS) con el motor real y
la báscula simulada, y recorre la app como lo haría el operador.
Requiere el paquete ``playwright`` (pip install playwright && playwright
install chromium); si no está, los tests se saltan.
"""
from __future__ import annotations

import socket
import threading
import time

import pytest

pw_sync = pytest.importorskip(
    "playwright.sync_api", reason="playwright no instalado"
)

from porcipeso.api.app import create_app  # noqa: E402


# ------------------------------------------------------------------ servidor

def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server_url(tmp_path_factory):
    uvicorn = pytest.importorskip("uvicorn")
    db = tmp_path_factory.mktemp("ui") / "ui.db"
    app = create_app(db)
    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.1)
    assert server.started, "uvicorn no arrancó"
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture(scope="module")
def page(server_url):
    with pw_sync.sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Exception:
            # sin headless-shell descargado: chromium completo (headless nuevo)
            browser = p.chromium.launch(headless=True, channel="chromium")
        ctx = browser.new_context()
        # saltar onboarding y overlay "¿cómo funciona?"
        ctx.add_init_script(
            "localStorage.setItem('porcipeso_onboard','1');"
            "localStorage.setItem('porcipeso_howto','1');"
        )
        pg = ctx.new_page()
        yield pg
        browser.close()


def _expect(page):
    return pw_sync.expect


# --------------------------------------------- formulario condicionado (2)

def test_formulario_por_unidades_solo_corral(page, server_url):
    """En modo POR UNIDADES no hay despacho: destino/placa/conductor no
    aplican y 'Más datos' queda solo con Corral."""
    expect = pw_sync.expect
    page.goto(server_url)
    page.click("#bStart")
    page.click("#bModeUnidades")
    expect(page.locator("#pvSetup")).to_have_class("subview active")
    # abrir "Más datos (opcional)"
    page.click("#formSetup details.more summary")
    expect(page.locator('#formSetup [data-extra="corral"]')).to_be_visible()
    for campo in ("destino", "placa", "conductor"):
        expect(page.locator(f'#formSetup [data-extra="{campo}"]')).to_be_hidden()


def test_formulario_por_lote_todos_los_campos(page, server_url):
    """En modo POR LOTE (despacho con camión) siguen los 4 campos."""
    expect = pw_sync.expect
    page.click("#bSetupBack")
    page.click("#bModeLote")
    expect(page.locator("#pvSetup")).to_have_class("subview active")
    # get_attribute("open") es "" cuando está abierto: comparar con None
    if page.locator("#formSetup details.more").get_attribute("open") is None:
        page.click("#formSetup details.more summary")
    for campo in ("corral", "destino", "placa", "conductor"):
        expect(page.locator(f'#formSetup [data-extra="{campo}"]')).to_be_visible()


# ------------------------------------------------------- chip DEMO (1c)

def test_chip_demo_en_resultados_datos_y_detalle(page, server_url):
    expect = pw_sync.expect
    page.goto(server_url)

    # el enlace de la simulada es discreto y anuncia la política DEMO
    expect(page.locator("#bUseSim")).to_be_visible()
    expect(page.locator("#simNote")).to_be_visible()
    expect(page.locator("#simNote")).to_contain_text("se borran solos")

    page.click("#bUseSim")
    expect(page.locator("#scaleChip")).to_have_text("Báscula simulada")

    # pesar con la simulada (modo unidades, sin subir cerdos: cierre en 0)
    page.click("#bStart")
    page.click("#bModeUnidades")
    page.click("#bComenzar")
    expect(page.locator("#pvWeigh")).to_have_class("subview active")
    page.click("#bTerminar")
    expect(page.locator("#pvDone")).to_have_class("subview active")

    # resultados: chip ámbar DEMO + nota de práctica
    expect(page.locator("#doneDemo")).to_be_visible()
    expect(page.locator("#doneDemoNote")).to_be_visible()

    # módulo Datos: la demo aparece en la tabla CON chip, pero el resumen
    # global no la cuenta (Pesajes = 0)
    page.click('.navbtn[data-mod="datos"]')
    if page.locator("#colPesajes").get_attribute("open") is None:
        page.click("#colPesajes summary")  # desplegar la tabla de pesajes
    expect(page.locator("#dataRows .chip.demo")).to_be_visible()
    expect(page.locator("#gStats .gstat").first.locator(".v")).to_have_text("0")

    # detalle: chip DEMO + nota
    page.click("#dataRows tr >> nth=0")
    expect(page.locator("#dvDetail")).to_have_class("subview active")
    expect(page.locator("#dDemo")).to_be_visible()
    expect(page.locator("#dDemoNote")).to_be_visible()
