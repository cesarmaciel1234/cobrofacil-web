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

    if p in ("ayer", "dia_anterior"):
        ayer = hoy - timedelta(days=1)
        d_str = ayer.isoformat()
        return f"{d_str} 00:00:00", f"{d_str} 23:59:59", "Ayer"

    if p in ("semana", "semana actual", "semana_actual"):
        inicio = hoy - timedelta(days=hoy.weekday())
        fin = inicio + timedelta(days=6)
        return f"{inicio.isoformat()} 00:00:00", f"{fin.isoformat()} 23:59:59", "Semana Actual"

    if p in ("semana p.", "semana pasada", "semanap", "semana_anterior"):
        lunes_esta = hoy - timedelta(days=hoy.weekday())
        lunes_anterior = lunes_esta - timedelta(days=7)
        domingo_anterior = lunes_anterior + timedelta(days=6)
        return f"{lunes_anterior.isoformat()} 00:00:00", f"{domingo_anterior.isoformat()} 23:59:59", "Semana p."

    if p in ("mes", "mes actual", "mes_actual"):
        ultimo_dia = calendar.monthrange(hoy.year, hoy.month)[1]
        inicio = hoy.replace(day=1)
        fin = hoy.replace(day=ultimo_dia)
        return f"{inicio.isoformat()} 00:00:00", f"{fin.isoformat()} 23:59:59", "Mes Actual"

    if p in ("mes anterior", "mes pasado", "mes_anterior", "mesp"):
        primer_dia_este = hoy.replace(day=1)
        ultimo_dia_ant = primer_dia_este - timedelta(days=1)
        primer_dia_ant = ultimo_dia_ant.replace(day=1)
        return f"{primer_dia_ant.isoformat()} 00:00:00", f"{ultimo_dia_ant.isoformat()} 23:59:59", "Mes Anterior"

    if p in ("todas", "todo", "todos", "historico", "historica"):
        return "1970-01-01 00:00:00", "2099-12-31 23:59:59", "Todas"

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
    sucursal_id: int | str | None = None,
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

    es_web = str(sucursal_id or "").strip().lower() == "web"

    # 1. Ventas en el rango
    if es_web:
        col_v, filas_v = [], []
    else:
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

    # Sumar pedidos web si es consolidado o Tienda Web
    if sucursal_id is None or es_web:
        try:
            from app.database import get_db
            from app.services.pos_base import _empresa_activa
            eid_actual = _empresa_activa()
            with get_db() as conn:
                q_web = """
                    SELECT id, ticket_id, total, metodo_pago, estado, created_at
                    FROM public.repartofacil_pedidos
                    WHERE empresa_id = %s AND ticket_id IS NOT NULL AND estado NOT IN ('cancelled', 'rejected', 'cancelled_by_client', 'cancelled_timeout')
                    AND created_at >= %s AND created_at <= %s
                """
                web_rows = conn.execute(q_web, (eid_actual, desde_iso, hasta_iso)).fetchall()
                for wr in web_rows:
                    tot = float(wr["total"] or 0.0)
                    cant_tickets += 1
                    total_tickets += tot
                    tickets_digitales_monto += tot
                    cant_tickets_digitales += 1
                    ventas_vivas_ids.add(str(wr["ticket_id"] or wr["id"]))
        except Exception as e:
            logger.warning("Error sumando pedidos web en calcular_vitrina: %s", e)

    # 2. Detalles ventas y Costo (para ganancia parcial y descuentos de oferta)
    if es_web:
        col_dv, filas_dv = [], []
        col_p, filas_p = filas_de("productos", None)
        if not col_p:
            col_p, filas_p = filas_de("articulos", None)
    else:
        col_dv, filas_dv = filas_de("detalles_ventas", sucursal_id, desde=desde_iso[:10], hasta=hasta_iso[:10])
        if not col_dv:
            col_dv, filas_dv = filas_de("detalle_ventas", sucursal_id, desde=desde_iso[:10], hasta=hasta_iso[:10])
        col_p, filas_p = filas_de("productos", sucursal_id)
        if not col_p:
            col_p, filas_p = filas_de("articulos", sucursal_id)
    idx_dv = _indice(col_dv)
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


