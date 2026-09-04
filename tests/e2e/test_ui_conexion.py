"""E2E de la CONEXIÓN de báscula en la UI real (Playwright + FastAPI).

Cubre los pedidos del cliente (2026-08):
  1. Tarjeta de estado en ⚙ Báscula: conectada → Desconectar → reconectar
     con un toque (la config guardada se conserva).
  2. "Cable serial" (escritorio) oculto sin el flag avanzado
     (?avanzado=1 / localStorage porcipeso_avanzado) y visible con él.
  3. Salto de la pregunta "¿cómo la vas a conectar?" cuando en la
     plataforma queda UNA sola opción visible.
  4. OTG sin marcas: tocar OTG → lista USB → tocar → detección automática
     completa (perfil "auto") → "✓ Conectada" (endpoints nativos mockeados
     con page.route, como los del APK).

Si playwright no está instalado, la suite se salta (mismo patrón
importorskip del resto de tests e2e).
"""
from __future__ import annotations

import contextlib
import json
import socket
import threading
import time

import pytest

pw = pytest.importorskip("playwright.sync_api", reason="playwright no instalado")
uvicorn = pytest.importorskip("uvicorn")

from porcipeso.api.app import create_app  # noqa: E402


# ------------------------------------------------------------- infraestructura

def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server_url(tmp_path_factory):
    """FastAPI real (con la UI estática montada) en un hilo."""
    db = tmp_path_factory.mktemp("e2e_ui") / "e2e.db"
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


@pytest.fixture(autouse=True)
def _scale_reset(server_url):
    """El servidor es de alcance módulo: desconecta la báscula ANTES de cada
    test para que el estado de la simulada no se filtre entre pruebas."""
    import urllib.request
    with contextlib.suppress(Exception):
        urllib.request.urlopen(
            urllib.request.Request(server_url + "/api/scale/disconnect",
                                   method="POST"), timeout=5)
    yield


@pytest.fixture()
def page(browser):
    ctx = browser.new_context()
    pg = ctx.new_page()
    # sin onboarding: el diálogo de bienvenida no tapa los tests
    pg.add_init_script("try{localStorage.setItem('porcipeso_onboard','1')}catch(e){}")
    # app pre-activada (el gate de activación es lo primero desde v2.6.0)
    from ._preactivate import PREACTIVATE_JS
    pg.add_init_script(PREACTIVATE_JS)
    yield pg
    ctx.close()


def _seed_cfg(page, cfg: dict) -> None:
    page.add_init_script(
        f"try{{localStorage.setItem('porcipeso_cfg', {json.dumps(json.dumps(cfg))})}}catch(e){{}}"
    )


EXPECT = pw.expect


# ---------------------------------------------- 1) tarjeta de estado + disconnect

