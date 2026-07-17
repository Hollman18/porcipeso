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

def _styles():
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet

    eleia = branding.ELEIA_GREEN
    charcoal = branding.ELEIA_CHARCOAL
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "pp-title", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=22, leading=26, alignment=0, spaceAfter=0,
            textColor=charcoal,
        ),
        "lockup": ParagraphStyle(
            "pp-lockup", parent=base["Normal"], fontSize=11, leading=14,
            textColor=eleia, fontName="Helvetica-Bold",
        ),
        "tagline": ParagraphStyle(
            "pp-tagline", parent=base["Normal"], fontSize=8.5, leading=11,
            textColor=charcoal,
        ),
        "h2": ParagraphStyle(
            "pp-h2", parent=base["Heading2"], fontName="Helvetica-Bold",
            fontSize=12, leading=15, textColor=charcoal, spaceBefore=14,
            spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "pp-body", parent=base["Normal"], fontSize=9.5, leading=13,
            textColor=charcoal,
        ),
        "note": ParagraphStyle(
            "pp-note", parent=base["Normal"], fontSize=9.5, leading=13,
            textColor=charcoal, backColor="#F2F7EA", borderPadding=6,
            spaceBefore=6,
        ),
        "card-v": ParagraphStyle(
            "pp-card-v", parent=base["Normal"], fontSize=20, leading=24,
            alignment=1, fontName="Helvetica-Bold",
            textColor=branding.PORCIPESO_GREEN,
        ),
        "card-k": ParagraphStyle(
            "pp-card-k", parent=base["Normal"], fontSize=8.5, leading=11,
            alignment=1, textColor=charcoal,
        ),
    }


def _header_flowables(subtitle: str) -> list[Any]:
    """Lockup del informe: logo Eleia si existe, si no wordmark verde."""
    from reportlab.lib import colors
    from reportlab.lib.units import cm
    from reportlab.platypus import HRFlowable, Image, Paragraph, Spacer, Table, TableStyle

    st = _styles()
    left = [
        Paragraph(branding.PRODUCT_NAME, st["title"]),
        Paragraph(f"{subtitle} · {branding.TAGLINE_PRODUCT}", st["tagline"]),
    ]
    logo = branding.get_logo_path()
    if logo is not None:
        right: Any = Image(str(logo), width=3.2 * cm, height=1.3 * cm, kind="proportional")
    else:
        # wordmark tipográfico (no hay eleia-logo.png en branding/assets)
        right = [
            Paragraph(f"una solución <b>{branding.COMPANY}</b>", st["lockup"]),
            Paragraph(branding.TAGLINE_COMPANY, st["tagline"]),
        ]
    head = Table([[left, right]], colWidths=["70%", "30%"])
    head.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return [
        head,
        Spacer(0, 6),
        HRFlowable(width="100%", thickness=2.2,
                   color=colors.HexColor(branding.ELEIA_GREEN)),
        Spacer(0, 10),
    ]


def _kv_table(rows: list[tuple[str, str]], col_label: float, col_value: float):
    from reportlab.lib import colors
    from reportlab.platypus import Table, TableStyle

    t = Table(rows, colWidths=[col_label, col_value])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (1, 0), (1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor(branding.ELEIA_CHARCOAL)),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, colors.HexColor("#F4F6F2")]),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def _cards_table(cards: list[tuple[str, str]]):
    """Tarjetas de totales (valor grande verde PorciPeso + etiqueta)."""
    from reportlab.lib import colors
    from reportlab.platypus import Paragraph, Table, TableStyle

    st = _styles()
    row_v = [Paragraph(v, st["card-v"]) for v, _k in cards]
    row_k = [Paragraph(k, st["card-k"]) for _v, k in cards]
    t = Table([row_v, row_k], colWidths=[None] * len(cards))
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EFF6E6")),
        ("BOX", (0, 0), (-1, -1), 1, colors.HexColor(branding.ELEIA_GREEN)),
        ("INNERGRID", (0, 0), (-1, 0), 0.5, colors.HexColor(branding.ELEIA_GREEN)),
        ("LINEBEFORE", (1, 1), (-1, 1), 0.5, colors.HexColor(branding.ELEIA_GREEN)),
        ("TOPPADDING", (0, 0), (-1, 0), 10),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 10),
    ]))
    return t


def _data_table(header: list[str], rows: list[list[str]], col_widths=None):
    from reportlab.lib import colors
    from reportlab.platypus import Table, TableStyle

    t = Table([header] + rows, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(branding.ELEIA_GREEN)),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("TEXTCOLOR", (0, 1), (-1, -1), colors.HexColor(branding.ELEIA_CHARCOAL)),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F4F6F2")]),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def _on_page(canvas, doc) -> None:
    """Pie de página con marca + versión + fecha de generación."""
    from reportlab.lib import colors
    from reportlab.lib.units import cm

    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor(branding.ELEIA_GREEN))
    canvas.setLineWidth(0.8)
    canvas.line(1.8 * cm, 1.55 * cm, doc.pagesize[0] - 1.8 * cm, 1.55 * cm)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(colors.HexColor(branding.ELEIA_CHARCOAL))
    generado = datetime.now().strftime("%d/%m/%Y %H:%M")
    canvas.drawString(
        1.8 * cm, 1.15 * cm,
        f"{branding.LOCKUP} · Generado por {branding.PRODUCT_NAME} "
        f"v{branding.get_version()} · {generado}",
    )
    canvas.drawRightString(
        doc.pagesize[0] - 1.8 * cm, 1.15 * cm, f"Página {doc.page}",
    )
    canvas.restoreState()


