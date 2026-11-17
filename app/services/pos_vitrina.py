"""
Vitrina de tienda del Jefe (Cerebro POS en CRM Nube).
Calcula los 12 KPIs de vitrina y resuelve rangos de fechas (Hoy, Semana, Semana p., Mes, Año, Período).
No depende de tpv pro 2026; funciona 100% aislado sobre el espejo en la nube.
"""
from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from typing import Any, Optional
from zoneinfo import ZoneInfo

from app.services.pos_base import filas_de, ultima_carga, unir_clientes

_ZONA = ZoneInfo("America/Argentina/Buenos_Aires")
_MARCAS_DIGITAL = ("QR", "MERCADOPAGO", "MP", "TARJETA", "POINT", "TRANSFERENCIA", "DIGITAL", "MIXTO")
_ESTADOS_CANCELADOS = ("CANCELADA", "ANULADA", "CANCELADO", "ANULADO")


def _indice(columnas: list) -> dict[str, int]:
    return {str(col).lower(): i for i, col in enumerate(columnas)}


def _valor(fila: list, idx: dict[str, int], *nombres: str) -> Any:
    for nombre in nombres:
        i = idx.get(nombre)
        if i is not None and i < len(fila):
            return fila[i]
    return None


def _numero(valor: Any) -> float:
    try:
        return float(valor or 0)
    except (TypeError, ValueError):
        return 0.0


def _es_viva(estado: Any) -> bool:
    return str(estado or "").strip().upper() not in _ESTADOS_CANCELADOS


def _es_digital(pago: Any) -> bool:
    texto = str(pago or "").upper()
    return any(marca in texto for marca in _MARCAS_DIGITAL)


def _formatear_pesos(valor: float | None) -> str:
    if valor is None:
        return "$0,00"
    try:
        val = float(valor)
    except (ValueError, TypeError):
        return "$0,00"
    neg = val < 0
    val = abs(val)
    entero = int(val)
    decimales = int(round((val - entero) * 100))
    if decimales >= 100:
        entero += 1
        decimales = 0
    s_entero = f"{entero:,}".replace(",", ".")
    res = f"${s_entero},{decimales:02d}"
    return f"-{res}" if neg else res


def saludo_jefe(ahora: datetime | None = None) -> str:
    ahora = ahora or datetime.now(_ZONA)
    h = ahora.hour
    if 5 <= h < 13:
        return "Buenos días, Jefe"
    elif 13 <= h < 20:
        return "Buenas tardes, Jefe"
    else:
        return "Buenas noches, Jefe"


def resolver_rango(
    periodo: str = "Hoy",
    hoy: date | None = None,
    desde_custom: str | None = None,
    hasta_custom: str | None = None,
) -> tuple[str, str, str]:
    """
    Retorna (desde_iso, hasta_iso, etiqueta_periodo).
    Las fechas tienen formato 'YYYY-MM-DD HH:MM:SS'.
    """
    p = (periodo or "Hoy").strip().lower()
    hoy = hoy or datetime.now(_ZONA).date()

    if p in ("hoy", "dia", "diario"):
        d_str = hoy.isoformat()
        return f"{d_str} 00:00:00", f"{d_str} 23:59:59", "Hoy"

    if p in ("semana", "semana actual"):
        inicio = hoy - timedelta(days=hoy.weekday())
        return f"{inicio.isoformat()} 00:00:00", f"{hoy.isoformat()} 23:59:59", "Semana"

    if p in ("semana p.", "semana pasada", "semanap"):
        lunes_esta = hoy - timedelta(days=hoy.weekday())
        lunes_anterior = lunes_esta - timedelta(days=7)
        domingo_anterior = lunes_anterior + timedelta(days=6)
        return f"{lunes_anterior.isoformat()} 00:00:00", f"{domingo_anterior.isoformat()} 23:59:59", "Semana p."

    if p in ("mes", "mes actual"):
        ultimo_dia = calendar.monthrange(hoy.year, hoy.month)[1]
        inicio = hoy.replace(day=1)
        fin = hoy.replace(day=ultimo_dia)
        return f"{inicio.isoformat()} 00:00:00", f"{fin.isoformat()} 23:59:59", "Mes"

    if p in ("año", "anio", "año actual"):
        return f"{hoy.year}-01-01 00:00:00", f"{hoy.year}-12-31 23:59:59", "Año"

    if p in ("periodo", "período", "custom"):
        d0 = (desde_custom or hoy.isoformat())[:10]
        d1 = (hasta_custom or d0)[:10]
        if d0 > d1:
            d0, d1 = d1, d0
        return f"{d0} 00:00:00", f"{d1} 23:59:59", "Período"

    # Default
    d_str = hoy.isoformat()
    return f"{d_str} 00:00:00", f"{d_str} 23:59:59", "Hoy"