def test_tarjeta_conectada_desconectar_reconectar(page, server_url):
    _seed_cfg(page, {"method": "sim", "profile_id": "sim", "name": "Báscula simulada"})
    page.goto(server_url + "/#bascula")

    # con config guardada → tarjeta (no wizard, no botón grande)
    card = page.locator("#connCard")
    EXPECT(card).to_be_visible()
    EXPECT(page.locator("#wizard")).to_be_hidden()
    EXPECT(page.locator("#connEmpty")).to_be_hidden()
    EXPECT(page.locator("#ccName")).to_have_text("Báscula simulada")
    EXPECT(page.locator("#ccMethod")).to_contain_text("Simulada")

    # sin conexión → chip suelto + botón Conectar (reconexión de un toque)
    EXPECT(page.locator("#ccChip")).to_have_text("Sin conectar")
    EXPECT(page.locator("#bccConnect")).to_be_visible()
    EXPECT(page.locator("#bccDisconnect")).to_be_hidden()

    # Conectar → chip verde VIVO con el último peso
    page.locator("#bccConnect").click()
    EXPECT(page.locator("#ccChip")).to_contain_text("Conectada", timeout=10_000)
    EXPECT(page.locator("#ccChip")).to_contain_text("kg", timeout=10_000)
    EXPECT(page.locator("#ccChip")).to_have_class("chip ok")
    EXPECT(page.locator("#bccDisconnect")).to_be_visible()
    EXPECT(page.locator("#bccConnect")).to_be_hidden()

    # Desconectar → corta el driver, la config SE CONSERVA
    page.locator("#bccDisconnect").click()
    EXPECT(page.locator("#ccChip")).to_have_text("Sin conectar", timeout=10_000)
    EXPECT(page.locator("#bccConnect")).to_be_visible()
    EXPECT(page.locator("#ccResult")).to_contain_text("configuración queda guardada")
    st = page.evaluate("fetch('/api/scale/status').then(r => r.json())")
    assert st["connected"] is False
    cfg = page.evaluate("JSON.parse(localStorage.getItem('porcipeso_cfg'))")
    assert cfg["profile_id"] == "sim"  # desconectar NO borró la config

    # Reconectar con un toque
    page.locator("#bccConnect").click()
    EXPECT(page.locator("#ccChip")).to_contain_text("Conectada", timeout=10_000)
    EXPECT(page.locator("#bccDisconnect")).to_be_visible()

    # "Cambiar de báscula" abre el wizard; en escritorio sin flag hay UNA
    # sola opción (Bluetooth) → la pregunta se salta y cae en el paso 2
    page.locator("#bccChange").click()
    EXPECT(page.locator("#wizard")).to_be_visible()
    EXPECT(page.locator("#connHome")).to_be_hidden()
    EXPECT(page.locator("#wizPane2")).to_have_class("wizpane active")
    # ◂ Atrás regresa a la tarjeta (no hay paso 1 al que volver)
    page.locator("#bWizBack2").click()
    EXPECT(page.locator("#connCard")).to_be_visible()
    EXPECT(page.locator("#wizard")).to_be_hidden()


def test_tarjeta_reconectando_estado_honesto(page, server_url):
    """Endurecimiento SPP: si el enlace se cayó y el driver reintenta, la
    tarjeta muestra 'Reconectando…' en ÁMBAR (chip warn) — NUNCA verde
    mintiendo. Estado forzado con page.route sobre /api/scale/status."""
    _seed_cfg(page, {"method": "bluetooth", "profile_id": "auto",
                     "name": "Báscula BT", "port": "00:14:03:05:59:02"})

    # estado FORZADO: conectado (el motor conserva el pesaje) pero el enlace
    # SPP está reconectando de forma transparente
    def handle_status(route):
        route.fulfill(json={
            "connected": True, "reconnecting": True,
            "profile_id": "auto", "last_kg": None, "last_ts_ms": None,
            "state": "sin_senal", "error": None,
        })

    page.route("**/api/scale/status", handle_status)
    page.goto(server_url + "/#bascula")

    card = page.locator("#connCard")
    EXPECT(card).to_be_visible()
    # chip HONESTO: ámbar "Reconectando…", no verde
    EXPECT(page.locator("#ccChip")).to_contain_text("Reconectando", timeout=10_000)
    EXPECT(page.locator("#ccChip")).to_have_class("chip warn")
    # sigue "conectada" a efectos de acciones (Desconectar visible)
    EXPECT(page.locator("#bccDisconnect")).to_be_visible()
    EXPECT(page.locator("#bccConnect")).to_be_hidden()

    # al recuperar el enlace y llegar un peso fresco → vuelve a verde honesto
    def handle_status_ok(route):
        route.fulfill(json={
            "connected": True, "reconnecting": False,
            "profile_id": "auto", "last_kg": 126.35,
            "last_ts_ms": int(time.time() * 1000),
            "state": "estable", "error": None,
        })

    page.unroute("**/api/scale/status")
    page.route("**/api/scale/status", handle_status_ok)
    # el poll de la tarjeta corre cada 2.5 s; la UI se corrige sola
    EXPECT(page.locator("#ccChip")).to_contain_text("Conectada", timeout=10_000)
    EXPECT(page.locator("#ccChip")).to_have_class("chip ok")


# --------------------------- 2+3) serial tras flag avanzado + salto de pregunta

