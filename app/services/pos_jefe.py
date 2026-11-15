"""Cara del panel del jefe, contabilidad y admin. Los números salen del libro de Cobro Fácil guardado en la nube."""
from __future__ import annotations

import threading
from datetime import datetime
from zoneinfo import ZoneInfo

from app.services.pos_base import filas_de, listar_sucursales, ultima_carga
from app.services.pos_historial import historial_ventas, rango_fechas

_ZONA = ZoneInfo("America/Argentina/Buenos_Aires")
_cartera_lock = threading.Lock()
_cartera_cache: dict[tuple, tuple[tuple, dict]] = {}


def olvidar_cartera() -> None:
    """El libro cambió: la cartera armada deja de servir."""
    with _cartera_lock:
        _cartera_cache.clear()


def _indice(columnas: list) -> dict[str, int]:
    return {str(col).lower(): i for i, col in enumerate(columnas)}


def _valor(fila: list, idx: dict[str, int], *nombres: str):
    for nombre in nombres:
        i = idx.get(nombre)
        if i is not None and i < len(fila):
            return fila[i]
    return None


def _numero(valor) -> float:
    try:
        return float(valor or 0)
    except (TypeError, ValueError):
        return 0.0


def _dia(valor) -> str:
    texto = str(valor or "").strip()
    return texto[:10] if len(texto) >= 10 else ""


def _viva(estado) -> bool:
    return str(estado or "").strip().upper() not in ("CANCELADA", "ANULADA", "CANCELADO", "ANULADO")


def _clave(valor) -> str:
    if valor is None or valor == "":
        return ""
    if isinstance(valor, float) and valor.is_integer():
        return str(int(valor))
    texto = str(valor).strip()
    return texto[:-2] if texto.endswith(".0") else texto


_MARCAS_DIGITAL = ("QR", "MERCADOPAGO", "MP", "TARJETA", "POINT", "TRANSFERENCIA", "DIGITAL", "MIXTO")


def _es_digital(pago) -> bool:
    texto = str(pago or "").upper()
    return any(marca in texto for marca in _MARCAS_DIGITAL)


def _comercio(sucursal_id: int | None, sucursales: list[dict]) -> str:
    if sucursal_id is not None:
        for sucursal in sucursales:
            if sucursal["id"] == int(sucursal_id):
                return sucursal["nombre"]
    if len(sucursales) == 1:
        return sucursales[0]["nombre"]
    return "Todas las sucursales"


def _ventas(sucursal_id: int | None = None):
    columnas, filas = filas_de("ventas", sucursal_id)
    if not columnas:
        return [], {}
    idx = _indice(columnas)
    vivas = []
    for fila in filas:
        if not _viva(_valor(fila, idx, "estado")):
            continue
        dia = _dia(_valor(fila, idx, "fecha"))
        if not dia:
            continue
        vivas.append(
            {
                "id": _valor(fila, idx, "id"),
                "fecha": str(_valor(fila, idx, "fecha") or "").split(".")[0],
                "dia": dia,
                "total": _numero(_valor(fila, idx, "total")),
                "pago": str(_valor(fila, idx, "metodo_pago", "medio_pago") or "Efectivo"),
                "sucursal_id": _valor(fila, idx, "sucursal_id"),
            }
        )
    return vivas, idx


def _dia_libro(ventas: list[dict]) -> str:
    hoy = datetime.now(_ZONA).date().isoformat()
    dias = {v["dia"] for v in ventas}
    if hoy in dias:
        return hoy
    return max(dias) if dias else hoy


def _resumen(ventas: list[dict], dia: str) -> dict:
    del_dia = [v for v in ventas if v["dia"] == dia]
    tickets = len(del_dia)
    total = sum(v["total"] for v in del_dia)
    por_medio: dict[str, float] = {}
    digital = 0.0
    for venta in del_dia:
        medio = venta["pago"] or "Efectivo"
        por_medio[medio] = por_medio.get(medio, 0.0) + venta["total"]
        if _es_digital(medio):
            digital += venta["total"]
    pago = max(por_medio, key=por_medio.get) if por_medio else ""
    anteriores = sorted({v["dia"] for v in ventas if v["dia"] < dia})
    dia_anterior = anteriores[-1] if anteriores else ""
    ventas_anterior = (
        round(sum(v["total"] for v in ventas if v["dia"] == dia_anterior), 2)
        if dia_anterior else None
    )
    variacion = None
    if ventas_anterior:
        variacion = round((total - ventas_anterior) / ventas_anterior * 100, 1)
    return {
        "dia": dia,
        "ventas": round(total, 2),
        "tickets": tickets,
        "promedio": round(total / tickets, 2) if tickets else 0.0,
        "pago": pago,
        "es_hoy": dia == datetime.now(_ZONA).date().isoformat(),
        "dia_anterior": dia_anterior,
        "ventas_anterior": ventas_anterior,
        "variacion_pct": variacion,
        "mix_digital_pct": round(digital / total * 100, 1) if total else 0.0,
    }


