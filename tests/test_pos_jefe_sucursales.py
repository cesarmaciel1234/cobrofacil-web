"""Pruebas del panel ejecutivo del Jefe, Contabilidad y Admin multi-sucursal."""
from app.services.pos_base import guardar_parte


def _cargar_datos_muestra():
    # 1. Sucursal 1 (Casa Central)
    guardar_parte(
        tabla="ventas",
        sucursal_id=1,
        sucursal_nombre="Casa Central",
        columnas=["id", "fecha", "total", "metodo_pago", "estado"],
        filas=[
            [101, "2026-11-13 10:00:00", 25000.0, "Efectivo", "PAGADO"],
            [102, "2026-11-13 11:30:00", 45000.0, "QR MercadoPago", "PAGADO"],
            [103, "2026-11-13 12:15:00", 15000.0, "Efectivo", "PAGADO"],
        ],
        parte=1,
        partes=1,
    )
    guardar_parte(
        tabla="ventas_items",
        sucursal_id=1,
        sucursal_nombre="Casa Central",
        columnas=["id", "venta_id", "nombre", "cantidad", "subtotal"],
        filas=[
            [1, 101, "ASADO", 5.0, 25000.0],
            [2, 102, "VACÍO", 8.0, 45000.0],
            [3, 103, "ASADO", 3.0, 15000.0],
        ],
        parte=1,
        partes=1,
    )

    # 2. Sucursal 2 (Sucursal Norte)
    guardar_parte(
        tabla="ventas",
        sucursal_id=2,
        sucursal_nombre="Sucursal Norte",
        columnas=["id", "fecha", "total", "metodo_pago", "estado"],
        filas=[
            [201, "2026-11-13 10:15:00", 30000.0, "Transferencia", "PAGADO"],
            [202, "2026-11-13 13:00:00", 20000.0, "Efectivo", "PAGADO"],
        ],
        parte=1,
        partes=1,
    )

    # 3. Cartera de Clientes
    guardar_parte(
        tabla="clientes",
        sucursal_id=1,
        sucursal_nombre="Casa Central",
        columnas=["id", "nombre", "telefono", "dni", "deuda_actual", "limite_credito"],
        filas=[
            [1, "SILVIA Regular", "11-4444-5555", "2720111222", 23513.85, 20000.0],
            [2, "JUAN Gomez", "11-9999-8888", "20333444", 0.0, 50000.0],
            [3, "CARLOS Perez", "11-7777-6666", "20123456", -4486.15, 30000.0],
        ],
        parte=1,
        partes=1,
    )

    # 4. Gastos
    guardar_parte(
        tabla="gastos",
        sucursal_id=1,
        sucursal_nombre="Casa Central",
        columnas=["id", "fecha", "categoria", "descripcion", "monto", "estado"],
        filas=[
            [1, "2026-11-13 09:00:00", "Limpieza", "Artículos de limpieza", 5000.0, "APROBADO"],
        ],
        parte=1,
        partes=1,
    )


def test_api_sucursales_descubre_locales(client):
    _cargar_datos_muestra()
    r = client.get("/api/pos/sucursales")
    assert r.status_code == 200
    d = r.get_json()
    assert d["ok"] is True
    ids = [s["id"] for s in d["sucursales"]]
    assert 1 in ids
    assert 2 in ids


def test_api_panel_jefe_consolidado_y_filtrado(client):
    _cargar_datos_muestra()
    # Consolidado
    r = client.get("/api/pos/jefe?panel=jefe")
    assert r.status_code == 200
    d = r.get_json()
    assert d["ok"] is True
    assert d["libro"] is True
    assert d["resumen"]["ventas"] == 135000.0  # 25+45+15 + 30+20
    assert d["resumen"]["tickets"] == 5
    assert len(d["desglose_sucursales"]) >= 2

    # Ranking de cortes
    cortes = [c["producto"] for c in d["ranking_cortes"]]
    assert "ASADO" in cortes
    assert "VACÍO" in cortes

    # Filtrado por Sucursal 1
    r_suc1 = client.get("/api/pos/jefe?panel=jefe&sucursal_id=1")
    d_suc1 = r_suc1.get_json()
    assert d_suc1["resumen"]["ventas"] == 85000.0  # 25+45+15
    assert d_suc1["resumen"]["tickets"] == 3


def test_api_panel_contabilidad(client):
    _cargar_datos_muestra()
    r = client.get("/api/pos/jefe?panel=contabilidad&fecha=2026-11-13")
    assert r.status_code == 200
    d = r.get_json()
    assert d["ok"] is True
    c = d["contabilidad"]
    assert c["ventas"] == 135000.0
    assert c["gastos"] == 5000.0
    assert c["resultado"] == 130000.0  # ventas (135000) - gastos (5000)

    medios = {m["medio"]: m["monto"] for m in c["medios_pago"]}
    assert medios.get("Efectivo") == 60000.0  # 25+15 + 20
    assert medios.get("QR MercadoPago") == 45000.0


