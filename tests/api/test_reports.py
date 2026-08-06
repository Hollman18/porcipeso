"""Informes PDF con marca ELEIA (porcipeso/api/reports.py) + xlsx marcado."""
from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from porcipeso import branding
from porcipeso.api.app import create_app
from porcipeso.core.models import EventType, WeighEvent
from porcipeso.db.repo import Repo

from .fake_engine import FakeEngine


def _seed(db_path) -> dict[str, int]:
    """Una sesión cerrada con eventos + conciliación, y una abierta."""
    repo = Repo(db_path)
    sid = repo.create_session({
        "lote": "Lote 47 — corral C-2", "corral_origen": "C-2",
        "destino": "Planta Norte", "placa": "ABC-123",
        "conductor": "Pedro", "operador": "Marta", "modo": "lote",
        "hora_entrada": "2026-07-15T08:00:00+00:00",
    })

    def ev(ts_ms, antes, despues, n, tipo, motivo=None,
           ambiguo=False, opciones=()):
        return repo.insert_event(WeighEvent(
            id=None, session_id=sid, ts_ms=ts_ms, peso_antes=antes,
            peso_despues=despues, delta_kg=despues - antes,
            animales_estimados=n, tipo=tipo, motivo_bajada=motivo,
            ambiguo=ambiguo, opciones=list(opciones),
        ))

    ev(1_000, 0.0, 100.0, 1, EventType.REFERENCIA)
    ev(5_000, 0.0, 105.0, 1, EventType.SUBIDA)
    ev(9_000, 105.0, 315.0, 2, EventType.SUBIDA)
    ev(13_000, 315.0, 210.0, 1, EventType.BAJADA, motivo="estres")
    ev(17_000, 210.0, 305.0, 1, EventType.SUBIDA)
    # peso ambiguo que el operador confirmó (sale como detalle en informes)
    amb = ev(21_000, 305.0, 515.0, 2, EventType.SUBIDA,
             ambiguo=True, opciones=[2, 3])
    repo.update_event_confirm(amb, 2, "Marta")
    repo.close_session(
        sid, {"total_kg": 515.0, "count": 5, "avg_kg": 515.0 / 5},
        conteo_fisico=5,
    )
    abierta = repo.create_session({
        "lote": "L-abierta", "hora_entrada": "2026-07-16T09:00:00+00:00",
    })
    repo.close()
    return {"cerrada": sid, "abierta": abierta}


@pytest.fixture()
def ctx(tmp_path):
    db_path = tmp_path / "reports.db"
    ids = _seed(db_path)
    app = create_app(
        db_path,
        engine_factory=lambda cfg, on_event, on_state=None: FakeEngine(
            cfg, on_event, on_state
        ),
    )
    with TestClient(app) as client:
        yield client, ids