def test_serial_oculto_sin_flag_y_salto_de_pregunta(page, server_url):
    # sin config → botón grande "Conectar báscula"
    page.goto(server_url + "/#bascula")
    EXPECT(page.locator("#connEmpty")).to_be_visible()
    EXPECT(page.locator("#connCard")).to_be_hidden()

    # escritorio SIN flag: solo Bluetooth visible → la pregunta se SALTA
    page.locator("#bConnStart").click()
    EXPECT(page.locator("#wizard")).to_be_visible()
    EXPECT(page.locator("#wizPane2")).to_have_class("wizpane active")
    EXPECT(page.locator("#wizPane1")).not_to_have_class("wizpane active")
    EXPECT(page.locator("#wizPane2 h3")).to_contain_text("¿Qué báscula es?")
    # y la tarjeta serial quedó oculta (aunque el paso 1 no se muestre)
    EXPECT(page.locator('#wizPane1 [data-method="serial"]')).to_be_hidden()
    EXPECT(page.locator('#wizPane1 [data-method="otg"]')).to_be_hidden()


def test_serial_visible_con_flag_avanzado(page, server_url):
    page.goto(server_url + "/?avanzado=1#bascula")
    page.locator("#bConnStart").click()
    # dos opciones (Bluetooth + Cable serial) → la pregunta SÍ se muestra
    EXPECT(page.locator("#wizPane1")).to_have_class("wizpane active")
    serial_card = page.locator('#wizPane1 [data-method="serial"]')
    EXPECT(serial_card).to_be_visible()
    EXPECT(page.locator('#wizPane1 [data-method="bluetooth"]')).to_be_visible()
    EXPECT(page.locator('#wizPane1 [data-method="otg"]')).to_be_hidden()
    # y el método serial sigue funcionando (paso 2 al elegirlo)
    serial_card.click()
    EXPECT(page.locator("#wizPane2")).to_have_class("wizpane active")


# ------------------------------------------------- 4) OTG automático sin marcas

def test_otg_auto_sin_marcas_mock_usb(page, server_url):
    """APK simulado: window.__PORCIPESO_SHIM__ + endpoints nativos mockeados."""
    page.add_init_script("window.__PORCIPESO_SHIM__ = { native: true };")

    detect_bodies: list[dict] = []
    connect_bodies: list[dict] = []

    def handle_usb(route):
        route.fulfill(json=[{
            "deviceId": 7, "vid": 0x1A86, "pid": 0x7523,
            "name": "CH340 USB-Serial", "driver": "Ch34xSerialDriver",
        }])

    def handle_detect(route):
        detect_bodies.append(route.request.post_data_json)
        route.fulfill(json={
            "ok": True, "verdict": "directa", "kg": 102.5, "baudrate": 4800,
            "invert_bits": False, "reverse_frame": False, "parser_ok": True,
            "parser": "matrix", "message": "✓ La báscula responde: 102.5 kg",
            "hex": "3D 20 31 30 32 2E 35 30",
        })

    def handle_connect(route):
        connect_bodies.append(route.request.post_data_json)
        route.fulfill(json={"connected": True, "profile_id": "auto", "transport": "usb"})

    page.route("**/api/usb/devices", handle_usb)
    page.route("**/api/scale/detect", handle_detect)
    page.route("**/api/scale/connect", handle_connect)

    page.goto(server_url + "/#bascula")
    page.locator("#bConnStart").click()

    # APK: dos opciones (Bluetooth + OTG) → pregunta visible, serial jamás
    EXPECT(page.locator("#wizPane1")).to_have_class("wizpane active")
    otg_card = page.locator('#wizPane1 [data-method="otg"]')
    EXPECT(otg_card).to_be_visible()
    EXPECT(page.locator('#wizPane1 [data-method="serial"]')).to_be_hidden()

    # tocar OTG → DIRECTO a la lista de dispositivos (sin paso de marcas)
    otg_card.click()
    EXPECT(page.locator("#wizPane3")).to_have_class("wizpane active")
    EXPECT(page.locator("#wizQ3")).to_have_text("Elige tu báscula")
    EXPECT(page.locator("#wizSel")).to_contain_text("sin configurar nada")
    # sin pasos ni Probar/Guardar: una sola pantalla automática
    EXPECT(page.locator("#wizard .wizsteps")).to_be_hidden()
    EXPECT(page.locator("#bProbar")).to_be_hidden()
    # ajustes avanzados disponibles (marcas/baudios a mano)
    EXPECT(page.locator("#bOtgAdvanced")).to_be_visible()

    # tocar el dispositivo → detección automática completa → tarjeta "✓ Conectada"
    device = page.locator("#usbList .bt-item")
    EXPECT(device).to_have_count(1)
    EXPECT(device).to_contain_text("CH340")
    device.click()

    EXPECT(page.locator("#connCard")).to_be_visible(timeout=10_000)
    EXPECT(page.locator("#ccResult")).to_contain_text("✓ Conectada")
    EXPECT(page.locator("#ccResult")).to_contain_text("kg")
    EXPECT(page.locator("#ccName")).to_contain_text("Báscula USB (CH340 USB-Serial)")
    EXPECT(page.locator("#ccMethod")).to_contain_text("OTG")

    # el detector corrió en modo AUTO (todas las velocidades, sin marca)
    assert detect_bodies and detect_bodies[0]["profile_id"] == "auto"
    assert detect_bodies[0]["transport"] == "usb"
    assert detect_bodies[0]["device_id"] == 7
    assert detect_bodies[0]["baudrates"] == [1200, 2400, 4800, 9600, 19200]

    # conectó con el parser y la velocidad DETECTADOS
    assert connect_bodies and connect_bodies[0]["profile_id"] == "auto"
    assert connect_bodies[0]["parser"] == "matrix"
    assert connect_bodies[0]["baudrate"] == 4800

    # la config guardada permite reconectar sin volver a detectar
    cfg = page.evaluate("JSON.parse(localStorage.getItem('porcipeso_cfg'))")
    assert cfg["method"] == "otg"
    assert cfg["profile_id"] == "auto"
    assert cfg["parser"] == "matrix"
    assert cfg["baudrate"] == 4800
    assert cfg["usb"] == {"vid": 0x1A86, "pid": 0x7523, "name": "CH340 USB-Serial"}


