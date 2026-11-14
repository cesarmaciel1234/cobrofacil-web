"""Pruebas de la Vitrina del Jefe (12 KPIs de vitrina y períodos)."""
from datetime import datetime
from zoneinfo import ZoneInfo

from app.services.pos_base import guardar_parte
from app.services.pos_vitrina import calcular_vitrina, resolver_rango

_ZONA = ZoneInfo("America/Argentina/Buenos_Aires")


def test_resolver_rango_periodos():
    hoy = datetime.now(_ZONA).date()
    # 1. Hoy
    d_hoy, h_hoy, lbl_hoy = resolver_rango("Hoy", hoy=hoy)
    assert lbl_hoy == "Hoy"
    assert d_hoy.startswith(hoy.isoformat())
    assert h_hoy.endswith("23:59:59")

    # 2. Semana
    d_sem, h_sem, lbl_sem = resolver_rango("Semana", hoy=hoy)
    assert lbl_sem == "Semana"

    # 3. Semana p.
    d_semp, h_semp, lbl_semp = resolver_rango("Semana p.", hoy=hoy)
    assert lbl_semp == "Semana p."
    assert d_semp < d_sem

    # 4. Mes
    d_mes, h_mes, lbl_mes = resolver_rango("Mes", hoy=hoy)
    assert lbl_mes == "Mes"
    assert d_mes.endswith("-01 00:00:00")

    # 5. Año
    d_anio, h_anio, lbl_anio = resolver_rango("Año", hoy=hoy)
    assert lbl_anio == "Año"
    assert d_anio.endswith("-01-01 00:00:00")
    assert h_anio.endswith("-12-31 23:59:59")

    # 6. Período custom
    d_per, h_per, lbl_per = resolver_rango("Período", desde_custom="2026-05-01", hasta_custom="2026-05-15")
    assert lbl_per == "Período"
    assert d_per.startswith("2026-05-01")
    assert h_per.startswith("2026-05-15")


def test_calcular_vitrina_12_tarjetas(app):
    with app.app_context():
        hoy_str = datetime.now(_ZONA).date().isoformat()

        # Cargar datos de prueba
        guardar_parte(
            tabla="productos",
            sucursal_id=1,
            columnas=["id", "nombre", "stock", "costo", "precio"],
            filas=[
                [1, "Lomo", 10.0, 5000.0, 8000.0],
                [2, "Asado", 20.0, 4000.0, 7000.0],
                [3, "Carbón", 0.0, 1000.0, 2000.0],
            ],
            parte=1,
            partes=1,
        )

        guardar_parte(
            tabla="clientes",
            sucursal_id=1,
            columnas=["id", "nombre", "deuda_actual"],
            filas=[
                [1, "Juan", 15000.0],
                [2, "Pedro", 25000.0],
            ],
            parte=1,
            partes=1,
        )

        guardar_parte(
            tabla="ventas",
            sucursal_id=1,
            columnas=["id", "fecha", "total", "metodo_pago", "descuento", "estado"],
            filas=[
                [101, f"{hoy_str} 10:00:00", 16000.0, "QR MercadoPago", 200.0, "PAGADO"],
                [102, f"{hoy_str} 11:30:00", 7000.0, "Efectivo", 0.0, "PAGADO"],
                [103, f"{hoy_str} 12:00:00", 5000.0, "Efectivo", 0.0, "CANCELADA"],
            ],
            parte=1,
            partes=1,
        )

        guardar_parte(
            tabla="detalles_ventas",
            sucursal_id=1,
            columnas=["id", "id_venta", "id_producto", "cantidad", "subtotal"],
            filas=[
                [1, 101, 1, 2.0, 16000.0],
                [2, 102, 2, 1.0, 7000.0],
            ],
            parte=1,
            partes=1,
        )

        guardar_parte(
            tabla="cuenta_corriente",
            sucursal_id=1,
            columnas=["id", "cliente_id", "tipo", "monto", "fecha", "descripcion"],
            filas=[
                [1, 1, "ABONO", 5000.0, f"{hoy_str} 09:00:00", "Transferencia bancaria"],
                [2, 2, "CARGO", 25000.0, f"{hoy_str} 09:30:00", "Compra"],
            ],
            parte=1,
            partes=1,
        )

        guardar_parte(
            tabla="cobros_digitales",
            sucursal_id=1,
            columnas=["id", "id_pago", "fecha", "monto", "estado", "ticket_venta"],
            filas=[
                [1, "MP123", f"{hoy_str} 10:00:00", 16000.0, "SIN FIRMAR", "101"],
                [2, "MP456", f"{hoy_str} 10:30:00", 8000.0, "SIN TICKET", ""],
            ],
            parte=1,
            partes=1,
        )

        res = calcular_vitrina(periodo="Hoy", sucursal_id=1)

        assert res["es_hoy"] is True
        assert "Jefe" in res["saludo"]

        # 1. Ganancia parcial: Ventas vivas (23000) - Costos (2*5000 + 1*4000 = 14000) = 9000
        assert res["ganancia_parcial"]["valor"] == 9000.0

        # 2. Inventario al costo: (10 * 5000) + (20 * 4000) = 50000 + 80000 = 130000
        assert res["inventario_costo"]["valor"] == 130000.0

        # 3. Pagos clientes: 5000
        assert res["pagos_clientes"]["valor"] == 5000.0

        # 4. Deuda clientes: 15000 + 25000 = 40000
        assert res["deuda_clientes"]["valor"] == 40000.0

        # 5. Tickets digitales: 16000
        assert res["tickets_digitales"]["valor"] == 16000.0

        # 6. Cliente digital: 5000 (abono con transferencia)
        assert res["cliente"]["valor"] == 5000.0

        # 7. Sin firmar / F9: 16000
        assert res["sin_firmar"]["valor"] == 16000.0
        assert "1 / 1" in res["sin_firmar"]["badge"]

        # 8. MP sin ticket: 8000
        assert res["mp_sin_ticket"]["valor"] == 8000.0
        assert res["mp_sin_ticket"]["badge"] == "1"

        # 9. Redondeo: 200
        assert res["redondeo"]["valor"] == 200.0

        # 10. Descuento
        assert res["descuento"]["valor"] == 0.0

        # 11. Tickets: 2 ventas vivas, total 23000
        assert res["tickets"]["cant"] == 2
        assert res["tickets"]["total"] == 23000.0

        # 12. Cancelaciones: 1 cancelada, monto 5000
        assert res["cancelaciones"]["cant"] == 1
        assert res["cancelaciones"]["monto"] == 5000.0


def test_api_pos_jefe_vitrina_endpoint(auth_client):
    res = auth_client.get("/api/pos/jefe?panel=reporte&periodo=Semana")
    assert res.status_code == 200
    data = res.get_json()
    assert data["ok"] is True
    assert "vitrina" in data
    assert data["vitrina"]["periodo"] == "Semana"
    assert "ganancia_parcial" in data["vitrina"]
    assert "inventario_costo" in data["vitrina"]
    assert "deuda_clientes" in data["vitrina"]