def _desglose_sucursales(ventas: list[dict], dia: str) -> list[dict]:
    del_dia = [v for v in ventas if v["dia"] == dia]
    sucursales = listar_sucursales()
    nombres_suc = {s["id"]: s["nombre"] for s in sucursales}

    agrupado: dict[int, dict] = {}
    for v in del_dia:
        sid = v.get("sucursal_id")
        sid_val = int(sid) if sid is not None else 1
        if sid_val not in agrupado:
            agrupado[sid_val] = {
                "sucursal_id": sid_val,
                "nombre": nombres_suc.get(sid_val, f"Sucursal {sid_val}"),
                "ventas": 0.0,
                "tickets": 0,
            }
        agrupado[sid_val]["ventas"] += v["total"]
        agrupado[sid_val]["tickets"] += 1

    lista = []
    for item in agrupado.values():
        t = item["tickets"]
        m = item["ventas"]
        lista.append({
            "sucursal_id": item["sucursal_id"],
            "nombre": item["nombre"],
            "ventas": round(m, 2),
            "tickets": t,
            "promedio": round(m / t, 2) if t else 0.0,
        })
    lista.sort(key=lambda x: x["ventas"], reverse=True)
    return lista


def _ranking_cortes(dia: str, sucursal_id: int | None, ventas: list[dict]) -> list[dict]:
    columnas, filas = filas_de("ventas_items", sucursal_id)
    if not columnas:
        columnas, filas = filas_de("detalle_ventas", sucursal_id)
    if not columnas:
        return []
    idx = _indice(columnas)
    ids_dia = {_clave(v["id"]) for v in ventas if v["dia"] == dia and _clave(v.get("id"))}
    enlace = next((nombre for nombre in ("venta_id", "id_venta", "ticket_id", "venta") if nombre in idx), "")
    cortes: dict[str, dict] = {}
    for fila in filas:
        if enlace and ids_dia and _clave(_valor(fila, idx, enlace)) not in ids_dia:
            continue
        if not enlace:
            fecha_item = _dia(_valor(fila, idx, "fecha"))
            if fecha_item and fecha_item != dia:
                continue
        nombre = str(_valor(fila, idx, "nombre", "producto", "descripcion") or "").strip()
        if not nombre:
            continue
        cant = _numero(_valor(fila, idx, "cantidad", "kilos", "peso", "unidades"))
        subtotal = _numero(_valor(fila, idx, "subtotal", "total", "monto"))
        if nombre not in cortes:
            cortes[nombre] = {"producto": nombre, "cantidad": 0.0, "total": 0.0, "operaciones": 0}
        cortes[nombre]["cantidad"] += cant
        cortes[nombre]["total"] += subtotal
        cortes[nombre]["operaciones"] += 1

    lista = sorted(
        [
            {
                "producto": c["producto"],
                "cantidad": round(c["cantidad"], 2),
                "total": round(c["total"], 2),
                "operaciones": c["operaciones"],
            }
            for c in cortes.values()
        ],
        key=lambda x: x["total"],
        reverse=True,
    )
    return lista[:20]


def _en_dias(fecha, ini: str, fin: str) -> bool:
    dia = _dia(fecha)
    return bool(dia) and ini <= dia <= fin


