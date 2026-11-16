"""La misma base en otra PC no duplica clientes ni tickets."""
from app.services.pos_base import filas_de, guardar_parte
from app.services.pos_historial import movimientos_de
from app.services.pos_jefe import _calcular_cartera


def _clientes(sid, filas):
    guardar_parte(
        tabla="clientes",
        sucursal_id=sid,
        sucursal_nombre=f"PC {sid}",
        columnas=["id", "nombre", "dni", "deuda_actual"],
        filas=filas,
        parte=1,
        partes=1,
    )


def _ventas(sid, columnas, filas):
    guardar_parte(
        tabla="ventas",
        sucursal_id=sid,
        sucursal_nombre=f"PC {sid}",
        columnas=columnas,
        filas=filas,
        parte=1,
        partes=1,
    )


def test_el_dni_es_el_id_y_la_copia_no_suma_deuda(client):
    _clientes(1, [[5, "SILVIA", "27.201.11222", 100.0]])
    _clientes(2, [[5, "SILVIA", "2720111222", 100.0], [10, "OTRO", "30111222", 40.0]])

    columnas, filas = filas_de("clientes")
    dni = columnas.index("dni")
    nombres = {"".join(ch for ch in str(fila[dni]) if ch.isdigit()) for fila in filas}
    assert nombres == {"2720111222", "30111222"}

    cartera = _calcular_cartera()
    por_nombre = {fila["nombre"]: fila for fila in cartera["clientes"]}
    assert por_nombre["SILVIA"]["id"] == "2720111222"
    assert por_nombre["SILVIA"]["deuda"] == 100.0
    assert cartera["deuda_total"] == 140.0


def test_el_mismo_dni_en_otra_sucursal_junta_los_tickets(client):
    _clientes(1, [[5, "SILVIA", "2720111222", 100.0]])
    _clientes(2, [[9, "SILVIA GOMEZ", "2720111222", 40.0]])
    _ventas(1, ["id", "fecha", "total", "cliente_nombre"], [[100, "2026-11-13 10:00:00", 10.0, "SILVIA"]])
    _ventas(2, ["id", "fecha", "total", "cliente_nombre"], [
        [100, "2026-11-13 10:00:00", 10.0, "SILVIA"],
        [200, "2026-11-15 18:00:00", 25.0, "SILVIA GOMEZ"],
    ])

    _, filas = filas_de("ventas")
    assert sorted(fila[0] for fila in filas) == [100, 200]

    from app.services.pos_historial import movimientos_de

    tickets = sorted(fila["ticket"] for fila in movimientos_de("2720111222"))
    assert tickets == ["#100", "#200"]

    cartera = _calcular_cartera()
    silvia = next(fila for fila in cartera["clientes"] if fila["id"] == "2720111222")
    assert silvia["deuda"] == 140.0
    assert silvia["nombres"] == ["SILVIA", "SILVIA GOMEZ"]


def test_el_mismo_ticket_se_omite_y_otro_dia_se_queda(client):
    columnas = ["id", "fecha", "total"]
    _ventas(1, columnas, [[100, "2026-11-13 10:00:00", 25000.0]])
    _ventas(2, columnas, [
        [100, "2026-11-13 10:00:00", 25000.0],
        [100, "2026-11-14 10:00:00", 3000.0],
    ])
    _, filas = filas_de("ventas")
    fechas = sorted(fila[1] for fila in filas)
    assert fechas == ["2026-11-13 10:00:00", "2026-11-14 10:00:00"]


def test_el_numero_de_ticket_manda(client):
    columnas = ["id", "fecha", "numero_ticket", "total"]
    _ventas(1, columnas, [[4, "2026-11-13 10:00:00", "T-100", 10.0]])
    _ventas(2, columnas, [
        [4, "2026-11-15 18:00:00", "T-100", 99.0],
        [4, "2026-11-15 18:00:00", "T-200", 15.0],
    ])
    _, filas = filas_de("ventas")
    numeros = sorted(fila[2] for fila in filas)
    assert numeros == ["T-100", "T-200"]


def test_sin_dni_el_id_de_caja_no_se_repite(client):
    _clientes(1, [[5, "MOSTRADOR", "", 0.0]])
    _clientes(2, [[5, "MOSTRADOR", "", 0.0], [5, "OTRA PERSONA", "", 10.0], [6, "VECINO", "", 0.0]])
    _, filas = filas_de("clientes")
    nombres = sorted(fila[1] for fila in filas)
    assert nombres == ["MOSTRADOR", "OTRA PERSONA", "VECINO"]


def test_la_cuenta_copiada_no_entra_dos_veces(client):
    _clientes(1, [[5, "SILVIA", "2720111222", 100.0]])
    guardar_parte(
        tabla="cuenta_corriente",
        sucursal_id=1,
        sucursal_nombre="PC 1",
        columnas=["id", "cliente_id", "fecha", "tipo", "monto", "saldo_resultante", "descripcion"],
        filas=[[7, 5, "2026-11-13 10:00:00", "CARGO", 100.0, 100.0, "Fiado"]],
        parte=1,
        partes=1,
    )
    guardar_parte(
        tabla="cuenta_corriente",
        sucursal_id=2,
        sucursal_nombre="PC 2",
        columnas=["id", "cliente_id", "fecha", "tipo", "monto", "saldo_resultante", "descripcion"],
        filas=[[7, 5, "2026-11-13 10:00:00", "CARGO", 100.0, 100.0, "Fiado"]],
        parte=1,
        partes=1,
    )
    assert len(movimientos_de("2720111222")) == 1


def test_la_misma_pc_puede_actualizar(client):
    _clientes(1, [[5, "SILVIA", "2720111222", 100.0]])
    guardar_parte(
        tabla="clientes",
        sucursal_id=1,
        sucursal_nombre="PC 1",
        columnas=["id", "nombre", "dni", "deuda_actual"],
        filas=[[5, "SILVIA", "2720111222", 50.0]],
        parte=1,
        partes=1,
        modo="delta",
    )
    _, filas = filas_de("clientes")
    assert len(filas) == 1
    assert filas[0][3] == 50.0