def test_otg_avanzado_conserva_marcas_manuales(page, server_url):
    """El camino manual (marcas + baudios) sigue vivo tras 'Ajustes avanzados'."""
    page.add_init_script("window.__PORCIPESO_SHIM__ = { native: true };")
    page.route("**/api/usb/devices", lambda r: r.fulfill(json=[]))

    page.goto(server_url + "/#bascula")
    page.locator("#bConnStart").click()
    page.locator('#wizPane1 [data-method="otg"]').click()
    EXPECT(page.locator("#wizPane3")).to_have_class("wizpane active")

    page.locator("#bOtgAdvanced").click()
    # avanzado → paso 2 (marca y modelo) y luego el panel manual con baudios
    EXPECT(page.locator("#wizPane2")).to_have_class("wizpane active")
    page.locator("#wizCommons .commoncard").first.click()
    EXPECT(page.locator("#wizPane3")).to_have_class("wizpane active")
    EXPECT(page.locator("#wizQ3")).to_have_text("¿Qué hay conectado al teléfono?")
    EXPECT(page.locator("#wizBaud")).to_be_visible()      # velocidad manual
    EXPECT(page.locator("#bProbar")).to_be_visible()      # Probar/Guardar clásicos


# ------------------- 4bis) selector Bluetooth con badges Clásico / BLE