def _cobros_digitales(dia: str, sucursal_id: int | None = None, hasta: str | None = None) -> dict:
    ini = (dia or "")[:10]
    fin = (hasta or dia or "")[:10]
    col_v, filas_v = filas_de("ventas", sucursal_id)
    idx_v = _indice(col_v)
    vivas = []
    cancelados = 0.0
    if col_v:
        for f in filas_v:
            if not _en_dias(_valor(f, idx_v, "fecha"), ini, fin):
                continue
            pago = _valor(f, idx_v, "metodo_pago", "medio_pago")
            if not _es_digital(pago):
                continue
            monto = _numero(_valor(f, idx_v, "total"))
            if not _viva(_valor(f, idx_v, "estado")):
                cancelados += monto
                continue
            vivas.append({
                "id": _valor(f, idx_v, "id"),
                "fecha": str(_valor(f, idx_v, "fecha") or ""),
                "pago": pago or "QR",
                "total": monto,
                "id_pago": _valor(f, idx_v, "id_pago", "mp_id", "payment_id"),
            })

    col_cc, filas_cc = filas_de("cuenta_corriente", sucursal_id)
    idx_cc = _indice(col_cc)
    cobros_dig = []
    if col_cc:
        for f in filas_cc:
            if _en_dias(_valor(f, idx_cc, "fecha"), ini, fin) and str(_valor(f, idx_cc, "tipo") or "").upper() == "ABONO":
                desc = str(_valor(f, idx_cc, "descripcion") or "")
                if _es_digital(desc):
                    cobros_dig.append({
                        "id": _valor(f, idx_cc, "id"),
                        "monto": _numero(_valor(f, idx_cc, "monto")),
                        "desc": desc or "Cobro digital fiado",
                        "fecha": str(_valor(f, idx_cc, "fecha") or ""),
                    })

    col_cd, filas_cd = filas_de("cobros_digitales", sucursal_id)
    idx_cd = _indice(col_cd)
    registros = []
    netos_reales = []
    fuente = "vacio"
    if col_cd:
        fuente = "libro"
        for f in filas_cd:
            if not _en_dias(_valor(f, idx_cd, "fecha"), ini, fin):
                continue
            neto = _valor(f, idx_cd, "neto", "monto_neto", "liquido")
            if neto not in (None, ""):
                netos_reales.append(_numero(neto))
            registros.append({
                "id": _valor(f, idx_cd, "id"),
                "id_pago": _valor(f, idx_cd, "id_pago", "mp_id") or "—",
                "fecha": str(_valor(f, idx_cd, "fecha") or ""),
                "cuenta": str(_valor(f, idx_cd, "cuenta", "titular") or "—"),
                "concepto": str(_valor(f, idx_cd, "concepto", "tipo") or "Cobro digital"),
                "monto": _numero(_valor(f, idx_cd, "monto")),
                "estado": str(_valor(f, idx_cd, "estado") or "FIRMADO").upper(),
                "ticket_venta": _valor(f, idx_cd, "ticket_venta", "ticket_id") or "—",
                "ticket_cobro": _valor(f, idx_cd, "ticket_cobro") or "—",
            })

    if not registros:
        fuente = "ticket" if (vivas or cobros_dig) else "vacio"
        for venta in vivas:
            pago = str(venta["pago"])
            registros.append({
                "id": venta["id"],
                "id_pago": venta["id_pago"] or "—",
                "fecha": venta["fecha"],
                "cuenta": pago,
                "concepto": f"Ticket {pago}",
                "monto": venta["total"],
                "estado": "EN TICKET",
                "ticket_venta": str(venta["id"]),
                "ticket_cobro": "—",
            })
        for cobro in cobros_dig:
            registros.append({
                "id": cobro["id"],
                "id_pago": "—",
                "fecha": cobro["fecha"],
                "cuenta": "Cuenta corriente",
                "concepto": cobro["desc"],
                "monto": cobro["monto"],
                "estado": "COBRADO",
                "ticket_venta": "—",
                "ticket_cobro": str(cobro["id"]),
            })

    bruto = sum(r["monto"] for r in registros)
    tickets_digitales = sum(v["total"] for v in vivas)
    if fuente == "libro" and netos_reales:
        neto = round(sum(netos_reales), 2)
        neto_estimado = False
    else:
        neto = round(bruto, 2)
        neto_estimado = fuente != "libro" or not netos_reales
    firmados = sum(r["monto"] for r in registros if r["estado"] == "FIRMADO")
    sin_firmar = sum(r["monto"] for r in registros if "SIN FIRMAR" in r["estado"])
    sin_ticket = sum(r["monto"] for r in registros if "SIN TICKET" in r["estado"])
    brecha = round(tickets_digitales - bruto, 2) if fuente == "libro" else 0.0

    return {
        "fuente": fuente,
        "bruto_mp": round(bruto, 2),
        "neto_mp": neto,
        "neto_estimado": neto_estimado,
        "tickets_digitales": round(tickets_digitales, 2),
        "brecha_ticket": brecha,
        "firmados_ticket": round(firmados, 2),
        "sin_firmar": round(sin_firmar, 2),
        "sin_ticket": round(sin_ticket, 2),
        "cliente_cobros": round(sum(c["monto"] for c in cobros_dig), 2),
        "cancelados": round(cancelados, 2),
        "transacciones": sorted(registros, key=lambda fila: str(fila.get("fecha") or ""), reverse=True)[:400],
        "recorte": len(registros) > 400,
    }


