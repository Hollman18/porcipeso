"""Informes PDF con marca — "PorciPeso · una solución ELEIA".

Dos endpoints (reportlab, A4):

- ``GET /api/sessions/{id}/report.pdf`` — informe profesional de UNA
  sesión: encabezado con lockup, datos del lote, tarjetas de totales,
  estadística con nota en humano, movimientos y conciliación.
- ``GET /api/reports/global.pdf?desde&hasta`` — resumen ejecutivo:
  totales globales + tabla por lote (``repo.stats_global``).

En la app MÓVIL (APK) reportlab no corre: el shim TS responde la misma
ruta ``report.pdf`` con una vista HTML imprimible equivalente y Android
genera el PDF nativo con ``window.print()`` (ver mobile/src/reportview.ts).

Toda la marca sale de ``porcipeso.branding`` — nada de strings sueltos.
"""
from __future__ import annotations

import io
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from porcipeso import branding

router = APIRouter()

PDF_MEDIA_TYPE = "application/pdf"

#: tipos de evento del motor → texto humano de los informes
TIPO_HUMANO = {
    "referencia": "Cerdo de prueba",
    "subida": "Subida",
    "bajada": "Bajada",
    "reingreso": "Reingreso",
    "ajuste": "Ajuste",
}

STATS_LABELS = [
    ("Mediana (kg)", "mediana"),
    ("Desviación estándar muestral (kg)", "desviacion_std"),
    ("Varianza muestral (kg²)", "varianza"),
    ("CV %", "cv_pct"),
    ("Uniformidad ±10% (%)", "uniformidad_pct"),
    ("Tipo de muestra", "tipo_muestra"),
]


# ------------------------------------------------------------------ helpers

def _fmt(value: Any, decimals: int = 1) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:,.{decimals}f}".replace(",", " ")
    return str(value)


def _fecha(iso: Optional[str]) -> str:
    if not iso:
        return "—"
    try:
        return datetime.fromisoformat(iso).strftime("%d/%m/%Y %H:%M")
    except ValueError:
        return str(iso)


def _hora_ms(ts_ms: Any) -> str:
    try:
        return datetime.fromtimestamp(float(ts_ms) / 1000.0).strftime("%H:%M:%S")
    except (TypeError, ValueError, OSError):
        return "—"


def _nota_humana(stats: dict[str, Any]) -> str:
    """La firma de PorciPeso también en el papel: hablar claro."""
    u = stats.get("uniformidad_pct")
    if u is None:
        return ("Sin muestras individuales suficientes para medir qué tan "
                "parejo está el lote.")
    if float(u) >= 70.0:
        return (f"Lote parejo: {round(float(u))}% de los cerdos pesados uno a "
                "uno están cerca del promedio.")
    return (f"Lote disparejo: solo {round(float(u))}% está cerca del promedio "
            "— hay cerdos muy distintos entre sí.")


# ----------------------------------------------------------- lienzo platypus

#: márgenes y bandas del documento (cm) — compartidos por bandas y frames
_MARGIN_CM = 1.7
_BAND_FIRST_CM = 3.6   # banda de portada (título + chip + fechas)
_BAND_LATER_CM = 1.05  # banda slim de páginas siguientes
_FOOTER_CM = 2.05


def _c(hex_color: str):
    from reportlab.lib import colors

    return colors.HexColor(hex_color)


def _styles():
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet

    charcoal = branding.ELEIA_CHARCOAL
    base = getSampleStyleSheet()
    return {
        "h2": ParagraphStyle(
            "pp-h2", parent=base["Heading2"], fontName="Helvetica-Bold",
            fontSize=10.5, leading=13, textColor=charcoal,
            spaceBefore=0, spaceAfter=0,
        ),
        "body": ParagraphStyle(
            "pp-body", parent=base["Normal"], fontSize=9.5, leading=13,
            textColor=charcoal,
        ),
        "note": ParagraphStyle(
            "pp-note", parent=base["Normal"], fontSize=9.5, leading=13.5,
            textColor=charcoal,
        ),
        "cell": ParagraphStyle(
            "pp-cell", parent=base["Normal"], fontSize=8.5, leading=11,
            textColor=charcoal,
        ),
    }


