"""Pruebas del motor espejo de base de datos en nube para PWA."""
import pytest
from app.services.pos_base import guardar_parte, indice_espejo, tabla_espejo, delta_espejo


def test_indice_espejo_vacio(client):
    res = client.get("/api/pos/espejo")
    assert res.status_code == 200
    data = res.get_json()
    assert data["ok"] is True
    assert "sello" in data
    assert isinstance(data["tablas"], list)


def test_tabla_espejo_y_delta(client):
    # Cargar datos de ventas en sucursal 1
    guardar_parte(
        tabla="ventas",
        sucursal_id=1,
        sucursal_nombre="Central",
        columnas=["id", "fecha", "total", "metodo_pago", "estado"],
        filas=[
            [1, "2026-11-17 10:00:00", 5000.0, "Efectivo", "PAGADO"],
            [2, "2026-11-17 11:00:00", 12000.0, "QR MercadoPago", "PAGADO"],
        ],
        parte=1,
        partes=1,
    )

    # Cargar datos de clientes
    guardar_parte(
        tabla="clientes",
        sucursal_id=1,
        sucursal_nombre="Central",
        columnas=["id", "nombre", "dni_cuit", "saldo_actual"],
        filas=[
            [10, "Juan Carnicero", "20123456789", 15000.0],
        ],
        parte=1,
        partes=1,
    )

    # 1. Probar /api/pos/espejo
    res = client.get("/api/pos/espejo")
    data = res.get_json()
    assert data["ok"] is True
    assert data["sello"]
    tablas = {t["tabla"] for t in data["tablas"]}
    assert "ventas" in tablas
    assert "clientes" in tablas

    sello_anterior = data["sello"]

    # 2. Probar /api/pos/espejo/tabla?tabla=ventas
    res_tabla = client.get("/api/pos/espejo/tabla?tabla=ventas")
    assert res_tabla.status_code == 200
    d_tabla = res_tabla.get_json()
    assert d_tabla["ok"] is True
    assert d_tabla["tabla"] == "ventas"
    assert len(d_tabla["sucursales"]) == 1
    assert len(d_tabla["sucursales"][0]["filas"]) == 2

    # 3. Probar /api/pos/espejo/delta sin sello (debe devolver índice)
    res_delta_init = client.get("/api/pos/espejo/delta")
    assert res_delta_init.status_code == 200
    d_init = res_delta_init.get_json()
    assert d_init["ok"] is True
    assert d_init.get("es_indice") is True

    # 4. Probar delta con el sello actual (no debe haber cambios)
    res_delta_nada = client.get(f"/api/pos/espejo/delta?sello={sello_anterior}")
    assert res_delta_nada.status_code == 200
    d_nada = res_delta_nada.get_json()
    assert d_nada["ok"] is True
    if d_nada["cantidad"] != 0:
        print("CAMBIOS INESPERADOS:", d_nada["cambios"])
    assert d_nada["cantidad"] == 0
    assert d_nada["cambios"] == []

    # 5. Agregar una nueva tabla 'productos' en la nube
    guardar_parte(
        tabla="productos",
        sucursal_id=1,
        sucursal_nombre="Central",
        columnas=["id", "nombre", "precio"],
        filas=[[50, "Bife de Chorizo", 8500.0]],
        parte=1,
        partes=1,
    )

    # 6. Probar delta con el sello_anterior (debe detectar el cambio en productos)
    res_delta_nuevo = client.get(f"/api/pos/espejo/delta?sello={sello_anterior}")
    assert res_delta_nuevo.status_code == 200
    d_nuevo = res_delta_nuevo.get_json()
    assert d_nuevo["ok"] is True
    assert d_nuevo["cantidad"] >= 1
    tablas_delta = [c["tabla"] for c in d_nuevo["cambios"]]
    assert "productos" in tablas_delta
    # La tabla devuelta debe incluir los datos completos para hidratar el espejo local
    prod_data = next(c for c in d_nuevo["cambios"] if c["tabla"] == "productos")
    assert len(prod_data["sucursales"][0]["filas"]) == 1