def _pedidos_abastecimiento(sucursal_id: int | None = None) -> dict:
    col_p, filas_p = filas_de("productos", sucursal_id)
    if not col_p:
        col_p, filas_p = filas_de("articulos", sucursal_id)
    idx_p = _indice(col_p)

    faltantes = []
    inversion_estimada = 0.0
    proveedores_set = set()

    if col_p:
        for f in filas_p:
            codigo = str(_valor(f, idx_p, "codigo", "id") or "")
            nombre = str(_valor(f, idx_p, "nombre", "descripcion", "producto") or "").strip()
            if not nombre:
                continue
            stock = _numero(_valor(f, idx_p, "stock", "stock_actual", "existencia"))
            minimo = _numero(_valor(f, idx_p, "minimo", "stock_minimo", "punto_pedido"))
            maximo = _numero(_valor(f, idx_p, "maximo", "stock_maximo")) or (minimo * 2 if minimo > 0 else 10.0)
            costo = _numero(_valor(f, idx_p, "costo", "costo_unitario", "precio_costo"))
            precio = _numero(_valor(f, idx_p, "precio", "precio_lista", "precio_venta"))
            unidad = str(_valor(f, idx_p, "unidad") or "").strip()
            marca_pesable = str(_valor(f, idx_p, "es_pesable") or "").strip().lower()
            pesable = marca_pesable in ("1", "true", "t", "si", "sí") or unidad.lower() in ("kg", "kilo", "kilos")
            prov = str(_valor(f, idx_p, "proveedor", "proveedor_nombre") or "").strip() or "Sin proveedor"

            if stock <= minimo:
                a_pedir = max(1.0, round(maximo - stock, 1))
                subtotal = round(a_pedir * costo, 2)
                inversion_estimada += subtotal
                proveedores_set.add(prov)
                faltantes.append({
                    "codigo": codigo,
                    "producto": nombre,
                    "stock_actual": stock,
                    "minimo": minimo,
                    "maximo": maximo,
                    "a_pedir": a_pedir,
                    "costo_unit": costo,
                    "precio": precio,
                    "unidad": "kg" if pesable else (unidad or "un"),
                    "pesable": pesable,
                    "subtotal": subtotal,
                    "proveedor": prov,
                })

    faltantes.sort(key=lambda x: x["subtotal"], reverse=True)

    sucursales = listar_sucursales()
    comercio = _comercio(sucursal_id, sucursales)
    hoy_str = datetime.now(_ZONA).strftime("%d/%m/%Y")
    lineas_wsp = [
        "--- PEDIDO DE REPOSICION ---",
        f"Comercio: {comercio}",
        f"Fecha: {hoy_str}",
        "----------------------------",
    ]
    por_proveedor: dict[str, list] = {}
    for item in faltantes[:15]:
        por_proveedor.setdefault(item["proveedor"], []).append(item)
    for proveedor, items in por_proveedor.items():
        lineas_wsp.append(proveedor)
        for item in items:
            lineas_wsp.append(f"- {int(item['a_pedir'])}x {item['producto']}")
    lineas_wsp.append("Favor confirmar recepcion y fecha estimada de entrega. Muchas gracias!")
    mensaje_wsp = "\n".join(lineas_wsp)

    return {
        "articulos_en_quiebre": len(faltantes),
        "proveedores_con_pedido": len(proveedores_set) or (1 if faltantes else 0),
        "inversion_estimada": round(inversion_estimada, 2),
        "faltantes": faltantes[:50],
        "mensaje_whatsapp": mensaje_wsp,
    }


def _porcentaje(tasa) -> int:
    try:
        return int(round(float(tasa) * 100))
    except (TypeError, ValueError):
        return 0


def _interes_del_libro(
    sucursal_id: int | None,
    columnas: list | None = None,
    filas: list | None = None,
    solo: set[str] | None = None,
) -> tuple[dict[str, dict], str, str]:
    """Días y mantenimiento del libro. Una sola lectura, y solo de quien tiene deuda."""
    from app.services.pos_historial import _activacion, _dicts, _politica
    from app.services.pos_interes import proyectar_interes

    col_cfg, filas_cfg = filas_de("configuracion", sucursal_id)
    if not col_cfg and sucursal_id is not None:
        col_cfg, filas_cfg = filas_de("configuracion")
    configs = _dicts(col_cfg, filas_cfg) if col_cfg else []
    activacion = _activacion(configs)
    tasa_base, tasa_apal, plazo = _politica(configs)
    tarifa_base = f"{_porcentaje(tasa_base)}%"
    tarifa_morosa = f"{_porcentaje(tasa_base + tasa_apal)}%"

    if columnas is None or filas is None:
        columnas, filas = filas_de("cuenta_corriente", sucursal_id)
    if not columnas or (solo is not None and not solo):
        return {}, tarifa_base, tarifa_morosa
    idx = _indice(columnas)
    if "cliente_id" not in idx:
        return {}, tarifa_base, tarifa_morosa
    grupos: dict[str, list[dict]] = {}
    for fila in filas:
        cliente = _clave(_valor(fila, idx, "cliente_id"))
        if not cliente or (solo is not None and cliente not in solo):
            continue
        desc = str(_valor(fila, idx, "descripcion") or "")
        if "MANTENIMIENTO" in desc.upper():
            continue
        grupos.setdefault(cliente, []).append({
            "tipo": _valor(fila, idx, "tipo"),
            "descripcion": desc,
            "fecha": _valor(fila, idx, "fecha"),
            "id": _valor(fila, idx, "id"),
            "monto": _valor(fila, idx, "monto"),
            "venta_id": _valor(fila, idx, "venta_id"),
        })

    ahora = datetime.now(_ZONA).replace(tzinfo=None)
    salida: dict[str, dict] = {}
    for cliente, movimientos in grupos.items():
        try:
            proyeccion = proyectar_interes(
                movimientos,
                activacion,
                ahora=ahora,
                tasa_base=tasa_base,
                tasa_apal=tasa_apal,
                dias_plazo=plazo,
            )
        except (ValueError, TypeError):
            continue
        tickets = proyeccion.get("tickets") or {}
        dias = max((int(t.get("dias") or 0) for t in tickets.values()), default=0)
        salida[cliente] = {
            "dias": dias,
            "mantenimiento": round(float(proyeccion.get("interes_acumulado") or 0), 2),
            "en_apalancamiento": any(t.get("en_apalancamiento") for t in tickets.values()),
        }
    return salida, tarifa_base, tarifa_morosa


