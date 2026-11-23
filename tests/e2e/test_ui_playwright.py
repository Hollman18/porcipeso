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
        # app pre-activada (el gate de activación es lo primero desde v2.6.0)
        from ._preactivate import PREACTIVATE_JS
        ctx.add_init_script(PREACTIVATE_JS)
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


# --------------------------------------------- eliminar un lote (Función A)

def test_eliminar_lote_desde_datos(page, server_url):
    """Crear un pesaje (DEMO), terminarlo, abrir su detalle en Datos,
    'Eliminar este lote' → confirmación doble → el lote desaparece."""
    expect = pw_sync.expect
    page.goto(server_url)

    # asegurar la báscula simulada conectada (si otra prueba la dejó activa,
    # el enlace 'Usar simulada' está oculto — no hace falta clicarlo)
    if page.locator("#bUseSim").is_visible():
        page.click("#bUseSim")
    expect(page.locator("#scaleChip")).to_contain_text("Báscula")

    # crear un pesaje con nombre único (unidades, sin subir cerdos → cierre en 0)
    page.click("#bStart")
    page.click("#bModeUnidades")
    page.fill("#inpNombre", "LOTE-BORRAR-E2E")
    page.click("#bComenzar")
    expect(page.locator("#pvWeigh")).to_have_class("subview active")
    page.click("#bTerminar")
    expect(page.locator("#pvDone")).to_have_class("subview active")

    # Datos → abrir el detalle del lote recién creado
    page.click('.navbtn[data-mod="datos"]')
    if page.locator("#colPesajes").get_attribute("open") is None:
        page.click("#colPesajes summary")
    fila = page.locator("#dataRows tr", has_text="LOTE-BORRAR-E2E")
    expect(fila).to_have_count(1)
    fila.first.click()
    expect(page.locator("#dvDetail")).to_have_class("subview active")
    expect(page.locator("#dNombre")).to_have_text("LOTE-BORRAR-E2E")

    # botón rojo → diálogo de confirmación con el nombre del lote → borrar
    page.click("#bDeleteLote")
    expect(page.locator("#dlgDelLote")).to_be_visible()
    expect(page.locator("#delLoteMsg")).to_contain_text("LOTE-BORRAR-E2E")
    page.click("#bDelLoteConfirm")

    # vuelve a la lista y el lote ya no aparece
    expect(page.locator("#dvList")).to_have_class("subview active")
    expect(page.locator("#dataRows tr", has_text="LOTE-BORRAR-E2E")).to_have_count(0)


# ----------------------------------- pregunta "¿Cuántos subieron?" (v2.9.15)

def test_respuesta_a_pregunta_se_anota_una_sola_vez(page, server_url):
    """Al responder «¿Cuántos subieron?», el backend re-emite el evento
    confirmado por WS. La pantalla lo anotaba DOS veces: pesos por cerdo
    duplicados (el veredicto parejo/disparejo salía falso) y el movimiento
    repetido. Debe quedar UNA sola vez."""
    expect = pw_sync.expect

    def sim(action, **kw):
        r = page.request.post(f"{server_url}/api/sim/action", data={"action": action, **kw})
        assert r.ok, r.text()

    page.goto(server_url)
    page.evaluate("localStorage.removeItem('porcipeso_cfg')")
    page.goto(server_url)
    if page.locator("#bUseSim").is_visible():
        page.click("#bUseSim")
    page.click("#bStart")
    page.click("#bModeLote")
    page.click("#bComenzar")
    expect(page.locator("#pvWeigh")).to_have_class("subview active")
    page.wait_for_timeout(3500)  # base vacía estable

    sim("pigs_on", n=1, kg_each=100.0)  # cerdo de prueba
    expect(page.locator("#stepGuide")).to_contain_text("bájalo", timeout=30_000)
    sim("pig_off")
    expect(page.locator("#stepGuide")).to_contain_text("PASO 2", timeout=30_000)

    sim("pigs_on", n=1, kg_each=250.0)  # 2,5 × promedio → el motor pregunta
    botones = page.locator("#narrBtns button")
    expect(botones.first).to_be_visible(timeout=30_000)
    n = int(botones.first.text_content().strip())
    botones.first.click()
    expect(page.locator("#narrTxt")).to_contain_text("Anotado", timeout=10_000)
    page.wait_for_timeout(2500)  # deja llegar el eco del confirm por WS

    pesos = page.evaluate("APP.weights.length")
    assert pesos == 1 + n, f"el grupo se anotó más de una vez: {pesos} pesos para 1 + {n}"
    textos = page.evaluate("APP.moves.map(m => m.text || '')")
    dijiste = [t for t in textos if t.startswith("Me dijiste que subieron")]
    eco = [t for t in textos if t.startswith(("Subieron", "Subió 1"))]
    assert len(dijiste) == 1, textos
    assert eco == [], f"el eco del confirm se anotó como subida nueva: {eco}"
    assert int(page.locator("#nCerdos").text_content()) == n
