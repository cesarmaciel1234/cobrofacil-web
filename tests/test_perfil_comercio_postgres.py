"""Comprueba la ficha con el adaptador real de PostgreSQL en un esquema aislado."""
import os
import uuid
from contextlib import contextmanager

import psycopg2
import pytest
from dotenv import dotenv_values
from flask import Flask
from psycopg2 import sql
from psycopg2.extras import DictCursor

import app.database as database
from app.routes.api import api_bp
from app.services import perfil_comercio


@pytest.mark.skipif(os.environ.get("RF_RUN_POSTGRES_TEST") != "1", reason="Requiere base autorizada.")
def test_perfil_en_postgres_aislado(monkeypatch):
    env_file = os.environ.get("RF_DATABASE_ENV_FILE")
    assert env_file, "Indicá la base autorizada."
    url = dotenv_values(env_file).get("DATABASE_URL")
    assert url, "No se pudo leer la base de pruebas."
    schema = "rf_profile_test_" + uuid.uuid4().hex[:24]
    admin = psycopg2.connect(url, connect_timeout=10)
    admin.autocommit = True
    created = False
    try:
        with admin.cursor() as cur:
            cur.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
            created = True
            cur.execute(sql.SQL("CREATE TABLE {}.empresas (id integer primary key, nombre text)").format(sql.Identifier(schema)))
            cur.execute(sql.SQL("INSERT INTO {}.empresas VALUES (1, 'Comercio ficticio')").format(sql.Identifier(schema)))
            cur.execute(sql.SQL("""
                CREATE TABLE {}.repartofacil_empresa_perfiles (
                    empresa_id integer PRIMARY KEY, nombre text, descripcion text, direccion text,
                    latitud double precision, longitud double precision, whatsapp text, horario text,
                    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """).format(sql.Identifier(schema)))
            cur.execute(sql.SQL("""
                CREATE TABLE {}.repartofacil_resenas (
                    pedido_id text PRIMARY KEY, empresa_id integer, estrellas integer,
                    comentario text, created_at timestamptz DEFAULT CURRENT_TIMESTAMP
                )
            """).format(sql.Identifier(schema)))

        class Adapter:
            def __init__(self, conn):
                self.wrapper = database.PostgresConnWrapper(conn)

            def execute(self, query, params=()):
                return self.wrapper.execute(query.replace("public.", f'"{schema}".'), params)

        @contextmanager
        def db(empresa_id=None):
            assert empresa_id == 0
            conn = psycopg2.connect(url, connect_timeout=10, cursor_factory=DictCursor)
            try:
                yield Adapter(conn)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

        monkeypatch.setattr(database, "is_postgres", lambda: True)
        monkeypatch.setattr(perfil_comercio, "get_db", db)
        monkeypatch.setattr(perfil_comercio, "is_postgres", lambda: True)
        app = Flask(__name__)
        app.config.update(TESTING=True, SECRET_KEY="prueba")
        app.register_blueprint(api_bp)
        with app.test_client() as client:
            with client.session_transaction() as sess:
                sess.update(authenticated=True, empresa_id=1, role="admin")
            data = {
                "empresa_id": 1, "nombre": "Tienda", "descripcion": "",
                "direccion": "Calle 123", "latitud": -32.9, "longitud": -60.6,
                "whatsapp": "5493411234567", "horario": "Lunes a viernes",
            }
            response = client.put("/api/repartofacil/mi-empresa", json=data)
            assert response.status_code == 200
            assert client.get("/api/repartofacil/mi-empresa").get_json()["perfil"]["whatsapp"] == data["whatsapp"]
            data["whatsapp"] = "5493417654321"
            assert client.put("/api/repartofacil/mi-empresa", json=data).get_json()["perfil"]["whatsapp"] == data["whatsapp"]
    finally:
        if created:
            with admin.cursor() as cur:
                cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = %s", (schema,))
                assert {row[0] for row in cur.fetchall()} <= {
                    "empresas", "repartofacil_empresa_perfiles", "repartofacil_resenas"
                }, "Se conservó el esquema por contener tablas inesperadas."
                cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
        admin.close()