def _nombres_en_crm() -> dict[str, dict]:
    """Nombre y teléfono que el CRM ya tiene, cuando el libro no trajo la tabla de clientes."""
    from app.database import get_db

    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT nombre, telefono, cuit, tipo_cliente, pos_id FROM clientes WHERE pos_id IS NOT NULL"
            ).fetchall()
    except Exception:
        return {}
    return {_clave(fila["pos_id"]): dict(fila) for fila in rows if _clave(fila["pos_id"])}


def _filas_clientes(sucursal_id: int | None) -> tuple[list[str], list[list]]:
    columnas, filas = filas_de("clientes", sucursal_id)
    if filas:
        return columnas, filas
    col_cc, filas_cc = filas_de("cuenta_corriente", sucursal_id)
    if not col_cc:
        return [], []
    idx = _indice(col_cc)
    ultimos: dict[str, tuple] = {}
    for fila in filas_cc:
        cid = _clave(_valor(fila, idx, "cliente_id"))
        if not cid:
            continue
        marca = (str(_valor(fila, idx, "fecha") or ""), int(_numero(_valor(fila, idx, "id"))))
        previo = ultimos.get(cid)
        if previo is None or marca >= previo[0]:
            ultimos[cid] = (marca, _numero(_valor(fila, idx, "saldo_resultante")))
    nombres = _nombres_en_crm()
    armadas = []
    for cid, (_, saldo) in ultimos.items():
        crm = nombres.get(cid) or {}
        armadas.append([
            cid,
            crm.get("nombre") or f"Cliente {cid}",
            crm.get("telefono") or "",
            crm.get("cuit") or "",
            str(crm.get("tipo_cliente") or "Fiado"),
            saldo,
            0,
        ])
    return ["id", "nombre", "telefono", "dni", "tipo_cliente", "deuda_actual", "limite_credito"], armadas


def _cartera_admin(sucursal_id: int | None = None) -> dict:
    from app.services.pos_base import _ambito_cache, sellos_de

    clave = (_ambito_cache(), sucursal_id)
    sellos = sellos_de(("clientes", "cuenta_corriente", "configuracion"), sucursal_id)
    with _cartera_lock:
        guardada = _cartera_cache.get(clave)
        if guardada and guardada[0] == sellos:
            return guardada[1]
    resultado = _calcular_cartera(sucursal_id)
    with _cartera_lock:
        _cartera_cache[clave] = (sellos, resultado)
    return resultado


