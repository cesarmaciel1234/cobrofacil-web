"""Recepción de la cartera de Cobro Fácil."""


def _cliente_pos(**extra):
    data = {
        "id": 15,
        "uid": "cli-15",
        "nombre": "Juan Pérez",
        "telefono": "11-1234-5678",
        "dni": "30111222",
        "direccion": "Calle Falsa 123",
        "limite_credito": 200000,
        "deuda_actual": 15000.5,
        "tipo_cliente": "express",
        "estado_cuenta": "activo",
    }
    data.update(extra)
    return data


def test_alta_no_pisa_saldo_del_crm(client):
    r = client.post("/api/pos/clientes", json=_cliente_pos())
    assert r.status_code == 200
    body = r.get_json()
    assert body["accion"] == "creado"

    lista = client.get("/api/clientes").get_json()
    juan = next(c for c in lista if c["nombre"] == "Juan Pérez")
    assert juan["saldo_actual"] == 0
    assert juan["deuda_pos"] == 15000.5
    assert juan["scoring"] == "A"
    assert juan["techo_deuda"] == 200000
    assert juan["cuit"] == "30111222"
    assert juan["tipo_cliente"] == "express"
    assert juan["pos_id"] == 15
    assert juan["pos_uid"] == "cli-15"


def test_reenvio_actualiza_deuda_pos_y_conserva_saldo(client):
    import sqlite3

    from app.config import Config

    client.post("/api/pos/clientes", json=_cliente_pos())
    conn = sqlite3.connect(Config.DB_PATH)
    conn.execute("UPDATE clientes SET saldo_actual = 8000, scoring = 'C' WHERE pos_uid = 'cli-15'")
    conn.commit()
    conn.close()

    r = client.post("/api/pos/clientes", json=_cliente_pos(deuda_actual=4200, telefono="11-0000-1111"))
    assert r.status_code == 200
    assert r.get_json()["accion"] == "actualizado"

    lista = client.get("/api/clientes").get_json()
    juan = next(c for c in lista if c["pos_uid"] == "cli-15")
    assert juan["saldo_actual"] == 8000
    assert juan["scoring"] == "C"
    assert juan["deuda_pos"] == 4200
    assert juan["telefono"] == "11-0000-1111"


def test_mismo_nombre_distinto_uid_no_se_mezcla(client):
    client.post("/api/pos/clientes", json=_cliente_pos())
    r = client.post(
        "/api/pos/clientes",
        json=_cliente_pos(id=99, uid="cli-99", dni="27888999", deuda_actual=10),
    )
    assert r.status_code == 200
    assert r.get_json()["accion"] == "creado"
    assert "POS 99" in r.get_json()["nombre"]

    lista = client.get("/api/clientes").get_json()
    assert len([c for c in lista if "Juan" in c["nombre"]]) == 2


def test_misma_uid_en_otra_sucursal_no_se_mezcla(client):
    client.post("/api/pos/clientes", json=_cliente_pos(sucursal_id=1, sucursal="Centro"))
    r = client.post(
        "/api/pos/clientes",
        json=_cliente_pos(sucursal_id=2, sucursal="Norte", deuda_actual=9),
    )
    assert r.status_code == 200
    assert r.get_json()["accion"] == "creado"

    lista = client.get("/api/clientes").get_json()
    mismos = [c for c in lista if c["pos_uid"] == "cli-15"]
    assert len(mismos) == 2
    assert {c["sucursal_nombre"] for c in mismos} == {"Centro", "Norte"}
    assert {c["deuda_pos"] for c in mismos} == {15000.5, 9}


def test_el_lote_marca_la_sucursal_del_sobre(client):
    r = client.post(
        "/api/pos/clientes/lote",
        json={
            "sucursal_id": 4,
            "sucursal": "Oeste",
            "clientes": [_cliente_pos(id=7, uid="cli-7", nombre="Rita", dni="40111000")],
        },
    )
    assert r.status_code == 200
    assert r.get_json()["creados"] == 1
    lista = client.get("/api/clientes").get_json()
    rita = next(c for c in lista if c["pos_uid"] == "cli-7")
    assert rita["sucursal_id"] == 4
    assert rita["sucursal_nombre"] == "Oeste"
    assert rita["saldo_actual"] == 0


def test_el_limite_y_el_telefono_salen_como_en_la_base(client):
    r = client.post(
        "/api/pos/clientes",
        json=_cliente_pos(
            id=40,
            uid="cli-40",
            nombre="Límite Cero",
            dni="10999888",
            limite_credito=0,
            telefono="1",
            deuda_actual=-12.5,
            plazo_dias=15,
            tipo_cliente="cliente_express",
        ),
    )
    assert r.status_code == 200
    lista = client.get("/api/clientes").get_json()
    ficha = next(c for c in lista if c["pos_uid"] == "cli-40")
    assert ficha["techo_deuda"] == 0
    assert ficha["telefono"] == "1"
    assert ficha["deuda_pos"] == -12.5
    assert ficha["plazo_dias"] == 15
    assert ficha["tipo_cliente"] == "cliente_express"
    assert ficha["saldo_actual"] == 0


def test_el_nombre_de_la_empresa_devuelve_su_numero(client):
    r = client.get("/api/pos/empresas/resolver?nombre=Rumaul")
    assert r.status_code == 200
    assert r.get_json()["id"] == 1
    assert r.get_json()["slug"] == "rumaul"


def test_dos_empresas_parecidas_no_se_eligen_solas(client):
    from app.database import get_db

    with get_db(empresa_id=0) as conn:
        conn.execute("INSERT INTO empresas (nombre, slug) VALUES ('Casa Norte', 'casa-norte')")
        conn.execute("INSERT INTO empresas (nombre, slug) VALUES ('Casa Sur', 'casa-sur')")
    r = client.get("/api/pos/empresas/resolver?nombre=Casa")
    assert r.status_code == 409


def test_lote_y_log(client):
    r = client.post(
        "/api/pos/clientes/lote",
        json={"clientes": [_cliente_pos(), _cliente_pos(id=2, uid="cli-2", nombre="Ana", dni="20111000")]},
    )
    assert r.status_code == 200
    body = r.get_json()
    assert body["creados"] == 2
    assert body["errores"] == []

    logs = client.get("/api/pos/sync/logs").get_json()["logs"]
    assert logs[0]["status"] == "success"
    assert logs[0]["records_success"] == 2


def test_config_no_devuelve_la_clave(auth_client):
    r = auth_client.put(
        "/api/pos/config",
        json={"server_url": "http://192.168.0.8:3306", "api_key": "secreto-pos"},
    )
    assert r.status_code == 200
    body = r.get_json()
    assert body["api_key"] == ""
    assert body["api_key_configurada"] is True
    assert body["server_url"] == "http://192.168.0.8:3306"