# --------------------------------------------------- bandas de marca (canvas)


def _draw_band_first(canvas, doc, meta: dict[str, str]) -> None:
    """Portada: banda verde Eleia con lockup, título, chip del lote y fechas."""
    from reportlab.lib import colors
    from reportlab.lib.units import cm

    w, h = doc.pagesize
    m = _MARGIN_CM * cm
    band_h = _BAND_FIRST_CM * cm
    canvas.saveState()

    canvas.setFillColor(_c(branding.ELEIA_GREEN))
    canvas.rect(0, h - band_h, w, band_h, stroke=0, fill=1)
    # remate inferior en verde oscuro (da profundidad a la banda)
    canvas.setFillColor(_c(branding.ELEIA_GREEN_DARK))
    canvas.rect(0, h - band_h, w, 0.12 * cm, stroke=0, fill=1)

    # --- título: producto en bold + nombre del informe al lado
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 21)
    y_title = h - 1.22 * cm
    canvas.drawString(m, y_title, branding.PRODUCT_NAME)
    tw = canvas.stringWidth(branding.PRODUCT_NAME, "Helvetica-Bold", 21)
    canvas.setFont("Helvetica", 12.5)
    canvas.drawString(m + tw + 0.28 * cm, y_title, f"—  {meta['title']}")

    # --- subtítulo del lockup
    canvas.setFillColor(_c("#EAF5DA"))
    canvas.setFont("Helvetica", 8.5)
    canvas.drawString(
        m, h - 1.80 * cm,
        f"una solución {branding.COMPANY} · {branding.TAGLINE_COMPANY}",
    )

    # --- chip del lote (píldora verde oscuro) + fechas a su derecha
    chip = meta.get("chip") or ""
    if chip:
        canvas.setFont("Helvetica-Bold", 9)
        cw = canvas.stringWidth(chip, "Helvetica-Bold", 9)
        chip_h = 0.64 * cm
        chip_y = h - band_h + 0.46 * cm
        canvas.setFillColor(_c(branding.ELEIA_GREEN_DARK))
        canvas.roundRect(m, chip_y, cw + 0.72 * cm, chip_h, 0.32 * cm,
                         stroke=0, fill=1)
        canvas.setFillColor(colors.white)
        canvas.drawString(m + 0.36 * cm, chip_y + 0.205 * cm, chip)
        dates = meta.get("dates") or ""
        if dates:
            canvas.setFillColor(_c("#EAF5DA"))
            canvas.setFont("Helvetica", 8.5)
            canvas.drawString(m + cw + 1.10 * cm, chip_y + 0.205 * cm, dates)

    # --- logo Eleia sobre placa blanca, o wordmark tipográfico
    logo = branding.get_logo_path()
    right = w - m
    if logo is not None:
        pw, ph = 3.5 * cm, 1.45 * cm
        py = h - 0.62 * cm - ph
        canvas.setFillColor(colors.white)
        canvas.roundRect(right - pw, py, pw, ph, 0.16 * cm, stroke=0, fill=1)
        try:
            canvas.drawImage(
                str(logo), right - pw + 0.25 * cm, py + 0.18 * cm,
                width=pw - 0.5 * cm, height=ph - 0.36 * cm,
                preserveAspectRatio=True, anchor="c", mask="auto",
            )
        except Exception:
            pass  # placa blanca sola si el PNG no carga
    else:
        canvas.setFillColor(colors.white)
        canvas.setFont("Helvetica-Bold", 15)
        canvas.drawRightString(right, h - 1.22 * cm, branding.COMPANY)
        canvas.setFillColor(_c("#EAF5DA"))
        canvas.setFont("Helvetica", 7.5)
        canvas.drawRightString(right, h - 1.58 * cm, branding.TAGLINE_COMPANY)

    canvas.restoreState()