def _rango_anterior(desde_iso: str, hasta_iso: str, periodo: str, hoy: date) -> tuple[str, str]:
    p = (periodo or "").strip().lower()
    d0 = datetime.fromisoformat(desde_iso[:19])
    d1 = datetime.fromisoformat(hasta_iso[:19])
    duracion = (d1.date() - d0.date()).days + 1
    if p in ("hoy", "dia", "diario"):
        prev_d0 = d0 - timedelta(days=1)
        prev_d1 = d1 - timedelta(days=1)
    elif p in ("ayer", "dia_anterior"):
        prev_d0 = d0 - timedelta(days=1)
        prev_d1 = d1 - timedelta(days=1)
    elif p in ("semana", "semana actual", "semana_actual"):
        prev_d0 = d0 - timedelta(days=7)
        prev_d1 = d1 - timedelta(days=7)
    elif p in ("semana p.", "semana pasada", "semanap"):
        prev_d0 = d0 - timedelta(days=7)
        prev_d1 = d1 - timedelta(days=7)
    elif p in ("mes", "mes actual", "mes_actual"):
        primer_este = d0.date().replace(day=1)
        ult_ant = primer_este - timedelta(days=1)
        primer_ant = ult_ant.replace(day=1)
        return f"{primer_ant.isoformat()} 00:00:00", f"{ult_ant.isoformat()} 23:59:59"
    elif p in ("mes anterior", "mes pasado", "mes_anterior", "mesp"):
        primer_este = d0.date().replace(day=1)
        ult_ant = primer_este - timedelta(days=1)
        primer_ant = ult_ant.replace(day=1)
        return f"{primer_ant.isoformat()} 00:00:00", f"{ult_ant.isoformat()} 23:59:59"
    elif p in ("año", "anio", "año actual"):
        return f"{d0.year - 1}-01-01 00:00:00", f"{d0.year - 1}-12-31 23:59:59"
    else:
        prev_d0 = d0 - timedelta(days=duracion)
        prev_d1 = d1 - timedelta(days=duracion)
    return f"{prev_d0.strftime('%Y-%m-%d %H:%M:%S')}", f"{prev_d1.strftime('%Y-%m-%d %H:%M:%S')}"


