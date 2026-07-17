"""Panel web (/panel): estáticos, redirect de raíz y /panel/session."""
from __future__ import annotations

from tests.cloud.conftest import SA_EMAIL, SA_PASS, auth, login, make_tenant


# ------------------------------------------------------------- estáticos

def test_panel_sirve_index_html(client):
    r = client.get("/panel/")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert "PorciPeso Cloud" in r.text
    assert 'src="app.js"' in r.text
    assert 'href="styles.css"' in r.text


def test_panel_sirve_js_y_css(client):
    r = client.get("/panel/app.js")
    assert r.status_code == 200
    assert "javascript" in r.headers["content-type"]
    assert "/auth/login" in r.text  # el wrapper habla con la API real

    r = client.get("/panel/styles.css")
    assert r.status_code == 200
    assert "text/css" in r.headers["content-type"]
    assert "--accent:#178A50" in r.text  # tokens de la marca PorciPeso


def test_raiz_redirige_al_panel(client):
    r = client.get("/", follow_redirects=False)
    assert r.status_code in (302, 307)
    assert r.headers["location"] == "/panel/"

    r = client.get("/", follow_redirects=True)
    assert r.status_code == 200
    assert "PorciPeso Cloud" in r.text


def test_estatico_inexistente_da_404(client):
    assert client.get("/panel/no-existe.js").status_code == 404


# --------------------------------------------------------- /panel/session

def test_session_sin_token_da_401(client):
    assert client.get("/panel/session").status_code == 401


def test_session_superadmin(client, sa_token):
    r = client.get("/panel/session", headers=auth(sa_token))
    assert r.status_code == 200
    body = r.json()
    assert body["rol"] == "superadmin"
    assert body["email"] == SA_EMAIL
    assert body["tenant"] is None


def test_session_admin_de_tenant_trae_su_tenant(client, sa_token):
    make_tenant(client, sa_token, "granja-a", nombre="Granja A")
    token = login(client, "admin@granja-a.test", "clave-admin-1")["access_token"]
    r = client.get("/panel/session", headers=auth(token))
    assert r.status_code == 200
    body = r.json()
    assert body["rol"] == "admin"
    assert body["tenant"] == {
        "id": body["tenant"]["id"], "slug": "granja-a", "nombre": "Granja A",
    }


def test_session_operador(client, sa_token):
    make_tenant(client, sa_token, "granja-b")
    admin = login(client, "admin@granja-b.test", "clave-admin-1")["access_token"]
    client.post(
        "/tenant/users",
        json={"email": "op@granja-b.test", "password": "clave-oper-1",
              "rol": "operador"},
        headers=auth(admin),
    )
    token = login(client, "op@granja-b.test", "clave-oper-1")["access_token"]
    r = client.get("/panel/session", headers=auth(token))
    assert r.status_code == 200
    assert r.json()["rol"] == "operador"
    assert r.json()["tenant"]["slug"] == "granja-b"


def test_session_no_acepta_login_con_password(client):
    # Sanidad: /panel/session exige Bearer, no credenciales.
    r = client.get(
        "/panel/session", headers={"Authorization": f"Basic {SA_PASS}"}
    )
    assert r.status_code == 401