def test_bt_scan_muestra_badges_clasico_y_ble(page, server_url):
    """APK simulado: el scan combinado (clásico + BLE) pinta CADA dispositivo
    con su badge de TIPO ('Clásico' o 'BLE') en el selector 'Buscar básculas
    Bluetooth'. Endpoints nativos mockeados con page.route, como en el APK."""
    page.add_init_script("window.__PORCIPESO_SHIM__ = { native: true };")

    def handle_devices(route):  # emparejados (siempre clásicos) al instante
        route.fulfill(json=[
            {"name": "BC04-BT", "address": "00:14:03:05:59:02",
             "paired": True, "kind": "classic"},
        ])

    def handle_disc_start(route):
        route.fulfill(json={"started": True})

    def handle_disc(route):  # merge clásico + BLE, ciclo terminado
        route.fulfill(json={"devices": [
            {"name": "BC04-BT", "address": "00:14:03:05:59:02",
             "paired": True, "kind": "classic"},
            {"name": "PorciScale-BLE", "address": "AB:CD:EF:00:11:22",
             "paired": False, "kind": "ble"},
        ], "finished": True})

    page.route("**/api/bt/devices", handle_devices)
    page.route("**/api/bt/discovery/start", handle_disc_start)
    page.route("**/api/bt/discovery", handle_disc)

    page.goto(server_url + "/#bascula")
    page.locator("#bConnStart").click()

    # APK: Bluetooth + OTG → pregunta visible; elegimos Bluetooth
    EXPECT(page.locator("#wizPane1")).to_have_class("wizpane active")
    page.locator('#wizPane1 [data-method="bluetooth"]').click()
    EXPECT(page.locator("#wizPane3")).to_have_class("wizpane active")

    # el selector muestra AMBOS dispositivos, cada uno con su badge de TIPO
    btlist = page.locator("#btList")
    EXPECT(btlist.locator(".bt-item")).to_have_count(2, timeout=10_000)
    EXPECT(btlist).to_contain_text("Clásico")
    EXPECT(btlist).to_contain_text("BLE")

    # el badge BLE está en la fila del módulo BLE; el Clásico en la del clásico
    ble_row = btlist.locator(".bt-item", has_text="PorciScale-BLE")
    EXPECT(ble_row.locator(".bt-kind.ble")).to_have_text("BLE")
    classic_row = btlist.locator(".bt-item", has_text="BC04-BT")
    EXPECT(classic_row.locator(".bt-kind.classic")).to_have_text("Clásico")


# ------------- 4ter) fallo de conexión → botones de recuperación (emparejar/BLE)

def test_bt_connect_fallo_muestra_botones_recuperacion(page, server_url):
    """Bug de campo: el módulo 'RS232/485' (dual-mode) aparece como Clásico
    pero el SPP no conecta ('read ret: -1'). Al fallar, la UI debe ofrecer
    botones accionables: '🔗 Emparejar e intentar de nuevo' (re-dispara el
    connect, que ahora AUTO-empareja en el nativo) y, como es dual-mode,
    'Probar como BLE'. Estado forzado con page.route (como en el APK)."""
    page.add_init_script("window.__PORCIPESO_SHIM__ = { native: true };")

    dual = {"name": "RS232/485", "address": "48:87:2D:9D:D5:71",
            "paired": False, "kind": "classic", "alsoBle": True}

    def handle_devices(route):  # emparejados: ninguno
        route.fulfill(json=[])

    def handle_disc_start(route):
        route.fulfill(json={"started": True})

    def handle_disc(route):  # el dual-mode aparece como cercano, con alsoBle
        route.fulfill(json={"devices": [dual], "finished": True})

    def handle_detect(route):  # el SPP no conecta: el síntoma exacto de campo
        route.fulfill(status=502,
                      json={"detail": "SPP no conectó (read failed... read ret: -1)"})

    page.route("**/api/bt/devices", handle_devices)
    page.route("**/api/bt/discovery/start", handle_disc_start)
    page.route("**/api/bt/discovery", handle_disc)
    page.route("**/api/scale/detect", handle_detect)

    page.goto(server_url + "/#bascula")
    page.locator("#bConnStart").click()

    # APK: Bluetooth + OTG → elegimos Bluetooth (flujo automático)
    EXPECT(page.locator("#wizPane1")).to_have_class("wizpane active")
    page.locator('#wizPane1 [data-method="bluetooth"]').click()
    EXPECT(page.locator("#wizPane3")).to_have_class("wizpane active")

    # aparece el módulo dual-mode; tocarlo dispara detect → falla
    device = page.locator("#btList .bt-item", has_text="RS232/485")
    EXPECT(device).to_have_count(1, timeout=10_000)
    device.click()

    # botones de RECUPERACIÓN en #btAutoStatus
    recover = page.locator("#btAutoStatus .bt-recover")
    EXPECT(recover).to_be_visible(timeout=10_000)
    EXPECT(recover.get_by_text("Emparejar e intentar de nuevo")).to_be_visible()
    # dual-mode → botón "Probar como BLE"
    EXPECT(recover.get_by_text("Probar como BLE")).to_be_visible()

    # "Probar como BLE" reintenta por BLE: el detect BLE ahora responde OK y
    # el connect deja la báscula conectada → tarjeta "✓ Conectada".
    detect_bodies: list[dict] = []
    connect_bodies: list[dict] = []

    def handle_detect_ok(route):
        detect_bodies.append(route.request.post_data_json)
        route.fulfill(json={
            "ok": True, "verdict": "directa", "kg": 126.35,
            "invert_bits": False, "reverse_frame": False, "parser_ok": True,
            "parser": "matrix", "message": "✓ La báscula responde: 126.35 kg",
            "hex": "3D 20 31 32 36",
        })

    def handle_connect_ok(route):
        connect_bodies.append(route.request.post_data_json)
        route.fulfill(json={"connected": True, "profile_id": "auto", "transport": "ble"})

    page.unroute("**/api/scale/detect")
    page.route("**/api/scale/detect", handle_detect_ok)
    page.route("**/api/scale/connect", handle_connect_ok)

    recover.get_by_text("Probar como BLE").click()
    EXPECT(page.locator("#connCard")).to_be_visible(timeout=10_000)
    EXPECT(page.locator("#ccResult")).to_contain_text("✓ Conectada")

    # el reintento por BLE usó transport:'ble' a la MISMA MAC
    assert detect_bodies and detect_bodies[0]["transport"] == "ble"
    assert detect_bodies[0]["port"] == "48:87:2D:9D:D5:71"
    assert connect_bodies and connect_bodies[0]["transport"] == "ble"
    # y la config guardada queda como BLE para reconectar directo
    cfg = page.evaluate("JSON.parse(localStorage.getItem('porcipeso_cfg'))")
    assert cfg["transport"] == "ble"
    assert cfg["kind"] == "ble"