def _draw_band_later(canvas, doc, meta: dict[str, str]) -> None:
    """Páginas siguientes: banda slim con lockup e informe · chip."""
    from reportlab.lib import colors
    from reportlab.lib.units import cm

    w, h = doc.pagesize
    m = _MARGIN_CM * cm
    band_h = _BAND_LATER_CM * cm
    canvas.saveState()
    canvas.setFillColor(_c(branding.ELEIA_GREEN))
    canvas.rect(0, h - band_h, w, band_h, stroke=0, fill=1)
    canvas.setFillColor(_c(branding.ELEIA_GREEN_DARK))
    canvas.rect(0, h - band_h, w, 0.08 * cm, stroke=0, fill=1)
    baseline = h - band_h / 2 - 0.11 * cm
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(m, baseline, branding.LOCKUP)
    canvas.setFillColor(_c("#EAF5DA"))
    canvas.setFont("Helvetica", 8.5)
    right_txt = meta["title"]
    if meta.get("chip"):
        right_txt = f"{meta['title']} · {meta['chip']}"
    canvas.drawRightString(w - m, baseline, right_txt)
    canvas.restoreState()


def _numbered_canvas_factory(footer_left: str):
    """Canvas de dos pasadas: pie con 'Página X de Y' + línea de marca."""
    from reportlab.lib.units import cm
    from reportlab.pdfgen import canvas as pdfcanvas

    class _NumberedCanvas(pdfcanvas.Canvas):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self._saved_states: list[dict[str, Any]] = []

        def showPage(self) -> None:  # noqa: N802 (API reportlab)
            self._saved_states.append(dict(self.__dict__))
            self._startPage()

        def save(self) -> None:
            total = len(self._saved_states)
            for state in self._saved_states:
                self.__dict__.update(state)
                self._draw_footer(total)
                pdfcanvas.Canvas.showPage(self)
            pdfcanvas.Canvas.save(self)

        def _draw_footer(self, total: int) -> None:
            w = self._pagesize[0]
            m = _MARGIN_CM * cm
            self.saveState()
            self.setStrokeColor(_c(branding.ELEIA_GREEN))
            self.setLineWidth(0.9)
            self.line(m, 1.55 * cm, w - m, 1.55 * cm)
            self.setFont("Helvetica", 7.5)
            self.setFillColor(_c(branding.ELEIA_CHARCOAL))
            self.drawString(m, 1.15 * cm, footer_left)
            self.drawRightString(
                w - m, 1.15 * cm, f"Página {self._pageNumber} de {total}"
            )
            self.restoreState()

    return _NumberedCanvas


# -------------------------------------------------------- flowables de diseño


def _totals_cards(cards: list[tuple[str, str]]):
    """Tarjetas de totales: rectángulos redondeados con relleno suave,
    número grande centrado en verde PorciPeso y etiqueta pequeña."""
    from reportlab.lib.units import cm
    from reportlab.platypus import Flowable

    class _Cards(Flowable):
        def wrap(self, avail_w: float, avail_h: float):
            self.width = avail_w
            self.height = 2.35 * cm
            return self.width, self.height

        def draw(self) -> None:
            c = self.canv
            n = len(cards)
            gap = 0.42 * cm
            cw = (self.width - gap * (n - 1)) / n
            for i, (value, label) in enumerate(cards):
                x = i * (cw + gap)
                c.setFillColor(_c(branding.REPORT_CARD_BG))
                c.setStrokeColor(_c(branding.REPORT_CARD_BORDER))
                c.setLineWidth(1)
                c.roundRect(x, 0, cw, self.height, 0.22 * cm,
                            stroke=1, fill=1)
                # acento superior centrado
                c.setFillColor(_c(branding.ELEIA_GREEN))
                c.rect(x + cw / 2 - 0.55 * cm, self.height - 0.30 * cm,
                       1.1 * cm, 0.085 * cm, stroke=0, fill=1)
                # número grande (se encoge si no cabe)
                size = 19.0
                while (c.stringWidth(value, "Helvetica-Bold", size)
                       > cw - 0.5 * cm and size > 9):
                    size -= 0.5
                c.setFont("Helvetica-Bold", size)
                c.setFillColor(_c(branding.PORCIPESO_GREEN))
                c.drawCentredString(x + cw / 2, self.height / 2 - 0.13 * cm,
                                    value)
                # etiqueta pequeña
                c.setFont("Helvetica-Bold", 7.2)
                c.setFillColor(_c(branding.ELEIA_CHARCOAL))
                c.drawCentredString(x + cw / 2, 0.42 * cm, label)

    return _Cards()


