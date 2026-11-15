"""El filtro de ventas usa la misma regla que el historial de Cobro Fácil."""
from app.services.pos_historial import evaluar_ticket, rango_fechas


def _venta(**extra):
    base = {
        "id": "10",
        "fecha": "2026-11-14 21:02:03",
        "total": 15225,
        "usuario": "caja",
        "estado": "CERRADA",
        "metodo_pago": "Efectivo",
        "descuento": 0,
        "recargo": 0,
        "caja_id": 1,
        "pago_efectivo": 0,
        "pago_otro": 0,
        "cambio": 0,
    }
    base.update(extra)
    return base


def test_el_efectivo_entra_y_el_qr_no():
    assert evaluar_ticket(_venta(), metodo="EFECTIVO", fecha_ini="2026-11-14", fecha_fin="2026-11-14") == (True, 15225)
    assert evaluar_ticket(_venta(metodo_pago="QR"), metodo="EFECTIVO", fecha_ini="2026-11-14", fecha_fin="2026-11-14")[0] is False


def test_el_qr_tiene_su_filtro():
    entra, monto = evaluar_ticket(_venta(metodo_pago="QR", total=6000), metodo="QR")
    assert entra is True and monto == 6000


def test_fiado_y_clientes_son_credito():
    assert evaluar_ticket(_venta(metodo_pago="Fiado"), metodo="CRÉDITO")[0] is True
    assert evaluar_ticket(_venta(metodo_pago="Clientes"), metodo="CREDITO")[0] is True
    assert evaluar_ticket(_venta(metodo_pago="Efectivo"), metodo="CRÉDITO")[0] is False


def test_el_mixto_suma_solo_la_parte_pedida():
    mixto = _venta(metodo_pago="Mixto", total=1000, pago_efectivo=400, cambio=50, pago_otro=650)
    assert evaluar_ticket(mixto, metodo="EFECTIVO") == (True, 350)
    assert evaluar_ticket(mixto, metodo="TRANSFERENCIA") == (True, 650)
    credito = _venta(metodo_pago="Mixto (Cliente)", pago_efectivo=100, pago_otro=900)
    assert evaluar_ticket(credito, metodo="CRÉDITO") == (True, 900)
    assert evaluar_ticket(credito, metodo="TARJETA")[0] is False


def test_la_cancelada_se_ve_y_no_suma():
    entra, monto = evaluar_ticket(_venta(estado="CANCELADA", total=5000))
    assert entra is True and monto == 0


def test_redondeo_recargo_caja_hora_y_texto():
    assert evaluar_ticket(_venta(descuento=30), metodo="REDONDEO")[0] is True
    assert evaluar_ticket(_venta(), metodo="REDONDEO")[0] is False
    assert evaluar_ticket(_venta(recargo=10), metodo="RECARGO")[0] is True
    assert evaluar_ticket(_venta(caja_id=6), caja="1")[0] is False
    assert evaluar_ticket(_venta(), hora_desde="22:00", hora_hasta="23:00")[0] is False
    assert evaluar_ticket(_venta(), texto="asado", nombres="asado de tira")[0] is True
    assert evaluar_ticket(_venta(), texto="1024")[0] is False


def test_el_mes_cubre_el_calendario():
    assert rango_fechas("mes", "2026-11-14", False, "2026-11-14") == ("2026-11-01", "2026-11-30")
    assert rango_fechas("dia", "", True, "2026-11-14") == (None, None)