def _pdf_text(content: bytes) -> str | None:
    """Texto plano del PDF si pypdf está disponible (smoke opcional)."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return None
    reader = PdfReader(io.BytesIO(content))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


# ---------------------------------------------------------------- PDF sesión

def test_session_report_pdf(ctx):
    client, ids = ctx
    resp = client.get(f"/api/sessions/{ids['cerrada']}/report.pdf")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/pdf")
    assert resp.content.startswith(b"%PDF")
    assert len(resp.content) > 5_000

    text = _pdf_text(resp.content)
    if text is not None:
        assert branding.PRODUCT_NAME in text
        assert branding.COMPANY in text
        assert "Lote 47" in text
        assert "Cerdo de prueba" in text        # tipo en español
        assert "Conciliación" in text.replace("\n", "")


def test_session_report_pdf_abierta_tambien_sale(ctx):
    client, ids = ctx
    resp = client.get(f"/api/sessions/{ids['abierta']}/report.pdf")
    assert resp.status_code == 200
    assert resp.content.startswith(b"%PDF")


def test_session_report_pdf_404(ctx):
    client, _ = ctx
    assert client.get("/api/sessions/9999/report.pdf").status_code == 404


# ---------------------------------------------------------------- PDF global

def test_global_report_pdf(ctx):
    client, _ = ctx
    resp = client.get("/api/reports/global.pdf")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/pdf")
    assert resp.content.startswith(b"%PDF")
    assert len(resp.content) > 2_000

    text = _pdf_text(resp.content)
    if text is not None:
        assert branding.PRODUCT_NAME in text
        assert branding.COMPANY in text


def test_global_report_pdf_con_rango(ctx):
    client, _ = ctx
    resp = client.get(
        "/api/reports/global.pdf",
        params={"desde": "2026-07-15", "hasta": "2026-07-15"},
    )
    assert resp.status_code == 200
    assert resp.content.startswith(b"%PDF")


# --------------------------------------------------------- xlsx con la marca

def test_xlsx_sigue_valido_y_con_marca(ctx):
    client, ids = ctx
    resp = client.get(f"/api/sessions/{ids['cerrada']}/export.xlsx")
    assert resp.status_code == 200
    wb = load_workbook(io.BytesIO(resp.content))
    assert wb.sheetnames == ["Resumen", "Eventos"]
    ws = wb["Resumen"]

    # filas de marca al tope (constantes de branding, no strings sueltos)
    assert ws.cell(row=1, column=1).value == (
        f"{branding.PRODUCT_NAME} — Informe de pesaje"
    )
    assert ws.cell(row=2, column=1).value == (
        f"una solución {branding.COMPANY} · {branding.TAGLINE_COMPANY}"
    )
    # fill verde Eleia + tipografía blanca en bold
    c1 = ws.cell(row=1, column=1)
    assert c1.font.bold is True
    assert str(c1.font.color.rgb).endswith(
        branding.ELEIA_GREEN.lstrip("#").upper()
    ) is False  # la letra es blanca, no verde
    assert str(c1.font.color.rgb).endswith("FFFFFF")
    assert str(c1.fill.fgColor.rgb).endswith(branding.ELEIA_GREEN.lstrip("#"))

    # el resumen clásico sigue ahí (por etiqueta, indiferente a la fila)
    resumen = {row[0]: row[1] for row in ws.iter_rows(values_only=True)
               if row and row[0]}
    assert resumen["Lote"] == "Lote 47 — corral C-2"
    assert resumen["Total animales"] == 5

    # pie con versión + ELEIA
    pie = [row[0] for row in ws.iter_rows(values_only=True)
           if row and isinstance(row[0], str) and row[0].startswith("Generado por")]
    assert len(pie) == 1
    assert branding.COMPANY in pie[0]
    assert f"v{branding.get_version()}" in pie[0]


def test_xlsx_diseno_resumen(ctx):
    """Diseño del Resumen: secciones, tarjetas combinadas, movimientos
    en español y nota 'en cristiano'."""
    client, ids = ctx
    resp = client.get(f"/api/sessions/{ids['cerrada']}/export.xlsx")
    wb = load_workbook(io.BytesIO(resp.content))
    ws = wb["Resumen"]

    todas = [row for row in ws.iter_rows()]
    textos = {str(c.value) for row in todas for c in row if c.value is not None}

    # encabezados de sección en mayúsculas
    for section in ("DATOS DEL LOTE", "TOTALES",
                    "ESTADÍSTICA DEL LOTE", "MOVIMIENTOS"):
        assert section in textos

    # tarjetas de totales: celdas combinadas, número grande verde PorciPeso
    merges = {str(m) for m in ws.merged_cells.ranges}
    card_cells = [c for row in todas for c in row
                  if c.value == "CERDOS"]
    assert card_cells, "falta la tarjeta CERDOS"
    label = card_cells[0]
    valor = ws.cell(row=label.row - 1, column=label.column)
    assert valor.value == 5
    assert valor.font.bold is True
    assert valor.font.size >= 16
    assert str(valor.font.color.rgb).endswith(
        branding.PORCIPESO_GREEN.lstrip("#"))
    assert valor.fill.fgColor.rgb.endswith(
        branding.REPORT_CARD_BG.lstrip("#"))
    assert any(":" in m for m in merges)  # hay celdas combinadas

    # movimientos con tipos en español + detalle del ambiguo confirmado
    assert "Cerdo de prueba" in textos
    assert "Bajada" in textos
    assert any("confirmado por Marta" in t for t in textos)
    assert any(t.startswith("En cristiano:") for t in textos)

    # claves en bold + bordes finos en la tabla clave-valor
    lote_cell = next(c for row in todas for c in row if c.value == "Lote")
    assert lote_cell.font.bold is True
    assert lote_cell.border.bottom.style == "thin"


def test_xlsx_eventos_estilizados(ctx):
    """Hoja Eventos: header verde, freeze panes, autofiltro y formatos."""
    client, ids = ctx
    resp = client.get(f"/api/sessions/{ids['cerrada']}/export.xlsx")
    wb = load_workbook(io.BytesIO(resp.content))
    we = wb["Eventos"]

    assert we.freeze_panes == "A2"
    assert we.auto_filter.ref is not None
    assert we.auto_filter.ref.startswith("A1:")

    hdr = we.cell(row=1, column=1)
    assert hdr.fill.fgColor.rgb.endswith(branding.ELEIA_GREEN.lstrip("#"))
    assert hdr.font.bold is True
    assert str(hdr.font.color.rgb).endswith("FFFFFF")

    header = [c.value for c in we[1]]
    idx_delta = header.index("delta_kg") + 1
    delta = we.cell(row=2, column=idx_delta)
    assert delta.number_format == "#,##0.0"
    assert delta.border.top.style == "thin"