# --------- 4quater) "Probar como BLE" SIEMPRE, aunque NO sea dual-mode

def test_probar_como_ble_visible_para_cualquier_dispositivo(page, server_url):
    """Un módulo etiquetado 'clásico'/'cercano' que en realidad es BLE debe
    poder forzarse: 'Probar como BLE' aparece tras un fallo AUNQUE el
    dispositivo NO sea dual-mode (sin alsoBle)."""
    page.add_init_script("window.__PORCIPESO_SHIM__ = { native: true };")

    dev = {"name": "HC-05", "address": "98:D3:31:F0:12:34",
           "paired": False, "kind": "classic"}  # sin alsoBle

    page.route("**/api/bt/devices", lambda r: r.fulfill(json=[]))
    page.route("**/api/bt/discovery/start", lambda r: r.fulfill(json={"started": True}))
    page.route("**/api/bt/discovery",
               lambda r: r.fulfill(json={"devices": [dev], "finished": True}))
    page.route("**/api/scale/detect",
               lambda r: r.fulfill(status=502,
                                   json={"detail": "SPP no conectó (read ret: -1)"}))

    page.goto(server_url + "/#bascula")
    page.locator("#bConnStart").click()
    EXPECT(page.locator("#wizPane1")).to_have_class("wizpane active")
    page.locator('#wizPane1 [data-method="bluetooth"]').click()
    EXPECT(page.locator("#wizPane3")).to_have_class("wizpane active")

    device = page.locator("#btList .bt-item", has_text="HC-05")
    EXPECT(device).to_have_count(1, timeout=10_000)
    device.click()

    recover = page.locator("#btAutoStatus .bt-recover")
    EXPECT(recover).to_be_visible(timeout=10_000)
    # NO es dual-mode y AÚN así ofrece "Probar como BLE"
    EXPECT(recover.get_by_text("Probar como BLE")).to_be_visible()


# --------- 4quinquies) diagnóstico GATT copiable cuando el BLE no tiene UART

