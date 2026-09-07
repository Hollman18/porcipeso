"""LED de peso: fit-to-width + formato crudo (Playwright).

Evidencia de campo: el indicador muestra "-7143.0" y la app mostraba
"-7.143,0" desbordado del recuadro. Estos tests cargan la UI real
(porcipeso/ui/static) en Chromium headless, inyectan lecturas por el
mismo camino del WebSocket (routeMessage, el router del mensaje WS) y
verifican que:

  1. el numero SIEMPRE cabe en el recuadro (scrollWidth <= ancho util
     del ledbox) con cadenas de 3, 6 y 9 caracteres, en movil chico
     (320px) y escritorio (1280px);
  2. el LED pinta el string CRUDO tal cual ("raw" del WS): sin
     separador de miles ni coma decimal;
  3. sin "raw" (sim / binarios) degrada a numero plano sin locale.

Si playwright no esta instalado, los tests se SALTAN (mismo patron
importorskip del resto de la suite).
"""
from __future__ import annotations

import http.server
import json
import threading
from functools import partial
from pathlib import Path

import pytest

sync_api = pytest.importorskip(
    "playwright.sync_api", reason="playwright no instalado (pip install playwright)")

from porcipeso.licensing import keygen  # noqa: E402

STATIC_DIR = Path(__file__).resolve().parents[2] / "porcipeso" / "ui" / "static"

# La app está protegida por ACTIVACIÓN POR DISPOSITIVO: sin licencia queda
# bloqueada. Este test mide la UI real, así que la pre-activamos (deviceId fijo
# + su llave válida) antes de navegar, igual que los tests e2e.
_LED_DEVICE_ID = "led-fit-fixed-device"
_PREACTIVATE_JS = (
    "try{"
    f"localStorage.setItem('porcipeso_device', {json.dumps(_LED_DEVICE_ID)});"
    "localStorage.setItem('porcipeso_license', "
    f"{json.dumps(json.dumps({'deviceId': _LED_DEVICE_ID, 'key': keygen.activation_key(_LED_DEVICE_ID), 'activated_at': 0}))}"
    ");}catch(e){}"
)

# 3, 6 y 9 caracteres — de "0.0" al peor caso "-99999.99"
EXTREMOS = ["0.0", "1234.0", "-99999.99"]
CASO_DE_CAMPO = "-7143.0"


@pytest.fixture(scope="module")
def static_server():
    handler = partial(http.server.SimpleHTTPRequestHandler,
                      directory=str(STATIC_DIR))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


@pytest.fixture(scope="module")
def browser():
    try:
        with sync_api.sync_playwright() as p:
            b = p.chromium.launch()
            yield b
            b.close()
    except sync_api.Error as exc:  # navegador no instalado
        pytest.skip(f"chromium de playwright no disponible: {exc}")


@pytest.fixture()
def page(browser, static_server):
    page = browser.new_page()
    page.add_init_script(_PREACTIVATE_JS)   # app ya activada (gate principal)
    page.goto(static_server + "/index.html")
    page.wait_for_function("typeof routeMessage === 'function'")
    # mostrar la pantalla de pesaje (subview del modulo Pesaje)
    page.evaluate("setSubview('modPesaje', 'pvWeigh')")
    yield page
    page.close()


def inject(page, kg: float, raw: str | None) -> None:
    """Inyecta una lectura por el mismo router que consume el WS real."""
    page.evaluate(
        """([kg, raw]) => routeMessage({
             type: 'reading', kg, ts_ms: Date.now(),
             state: 'estable', fase: 'lote', raw,
           })""",
        [kg, raw],
    )


def led_metrics(page) -> dict:
    return page.evaluate(
        """() => {
             const led = document.getElementById('led');
             const box = led.parentElement;             // .ledbox
             const cs = getComputedStyle(box);
             const avail = box.clientWidth
               - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
             return { scrollWidth: led.scrollWidth,
                      clientWidth: led.clientWidth,
                      avail,
                      boxClient: box.clientWidth,
                      boxScroll: box.scrollWidth,
                      text: led.textContent,
                      fontSize: getComputedStyle(led).fontSize };
           }"""
    )


VIEWPORTS = [(320, 640), (1280, 800)]  # movil chico y escritorio


@pytest.mark.parametrize("width,height", VIEWPORTS)
@pytest.mark.parametrize("raw", EXTREMOS + [CASO_DE_CAMPO])
def test_texto_siempre_cabe_en_el_recuadro(page, raw, width, height):
    page.set_viewport_size({"width": width, "height": height})
    inject(page, float(raw), raw)
    m = led_metrics(page)
    # el contenido del LED cabe en el ancho util del recuadro: sin cortes,
    # sin scroll, sin salirse
    assert m["scrollWidth"] <= m["avail"] + 1, m       # +1: redondeo subpixel
    assert m["boxScroll"] <= m["boxClient"] + 1, m     # el ledbox no scrollea
    # y el texto es el raw VERBATIM (+ sufijo ' kg')
    assert m["text"].startswith(raw + " "), m


def test_de_corto_a_largo_y_de_vuelta_reescala(page):
    """El fit reescala en ambos sentidos: al crecer el numero se achica la
    fuente; al volver a un numero corto recupera el tamano natural del CSS
    (no se queda chiquito). En 320px el peor caso NO cabe al font natural,
    asi que el shrink es obligatorio."""
    page.set_viewport_size({"width": 320, "height": 640})
    inject(page, 0.0, "0.0")
    corto = led_metrics(page)
    inject(page, -99999.99, "-99999.99")
    largo = led_metrics(page)
    assert largo["scrollWidth"] <= largo["avail"] + 1, largo
    assert float(largo["fontSize"][:-2]) < float(corto["fontSize"][:-2])
    inject(page, 0.0, "0.0")
    de_vuelta = led_metrics(page)
    assert de_vuelta["scrollWidth"] <= de_vuelta["avail"] + 1
    assert de_vuelta["fontSize"] == corto["fontSize"], (corto, de_vuelta)


def test_led_crudo_identico_al_indicador(page):
    """Caso del video del cliente: el indicador muestra -7143.0 y el LED
    muestra '-7143.0', JAMAS '-7.143,0' (sin miles, sin coma decimal)."""
    inject(page, -7143.0, CASO_DE_CAMPO)
    m = led_metrics(page)
    assert m["text"].startswith("-7143.0 "), m
    assert "," not in m["text"], m
    assert m["scrollWidth"] <= m["avail"] + 1, m


def test_fallback_sin_raw_numero_plano_sin_locale(page):
    """Fuentes sin raw (sim, binarios): numero plano con punto decimal y
    sin separador de miles."""
    inject(page, -7143.0, None)
    m = led_metrics(page)
    # 1 decimal SIEMPRE (igual que la división de escala); "-7143.0" prueba que
    # no hay separador de miles (con locale es-CO habria sido "-7.143")
    assert m["text"].startswith("-7143.0 "), m
    assert "," not in m["text"], m
    inject(page, 52.5, None)
    m = led_metrics(page)
    assert m["text"].startswith("52.5 "), m            # punto, no coma