def _build_doc(story: list[Any]) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import cm
    from reportlab.platypus import SimpleDocTemplate

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=1.8 * cm, rightMargin=1.8 * cm,
        topMargin=1.6 * cm, bottomMargin=2.2 * cm,
        title=f"{branding.PRODUCT_NAME} — Informe de pesaje",
        author=f"{branding.PRODUCT_NAME} · {branding.COMPANY}",
        pageCompression=0,  # streams legibles (y peso estable en tests)
    )
    doc.build(story, onFirstPage=_on_page, onLaterPages=_on_page)
    return buf.getvalue()


# ------------------------------------------------------------- PDF sesión

def build_session_pdf(session: dict[str, Any], events: list[dict[str, Any]],
                      stats: dict[str, Any]) -> bytes:
    from reportlab.lib.units import cm
    from reportlab.platypus import Paragraph, Spacer

    st = _styles()
    story: list[Any] = _header_flowables("Informe de pesaje")

    # ------------------------------------------------------ datos del lote
    story.append(Paragraph("Datos del lote", st["h2"]))
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
        ("Estado", str(session.get("estado") or "—")),
    ], 5.2 * cm, 12.0 * cm))

    # ------------------------------------------------------------- totales
    total_kg = session.get("total_kg") or stats.get("total_kg") or 0.0
    animales = session.get("total_animales")
    if animales is None:
        animales = stats.get("total_animales") or 0
    promedio = session.get("promedio_final") or stats.get("promedio")
    story.append(Paragraph("Totales", st["h2"]))
    story.append(_cards_table([
        (str(int(animales)), "CERDOS"),
        (f"{_fmt(float(total_kg), 1)} kg", "PESO TOTAL"),
        (f"{_fmt(float(promedio), 1) if promedio is not None else '—'} kg",
         "PROMEDIO POR CERDO"),
    ]))

    # ---------------------------------------------------------- estadística
    story.append(Paragraph("Estadística del lote", st["h2"]))
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
    story.append(_kv_table(rows, 8.0 * cm, 9.2 * cm))
    story.append(Paragraph(f"<b>En cristiano:</b> {_nota_humana(stats)}", st["note"]))

    # ---------------------------------------------------------- movimientos
    story.append(Paragraph("Movimientos", st["h2"]))
    if events:
        ev_rows = []
        for ev in events:
            n = ev.get("animales_confirmados")
            if n is None:
                n = ev.get("animales_estimados")
            ev_rows.append([
                _hora_ms(ev.get("ts_ms")),
                TIPO_HUMANO.get(str(ev.get("tipo")), str(ev.get("tipo"))),
                f"{_fmt(ev.get('delta_kg'), 1)} kg",
                _fmt(n, 0),
                str(ev.get("motivo_bajada") or ""),
            ])
        story.append(_data_table(
            ["Hora", "Movimiento", "Peso (Δ)", "Animales", "Motivo"],
            ev_rows,
            [2.4 * cm, 4.6 * cm, 3.2 * cm, 2.4 * cm, 4.6 * cm],
        ))
    else:
        story.append(Paragraph("Sin movimientos registrados.", st["body"]))

    # --------------------------------------------------------- conciliación
    if session.get("conteo_fisico") is not None:
        story.append(Paragraph("Conciliación", st["h2"]))
        diff = session.get("diferencia_conciliacion")
        story.append(_kv_table([
            ("Conteo físico (contado a mano)", _fmt(session.get("conteo_fisico"), 0)),
            ("Conteo de la báscula", _fmt(animales, 0)),
            ("Diferencia", _fmt(diff, 0)),
        ], 8.0 * cm, 9.2 * cm))
        if diff == 0:
            story.append(Paragraph(
                "<b>En cristiano:</b> el conteo cuadró perfecto.", st["note"]))

    story.append(Spacer(0, 12))
    return _build_doc(story)


# -------------------------------------------------------------- PDF global

def build_global_pdf(g: dict[str, Any], desde: Optional[str],
                     hasta: Optional[str]) -> bytes:
    from reportlab.lib.units import cm
    from reportlab.platypus import Paragraph, Spacer

    st = _styles()
    story: list[Any] = _header_flowables("Resumen ejecutivo")

    if desde or hasta:
        rango = f"Periodo: {desde or 'inicio'} → {hasta or 'hoy'}"
    else:
        rango = "Periodo: todo el historial"
    story.append(Paragraph(rango, st["body"]))
    story.append(Spacer(0, 6))

    promedio = g.get("promedio_global")
    story.append(Paragraph("Totales", st["h2"]))
    story.append(_cards_table([
        (str(int(g.get("sesiones") or 0)), "PESAJES"),
        (str(int(g.get("total_animales") or 0)), "CERDOS"),
        (f"{_fmt(float(g.get('total_kg') or 0.0), 1)} kg", "PESO TOTAL"),
        (f"{_fmt(float(promedio), 1) if promedio is not None else '—'} kg",
         "PROMEDIO GLOBAL"),
    ]))

    story.append(Paragraph("Por lote", st["h2"]))
    por_lote = g.get("por_lote") or []
    if por_lote:
        rows = [[
            str(l.get("lote") or "—"),
            _fmt(l.get("sesiones"), 0),
            _fmt(l.get("animales"), 0),
            f"{_fmt(float(l.get('kg') or 0.0), 1)}",
            _fmt(l.get("promedio"), 1),
            _fecha(l.get("ultima_fecha")),
        ] for l in por_lote]
        story.append(_data_table(
            ["Lote", "Pesajes", "Animales", "Kg", "Promedio", "Última fecha"],
            rows,
            [4.6 * cm, 2.2 * cm, 2.4 * cm, 2.6 * cm, 2.6 * cm, 2.8 * cm],
        ))
    else:
        story.append(Paragraph("Sin pesajes en el periodo.", st["body"]))

    return _build_doc(story)


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