def calcular_reporte_financiero(
    periodo: str = "Semana Actual",
    sucursal_id: int | None = None,
    desde: str | None = None,
    hasta: str | None = None,
    comparar: bool = False,
) -> dict[str, Any]:
    """
    Reporte Financiero oficial (Cerebro Jefe).
    Calcula KPIs de ventas, ganancia sobre costo, serie temporal para curvas interactivas,
    departamentos, medios de pago y diagnósticos automáticos del Cerebro Jefe.
    """
    hoy_date = datetime.now(_ZONA).date()
    desde_iso, hasta_iso, nombre_periodo = resolver_rango(
        periodo=periodo,
        desde_custom=desde,
        hasta_custom=hasta,
        hoy=hoy_date,
    )

    prev_desde_iso, prev_hasta_iso = _rango_anterior(desde_iso, hasta_iso, periodo, hoy_date)

    es_web = str(sucursal_id or "").strip().lower() == "web"

    # 1. Ventas actuales
    if es_web:
        col_v, filas_v = [], []
    else:
        col_v, filas_v = filas_de("ventas", sucursal_id, desde=desde_iso[:10], hasta=hasta_iso[:10])
    idx_v = _indice(col_v)

    # 2. Productos (costo, depto, categoria)
    col_p, filas_p = filas_de("productos", None if es_web else sucursal_id)
    if not col_p:
        col_p, filas_p = filas_de("articulos", None if es_web else sucursal_id)
    idx_p = _indice(col_p)

    mapa_costos: dict[str, float] = {}
    mapa_deptos: dict[str, str] = {}
    for f in filas_p:
        pid = str(_valor(f, idx_p, "id") or "")
        if pid:
            mapa_costos[pid] = _numero(_valor(f, idx_p, "costo", "precio_costo"))
            depto = str(_valor(f, idx_p, "departamento", "categoria") or "").strip().upper()
            if not depto or depto in ("S/D", "SD", "NONE", "NULL", "SIN DEPARTAMENTO"):
                depto = "CARNE"
            mapa_deptos[pid] = depto

    # 3. Detalles de ventas
    if es_web:
        col_dv, filas_dv = [], []
    else:
        col_dv, filas_dv = filas_de("detalles_ventas", sucursal_id, desde=desde_iso[:10], hasta=hasta_iso[:10])
        if not col_dv:
            col_dv, filas_dv = filas_de("detalle_ventas", sucursal_id, desde=desde_iso[:10], hasta=hasta_iso[:10])
    idx_dv = _indice(col_dv)

    items_por_venta: dict[str, list[dict]] = {}
    for f in filas_dv:
        vid = str(_valor(f, idx_dv, "id_venta", "venta_id") or "")
        if not vid:
            continue
        pid = str(_valor(f, idx_dv, "id_producto", "producto_id") or "")
        cant = _numero(_valor(f, idx_dv, "cantidad", "cant"))
        subtotal = _numero(_valor(f, idx_dv, "subtotal", "total"))
        if vid not in items_por_venta:
            items_por_venta[vid] = []
        items_por_venta[vid].append({"pid": pid, "cant": cant, "subtotal": subtotal})

    p_norm = (periodo or "semana").strip().lower()
    slots: list[dict[str, Any]] = []

    if p_norm in ("hoy", "dia", "diario", "ayer", "dia_anterior"):
        for h in range(8, 23):
            k = f"{h:02d}"
            slots.append({"key": k, "label": f"{h:02d}h", "ventas": 0.0, "ganancia": 0.0, "tickets": 0, "ventas_prev": 0.0, "ganancia_prev": 0.0, "tickets_prev": 0})
    elif p_norm in ("año", "anio", "año actual"):
        meses_nom = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
        for i, m in enumerate(meses_nom):
            k = f"{i+1:02d}"
            slots.append({"key": k, "label": m, "ventas": 0.0, "ganancia": 0.0, "tickets": 0, "ventas_prev": 0.0, "ganancia_prev": 0.0, "tickets_prev": 0})
    elif p_norm in ("semana", "semana actual", "semana_actual", "semana p.", "semana pasada", "semanap"):
        dias_nom = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
        d0 = datetime.fromisoformat(desde_iso[:10])
        for i in range(7):
            curr_d = d0 + timedelta(days=i)
            slots.append({
                "key": curr_d.strftime("%Y-%m-%d"),
                "label": dias_nom[i],
                "fecha": curr_d.strftime("%d/%m"),
                "ventas": 0.0,
                "ganancia": 0.0,
                "tickets": 0,
                "ventas_prev": 0.0,
                "ganancia_prev": 0.0,
                "tickets_prev": 0,
            })
    else:
        d0 = datetime.fromisoformat(desde_iso[:10])
        d1 = datetime.fromisoformat(hasta_iso[:10])
        diff = (d1.date() - d0.date()).days + 1
        dias_nom = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
        for i in range(max(1, diff)):
            curr_d = d0 + timedelta(days=i)
            slots.append({
                "key": curr_d.strftime("%Y-%m-%d"),
                "label": f"{dias_nom[curr_d.weekday()]} {curr_d.strftime('%d')}",
                "fecha": curr_d.strftime("%d/%m"),
                "ventas": 0.0,
                "ganancia": 0.0,
                "tickets": 0,
                "ventas_prev": 0.0,
                "ganancia_prev": 0.0,
                "tickets_prev": 0,
            })

    slot_map: dict[str, dict] = {s["key"]: s for s in slots}

    total_ventas = 0.0
    total_tickets = 0
    total_costo = 0.0
    venta_con_costo = 0.0
    hay_costo_cargado = False
    pagos_map: dict[str, float] = {}
    deptos_map: dict[str, float] = {}

    # Integrar pedidos web (Reparto Fácil) si es consolidado o Tienda Web
    if sucursal_id is None or es_web:
        try:
            from app.database import get_db
            from app.services.pos_base import _empresa_activa
            eid_actual = _empresa_activa()
            with get_db() as conn:
                web_rows = conn.execute(
                    """
                    SELECT id, ticket_id, cliente_nombre, total, metodo_pago, estado, created_at, items
                    FROM public.repartofacil_pedidos
                    WHERE empresa_id = %s AND ticket_id IS NOT NULL AND estado NOT IN ('cancelled', 'rejected', 'cancelled_by_client', 'cancelled_timeout')
                    AND created_at >= %s AND created_at <= %s
                    ORDER BY created_at DESC
                    """,
                    (eid_actual, desde_iso, hasta_iso)
                ).fetchall()
                for wr in web_rows:
                    fecha_str = str(wr["created_at"] or "").replace("T", " ")
                    if not (desde_iso <= fecha_str <= hasta_iso):
                        continue

                    tid = str(wr["ticket_id"] or wr["id"])
                    tot = float(wr["total"] or 0.0)
                    pago = "Web"  # Pedidos web siempre son pago Web

                    total_ventas += tot
                    total_tickets += 1
                    pagos_map[pago] = pagos_map.get(pago, 0.0) + tot

                    # Calcular costo y departamento para items web
                    w_items = []
                    if isinstance(wr.get("items"), str):
                        try:
                            import json
                            w_items = json.loads(wr["items"])
                        except Exception:
                            pass
                    elif isinstance(wr.get("items"), list):
                        w_items = wr["items"]

                    v_costo = 0.0
                    for item in w_items:
                        pid = str(item.get("id") or item.get("product_id") or "")
                        c_u = mapa_costos.get(pid, 0.0)
                        st = float(item.get("price") or item.get("precio") or 0.0) * float(item.get("quantity") or item.get("cantidad") or 1)
                        depto = mapa_deptos.get(pid, "CARNE")
                        deptos_map[depto] = deptos_map.get(depto, 0.0) + st
                        if c_u > 0.009:
                            hay_costo_cargado = True
                            v_costo += float(item.get("quantity") or item.get("cantidad") or 1) * c_u
                            venta_con_costo += st

                    total_costo += v_costo

                    # Agregar al slot correspondiente
                    k = ""
                    if p_norm in ("hoy", "dia", "diario"):
                        k = fecha_str[11:13] if len(fecha_str) >= 13 else "12"
                    elif p_norm in ("año", "anio", "año actual"):
                        k = fecha_str[5:7] if len(fecha_str) >= 7 else "01"
                    else:
                        k = fecha_str[:10]

                    target_slot = slot_map.get(k)
                    if target_slot:
                        target_slot["ventas"] += tot
                        target_slot["tickets"] += 1
                        if hay_costo_cargado:
                            target_slot["ganancia"] += (tot - v_costo)
                        else:
                            target_slot["ganancia"] += tot
        except Exception as e:
            logger.warning("Error integrando pedidos web en vitrina: %s", e)

    for fila in filas_v:
        fecha_str = str(_valor(fila, idx_v, "fecha") or "").replace("T", " ")
        if not (desde_iso <= fecha_str <= hasta_iso):
            dia = fecha_str[:10]
            if not (len(dia) == 10 and dia[4] == "-" and desde_iso[:10] <= dia <= hasta_iso[:10]):
                continue

        if not _es_viva(_valor(fila, idx_v, "estado")):
            continue

        vid = str(_valor(fila, idx_v, "id") or "")
        tot = _numero(_valor(fila, idx_v, "total"))
        pago = str(_valor(fila, idx_v, "metodo_pago", "medio_pago") or "Efectivo").strip()
        if not pago or pago.upper() == "NONE":
            pago = "Efectivo"

        total_ventas += tot
        total_tickets += 1
        pagos_map[pago] = pagos_map.get(pago, 0.0) + tot

        v_items = items_por_venta.get(vid, [])
        v_costo = 0.0
        for item in v_items:
            pid = item["pid"]
            c_u = mapa_costos.get(pid, 0.0)
            st = item["subtotal"]
            depto = mapa_deptos.get(pid, "CARNE")
            deptos_map[depto] = deptos_map.get(depto, 0.0) + st
            if c_u > 0.009:
                hay_costo_cargado = True
                v_costo += item["cant"] * c_u
                venta_con_costo += st

        total_costo += v_costo

        k = ""
        if p_norm in ("hoy", "dia", "diario"):
            k = fecha_str[11:13] if len(fecha_str) >= 13 else "12"
        elif p_norm in ("año", "anio", "año actual"):
            k = fecha_str[5:7] if len(fecha_str) >= 7 else "01"
        else:
            k = fecha_str[:10]

        target_slot = slot_map.get(k)
        if target_slot:
            target_slot["ventas"] += tot
            target_slot["tickets"] += 1
            if hay_costo_cargado:
                target_slot["ganancia"] += (tot - v_costo)
            else:
                target_slot["ganancia"] += tot

    total_ventas_prev = 0.0
    total_tickets_prev = 0
    total_costo_prev = 0.0
    hay_costo_prev = False

    # Siempre calculamos el período previo para benchmark día a día y proyección de cierre
    if prev_desde_iso and prev_hasta_iso:
        if es_web:
            col_vp, filas_vp = [], []
            col_dvp, filas_dvp = [], []
            idx_vp = {}
            idx_dvp = {}
            items_prev_map = {}
        else:
            col_vp, filas_vp = filas_de("ventas", sucursal_id, desde=prev_desde_iso[:10], hasta=prev_hasta_iso[:10])
            idx_vp = _indice(col_vp)
            col_dvp, filas_dvp = filas_de("detalles_ventas", sucursal_id, desde=prev_desde_iso[:10], hasta=prev_hasta_iso[:10])
            if not col_dvp:
                col_dvp, filas_dvp = filas_de("detalle_ventas", sucursal_id, desde=prev_desde_iso[:10], hasta=prev_hasta_iso[:10])
            idx_dvp = _indice(col_dvp)

            items_prev_map: dict[str, list[dict]] = {}
            for f in filas_dvp:
                vid = str(_valor(f, idx_dvp, "id_venta", "venta_id") or "")
                if not vid:
                    continue
                pid = str(_valor(f, idx_dvp, "id_producto", "producto_id") or "")
                cant = _numero(_valor(f, idx_dvp, "cantidad", "cant"))
                subtotal = _numero(_valor(f, idx_dvp, "subtotal", "total"))
                if vid not in items_prev_map:
                    items_prev_map[vid] = []
                items_prev_map[vid].append({"pid": pid, "cant": cant, "subtotal": subtotal})

        d0_prev = datetime.fromisoformat(prev_desde_iso[:10])
        for fila in filas_vp:
            fecha_str = str(_valor(fila, idx_vp, "fecha") or "").replace("T", " ")
            if not (prev_desde_iso <= fecha_str <= prev_hasta_iso):
                dia = fecha_str[:10]
                if not (len(dia) == 10 and dia[4] == "-" and prev_desde_iso[:10] <= dia <= prev_hasta_iso[:10]):
                    continue
            if not _es_viva(_valor(fila, idx_vp, "estado")):
                continue

            vid = str(_valor(fila, idx_vp, "id") or "")
            tot = _numero(_valor(fila, idx_vp, "total"))
            total_ventas_prev += tot
            total_tickets_prev += 1

            v_costo = 0.0
            for item in items_prev_map.get(vid, []):
                c_u = mapa_costos.get(item["pid"], 0.0)
                if c_u > 0.009:
                    hay_costo_prev = True
                    v_costo += item["cant"] * c_u

            total_costo_prev += v_costo

            if p_norm in ("hoy", "dia", "diario"):
                h_k = fecha_str[11:13] if len(fecha_str) >= 13 else "12"
                slot_obj = slot_map.get(h_k)
                if slot_obj:
                    slot_obj["ventas_prev"] += tot
                    slot_obj["ganancia_prev"] += (tot - v_costo)
                    slot_obj["tickets_prev"] += 1
            elif p_norm in ("año", "anio", "año actual"):
                m_k = fecha_str[5:7] if len(fecha_str) >= 7 else "01"
                slot_obj = slot_map.get(m_k)
                if slot_obj:
                    slot_obj["ventas_prev"] += tot
                    slot_obj["ganancia_prev"] += (tot - v_costo)
                    slot_obj["tickets_prev"] += 1
            else:
                try:
                    f_d = datetime.fromisoformat(fecha_str[:10]).date()
                    delta_dias = (f_d - d0_prev.date()).days
                    if 0 <= delta_dias < len(slots):
                        slots[delta_dias]["ventas_prev"] += tot
                        slots[delta_dias]["ganancia_prev"] += (tot - v_costo)
                        slots[delta_dias]["tickets_prev"] += 1
                except Exception:
                    pass

        # Integrar pedidos web en período previo si es consolidado o Tienda Web
        if sucursal_id is None or es_web:
            try:
                from app.database import get_db
                from app.services.pos_base import _empresa_activa
                eid_actual = _empresa_activa()
                with get_db() as conn:
                    web_prev = conn.execute(
                        """
                        SELECT id, ticket_id, total, created_at
                        FROM public.repartofacil_pedidos
                        WHERE empresa_id = %s AND ticket_id IS NOT NULL AND estado NOT IN ('cancelled', 'rejected', 'cancelled_by_client', 'cancelled_timeout')
                        AND created_at >= %s AND created_at <= %s
                        """,
                        (eid_actual, prev_desde_iso, prev_hasta_iso)
                    ).fetchall()
                    for wr in web_prev:
                        tot = float(wr["total"] or 0.0)
                        total_ventas_prev += tot
                        total_tickets_prev += 1
                        fecha_str = str(wr["created_at"] or "")
                        try:
                            f_d = datetime.fromisoformat(fecha_str[:10]).date()
                            delta_dias = (f_d - d0_prev.date()).days
                            if 0 <= delta_dias < len(slots):
                                slots[delta_dias]["ventas_prev"] += tot
                                slots[delta_dias]["tickets_prev"] += 1
                        except Exception:
                            pass
            except Exception as e:
                logger.warning("Error sumando pedidos web previos en reporte: %s", e)

    ticket_medio = round(total_ventas / total_tickets, 2) if total_tickets else 0.0
    ganancia_neta = round(total_ventas - total_costo, 2) if hay_costo_cargado else None
    margen = round((ganancia_neta / total_ventas) * 100, 1) if (ganancia_neta is not None and total_ventas > 0) else None
    cobertura = round((venta_con_costo / total_ventas) * 100, 1) if total_ventas > 0 else 0.0

    ganancia_prev = round(total_ventas_prev - total_costo_prev, 2) if hay_costo_prev else None
    ventas_diff_pct = round(((total_ventas - total_ventas_prev) / total_ventas_prev) * 100, 1) if total_ventas_prev > 0 else 0.0
    ganancia_diff_pct = round(((ganancia_neta - ganancia_prev) / ganancia_prev) * 100, 1) if (ganancia_neta is not None and ganancia_prev and ganancia_prev > 0) else 0.0

    for s in slots:
        s["ventas"] = round(s["ventas"], 2)
        s["ganancia"] = round(s["ganancia"], 2)
        s["ventas_prev"] = round(s["ventas_prev"], 2)
        s["ganancia_prev"] = round(s["ganancia_prev"], 2)
        s["tickets_prev"] = int(s.get("tickets_prev", 0))

    # Proyección inteligente para la semana en curso
    proyeccion = None
    if p_norm in ("semana", "semana actual", "semana_actual"):
        ventas_acum = sum(s["ventas"] for s in slots)
        ventas_restantes = sum(s["ventas_prev"] for s in slots if s["ventas"] <= 0.009)
        proy_ventas = round(ventas_acum + ventas_restantes, 2)
        ganancia_acum = sum(s["ganancia"] for s in slots)
        ganancia_restantes = sum(s["ganancia_prev"] for s in slots if s["ventas"] <= 0.009)
        proy_ganancia = round(ganancia_acum + ganancia_restantes, 2) if hay_costo_cargado else None
        dias_con_venta = sum(1 for s in slots if s["ventas"] > 0.009)
        proyeccion = {
            "ventas": proy_ventas,
            "ventas_texto": _formatear_pesos(proy_ventas),
            "ganancia": proy_ganancia,
            "ganancia_texto": _formatear_pesos(proy_ganancia) if proy_ganancia is not None else None,
            "ventas_acumuladas": round(ventas_acum, 2),
            "ventas_restantes_est": round(ventas_restantes, 2),
            "total_semana_anterior": round(total_ventas_prev, 2),
            "dias_con_venta": dias_con_venta,
            "dias_restantes": len(slots) - dias_con_venta,
        }

    pico_slot = max(slots, key=lambda s: s["ventas"]) if slots else None
    if pico_slot and pico_slot["ventas"] > 0:
        pico_txt = f"El mejor desempeño fue el día {pico_slot['label']} con {_formatear_pesos(pico_slot['ventas'])}. Asegurate de replicar la estrategia de ese día."
    else:
        pico_txt = "Aún no se registran picos de ventas en este período."

    top_depto = max(deptos_map.items(), key=lambda d: d[1])[0] if deptos_map else "CARNE"
    depto_txt = f"{top_depto} está liderando en volumen. Considerá ubicar promociones cruzadas cerca de esta sección."

    top_pago = max(pagos_map.items(), key=lambda p: p[1])[0] if pagos_map else "Efectivo"
    pago_txt = f"La mayoría de tus clientes prefiere usar {top_pago}. Analizá si las comisiones de este método están optimizadas."

    if hay_costo_cargado and ganancia_neta is not None:
        costo_txt = f"Ganancia neta {_formatear_pesos(ganancia_neta)} con margen del {margen:.0f}%. Cobertura de costo: {cobertura}%."
    else:
        costo_txt = "Falta precio de costo en algunos productos. Cargá inventario y costo para firmar la ganancia neta exacta."

    top_deptos = []
    tot_d = sum(deptos_map.values()) or 1.0
    for dep, v in sorted(deptos_map.items(), key=lambda x: x[1], reverse=True):
        top_deptos.append({
            "nombre": dep,
            "total": round(v, 2),
            "texto": _formatear_pesos(v),
            "porcentaje": round((v / tot_d) * 100, 1),
        })

    top_pagos = []
    tot_p = sum(pagos_map.values()) or 1.0
    for pag, v in sorted(pagos_map.items(), key=lambda x: x[1], reverse=True):
        top_pagos.append({
            "medio": pag,
            "total": round(v, 2),
            "texto": _formatear_pesos(v),
            "porcentaje": round((v / tot_p) * 100, 1),
        })

    from app.services.pos_base import listar_sucursales

    return {
        "ok": True,
        "panel": "financiero",
        "periodo": nombre_periodo,
        "titulo": f"Resumen de Ventas ({nombre_periodo})",
        "desde": desde_iso[:10],
        "hasta": hasta_iso[:10],
        "comparar": comparar,
        "kpis": {
            "ventas": round(total_ventas, 2),
            "ventas_texto": _formatear_pesos(total_ventas),
            "tickets": total_tickets,
            "ticket_medio": ticket_medio,
            "ticket_medio_texto": _formatear_pesos(ticket_medio),
            "costo": round(total_costo, 2),
            "costo_texto": _formatear_pesos(total_costo),
            "hay_costo": hay_costo_cargado,
            "ganancia": ganancia_neta,
            "ganancia_texto": _formatear_pesos(ganancia_neta) if hay_costo_cargado else "Sin costo",
            "margen": margen,
            "cobertura": cobertura,
            "ventas_prev": round(total_ventas_prev, 2),
            "ventas_prev_texto": _formatear_pesos(total_ventas_prev),
            "ventas_diff_pct": ventas_diff_pct,
            "ganancia_prev": ganancia_prev,
            "ganancia_prev_texto": _formatear_pesos(ganancia_prev) if ganancia_prev is not None else "Sin costo",
            "ganancia_diff_pct": ganancia_diff_pct,
        },
        "cerebro_jefe": [
            {"tipo": "pico", "icono": "📈", "titulo": "Pico de Ventas", "texto": pico_txt},
            {"tipo": "depto", "icono": "🏆", "titulo": "Departamento Estrella", "texto": depto_txt},
            {"tipo": "pago", "icono": "💳", "titulo": "Preferencia de Pago", "texto": pago_txt},
            {"tipo": "costo", "icono": "💰", "titulo": "Costo e Inventario", "texto": costo_txt},
        ],
        "serie": slots,
        "proyeccion": proyeccion,
        "deptos": top_deptos,
        "pagos": top_pagos,
        "sucursales": listar_sucursales(),
        "sucursal_id": sucursal_id,
    }
