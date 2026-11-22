"""Aislamiento de las conversaciones del comercio."""
import sqlite3
from contextlib import contextmanager

import pytest
from flask import Flask

from app.routes.api import api_bp
from app.routes import api_repartofacil


@pytest.fixture()
def chat_client(monkeypatch):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("ATTACH DATABASE ':memory:' AS public")
    conn.execute("""CREATE TABLE public.repartofacil_pedidos
        (id TEXT PRIMARY KEY, empresa_id INTEGER, sucursal_origen TEXT, estado TEXT,
         repartidor_id TEXT, repartidor_usuario_id TEXT, repartidor_nombre TEXT, updated_at TEXT,
         custodio_estado TEXT, custodio_advertencia_at TEXT, ticket_id TEXT,
         cliente_nombre TEXT, cliente_telefono TEXT, direccion_entrega TEXT,
         items TEXT, metodo_pago TEXT, subtotal REAL, costo_envio REAL, total REAL,
         notas TEXT, created_at TEXT, cliente_id TEXT, cliente_usuario_id TEXT,
         tipo_entrega TEXT, empresa_slug TEXT, ganancia_repartidor REAL,
         minutos_estimados INTEGER, distancia_km REAL, driver_last_ping TEXT)""")
    conn.execute("""CREATE TABLE clientes
        (id INTEGER PRIMARY KEY, nombre TEXT, telefono TEXT, direccion TEXT,
         scoring TEXT, tipo_cliente TEXT, techo_deuda REAL, saldo_actual REAL,
         saldo_inicial REAL, created_at TEXT)""")
    conn.execute("""CREATE TABLE public.repartofacil_chat_mensajes
        (id TEXT PRIMARY KEY, order_id TEXT, author_role TEXT, author_name TEXT,
         content TEXT, timestamp_str TEXT, created_at TEXT)""")
    conn.executemany("INSERT INTO public.repartofacil_pedidos (id, empresa_id, sucursal_origen, estado) VALUES (?, ?, ?, ?)", [
        ("propio", 2, "Mi comercio", "delivered"),
        ("ajeno", 3, "Otra empresa", "confirmed"),
        ("vacio", 2, "Mi comercio", "confirmed"),
        ("antiguo", None, "Comercio anterior", "confirmed"),
        ("pendiente", 2, "Mi comercio", "pending"),
        ("asignado", 2, "Mi comercio", "assigned"),
        ("retirado", 2, "Mi comercio", "picked up"),
        ("aceptar", 2, "Mi comercio", "pending_store"),
    ])
    conn.execute("""UPDATE public.repartofacil_pedidos SET cliente_nombre = 'Cliente',
        items = '[{"id":"p1","quantity":1}]' WHERE id = 'aceptar'""")
    conn.execute("UPDATE public.repartofacil_pedidos SET repartidor_id = 'driver-1', repartidor_nombre = 'Repartidor' WHERE id IN ('asignado', 'retirado', 'propio')")
    conn.execute("""INSERT INTO public.repartofacil_chat_mensajes
        VALUES ('m1', 'propio', 'customer', 'Cliente', 'Hola', '10:00', '2026-01-01')""")
    conn.commit()

    class SQLiteAdapter:
        def execute(self, sql, params=()):
            sql = sql.replace("%s", "?").replace("FOR SHARE", "").replace("FOR UPDATE", "").replace("NOW()", "CURRENT_TIMESTAMP")
            return conn.execute(sql, params)

        def commit(self):
            conn.commit()

    @contextmanager
    def fake_db(empresa_id=None):
        assert empresa_id in (0, 2)
        yield SQLiteAdapter()

    monkeypatch.setattr(api_repartofacil, "get_db", fake_db)
    app = Flask(__name__)
    app.config.update(TESTING=True, SECRET_KEY="chat-test-key")
    app.register_blueprint(api_bp)
    with app.test_client() as client:
        yield client
    conn.close()


def iniciar_sesion(client, empresa_id=2, role="operador"):
    with client.session_transaction() as sess:
        sess.update(authenticated=True, empresa_id=empresa_id, role=role)


def test_exige_sesion_incluso_con_cabecera_de_empresa(chat_client):
    headers = {"X-Empresa-ID": "2"}
    assert chat_client.get("/api/repartofacil/pedidos", headers=headers).status_code == 401
    assert chat_client.get("/api/repartofacil/ticket/propio", headers=headers).status_code == 401
    assert chat_client.get("/api/repartofacil/chat/propio", headers=headers).status_code == 401
    assert chat_client.post("/api/repartofacil/chat/propio/mensaje", headers=headers, json={"content": "Hola"}).status_code == 401
    iniciar_sesion(chat_client, empresa_id=None)
    assert chat_client.get("/api/repartofacil/chat/propio", headers=headers).status_code == 403