def _calcular_cartera(sucursal_id: int | None = None) -> dict:
    columnas, filas = _filas_clientes(sucursal_id)
    idx = _indice(columnas)
    total_deuda = 0.0
    total_a_favor = 0.0
    con_deuda = 0
    al_dia = 0
    a_favor = 0
    deuda_en_riesgo = 0.0
    cuentas_en_riesgo = 0
    mora_30 = 0
    mora_60 = 0
    mora_90 = 0
    deudores = []
    clientes = []

    mes_actual = datetime.now(_ZONA).strftime("%Y-%m")
    col_cc, filas_cc = filas_de("cuenta_corriente", sucursal_id)
    idx_cc = _indice(col_cc)
    cobros_mes = 0.0
    if col_cc:
        for f in filas_cc:
            if str(_valor(f, idx_cc, "tipo") or "").upper() == "ABONO":
                f_fecha = str(_valor(f, idx_cc, "fecha") or "")
                if f_fecha.startswith(mes_actual):
                    cobros_mes += _numero(_valor(f, idx_cc, "monto"))

    con_deuda_ids = {
        _clave(_valor(fila, idx, "id"))
        for fila in filas
        if _clave(_valor(fila, idx, "id")) and _numero(_valor(fila, idx, "deuda_actual", "deuda")) > 0.009
    }
    intereses, tarifa_base, tarifa_morosa = _interes_del_libro(
        sucursal_id,
        columnas=col_cc,
        filas=filas_cc,
        solo=con_deuda_ids,
    )
    for fila in filas:
        deuda = _numero(_valor(fila, idx, "deuda_actual", "deuda"))
        nombre = str(_valor(fila, idx, "nombre") or "Cliente").strip()
        tel = str(_valor(fila, idx, "telefono", "celular") or "").strip()
        dni = str(_valor(fila, idx, "dni", "cuit") or "").strip()
        limite = _numero(_valor(fila, idx, "limite_credito", "cupo"))
        tipo = str(_valor(fila, idx, "tipo_cliente", "tipo") or "Regular").capitalize()
        cliente_id = _clave(_valor(fila, idx, "id"))
        libro = intereses.get(cliente_id) or {}
        dias_crudo = _valor(fila, idx, "dias_mora", "dias_sin_pago", "dias")
        if cliente_id in intereses:
            dias = int(libro.get("dias") or 0)
            mantenimiento = float(libro["mantenimiento"])
            tarifa_str = tarifa_morosa if libro.get("en_apalancamiento") else tarifa_base
            origen = "libro"
        elif dias_crudo not in (None, ""):
            dias = int(_numero(dias_crudo))
            sobre_cupo = limite > 0 and deuda > limite
            tarifa_pct = 0.10 if dias > 30 or sobre_cupo else 0.05
            mantenimiento = round(deuda * tarifa_pct, 2) if deuda > 0 else 0.0
            tarifa_str = f"{int(tarifa_pct * 100)}%"
            origen = "politica"
        else:
            dias = None
            sobre_cupo = limite > 0 and deuda > limite
            tarifa_pct = 0.10 if sobre_cupo else 0.05
            mantenimiento = round(deuda * tarifa_pct, 2) if deuda > 0 else 0.0
            tarifa_str = f"{int(tarifa_pct * 100)}%"
            origen = "cupo" if sobre_cupo else "politica"

        sobre_cupo = limite > 0 and deuda > limite
        es_riesgo = False
        estado = "Normal"
        if deuda > 0.009:
            con_deuda += 1
            total_deuda += deuda
            if dias is not None and dias >= 30:
                mora_30 += 1
            if dias is not None and dias >= 60:
                mora_60 += 1
            if dias is not None and dias >= 90:
                mora_90 += 1

            if (dias is not None and dias > 30) or sobre_cupo or libro.get("en_apalancamiento"):
                es_riesgo = True
                estado = "Atención"
                deuda_en_riesgo += deuda
                cuentas_en_riesgo += 1
        elif deuda < -0.009:
            a_favor += 1
            total_a_favor += abs(deuda)
        else:
            al_dia += 1

        ficha = {
            "id": _valor(fila, idx, "id"),
            "nombre": nombre,
            "telefono": tel,
            "dni": dni,
            "tipo": tipo,
            "estado": estado,
            "deuda": round(deuda, 2),
            "limite": round(limite, 2),
            "mantenimiento": mantenimiento,
            "mantenimiento_origen": origen,
            "dias": dias,
            "tarifa": tarifa_str,
            "en_riesgo": es_riesgo,
        }
        clientes.append(ficha)
        if deuda > 0.009:
            deudores.append(ficha)

    deudores.sort(key=lambda x: x["deuda"], reverse=True)
    clientes.sort(key=lambda x: (x["deuda"] <= 0, -x["deuda"], x["nombre"]))
    return {
        "total_cuentas": len(filas),
        "con_deuda": con_deuda,
        "deuda_total": round(total_deuda, 2),
        "cartera_en_calle": round(total_deuda, 2),
        "cuentas_activas": con_deuda,
        "al_dia": al_dia,
        "a_favor": a_favor,
        "saldo_a_favor_total": round(total_a_favor, 2),
        "cartera_en_riesgo": round(deuda_en_riesgo, 2),
        "cuentas_en_riesgo": cuentas_en_riesgo,
        "cobros_del_mes": round(cobros_mes, 2),
        "mora_30": mora_30,
        "mora_60": mora_60,
        "mora_90": mora_90,
        "top_deudores": deudores[:100],
        "clientes": clientes[:200],
        "cuentas": len(filas),
        "deuda": round(total_deuda, 2),
    }


def _filas_en_rango(tabla: str, ini: str | None, fin: str | None, sucursal_id: int | None = None):
    columnas, filas = filas_de(tabla, sucursal_id)
    idx = _indice(columnas)
    if not ini and not fin:
        return idx, list(filas)
    desde = ini or ""
    hasta = fin or ini or "9999-99-99"
    return idx, [
        fila for fila in filas
        if (dia := _dia(_valor(fila, idx, "fecha"))) and desde <= dia <= hasta
    ]


def _etiqueta_caja(pedido: dict, ini: str | None, fin: str | None, hoy: str) -> str:
    if pedido.get("historico"):
        return "Todas"
    if str(pedido.get("alcance") or "dia").lower() == "mes":
        return "Mes · " + (ini or hoy)[:7]
    dia = ini or hoy
    return ("Hoy · " if dia == hoy else "Día · ") + dia