def _section(title: str) -> list[Any]:
    """Encabezado de sección con barrita verde de acento a la izquierda."""
    from reportlab.lib.units import cm
    from reportlab.platypus import Paragraph, Spacer, Table, TableStyle

    st = _styles()
    t = Table(
        [["", Paragraph(title.upper(), st["h2"])]],
        colWidths=[0.14 * cm, None], rowHeights=[0.52 * cm],
    )
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), _c(branding.ELEIA_GREEN)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
        ("RIGHTPADDING", (0, 0), (0, 0), 0),
        ("LEFTPADDING", (1, 0), (1, 0), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return [Spacer(0, 13), t, Spacer(0, 5)]


def _kv_table(rows: list[tuple[str, str]], col_label: float, col_value: float):
    """Tabla clave-valor: claves bold gris carbón, bordes finos, zebra."""
    from reportlab.lib import colors
    from reportlab.platypus import Table, TableStyle

    t = Table(rows, colWidths=[col_label, col_value])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (1, 0), (1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TEXTCOLOR", (0, 0), (-1, -1), _c(branding.ELEIA_CHARCOAL)),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1),
         [colors.white, _c(branding.REPORT_ZEBRA)]),
        ("GRID", (0, 0), (-1, -1), 0.4, _c(branding.REPORT_BORDER)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ]))
    return t


def _data_table(header: list[str], rows: list[list[str]], col_widths=None,
                num_cols: tuple[int, ...] = (), totals_row: bool = False):
    """Tabla de datos: header verde Eleia, grid fino, zebra, números a la
    derecha; ``repeatRows=1`` repite el encabezado al saltar de página."""
    from reportlab.lib import colors
    from reportlab.platypus import Table, TableStyle

    t = Table([header] + rows, colWidths=col_widths, repeatRows=1)
    cmds: list[Any] = [
        ("BACKGROUND", (0, 0), (-1, 0), _c(branding.ELEIA_GREEN)),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("LINEBELOW", (0, 0), (-1, 0), 1.1, _c(branding.ELEIA_GREEN_DARK)),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("TEXTCOLOR", (0, 1), (-1, -1), _c(branding.ELEIA_CHARCOAL)),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
         [colors.white, _c(branding.REPORT_ZEBRA)]),
        ("GRID", (0, 0), (-1, -1), 0.4, _c(branding.REPORT_BORDER)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]
    for ci in num_cols:
        cmds.append(("ALIGN", (ci, 0), (ci, -1), "RIGHT"))
    if totals_row:
        cmds += [
            ("BACKGROUND", (0, -1), (-1, -1), _c("#E7F1D8")),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("LINEABOVE", (0, -1), (-1, -1), 1.1,
             _c(branding.ELEIA_GREEN_DARK)),
        ]
    t.setStyle(TableStyle(cmds))
    return t


def _note_callout(text: str):
    """Callout "en cristiano": fondo suave + borde izquierdo verde."""
    from reportlab.platypus import Paragraph, Table, TableStyle

    st = _styles()
    t = Table([[Paragraph(text, st["note"])]], colWidths=["100%"])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _c(branding.REPORT_NOTE_BG)),
        ("LINEBEFORE", (0, 0), (0, -1), 2.6, _c(branding.ELEIA_GREEN)),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ]))
    return t


