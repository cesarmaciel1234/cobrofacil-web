"""Pruebas optativas de concurrencia en un esquema PostgreSQL aislado."""
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import psycopg2
import pytest
from dotenv import dotenv_values
from flask import Flask
from psycopg2 import sql
from psycopg2.extras import RealDictCursor

from app.routes.api import api_bp
from app.routes import api_repartofacil


@pytest.fixture()
def postgres_chat(monkeypatch):
    if os.environ.get("RF_RUN_POSTGRES_TEST") != "1":
        pytest.skip("Requiere autorización y base de pruebas configurada.")
    env_file = os.environ.get("RF_DATABASE_ENV_FILE")
    assert env_file, "Indicá RF_DATABASE_ENV_FILE."
    url = dotenv_values(env_file).get("DATABASE_URL")
    assert url, "No se pudo leer DATABASE_URL."
    schema = "rf_crm_test_" + uuid.uuid4().hex[:24]
    admin = psycopg2.connect(url, connect_timeout=10)
    admin.autocommit = True
    created = False

    try:
        with admin.cursor() as cur:
            cur.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
            created = True
            cur.execute(sql.SQL("""
                CREATE TABLE {}.repartofacil_pedidos (
                    id text PRIMARY KEY, empresa_id integer, sucursal_origen text, estado text,
                    repartidor_id text, repartidor_usuario_id text, repartidor_nombre text, updated_at timestamptz,
                    custodio_estado text, custodio_advertencia_at timestamptz, ticket_id text,
                    cliente_nombre text, cliente_telefono text, direccion_entrega text, items jsonb,
                    metodo_pago text, subtotal numeric, costo_envio numeric, total numeric, notas text,
                    created_at timestamptz, cliente_id text, cliente_usuario_id text, tipo_entrega text,
                    empresa_slug text, ganancia_repartidor numeric, minutos_estimados integer,
                    distancia_km numeric, driver_last_ping timestamptz
                )
            """).format(sql.Identifier(schema)))
            cur.execute(sql.SQL("""
                CREATE TABLE {}.repartofacil_chat_mensajes (
                    id text PRIMARY KEY, order_id text, author_role text, author_name text,
                    content text, timestamp_str text, created_at timestamptz
                )
            """).format(sql.Identifier(schema)))
            cur.execute(sql.SQL("""
                CREATE TABLE {}.clientes (
                    id serial PRIMARY KEY, nombre text, telefono text, direccion text, scoring text,
                    tipo_cliente text, techo_deuda numeric, saldo_actual numeric, saldo_inicial numeric,
                    created_at timestamptz
                )
            """).format(sql.Identifier(schema)))
            cur.execute(sql.SQL("""
                INSERT INTO {}.repartofacil_pedidos
                  (id, empresa_id, sucursal_origen, estado, cliente_nombre, items, created_at)
                VALUES ('aceptar', 2, 'Comercio ficticio', 'pending_store', 'Cliente ficticio', '[]', NOW()),
                       ('chat', 2, 'Comercio ficticio', 'assigned', 'Cliente ficticio', '[]', NOW())
            """).format(sql.Identifier(schema)))

        class Adapter:
            def __init__(self, conn):
                self.conn = conn

            def execute(self, query, params=()):
                assert "public." not in query.replace("public.repartofacil_", "")
                query = query.replace("public.repartofacil_", f'"{schema}".repartofacil_')
                cur = self.conn.cursor(cursor_factory=RealDictCursor)
                cur.execute(query, params)
                return cur

            def commit(self):
                self.conn.commit()

        @contextmanager
        def fake_db(empresa_id=None):
            assert empresa_id in (0, 2)
            conn = psycopg2.connect(url, connect_timeout=10)
            try:
                with conn.cursor() as cur:
                    cur.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema)))
                yield Adapter(conn)
            finally:
                conn.rollback()
                conn.close()

        monkeypatch.setattr(api_repartofacil, "get_db", fake_db)
        app = Flask(__name__)
        app.config.update(TESTING=True, SECRET_KEY="chat-postgres-test")
        app.register_blueprint(api_bp)
        yield app, admin, schema
    finally:
        if created:
            with admin.cursor() as cur:
                cur.execute("""
                    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = %s AND c.relkind IN ('r', 'p')
                """, (schema,))
                allowed = {"repartofacil_pedidos", "repartofacil_chat_mensajes", "clientes"}
                assert all(row[0] in allowed for row in cur.fetchall()), "Se conservó el esquema por contener tablas inesperadas."
                cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
        admin.close()


def call_as_store(app, path, payload):
    with app.test_client() as client:
        with client.session_transaction() as sess:
            sess.update(authenticated=True, empresa_id=2, role="operador")
        return client.post(path, json=payload).status_code


def test_aceptaciones_concurrentes_no_duplican_pedido(postgres_chat):
    app, admin, schema = postgres_chat
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(call_as_store, app, "/api/repartofacil/pedidos/aceptar/aceptar", {}) for _ in range(2)]
        assert sorted(f.result(timeout=30) for f in futures) == [200, 409]
    with admin.cursor() as cur:
        cur.execute(sql.SQL("SELECT estado FROM {}.repartofacil_pedidos WHERE id = 'aceptar'").format(sql.Identifier(schema)))
        assert cur.fetchone()[0] == "confirmed"
        cur.execute(sql.SQL("SELECT COUNT(*) FROM {}.repartofacil_chat_mensajes WHERE order_id = 'aceptar'").format(sql.Identifier(schema)))
        assert cur.fetchone()[0] == 1
        cur.execute(sql.SQL("SELECT COUNT(*) FROM {}.clientes").format(sql.Identifier(schema)))
        assert cur.fetchone()[0] == 1


def test_mensaje_espera_y_verifica_empresa_tras_cambio_concurrente(postgres_chat):
    app, admin, schema = postgres_chat
    lock_conn = psycopg2.connect(dotenv_values(os.environ["RF_DATABASE_ENV_FILE"])["DATABASE_URL"], connect_timeout=10)
    future = None
    try:
        with lock_conn.cursor() as cur:
            cur.execute(sql.SQL("UPDATE {}.repartofacil_pedidos SET empresa_id = 3 WHERE id = 'chat'").format(sql.Identifier(schema)))
        with ThreadPoolExecutor(max_workers=1) as executor:
            try:
                future = executor.submit(call_as_store, app, "/api/repartofacil/chat/chat/mensaje", {"content": "Prueba ficticia"})
                time.sleep(0.5)
                assert not future.done()
                lock_conn.commit()
                assert future.result(timeout=30) == 404
            finally:
                lock_conn.rollback()
    finally:
        lock_conn.rollback()
        lock_conn.close()
    with admin.cursor() as cur:
        cur.execute(sql.SQL("SELECT COUNT(*) FROM {}.repartofacil_chat_mensajes WHERE order_id = 'chat'").format(sql.Identifier(schema)))
        assert cur.fetchone()[0] == 0