def test_diagnostico_gatt_copiable_cuando_ble_sin_uart(page, server_url):
    """🔎 Cuando el connect BLE no halla una característica UART usable, el
    backend devuelve la lista de servicios/características del módulo y la UI la
    muestra en un bloque COPIABLE ('Detalle técnico del módulo — envíaselo a
    soporte') con botón Copiar — así se clava un perfil raro por su UUID."""
    page.add_init_script("window.__PORCIPESO_SHIM__ = { native: true };")

    dev = {"name": "RS232/485", "address": "48:87:2D:9D:D5:71",
           "paired": False, "kind": "ble"}

    page.route("**/api/bt/devices", lambda r: r.fulfill(json=[]))
    page.route("**/api/bt/discovery/start", lambda r: r.fulfill(json={"started": True}))
    page.route("**/api/bt/discovery",
               lambda r: r.fulfill(json={"devices": [dev], "finished": True}))

    def handle_detect(route):  # la escucha detecta parser OK (transporte BLE)
        route.fulfill(json={
            "ok": True, "parser_ok": True, "parser": "matrix",
            "invert_bits": False, "reverse_frame": False, "kg": 126.35,
            "message": "✓ La báscula responde: 126.35 kg", "hex": "3D 20 31 32 36",
        })

    def handle_connect(route):  # pero al conectar, el GATT no expone NOTIFY
        route.fulfill(status=400, json={
            "detail": "Ese dispositivo BLE no expone una característica de datos (NOTIFY).",
            "gatt": [{
                "uuid": "0000180a-0000-1000-8000-00805f9b34fb",
                "characteristics": [
                    {"uuid": "00002a29-0000-1000-8000-00805f9b34fb", "properties": ["read"]},
                ],
            }],
            "gatt_text": ("Servicio 0000180a-0000-1000-8000-00805f9b34fb\n"
                          "  · 00002a29-0000-1000-8000-00805f9b34fb [read]"),
        })

    page.route("**/api/scale/detect", handle_detect)
    page.route("**/api/scale/connect", handle_connect)

    page.goto(server_url + "/#bascula")
    page.locator("#bConnStart").click()
    EXPECT(page.locator("#wizPane1")).to_have_class("wizpane active")
    page.locator('#wizPane1 [data-method="bluetooth"]').click()
    EXPECT(page.locator("#wizPane3")).to_have_class("wizpane active")

    device = page.locator("#btList .bt-item", has_text="RS232/485")
    EXPECT(device).to_have_count(1, timeout=10_000)
    device.click()

    # el bloque de diagnóstico GATT copiable aparece con el UUID exacto
    diag = page.locator("#btAutoStatus .gatt-diag")
    EXPECT(diag).to_be_visible(timeout=10_000)
    EXPECT(diag).to_contain_text("Detalle técnico del módulo")
    EXPECT(diag).to_contain_text("00002a29-0000-1000-8000-00805f9b34fb")
    EXPECT(diag.locator(".gatt-diag-copy")).to_be_visible()


# ---------------------- 5) "Usar báscula simulada" deja tarjeta de estado

def test_usar_simulada_guarda_config_y_tarjeta(page, server_url):
    """El atajo '🎛 Usar báscula simulada' (módulo Pesaje) guarda la config
    de la simulada, de modo que ⚙ Báscula muestra la tarjeta de estado con
    el chip vivo — y NO el "Todavía no has conectado una báscula"."""
    page.goto(server_url + "/#pesaje")
    EXPECT(page.locator("#bUseSim")).to_be_visible()
    page.locator("#bUseSim").click()
    EXPECT(page.locator("#scaleChip")).to_have_text("Báscula simulada",
                                                    timeout=10_000)

    # la config quedó guardada (reconexión de un toque en ⚙ Báscula)
    cfg = page.evaluate("JSON.parse(localStorage.getItem('porcipeso_cfg'))")
    assert cfg["method"] == "sim"
    assert cfg["profile_id"] == "sim"
    assert cfg["name"] == "Báscula simulada"

    # ⚙ Báscula: tarjeta visible con chip vivo, no el botón grande.
    # (`:visible` clica el botón del módulo que corresponda al viewport:
    # la barra lateral en escritorio o la barra inferior en móvil.)
    page.locator('[data-mod="bascula"]:visible').click()
    EXPECT(page.locator("#connCard")).to_be_visible()
    EXPECT(page.locator("#connEmpty")).to_be_hidden()
    EXPECT(page.locator("#ccName")).to_have_text("Báscula simulada")
    EXPECT(page.locator("#ccChip")).to_contain_text("Conectada", timeout=10_000)
    EXPECT(page.locator("#bccDisconnect")).to_be_visible()