def test_aislamiento_y_pedido_inexistente(chat_client):
    iniciar_sesion(chat_client)
    assert chat_client.get("/api/repartofacil/ticket/ajeno").status_code == 404
    for order in ("ajeno", "inexistente", "antiguo"):
        assert chat_client.get(f"/api/repartofacil/chat/{order}").status_code == 404
        assert chat_client.post(f"/api/repartofacil/chat/{order}/mensaje", json={"content": "Hola"}).status_code == 404
    iniciar_sesion(chat_client, empresa_id=1)
    assert chat_client.get("/api/repartofacil/chat/antiguo").status_code == 404


def test_lista_y_ticket_filtran_empresa_de_sesion(chat_client, monkeypatch):
    iniciar_sesion(chat_client)
    response = chat_client.get("/api/repartofacil/pedidos?empresa_id=3", headers={"X-Empresa-ID": "3"})
    assert response.status_code == 200
    ids = {pedido["id"] for pedido in response.get_json()["pedidos"]}
    assert "propio" in ids
    assert "ajeno" not in ids
    assert "antiguo" not in ids
    assert chat_client.get("/api/repartofacil/ticket/propio").status_code == 200
    assert chat_client.get("/api/repartofacil/ticket/ajeno").status_code == 404


def test_historial_entregado_y_permiso_solo_lectura(chat_client):
    iniciar_sesion(chat_client, role="visor")
    response = chat_client.get("/api/repartofacil/chat/propio")
    assert response.status_code == 200
    assert response.get_json()["mensajes"][0]["content"] == "Hola"
    assert chat_client.post("/api/repartofacil/chat/propio/mensaje", json={"content": "Hola"}).status_code == 403
    assert chat_client.get("/api/repartofacil/chat/vacio").get_json()["mensajes"] == []


def test_comercio_envia_y_valida_contenido(chat_client):
    iniciar_sesion(chat_client)
    for invalid in (None, [], "", " " * 3, "x" * 4001):
        assert chat_client.post("/api/repartofacil/chat/propio/mensaje", json={"content": invalid}).status_code == 400
    assert chat_client.post("/api/repartofacil/chat/propio/mensaje", json=[]).status_code == 400
    response = chat_client.post("/api/repartofacil/chat/propio/mensaje", json={"content": " Gracias "})
    assert response.status_code == 200
    assert response.get_json()["mensaje"]["author_name"] == "Mi comercio"
    messages = chat_client.get("/api/repartofacil/chat/propio").get_json()["mensajes"]
    assert [m["content"] for m in messages] == ["Hola", "Gracias"]


def test_rol_invalido_no_accede(chat_client):
    iniciar_sesion(chat_client, role="desconocido")
    assert chat_client.get("/api/repartofacil/chat/propio").status_code == 403


@pytest.mark.parametrize("accion", ["aceptar", "rechazar", "embalar", "custodio/liberar"])
def test_acciones_exigen_sesion_y_empresa_y_no_reabren_entregados(chat_client, accion):
    def actuar(order):
        return chat_client.post(f"/api/repartofacil/pedidos/{order}/{accion}", json={})

    assert actuar("propio").status_code == 401
    iniciar_sesion(chat_client, role="visor")
    assert actuar("propio").status_code == 403
    iniciar_sesion(chat_client)
    assert actuar("ajeno").status_code == 404
    assert actuar("inexistente").status_code == 404
    assert actuar("propio").status_code == 409
    assert chat_client.get("/api/repartofacil/chat/propio").get_json()["mensajes"][0]["content"] == "Hola"


def test_embalar_y_liberar_no_retroceden_estados(chat_client):
    iniciar_sesion(chat_client)
    embalar = "/api/repartofacil/pedidos/asignado/embalar"
    assert chat_client.post(embalar).status_code == 200
    assert chat_client.post(embalar).status_code == 200
    messages = chat_client.get("/api/repartofacil/chat/asignado").get_json()["mensajes"]
    assert len(messages) == 1
    assert chat_client.post("/api/repartofacil/pedidos/asignado/custodio/liberar", json={}).status_code == 200
    assert chat_client.post("/api/repartofacil/pedidos/asignado/custodio/liberar", json={}).status_code == 409
    assert chat_client.post("/api/repartofacil/pedidos/retirado/embalar").status_code == 409
    assert chat_client.post("/api/repartofacil/pedidos/retirado/custodio/liberar", json={}).status_code == 409


def test_rechazar_pendiente_una_sola_vez(chat_client):
    iniciar_sesion(chat_client)
    url = "/api/repartofacil/pedidos/pendiente/rechazar"
    assert chat_client.post(url, json={"motivo": "Sin stock"}).status_code == 200
    assert chat_client.post(url, json={"motivo": "Sin stock"}).status_code == 409
    assert len(chat_client.get("/api/repartofacil/chat/pendiente").get_json()["mensajes"]) == 1


def test_aceptar_no_procesa_dos_veces(chat_client, monkeypatch):
    iniciar_sesion(chat_client)
    url = "/api/repartofacil/pedidos/aceptar/aceptar"
    assert chat_client.post(url, json={}).status_code == 200
    assert chat_client.post(url, json={}).status_code == 409
    assert len(chat_client.get("/api/repartofacil/chat/aceptar").get_json()["mensajes"]) == 1