def _contabilidad(medios_pago: list[dict], ini: str | None, fin: str | None, sucursal_id: int | None, etiqueta: str) -> dict:
    medios_lista = medios_pago or []
    total_medios = round(sum(_numero(m.get("monto")) for m in medios_lista), 2)
    tickets = sum(int(m.get("tickets") or 0) for m in medios_lista)

    idx_cc, movimientos = _filas_en_rango("cuenta_corriente", ini, fin, sucursal_id)
    cobros = 0.0
    detalle_cobros = []
    for fila in movimientos:
        tipo = str(_valor(fila, idx_cc, "tipo") or "").upper()
        if tipo == "ABONO":
            monto = _numero(_valor(fila, idx_cc, "monto"))
            cobros += monto
            detalle_cobros.append({
                "monto": round(monto, 2),
                "descripcion": str(_valor(fila, idx_cc, "descripcion") or "Cobro fiado"),
            })

    idx_g, gastos = _filas_en_rango("gastos", ini, fin, sucursal_id)
    lista_gastos = []
    total_gastos = 0.0
    for fila in gastos:
        estado = str(_valor(fila, idx_g, "status", "estado") or "").upper()
        if estado in ("ANULADO", "CANCELADO", "RECHAZADO"):
            continue
        monto = _numero(_valor(fila, idx_g, "monto"))
        total_gastos += monto
        lista_gastos.append(
            {
                "categoria": str(_valor(fila, idx_g, "categoria") or "Gasto"),
                "detalle": str(_valor(fila, idx_g, "descripcion") or ""),
                "monto": round(monto, 2),
            }
        )
    idx_caja, caja = _filas_en_rango("movimientos_caja", ini, fin, sucursal_id)
    por_tipo: dict[str, float] = {}
    for fila in caja:
        tipo = str(_valor(fila, idx_caja, "tipo") or "Movimiento")
        por_tipo[tipo] = por_tipo.get(tipo, 0.0) + _numero(_valor(fila, idx_caja, "monto"))
    return {
        "ventas": total_medios,
        "tickets": tickets,
        "etiqueta": etiqueta,
        "medios_pago": medios_lista,
        "cobros": round(cobros, 2),
        "detalle_cobros": detalle_cobros[:20],
        "gastos": round(total_gastos, 2),
        "resultado": round(total_medios + cobros - total_gastos, 2),
        "detalle_gastos": lista_gastos[:40],
        "caja": [{"tipo": tipo, "monto": round(monto, 2)} for tipo, monto in sorted(por_tipo.items())],
    }


def _pulso(resumen: dict, desglose: list[dict], digitales: dict, cartera: dict, pedidos: dict) -> dict:
    alertas = []
    if not resumen.get("es_hoy"):
        alertas.append({
            "nivel": "aviso",
            "texto": f"La última venta del espejo es del {resumen.get('dia')}.",
        })
    variacion = resumen.get("variacion_pct")
    dia_anterior = resumen.get("dia_anterior") or "el día anterior"
    if isinstance(variacion, (int, float)) and variacion <= -20:
        alertas.append({
            "nivel": "riesgo",
            "texto": f"La venta cayó {abs(variacion):.0f}% contra {dia_anterior}.",
        })
    elif isinstance(variacion, (int, float)) and variacion >= 20:
        alertas.append({
            "nivel": "ok",
            "texto": f"La venta subió {variacion:.0f}% contra {dia_anterior}.",
        })
    total = float(resumen.get("ventas") or 0)
    if len(desglose) > 1 and total > 0:
        top = desglose[0]
        parte = top["ventas"] / total
        if parte >= 0.7:
            alertas.append({
                "nivel": "aviso",
                "texto": f"{top['nombre']} concentra {round(parte * 100)}% de la venta.",
            })
    if float(digitales.get("sin_ticket") or 0) > 0:
        alertas.append({
            "nivel": "riesgo",
            "texto": "Hay cobros digitales en el libro sin ticket de venta.",
        })
    if float(digitales.get("brecha_ticket") or 0) > 1:
        alertas.append({
            "nivel": "aviso",
            "texto": "Los tickets digitales no cierran con el libro de Mercado Pago.",
        })
    if int(cartera.get("cuentas_en_riesgo") or 0) > 0:
        alertas.append({
            "nivel": "riesgo",
            "texto": f"{cartera['cuentas_en_riesgo']} cuentas superan el cupo o están en mora.",
        })
    quiebre = int(pedidos.get("articulos_en_quiebre") or 0)
    if quiebre > 0:
        alertas.append({
            "nivel": "aviso",
            "texto": f"{quiebre} productos están en quiebre de stock.",
        })
    return {"alertas": alertas}


def panel(
    nombre: str,
    sucursal_id: int | None = None,
    periodo: str = "Hoy",
    desde: str | None = None,
    hasta: str | None = None,
    filtro: dict | None = None,
) -> dict:
    dato = _armar_panel(
        nombre,
        sucursal_id,
        periodo=periodo,
        desde=desde,
        hasta=hasta,
        filtro=filtro,
    )
    dato["actualizado_en"] = ultima_carga(sucursal_id)
    return dato