def calcular_vitrina(
    periodo: str = "Hoy",
    sucursal_id: int | None = None,
    desde: str | None = None,
    hasta: str | None = None,
) -> dict[str, Any]:
    """Calcula todas las métricas de la vitrina del jefe."""
    desde_iso, hasta_iso, nombre_periodo = resolver_rango(
        periodo=periodo,
        desde_custom=desde,
        hasta_custom=hasta,
    )
    es_hoy = nombre_periodo == "Hoy"
    sufijo_periodo = "del día" if es_hoy else "del período"

    # 1. Ventas en el rango
    col_v, filas_v = filas_de("ventas", sucursal_id, desde=desde_iso[:10], hasta=hasta_iso[:10])
    idx_v = _indice(col_v)

    cant_tickets = 0
    total_tickets = 0.0
    tickets_digitales_monto = 0.0
    cant_tickets_digitales = 0
    descuento_total = 0.0
    cancelaciones_cant = 0
    cancelaciones_monto = 0.0
    ventas_vivas_ids = set()

    for fila in filas_v:
        fecha_str = str(_valor(fila, idx_v, "fecha") or "").replace("T", " ")
        if not (desde_iso <= fecha_str <= hasta_iso):
            dia = fecha_str[:10]
            if not (len(dia) == 10 and dia[4] == "-" and desde_iso[:10] <= dia <= hasta_iso[:10]):
                continue

        estado = _valor(fila, idx_v, "estado")
        total = _numero(_valor(fila, idx_v, "total"))
        vid = _valor(fila, idx_v, "id")

        if not _es_viva(estado):
            cancelaciones_cant += 1
            cancelaciones_monto += total
            continue

        cant_tickets += 1
        total_tickets += total
        ventas_vivas_ids.add(str(vid))

        pago = _valor(fila, idx_v, "metodo_pago", "medio_pago")
        if _es_digital(pago):
            tickets_digitales_monto += total
            cant_tickets_digitales += 1

        descuento_total += _numero(_valor(fila, idx_v, "descuento"))

    # 2. Detalles ventas y Costo (para ganancia parcial y descuentos de oferta)
    col_dv, filas_dv = filas_de("detalles_ventas", sucursal_id, desde=desde_iso[:10], hasta=hasta_iso[:10])
    if not col_dv:
        col_dv, filas_dv = filas_de("detalle_ventas", sucursal_id, desde=desde_iso[:10], hasta=hasta_iso[:10])
    idx_dv = _indice(col_dv)

    col_p, filas_p = filas_de("productos", sucursal_id)
    if not col_p:
        col_p, filas_p = filas_de("articulos", sucursal_id)
    idx_p = _indice(col_p)

    # El mostrador deja cerca de un millón de kilos para no cortar la venta.
    # Ese número no es mercadería en la cámara.
    _stock_sin_control = 100_000.0

    # Mapa de productos por ID
    mapa_costos: dict[str, float] = {}
    mapa_precios: dict[str, float] = {}
    inventario_costo_total = 0.0
    inventario_sin_control = 0

    for fila in filas_p:
        pid = str(_valor(fila, idx_p, "id") or "")
        stock = _numero(_valor(fila, idx_p, "stock", "stock_actual", "existencia"))
        costo = _numero(_valor(fila, idx_p, "costo", "precio_costo"))
        precio = _numero(_valor(fila, idx_p, "precio", "precio_venta"))

        if pid:
            mapa_costos[pid] = costo
            mapa_precios[pid] = precio

        if stock >= _stock_sin_control:
            inventario_sin_control += 1
            continue
        if stock > 0 and costo > 0:
            inventario_costo_total += stock * costo

    # Ganancia parcial & ofertas. El artículo sin costo no entra como ganancia del 100%.
    costo_ventas_rango = 0.0
    venta_con_costo = 0.0
    venta_sin_costo = 0.0
    hay_costo_cargado = False
    ahorro_ofertas = 0.0

    if ventas_vivas_ids and col_dv:
        for fila in filas_dv:
            id_venta = str(_valor(fila, idx_dv, "id_venta", "venta_id") or "")
            if id_venta not in ventas_vivas_ids:
                continue

            id_prod = str(_valor(fila, idx_dv, "id_producto", "producto_id") or "")
            cantidad = _numero(_valor(fila, idx_dv, "cantidad", "cant"))
            subtotal = _numero(_valor(fila, idx_dv, "subtotal", "total"))

            costo_unit = mapa_costos.get(id_prod, 0.0)
            if costo_unit > 0.009:
                hay_costo_cargado = True
                costo_ventas_rango += cantidad * costo_unit
                venta_con_costo += subtotal
            else:
                venta_sin_costo += subtotal

            precio_unit = mapa_precios.get(id_prod, 0.0)
            if precio_unit > 0:
                diferencia = (cantidad * precio_unit) - subtotal
                if diferencia > 0.009:
                    ahorro_ofertas += diferencia

    if hay_costo_cargado and venta_con_costo > 0:
        ganancia_val = round(venta_con_costo - costo_ventas_rango, 2)
        ganancia_txt = _formatear_pesos(ganancia_val)
        margen = round(ganancia_val / venta_con_costo * 100, 1)
        if venta_sin_costo > 0.009:
            ganancia_sub = f"Margen {margen}% · sin costo {_formatear_pesos(venta_sin_costo)}"
        else:
            ganancia_sub = f"Margen {margen}%"
    else:
        ganancia_val = None
        ganancia_txt = "Sin costo cargado"
        ganancia_sub = "Cargá precio de costo para firmarla"

    # Redondeo y Descuento
    ofertas_total = min(descuento_total, max(0.0, ahorro_ofertas))
    redondeo_val = round(max(0.0, descuento_total - ofertas_total), 2)
    descuento_val = round(ofertas_total, 2)

    # 3. Deuda clientes (alineada con Cartera oficial)
    from app.services.pos_jefe import _cartera_admin
    cartera_oficial = _cartera_admin(sucursal_id)
    deuda_clientes_total = float(cartera_oficial.get("deuda_total") or 0.0)

    # 4. Pagos clientes (cuenta_corriente tipo ABONO) y cobranzas digitales
    col_cc, filas_cc = filas_de("cuenta_corriente", sucursal_id)
    idx_cc = _indice(col_cc)
    pagos_clientes_total = 0.0
    cliente_digital_total = 0.0

    for fila in filas_cc:
        fecha_str = str(_valor(fila, idx_cc, "fecha") or "")
        if not (desde_iso <= fecha_str <= hasta_iso):
            continue
        tipo = str(_valor(fila, idx_cc, "tipo") or "").upper()
        if tipo == "ABONO":
            monto = _numero(_valor(fila, idx_cc, "monto"))
            pagos_clientes_total += monto
            desc = str(_valor(fila, idx_cc, "descripcion") or "")
            if _es_digital(desc):
                cliente_digital_total += monto

    # 5. Auditoría digital (cobros_digitales / mp_pagos)
    col_cd, filas_cd = filas_de("cobros_digitales", sucursal_id)
    idx_cd = _indice(col_cd)
    sin_firmar_monto = 0.0
    cant_sin_firmar = 0
    mp_sin_ticket_monto = 0.0
    cant_mp_sin_ticket = 0

    if col_cd:
        for fila in filas_cd:
            fecha_str = str(_valor(fila, idx_cd, "fecha") or "")
            if not (desde_iso <= fecha_str <= hasta_iso):
                continue
            monto = _numero(_valor(fila, idx_cd, "monto"))
            estado = str(_valor(fila, idx_cd, "estado") or "").upper()
            if "SIN FIRMAR" in estado or "F9" in estado:
                sin_firmar_monto += monto
                cant_sin_firmar += 1
            elif "SIN TICKET" in estado:
                mp_sin_ticket_monto += monto
                cant_mp_sin_ticket += 1
    else:
        # Reconstrucción de fallback desde mp_pagos
        col_mp, filas_mp = filas_de("mp_pagos", sucursal_id)
        idx_mp = _indice(col_mp)
        if col_mp:
            for fila in filas_mp:
                fecha_str = str(_valor(fila, idx_mp, "fecha", "date_created") or "")
                if not (desde_iso <= fecha_str <= hasta_iso):
                    continue
                monto = _numero(_valor(fila, idx_mp, "monto", "transaction_amount"))
                tid = _valor(fila, idx_mp, "ticket_id", "ticket_venta")
                if not tid:
                    cant_mp_sin_ticket += 1
                    mp_sin_ticket_monto += monto

    # Timestamp de última actualización
    ult_carga = ultima_carga(sucursal_id)
    marca_texto = ""
    if ult_carga:
        try:
            dt = datetime.fromisoformat(str(ult_carga).replace("Z", "+00:00")).astimezone(_ZONA)
            marca_texto = dt.strftime("%d/%m %H:%M")
        except Exception:
            marca_texto = str(ult_carga)[:16].replace("T", " ")

    from flask import has_request_context, session
    from app.services.pos_base import leer_carga
    emp_id = 1
    if has_request_context():
        try:
            emp_id = int(session.get("empresa_id") or 1)
        except Exception:
            emp_id = 1
    carga = leer_carga(emp_id)
    progreso_carga = str(carga.get("progreso_texto") or "").strip()

    return {
        "saludo": saludo_jefe(),
        "periodo": nombre_periodo,
        "es_hoy": es_hoy,
        "desde": desde_iso,
        "hasta": hasta_iso,
        "actualizado_en_texto": marca_texto,
        "progreso_carga": progreso_carga,
        "carga": carga,
        # 12 Tarjetas de Vitrina:
        "ganancia_parcial": {
            "titulo": "Ganancia parcial" if es_hoy else "Ganancia",
            "valor": ganancia_val,
            "texto": ganancia_txt,
            "subtitulo": ganancia_sub,
        },
        "inventario_costo": {
            "titulo": "Inventario al costo",
            "valor": round(inventario_costo_total, 2),
            "texto": _formatear_pesos(inventario_costo_total),
            "subtitulo": (
                "Sin el stock que el mostrador no controla"
                if inventario_sin_control
                else "Valuación a costo real"
            ),
        },
        "pagos_clientes": {
            "titulo": "Pagos clientes",
            "valor": round(pagos_clientes_total, 2),
            "texto": _formatear_pesos(pagos_clientes_total),
            "subtitulo": "",
        },
        "deuda_clientes": {
            "titulo": "Deuda clientes",
            "valor": round(deuda_clientes_total, 2),
            "texto": _formatear_pesos(deuda_clientes_total),
            "subtitulo": f"Capital: {_formatear_pesos(cartera_oficial.get('capital_total') or 0)} · Interés: {_formatear_pesos(cartera_oficial.get('interes_total') or 0)}" if cartera_oficial.get("interes_total") else "Saldo en la calle",
        },
        "tickets_digitales": {
            "titulo": "Tickets digitales",
            "valor": round(tickets_digitales_monto, 2),
            "texto": _formatear_pesos(tickets_digitales_monto),
            "subtitulo": "Con ticket · libro de ventas",
        },
        "cliente": {
            "titulo": "Cliente",
            "valor": round(cliente_digital_total, 2),
            "texto": _formatear_pesos(cliente_digital_total),
            "subtitulo": "Cobranza QR / tarjeta / transferencia",
        },
        "sin_firmar": {
            "titulo": "Sin firmar / F9",
            "valor": round(sin_firmar_monto, 2),
            "texto": _formatear_pesos(sin_firmar_monto),
            "badge": f"{cant_sin_firmar} / {cant_tickets_digitales}",
            "subtitulo": "",
        },
        "mp_sin_ticket": {
            "titulo": "MP sin ticket",
            "valor": round(mp_sin_ticket_monto, 2),
            "texto": _formatear_pesos(mp_sin_ticket_monto),
            "badge": str(cant_mp_sin_ticket),
            "subtitulo": "Nada suelto: todo tiene ticket" if cant_mp_sin_ticket == 0 else f"{cant_mp_sin_ticket} cobros sin ticket para facturar",
        },
        "redondeo": {
            "titulo": f"Redondeo {sufijo_periodo}",
            "valor": redondeo_val,
            "texto": _formatear_pesos(redondeo_val),
            "subtitulo": "F3 en el cobro",
        },
        "descuento": {
            "titulo": f"Descuento {sufijo_periodo}",
            "valor": descuento_val,
            "texto": _formatear_pesos(descuento_val),
            "subtitulo": "Ofertas del ticket",
        },
        "tickets": {
            "titulo": f"Tickets {sufijo_periodo}",
            "cant": cant_tickets,
            "total": round(total_tickets, 2),
            "texto": f"{cant_tickets} · {_formatear_pesos(total_tickets)}",
            "subtitulo": "",
        },
        "cancelaciones": {
            "titulo": f"Cancelaciones {sufijo_periodo}",
            "cant": cancelaciones_cant,
            "monto": round(cancelaciones_monto, 2),
            "texto": str(cancelaciones_cant) if cancelaciones_monto == 0 else f"{cancelaciones_cant} · {_formatear_pesos(cancelaciones_monto)}",
            "subtitulo": "",
        },
    }