def _build_doc(story: list[Any], meta: dict[str, str]) -> bytes:
    """Documento A4 con banda de portada, banda slim en páginas siguientes
    y pie 'Página X de Y' (canvas de dos pasadas)."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import cm
    from reportlab.platypus import (
        BaseDocTemplate, Frame, NextPageTemplate, PageTemplate,
    )

    buf = io.BytesIO()
    m = _MARGIN_CM * cm
    doc = BaseDocTemplate(
        buf, pagesize=A4,
        leftMargin=m, rightMargin=m,
        topMargin=(_BAND_FIRST_CM + 0.55) * cm, bottomMargin=_FOOTER_CM * cm,
        title=f"{branding.PRODUCT_NAME} — {meta['title']}",
        author=f"{branding.PRODUCT_NAME} · {branding.COMPANY}",
        pageCompression=0,  # streams legibles (y peso estable en tests)
    )
    page_w, page_h = A4
    frame_w = page_w - 2 * m

    def _frame(band_cm: float, fid: str) -> Frame:
        top = page_h - (band_cm + 0.55) * cm
        return Frame(m, _FOOTER_CM * cm, frame_w, top - _FOOTER_CM * cm,
                     id=fid, leftPadding=0, rightPadding=0,
                     topPadding=0, bottomPadding=0)

    doc.addPageTemplates([
        PageTemplate(
            id="first", frames=[_frame(_BAND_FIRST_CM, "f-first")],
            onPage=lambda c, d: _draw_band_first(c, d, meta),
        ),
        PageTemplate(
            id="later", frames=[_frame(_BAND_LATER_CM, "f-later")],
            onPage=lambda c, d: _draw_band_later(c, d, meta),
        ),
    ])
    generado = datetime.now().strftime("%d/%m/%Y %H:%M")
    footer_left = (
        f"{branding.LOCKUP} · Generado por {branding.PRODUCT_NAME} "
        f"v{branding.get_version()} · {generado}"
    )
    doc.build(
        [NextPageTemplate("later"), *story],
        canvasmaker=_numbered_canvas_factory(footer_left),
    )
    return buf.getvalue()


# ------------------------------------------------------------- PDF sesión

def build_session_pdf(session: dict[str, Any], events: list[dict[str, Any]],
                      stats: dict[str, Any]) -> bytes:
    from reportlab.lib.units import cm
    from reportlab.platypus import KeepTogether, Paragraph, Spacer

    st = _styles()
    lote = str(session.get("lote") or "Sin lote")
    if len(lote) > 42:
        lote = lote[:41] + "…"
    entrada = _fecha(session.get("hora_entrada"))
    salida = _fecha(session.get("hora_salida"))
    # Sesión de PRÁCTICA (báscula simulada): el informe lo DICE — chip DEMO
    # en la banda + callout arriba. Jamás debe circular como pesaje real.
    es_demo = bool(session.get("es_demo"))
    meta = {
        "title": "Informe de pesaje",
        "chip": f"DEMO · {lote}" if es_demo else lote,
        "dates": f"Entrada {entrada}   ·   Salida {salida}",
    }
    story: list[Any] = []
    if es_demo:
        story.append(_note_callout(
            "<b>PESAJE DE PRÁCTICA (DEMO):</b> hecho con la báscula "
            "simulada. No es un pesaje real, no cuenta en las estadísticas "
            "y se borra solo una hora después de cerrado."))

    # ------------------------------------------------------ datos del lote
    story += _section("Datos del lote")
    modo = session.get("modo") or "lote"
    story.append(_kv_table([
        ("Lote", str(session.get("lote") or "—")),
        ("Entrada", _fecha(session.get("hora_entrada"))),
        ("Salida", _fecha(session.get("hora_salida"))),
        ("Corral de origen", str(session.get("corral_origen") or "—")),
        ("Destino", str(session.get("destino") or "—")),
        ("Placa del camión", str(session.get("placa") or "—")),
        ("Conductor", str(session.get("conductor") or "—")),
        ("Operador", str(session.get("operador") or "—")),
        ("Modo de pesaje",
         "Por unidades (un cerdo a la vez)" if modo == "unidades"
         else "Por lote (cerdo de prueba + grupos)"),
        ("Estado", str(session.get("estado") or "—").capitalize()),
    ], 5.2 * cm, 12.4 * cm))

    # ------------------------------------------------------------- totales
    total_kg = session.get("total_kg") or stats.get("total_kg") or 0.0
    animales = session.get("total_animales")
    if animales is None:
        animales = stats.get("total_animales") or 0
    promedio = session.get("promedio_final") or stats.get("promedio")
    story += _section("Totales")
    story.append(_totals_cards([
        (str(int(animales)), "CERDOS"),
        (f"{_fmt(float(total_kg), 1)} kg", "PESO TOTAL"),
        (f"{_fmt(float(promedio), 1) if promedio is not None else '—'} kg",
         "PROMEDIO POR CERDO"),
    ]))

    # ---------------------------------------------------------- estadística
    story += _section("Estadística del lote")
    tipo_muestra = stats.get("tipo_muestra")
    tipo_txt = {
        "completa": "Completa (cada cerdo pesado individualmente)",
        "estimada": "Estimada (muestra de subidas de a un cerdo)",
    }.get(str(tipo_muestra), str(tipo_muestra or "—"))
    rows = []
    for label, key in STATS_LABELS:
        if key == "tipo_muestra":
            rows.append((label, tipo_txt))
        else:
            rows.append((label, _fmt(stats.get(key), 2)))
    rows.append(("Muestras individuales (n)", _fmt(stats.get("n_muestras"), 0)))
    story.append(_kv_table(rows, 8.0 * cm, 9.4 * cm))
    story.append(Spacer(0, 6))
    story.append(_note_callout(
        f"<b>En cristiano:</b> {_nota_humana(stats)}"))

    # ---------------------------------------------------------- movimientos
    story += _section("Movimientos")
    if events:
        ev_rows = []
        for ev in events:
            n = ev.get("animales_confirmados")
            if n is None:
                n = ev.get("animales_estimados")
            detalle = str(ev.get("motivo_bajada") or "")
            if ev.get("animales_confirmados") is not None:
                por = str(ev.get("confirmado_por") or "").strip()
                extra = (f"confirmado por {por}" if por
                         else "confirmado por el operador")
                detalle = f"{detalle} · {extra}" if detalle else extra
            elif ev.get("ambiguo"):
                extra = "peso ambiguo (sin confirmar)"
                detalle = f"{detalle} · {extra}" if detalle else extra
            ev_rows.append([
                _hora_ms(ev.get("ts_ms")),
                TIPO_HUMANO.get(str(ev.get("tipo")), str(ev.get("tipo"))),
                f"{_fmt(ev.get('delta_kg'), 1)} kg",
                _fmt(n, 0),
                Paragraph(detalle, st["cell"]),
            ])
        story.append(_data_table(
            ["Hora", "Movimiento", "Peso (kg)", "Animales",
             "Motivo / detalle"],
            ev_rows,
            [2.2 * cm, 3.6 * cm, 2.7 * cm, 2.2 * cm, 6.9 * cm],
            num_cols=(2, 3),
        ))
    else:
        story.append(Paragraph("Sin movimientos registrados.", st["body"]))

    # --------------------------------------------------------- conciliación
    if session.get("conteo_fisico") is not None:
        diff = session.get("diferencia_conciliacion")
        bloque: list[Any] = _section("Conciliación")
        bloque.append(_kv_table([
            ("Conteo físico (contado a mano)", _fmt(session.get("conteo_fisico"), 0)),
            ("Conteo de la báscula", _fmt(animales, 0)),
            ("Diferencia", _fmt(diff, 0)),
        ], 8.0 * cm, 9.6 * cm))
        if diff == 0:
            bloque.append(Spacer(0, 6))
            bloque.append(_note_callout(
                "<b>En cristiano:</b> el conteo cuadró perfecto."))
        story.append(KeepTogether(bloque))

    story.append(Spacer(0, 12))
    return _build_doc(story, meta)


# -------------------------------------------------------------- PDF global

def build_global_pdf(g: dict[str, Any], desde: Optional[str],
                     hasta: Optional[str]) -> bytes:
    from reportlab.lib.units import cm
    from reportlab.platypus import Paragraph, Spacer

    st = _styles()
    if desde or hasta:
        rango = f"Periodo: {desde or 'inicio'} → {hasta or 'hoy'}"
    else:
        rango = "Periodo: todo el historial"
    n_lotes = len(g.get("por_lote") or [])
    meta = {
        "title": "Resumen ejecutivo",
        "chip": f"{n_lotes} lote{'s' if n_lotes != 1 else ''}",
        "dates": rango,
    }
    story: list[Any] = []

    promedio = g.get("promedio_global")
    story += _section("Totales")
    story.append(_totals_cards([
        (str(int(g.get("sesiones") or 0)), "PESAJES"),
        (str(int(g.get("total_animales") or 0)), "CERDOS"),
        (f"{_fmt(float(g.get('total_kg') or 0.0), 1)} kg", "PESO TOTAL"),
        (f"{_fmt(float(promedio), 1) if promedio is not None else '—'} kg",
         "PROMEDIO GLOBAL"),
    ]))

    story += _section("Por lote")
    por_lote = g.get("por_lote") or []
    if por_lote:
        rows = [[
            Paragraph(str(l.get("lote") or "—"), st["cell"]),
            _fmt(l.get("sesiones"), 0),
            _fmt(l.get("animales"), 0),
            f"{_fmt(float(l.get('kg') or 0.0), 1)}",
            _fmt(l.get("promedio"), 1),
            _fecha(l.get("ultima_fecha")),
        ] for l in por_lote]
        # fila de TOTALES en bold con fondo (misma métrica que las tarjetas)
        rows.append([
            "TOTAL",
            _fmt(int(g.get("sesiones") or 0), 0),
            _fmt(int(g.get("total_animales") or 0), 0),
            f"{_fmt(float(g.get('total_kg') or 0.0), 1)}",
            _fmt(promedio, 1) if promedio is not None else "—",
            "",
        ])
        story.append(_data_table(
            ["Lote", "Pesajes", "Animales", "Kg", "Promedio (kg)",
             "Última fecha"],
            rows,
            [4.9 * cm, 2.0 * cm, 2.2 * cm, 2.5 * cm, 2.7 * cm, 3.3 * cm],
            num_cols=(1, 2, 3, 4),
            totals_row=True,
        ))
    else:
        story.append(Paragraph("Sin pesajes en el periodo.", st["body"]))

    story.append(Spacer(0, 12))
    return _build_doc(story, meta)


# --------------------------------------------------------------- endpoints

@router.get("/api/sessions/{session_id}/report.pdf")
def session_report_pdf(session_id: int, request: Request) -> Response:
    repo = request.app.state.repo
    session = repo.get_session(session_id)
    if session is None:
        raise HTTPException(404, "sesión no encontrada")
    content = build_session_pdf(
        session, repo.list_events(session_id), repo.stats(session_id)
    )
    return Response(
        content=content,
        media_type=PDF_MEDIA_TYPE,
        headers={
            "Content-Disposition":
                f'inline; filename="informe_sesion_{session_id}.pdf"'
        },
    )


@router.get("/api/reports/global.pdf")
def global_report_pdf(
    request: Request,
    desde: Optional[str] = None,
    hasta: Optional[str] = None,
) -> Response:
    repo = request.app.state.repo
    content = build_global_pdf(
        repo.stats_global(desde=desde, hasta=hasta), desde, hasta
    )
    return Response(
        content=content,
        media_type=PDF_MEDIA_TYPE,
        headers={
            "Content-Disposition": 'inline; filename="informe_global.pdf"'
        },
    )