def test_api_panel_admin_cartera(client):
    _cargar_datos_muestra()
    r = client.get("/api/pos/jefe?panel=admin")
    assert r.status_code == 200
    d = r.get_json()
    assert d["ok"] is True
    assert d["libro"] is True
    cartera = d["cartera"]
    assert cartera["con_deuda"] == 1
    assert cartera["deuda_total"] == 23513.85
    assert cartera["a_favor"] == 1
    assert cartera["saldo_a_favor_total"] == 4486.15

    deudores = cartera["top_deudores"]
    assert len(deudores) == 1
    assert deudores[0]["nombre"] == "SILVIA Regular"
    assert deudores[0]["deuda"] == 23513.85
    assert deudores[0]["tarifa"] == "10%"
    assert deudores[0]["en_riesgo"] is True


def test_api_panel_digitales(client):
    _cargar_datos_muestra()
    r = client.get("/api/pos/jefe?panel=digitales&periodo=Período&desde=2026-11-13&hasta=2026-11-13")
    assert r.status_code == 200
    d = r.get_json()
    assert d["ok"] is True
    assert d["libro"] is True
    dig = d["digitales"]
    assert dig["bruto_mp"] >= 45000.0
    assert dig["neto_mp"] > 0
    assert len(dig["transacciones"]) >= 1


def test_api_panel_pedidos(client):
    guardar_parte(
        tabla="productos",
        sucursal_id=1,
        sucursal_nombre="Casa Central",
        columnas=["id", "codigo", "nombre", "stock", "minimo", "maximo", "costo"],
        filas=[
            [1, "1250", "Mondongo", 0.0, 5.0, 15.0, 10000.0],
            [2, "656461", "Leña", 0.0, 5.0, 10.0, 7000.0],
            [3, "7798342990167", "Pan premium", 5.0, 5.0, 15.0, 2000.0],
        ],
        parte=1,
        partes=1,
    )
    r = client.get("/api/pos/jefe?panel=pedidos")
    assert r.status_code == 200
    d = r.get_json()
    assert d["ok"] is True
    assert d["libro"] is True
    ped = d["pedidos"]
    assert ped["articulos_en_quiebre"] == 3
    assert ped["inversion_estimada"] > 0
    assert "Mondongo" in ped["mensaje_whatsapp"]
    assert "Maciel" not in ped["mensaje_whatsapp"]
    assert "Casa Central" in ped["mensaje_whatsapp"]


def test_panel_no_inventa_mora_ni_cuenta_y_el_ranking_es_del_dia(client):
    _cargar_datos_muestra()
    guardar_parte(
        tabla="ventas_items",
        sucursal_id=1,
        sucursal_nombre="Casa Central",
        columnas=["id", "venta_id", "nombre", "cantidad", "subtotal"],
        filas=[[9, 999, "COSTILLAR VIEJO", 4.0, 80000.0]],
        parte=2,
        partes=2,
    )
    guardar_parte(
        tabla="ventas",
        sucursal_id=1,
        sucursal_nombre="Casa Central",
        columnas=["id", "fecha", "total", "metodo_pago", "estado"],
        filas=[[301, "2026-11-12 18:00:00", 100000.0, "Efectivo", "PAGADO"]],
        parte=2,
        partes=2,
    )

    jefe = client.get("/api/pos/jefe?panel=jefe").get_json()
    cortes = [c["producto"] for c in jefe["ranking_cortes"]]
    assert "COSTILLAR VIEJO" not in cortes
    assert "ASADO" in cortes
    assert jefe["resumen"]["variacion_pct"] == 35.0
    assert jefe["resumen"]["dia_anterior"] == "2026-11-12"
    assert jefe["actualizado_en"]
    textos = " ".join(a["texto"] for a in jefe["pulso"]["alertas"])
    assert "cuentas" in textos

    digitales = client.get("/api/pos/jefe?panel=digitales&periodo=Período&desde=2026-11-13&hasta=2026-11-13").get_json()["digitales"]
    assert digitales["fuente"] == "ticket"
    assert digitales["neto_estimado"] is True
    assert digitales["neto_mp"] == digitales["bruto_mp"]
    cuentas = {t["cuenta"] for t in digitales["transacciones"]}
    assert "Cristina Báez Rodríguez" not in cuentas
    assert all(t["estado"] != "FIRMADO" for t in digitales["transacciones"])

    cartera = client.get("/api/pos/jefe?panel=admin").get_json()["cartera"]
    silvia = cartera["top_deudores"][0]
    assert silvia["dias"] is None
    assert silvia["en_riesgo"] is True
    assert silvia["tarifa"] == "10%"
    assert silvia["mantenimiento_origen"] == "cupo"
