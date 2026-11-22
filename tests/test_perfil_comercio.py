import sqlite3
from contextlib import contextmanager

import pytest
from flask import Flask

from app.routes.api import api_bp
from app.security import register_security
from app.services import perfil_comercio


@pytest.fixture
def client(monkeypatch):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE empresas (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL);
        INSERT INTO empresas VALUES (1, 'Uno'), (2, 'Dos');
        CREATE TABLE repartofacil_empresa_perfiles (
            empresa_id INTEGER PRIMARY KEY, nombre TEXT, descripcion TEXT, direccion TEXT,
            latitud REAL, longitud REAL, whatsapp TEXT, horario TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE repartofacil_resenas (
            pedido_id TEXT PRIMARY KEY, empresa_id INTEGER, estrellas INTEGER,
            comentario TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO repartofacil_resenas (pedido_id, empresa_id, estrellas, comentario)
        VALUES ('uno', 1, 5, 'Bien'), ('dos', 2, 1, 'Otra empresa');
    """)

    @contextmanager
    def db(empresa_id=None):
        assert empresa_id == 0
        yield conn
        conn.commit()

    monkeypatch.setattr(perfil_comercio, "get_db", db)
    monkeypatch.setattr(perfil_comercio, "is_postgres", lambda: False)
    app = Flask(__name__)
    app.config.update(TESTING=True, SECRET_KEY="prueba")
    app.register_blueprint(api_bp)
    with app.test_client() as test_client:
        yield test_client
    conn.close()


def sesion(client, empresa_id=1, role="admin"):
    with client.session_transaction() as sess:
        sess.update(authenticated=True, empresa_id=empresa_id, role=role)


def perfil(**updates):
    return dict(empresa_id=1, nombre="Comercio", descripcion="", direccion="Calle 123",
                latitud=-32.9, longitud=-60.6, whatsapp="5493411234567",
                horario="Lunes a viernes", **updates)


def test_sesion_permisos_y_aislamiento(client):
    assert client.get("/api/repartofacil/mi-empresa").status_code == 401
    sesion(client, role="visor")
    lectura = client.get("/api/repartofacil/mi-empresa").get_json()
    assert lectura["perfil"]["nombre"] == "Uno"
    assert lectura["cantidad"] == 1
    assert lectura["resenas"][0]["comentario"] == "Bien"
    assert client.put("/api/repartofacil/mi-empresa", json=perfil()).status_code == 403
    sesion(client)
    assert client.put("/api/repartofacil/mi-empresa", json=perfil()).status_code == 200
    sesion(client, empresa_id=2)
    assert client.get("/api/repartofacil/mi-empresa").get_json()["perfil"]["nombre"] == "Dos"
    assert client.put("/api/repartofacil/mi-empresa", json=perfil()).status_code == 409


def test_validacion_y_cambio_de_direccion_invalida_coordenadas(client):
    sesion(client)
    assert client.put("/api/repartofacil/mi-empresa", json=perfil()).status_code == 200
    cambio = perfil()
    cambio["direccion"] = "Otra calle 42"
    result = client.put("/api/repartofacil/mi-empresa", json=cambio)
    assert result.get_json()["perfil"]["latitud"] is None
    cambio["whatsapp"] = "<no válido>"
    assert client.put("/api/repartofacil/mi-empresa", json=cambio).status_code == 400
    cambio["whatsapp"] = ""
    cambio["longitud"] = 200
    assert client.put("/api/repartofacil/mi-empresa", json=cambio).status_code == 400


def test_direccion_puede_conservar_punto_confirmado_en_mapa(client):
    sesion(client)
    assert client.put("/api/repartofacil/mi-empresa", json=perfil()).status_code == 200
    cambio = perfil()
    cambio["direccion"] = "Otra calle 42"
    cambio["ubicacion_confirmada"] = True
    guardado = client.put("/api/repartofacil/mi-empresa", json=cambio)
    assert guardado.status_code == 200
    assert guardado.get_json()["perfil"]["latitud"] == -32.9
    assert guardado.get_json()["perfil"]["longitud"] == -60.6
    cambio["ubicacion_confirmada"] = "true"
    assert client.put("/api/repartofacil/mi-empresa", json=cambio).status_code == 400


def test_politica_permite_mapa_y_ubicacion_del_propio_sitio():
    app = Flask(__name__)
    app.config["SECRET_KEY"] = "prueba"
    register_security(app)
    app.add_url_rule("/", view_func=lambda: "ok")
    response = app.test_client().get("/")
    assert "geolocation=(self)" in response.headers["Permissions-Policy"]
    assert "https://tile.openstreetmap.org" in response.headers["Content-Security-Policy"]
