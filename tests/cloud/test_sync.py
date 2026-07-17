"""Sync: push idempotente, consultas, stats y AISLAMIENTO entre tenants."""
from __future__ import annotations

from .conftest import auth, evento_payload, login, make_tenant, sesion_payload


def _tenant_tokens(client, sa_token, slug="granja-a"):
    make_tenant(client, sa_token, slug)
    admin = login(client, f"admin@{slug}.test", "clave-admin-1")["access_token"]
    client.post(
        "/tenant/users",
        json={"email": f"op@{slug}.test", "password": "clave-op-11",
              "rol": "operador"},
        headers=auth(admin),
    )
    op = login(client, f"op@{slug}.test", "clave-op-11")["access_token"]
    return admin, op


def _push(client, token, sesiones, eventos, device="dev-1"):
    r = client.post(
        "/sync/push",
        json={"device_id": device, "sesiones": sesiones, "eventos": eventos},
        headers=auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_push_idempotente(client, sa_token):
    _, op = _tenant_tokens(client, sa_token)
    ses = sesion_payload("ses-0001-aaaa")
    evs = [
        evento_payload("evt-0001-aaaa", ses["uuid"], ts_ms=1000),
        evento_payload("evt-0002-aaaa", ses["uuid"], ts_ms=2000, delta_kg=210.0,
                       peso_antes=104.2, peso_despues=314.2,
                       animales_estimados=2, ambiguo=True, opciones=[2, 3]),
    ]
    out1 = _push(client, op, [ses], evs)
    assert out1 == {"aceptadas": 3, "duplicadas": 0}
    # Mismo push otra vez: nada nuevo, mismas filas.
    out2 = _push(client, op, [ses], evs)
    assert out2 == {"aceptadas": 0, "duplicadas": 3}
    sesiones = client.get("/sync/sesiones", headers=auth(op)).json()
    assert len(sesiones) == 1
    eventos = client.get(
        f"/sync/sesiones/{ses['uuid']}/eventos", headers=auth(op)
    ).json()
    assert len(eventos) == 2
    assert eventos[1]["ambiguo"] is True and eventos[1]["opciones"] == [2, 3]


def test_push_actualiza_sesion_existente(client, sa_token):
    _, op = _tenant_tokens(client, sa_token)
    abierta = sesion_payload("ses-0001-aaaa", estado="abierta", total_kg=None,
                             total_animales=None, promedio_final=None)
    _push(client, op, [abierta], [])
    cerrada = sesion_payload("ses-0001-aaaa", estado="cerrada")
    out = _push(client, op, [cerrada], [])
    assert out == {"aceptadas": 0, "duplicadas": 1}
    (ses,) = client.get("/sync/sesiones", headers=auth(op)).json()
    assert ses["estado"] == "cerrada"
    assert ses["total_kg"] == 1250.5


def test_aislamiento_entre_tenants(client, sa_token):
    _, op_a = _tenant_tokens(client, sa_token, "granja-a")
    _, op_b = _tenant_tokens(client, sa_token, "granja-b")
    ses_a = sesion_payload("ses-aaaa-0001")
    _push(client, op_a, [ses_a], [evento_payload("evt-aaaa-0001", ses_a["uuid"])])
    ses_b = sesion_payload("ses-bbbb-0001", lote="L-99", total_kg=500.0,
                           total_animales=5)
    _push(client, op_b, [ses_b], [])
    # B no ve las sesiones de A (ni al revés).
    uuids_b = [s["uuid"] for s in
               client.get("/sync/sesiones", headers=auth(op_b)).json()]
    assert uuids_b == ["ses-bbbb-0001"]
    uuids_a = [s["uuid"] for s in
               client.get("/sync/sesiones", headers=auth(op_a)).json()]
    assert uuids_a == ["ses-aaaa-0001"]
    # B no puede leer los eventos de una sesión de A → 404 (no existe EN SU tenant).
    assert client.get(
        f"/sync/sesiones/{ses_a['uuid']}/eventos", headers=auth(op_b)
    ).status_code == 404
    # Stats: cada quien suma SOLO lo suyo.
    stats_a = client.get("/sync/stats/global", headers=auth(op_a)).json()
    stats_b = client.get("/sync/stats/global", headers=auth(op_b)).json()
    assert stats_a["total_kg"] == 1250.5 and stats_a["sesiones"] == 1
    assert stats_b["total_kg"] == 500.0 and stats_b["total_animales"] == 5


def test_mismo_uuid_en_dos_tenants_no_choca(client, sa_token):
    """El UPSERT es por (tenant, uuid): un uuid repetido entre tenants
    no puede pisar datos ajenos."""
    _, op_a = _tenant_tokens(client, sa_token, "granja-a")
    _, op_b = _tenant_tokens(client, sa_token, "granja-b")
    _push(client, op_a, [sesion_payload("ses-compartida", lote="A")], [])
    out = _push(client, op_b, [sesion_payload("ses-compartida", lote="B")], [])
    assert out == {"aceptadas": 1, "duplicadas": 0}  # nueva para B
    (ses_a,) = client.get("/sync/sesiones", headers=auth(op_a)).json()
    assert ses_a["lote"] == "A"  # intacta


def test_stats_global_forma_y_por_lote(client, sa_token):
    _, op = _tenant_tokens(client, sa_token)
    _push(client, op, [
        sesion_payload("ses-0001", lote="L-1", total_kg=1000.0, total_animales=10),
        sesion_payload("ses-0002", lote="L-1", total_kg=500.0, total_animales=4),
        sesion_payload("ses-0003", lote="L-2", total_kg=300.0, total_animales=3),
    ], [])
    stats = client.get("/sync/stats/global", headers=auth(op)).json()
    assert stats["sesiones"] == 3
    assert stats["total_animales"] == 17
    assert stats["total_kg"] == 1800.0
    assert stats["promedio_global"] == round(1800.0 / 17, 3)
    por_lote = {r["lote"]: r for r in stats["por_lote"]}
    assert por_lote["L-1"]["sesiones"] == 2
    assert por_lote["L-1"]["kg"] == 1500.0
    assert por_lote["L-1"]["promedio"] == round(1500.0 / 14, 3)
    assert por_lote["L-2"]["animales"] == 3
    assert set(por_lote["L-2"]) == {
        "lote", "sesiones", "animales", "kg", "promedio", "ultima_fecha",
    }


def test_filtros_desde_hasta_q(client, sa_token):
    _, op = _tenant_tokens(client, sa_token)
    _push(client, op, [
        sesion_payload("ses-0001", hora_entrada="2026-07-01T08:00:00+00:00",
                       lote="L-1", destino="Planta Norte"),
        sesion_payload("ses-0002", hora_entrada="2026-07-15T08:00:00+00:00",
                       lote="L-2", destino="Planta Sur"),
    ], [])
    r = client.get("/sync/sesiones", params={"desde": "2026-07-10"},
                   headers=auth(op))
    assert [s["uuid"] for s in r.json()] == ["ses-0002"]
    r = client.get("/sync/sesiones", params={"hasta": "2026-07-10"},
                   headers=auth(op))
    assert [s["uuid"] for s in r.json()] == ["ses-0001"]
    r = client.get("/sync/sesiones", params={"q": "Norte"}, headers=auth(op))
    assert [s["uuid"] for s in r.json()] == ["ses-0001"]
    stats = client.get("/sync/stats/global", params={"desde": "2026-07-10"},
                       headers=auth(op)).json()
    assert stats["sesiones"] == 1


def test_superadmin_no_sincroniza(client, sa_token):
    # El superadmin no pertenece a ningún tenant: 403 en todo /sync.
    assert client.post(
        "/sync/push",
        json={"device_id": "dev-x", "sesiones": [], "eventos": []},
        headers=auth(sa_token),
    ).status_code == 403
    assert client.get("/sync/sesiones", headers=auth(sa_token)).status_code == 403
    assert client.get(
        "/sync/stats/global", headers=auth(sa_token)
    ).status_code == 403


def test_push_valida_payload(client, sa_token):
    _, op = _tenant_tokens(client, sa_token)
    # Evento sin campos obligatorios → 422.
    r = client.post(
        "/sync/push",
        json={"device_id": "dev-1", "sesiones": [],
              "eventos": [{"uuid": "evt-x-123456"}]},
        headers=auth(op),
    )
    assert r.status_code == 422
    # Estado fuera del CHECK → 422.
    r = client.post(
        "/sync/push",
        json={"device_id": "dev-1",
              "sesiones": [sesion_payload("ses-1-123456", estado="rara")],
              "eventos": []},
        headers=auth(op),
    )
    assert r.status_code == 422