def test_usar_simulada_no_pisa_config_real(page, server_url):
    """Si ya hay una báscula real guardada, practicar con la simulada
    NO debe pisar esa configuración."""
    _seed_cfg(page, {"method": "bluetooth", "profile_id": "matrix",
                     "name": "Trumax Matrix", "parser": "matrix"})
    page.goto(server_url + "/#pesaje")
    EXPECT(page.locator("#bUseSim")).to_be_visible()
    page.locator("#bUseSim").click()
    EXPECT(page.locator("#scaleChip")).to_have_text("Báscula simulada",
                                                    timeout=10_000)
    cfg = page.evaluate("JSON.parse(localStorage.getItem('porcipeso_cfg'))")
    assert cfg["profile_id"] == "matrix"  # la real sigue intacta
    assert cfg["method"] == "bluetooth"


# ---------------------- 6) "Volver a báscula real" sale de la práctica

def test_volver_a_bascula_real_desde_home_sin_config(page, server_url):
    """Sin báscula real: entrar a la simulada desde el home ofrece
    '↩ Volver a báscula real'; al tocarlo, la sim se desconecta, la config
    demo se borra (queda 'Sin báscula') y reaparece 'Usar báscula simulada'."""
    page.goto(server_url + "/#pesaje")

    # fuera de práctica: se ofrece ENTRAR, no SALIR
    EXPECT(page.locator("#bUseSim")).to_be_visible()
    EXPECT(page.locator("#bBackReal")).to_be_hidden()

    # entrar a la simulada
    page.locator("#bUseSim").click()
    EXPECT(page.locator("#scaleChip")).to_have_text("Báscula simulada",
                                                    timeout=10_000)
    # ahora los enlaces se INVIERTEN: salir visible, entrar oculto
    EXPECT(page.locator("#bBackReal")).to_be_visible()
    EXPECT(page.locator("#bUseSim")).to_be_hidden()
    # la config demo quedó guardada (no había báscula real)
    cfg = page.evaluate("JSON.parse(localStorage.getItem('porcipeso_cfg'))")
    assert cfg["profile_id"] == "sim"

    # volver a báscula real → estado limpio
    page.locator("#bBackReal").click()
    EXPECT(page.locator("#scaleChip")).to_have_text("Sin báscula",
                                                    timeout=10_000)
    EXPECT(page.locator("#scaleChip")).to_have_class("chip err")
    # los enlaces vuelven al estado inicial
    EXPECT(page.locator("#bUseSim")).to_be_visible()
    EXPECT(page.locator("#bBackReal")).to_be_hidden()
    # sim desconectada en el backend
    st = page.evaluate("fetch('/api/scale/status').then(r => r.json())")
    assert st["connected"] is False
    # config demo borrada (no quedamos pegados en práctica)
    cfg = page.evaluate("localStorage.getItem('porcipeso_cfg')")
    assert cfg is None


def test_volver_a_bascula_real_restaura_config_real(page, server_url):
    """Con una báscula REAL guardada: practicar y luego 'Volver a báscula
    real' NO borra la config real — el home vuelve a esa báscula guardada."""
    _seed_cfg(page, {"method": "bluetooth", "profile_id": "matrix",
                     "name": "Trumax Matrix", "parser": "matrix"})
    page.goto(server_url + "/#pesaje")

    page.locator("#bUseSim").click()
    EXPECT(page.locator("#scaleChip")).to_have_text("Báscula simulada",
                                                    timeout=10_000)
    EXPECT(page.locator("#bBackReal")).to_be_visible()

    # salir de la práctica → vuelve a la báscula REAL guardada, no a "Sin báscula"
    page.locator("#bBackReal").click()
    EXPECT(page.locator("#scaleChip")).to_have_text("Trumax Matrix",
                                                    timeout=10_000)
    EXPECT(page.locator("#bUseSim")).to_be_visible()
    EXPECT(page.locator("#bBackReal")).to_be_hidden()
    # la config real sigue intacta
    cfg = page.evaluate("JSON.parse(localStorage.getItem('porcipeso_cfg'))")
    assert cfg["profile_id"] == "matrix"
    assert cfg["method"] == "bluetooth"
    # y la sim quedó desconectada en el backend
    st = page.evaluate("fetch('/api/scale/status').then(r => r.json())")
    assert st["connected"] is False