def _armar_panel(
    nombre: str,
    sucursal_id: int | None = None,
    periodo: str = "Hoy",
    desde: str | None = None,
    hasta: str | None = None,
    filtro: dict | None = None,
) -> dict:
    sucursales_disp = listar_sucursales()

    if nombre in ("admin", "cartera", "clientes"):
        cartera = _cartera_admin(sucursal_id)
        return {
            "ok": True,
            "libro": cartera.get("total_cuentas", 0) > 0,
            "panel": "admin",
            "cartera": cartera,
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }
    if nombre in ("pedidos", "abastecimiento", "quiebre", "faltantes"):
        pedidos = _pedidos_abastecimiento(sucursal_id)
        return {
            "ok": True,
            "libro": pedidos.get("articulos_en_quiebre", 0) > 0 or len(pedidos.get("faltantes", [])) > 0,
            "panel": "pedidos",
            "pedidos": pedidos,
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }
    if nombre == "proveedor":
        columnas, filas = filas_de("proveedores", sucursal_id)
        idx = _indice(columnas)
        lista = []
        for fila in filas:
            lista.append(
                {
                    "nombre": str(_valor(fila, idx, "nombre", "razon_social") or "Proveedor"),
                    "telefono": str(_valor(fila, idx, "telefono", "celular") or ""),
                    "deuda": _numero(_valor(fila, idx, "deuda", "deuda_actual", "saldo")),
                }
            )
        lista.sort(key=lambda item: item["deuda"], reverse=True)
        return {
            "ok": True,
            "libro": len(lista) > 0,
            "panel": nombre,
            "proveedores": lista,
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }

    ventas, _idx = _ventas(sucursal_id)
    dia = _dia_libro(ventas) if ventas else datetime.now(_ZONA).date().isoformat()
    resumen = _resumen(ventas, dia) if ventas else {"dia": dia, "ventas": 0.0, "tickets": 0, "promedio": 0.0, "pago": "", "es_hoy": True}
    desglose_suc = _desglose_sucursales(ventas, dia) if ventas else []

    if nombre in ("digitales", "cobros_digitales", "mercadopago", "mp"):
        from app.services.pos_vitrina import resolver_rango
        desde_iso, hasta_iso, nombre_periodo = resolver_rango(
            periodo=periodo, desde_custom=desde, hasta_custom=hasta
        )
        digitales = _cobros_digitales(desde_iso[:10], sucursal_id, hasta_iso[:10])
        digitales["periodo"] = nombre_periodo
        return {
            "ok": True,
            "libro": digitales.get("bruto_mp", 0) > 0 or len(digitales.get("transacciones", [])) > 0,
            "panel": "digitales",
            "resumen": resumen,
            "digitales": digitales,
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }

    from app.services.pos_vitrina import calcular_vitrina

    vitrina = calcular_vitrina(
        periodo=periodo,
        sucursal_id=sucursal_id,
        desde=desde,
        hasta=hasta,
    )

    col_c, filas_c = filas_de("clientes", sucursal_id)
    col_p, filas_p = filas_de("productos", sucursal_id)
    tiene_datos = bool(ventas or filas_c or filas_p)

    if not tiene_datos:
        return {
            "ok": True,
            "libro": False,
            "panel": nombre,
            "vitrina": vitrina,
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }

    if nombre in ("jefe", "reporte", "vitrina"):
        ranking = _ranking_cortes(dia, sucursal_id, ventas)
        digitales = _cobros_digitales(dia, sucursal_id)
        cartera = _cartera_admin(sucursal_id)
        pedidos = _pedidos_abastecimiento(sucursal_id)
        return {
            "ok": True,
            "libro": True,
            "panel": "jefe",
            "vitrina": vitrina,
            "resumen": resumen,
            "desglose_sucursales": desglose_suc,
            "ranking_cortes": ranking,
            "pulso": _pulso(resumen, desglose_suc, digitales, cartera, pedidos),
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }
    if nombre in ("contabilidad", "tesoreria"):
        hoy = datetime.now(_ZONA).date().isoformat()
        pedido = dict(filtro or {})
        pedido.setdefault("alcance", "dia")
        pedido.setdefault("metodo", "TODOS")
        ini, fin = rango_fechas(
            str(pedido.get("alcance") or "dia"),
            str(pedido.get("fecha") or ""),
            bool(pedido.get("historico")),
            hoy,
        )
        libro = historial_ventas(sucursal_id, pedido, hoy)
        return {
            "ok": True,
            "libro": True,
            "panel": "contabilidad",
            "resumen": resumen,
            "cartera": _cartera_admin(sucursal_id),
            "contabilidad": _contabilidad(
                libro.get("medios") or [],
                ini,
                fin,
                sucursal_id,
                _etiqueta_caja(pedido, ini, fin, hoy),
            ),
            "desglose_sucursales": desglose_suc,
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }
    if nombre == "ticket":
        libro = historial_ventas(sucursal_id, filtro, datetime.now(_ZONA).date().isoformat())
        return {
            "ok": True,
            "libro": libro["libro"],
            "panel": nombre,
            "resumen": resumen,
            "tickets": libro["tickets"],
            "filtrado": libro["filtrado"],
            "tickets_ok": libro["tickets_ok"],
            "cajas": libro["cajas"],
            "recorte": libro["recorte"],
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }
    return {
        "ok": True,
        "libro": True,
        "panel": nombre,
        "resumen": resumen,
        "sucursales": sucursales_disp,
        "sucursal_id": sucursal_id,
    }
