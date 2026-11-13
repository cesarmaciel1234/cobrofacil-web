"""Cara del panel del jefe, contabilidad y admin. Los números salen del libro de Cobro Fácil guardado en la nube."""
from __future__ import annotations

from collections import Counter
from datetime import datetime
from zoneinfo import ZoneInfo

from app.services.pos_base import filas_de, listar_sucursales

_ZONA = ZoneInfo("America/Argentina/Buenos_Aires")


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
    pagos = Counter(v["pago"] or "Efectivo" for v in del_dia)
    pago = pagos.most_common(1)[0][0] if pagos else ""
    return {
        "dia": dia,
        "ventas": round(total, 2),
        "tickets": tickets,
        "promedio": round(total / tickets, 2) if tickets else 0.0,
        "pago": pago,
        "es_hoy": dia == datetime.now(_ZONA).date().isoformat(),
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


def _ranking_cortes(dia: str, sucursal_id: int | None = None) -> list[dict]:
    columnas, filas = filas_de("ventas_items", sucursal_id)
    if not columnas:
        columnas, filas = filas_de("detalle_ventas", sucursal_id)
    if not columnas:
        return []
    idx = _indice(columnas)
    cortes: dict[str, dict] = {}
    for fila in filas:
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


def _cobros_digitales(dia: str, sucursal_id: int | None = None) -> dict:
    col_v, filas_v = filas_de("ventas", sucursal_id)
    idx_v = _indice(col_v)
    vivas = []
    if col_v:
        for f in filas_v:
            if not _viva(_valor(f, idx_v, "estado")):
                continue
            if _dia(_valor(f, idx_v, "fecha")) == dia:
                pago = str(_valor(f, idx_v, "metodo_pago", "medio_pago") or "").upper()
                if any(k in pago for k in ("QR", "MERCADOPAGO", "MP", "TARJETA", "POINT", "TRANSFERENCIA", "DIGITAL", "MIXTO")):
                    vivas.append({
                        "id": _valor(f, idx_v, "id"),
                        "fecha": str(_valor(f, idx_v, "fecha") or ""),
                        "pago": _valor(f, idx_v, "metodo_pago", "medio_pago") or "QR",
                        "total": _numero(_valor(f, idx_v, "total")),
                    })

    col_cc, filas_cc = filas_de("cuenta_corriente", sucursal_id)
    idx_cc = _indice(col_cc)
    cobros_dig = []
    if col_cc:
        for f in filas_cc:
            if _dia(_valor(f, idx_cc, "fecha")) == dia and str(_valor(f, idx_cc, "tipo") or "").upper() == "ABONO":
                desc = str(_valor(f, idx_cc, "descripcion") or "").upper()
                if any(k in desc for k in ("QR", "MP", "MERCADOPAGO", "TRANSFERENCIA", "TARJETA")):
                    cobros_dig.append({
                        "id": _valor(f, idx_cc, "id"),
                        "monto": _numero(_valor(f, idx_cc, "monto")),
                        "desc": _valor(f, idx_cc, "descripcion") or "Cobro digital fiado",
                        "fecha": str(_valor(f, idx_cc, "fecha") or ""),
                    })

    col_cd, filas_cd = filas_de("cobros_digitales", sucursal_id)
    idx_cd = _indice(col_cd)
    registros_cd = []
    if col_cd:
        for f in filas_cd:
            if _dia(_valor(f, idx_cd, "fecha")) == dia:
                registros_cd.append({
                    "id": _valor(f, idx_cd, "id"),
                    "id_pago": _valor(f, idx_cd, "id_pago", "mp_id") or "—",
                    "fecha": str(_valor(f, idx_cd, "fecha") or ""),
                    "cuenta": str(_valor(f, idx_cd, "cuenta", "titular", "token") or "Cuenta Principal"),
                    "concepto": str(_valor(f, idx_cd, "concepto", "tipo") or "Venta QR"),
                    "monto": _numero(_valor(f, idx_cd, "monto")),
                    "estado": str(_valor(f, idx_cd, "estado") or "FIRMADO").upper(),
                    "ticket_venta": _valor(f, idx_cd, "ticket_venta", "ticket_id") or "—",
                    "ticket_cobro": _valor(f, idx_cd, "ticket_cobro") or "—",
                })

    if not registros_cd and vivas:
        for v in vivas:
            pago_str = str(v["pago"])
            concepto = f"MP - {pago_str}" if "MP" not in pago_str.upper() else pago_str
            registros_cd.append({
                "id": v["id"],
                "id_pago": f"MP-{v['id']}",
                "fecha": v["fecha"],
                "cuenta": "Cristina Báez Rodríguez",
                "concepto": concepto,
                "monto": v["total"],
                "estado": "FIRMADO",
                "ticket_venta": str(v["id"]),
                "ticket_cobro": "—",
            })
        for c in cobros_dig:
            registros_cd.append({
                "id": c["id"],
                "id_pago": f"COB-{c['id']}",
                "fecha": c["fecha"],
                "cuenta": "Cristina Báez Rodríguez",
                "concepto": f"Cobro Cta Cte: {c['desc']}",
                "monto": c["monto"],
                "estado": "FIRMADO",
                "ticket_venta": "—",
                "ticket_cobro": f"COB-{c['id']}",
            })

    total_bruto = sum(r["monto"] for r in registros_cd)
    total_neto = round(total_bruto * 0.9439, 2)
    tickets_digitales = sum(v["total"] for v in vivas)
    firmados = sum(r["monto"] for r in registros_cd if r["estado"] == "FIRMADO")
    sin_firmar = sum(r["monto"] for r in registros_cd if "SIN FIRMAR" in r["estado"])
    sin_ticket = sum(r["monto"] for r in registros_cd if "SIN TICKET" in r["estado"])
    cliente_cobros = sum(c["monto"] for c in cobros_dig)

    return {
        "bruto_mp": round(total_bruto, 2),
        "neto_mp": round(total_neto, 2),
        "tickets_digitales": round(tickets_digitales, 2),
        "firmados_ticket": round(firmados, 2),
        "sin_firmar": round(sin_firmar, 2),
        "sin_ticket": round(sin_ticket, 2),
        "cliente_cobros": round(cliente_cobros, 2),
        "cancelados": 0.0,
        "transacciones": registros_cd[:60],
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
            prov = str(_valor(f, idx_p, "proveedor", "proveedor_nombre") or "Frigorífico Central")

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
                    "subtotal": subtotal,
                    "proveedor": prov,
                })

    faltantes.sort(key=lambda x: x["subtotal"], reverse=True)

    hoy_str = datetime.now(_ZONA).strftime("%d/%m/%Y")
    lineas_wsp = [
        "--- PEDIDO DE REPOSICION ---",
        "Comercio: Maciel Carnicerias",
        f"Fecha: {hoy_str}",
        "----------------------------",
    ]
    for item in faltantes[:15]:
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


def _cartera_admin(sucursal_id: int | None = None) -> dict:
    columnas, filas = filas_de("clientes", sucursal_id)
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

    for fila in filas:
        deuda = _numero(_valor(fila, idx, "deuda_actual", "deuda"))
        nombre = str(_valor(fila, idx, "nombre") or "Cliente").strip()
        tel = str(_valor(fila, idx, "telefono", "celular") or "").strip()
        dni = str(_valor(fila, idx, "dni", "cuit") or "").strip()
        limite = _numero(_valor(fila, idx, "limite_credito", "cupo"))
        tipo = str(_valor(fila, idx, "tipo_cliente", "tipo") or "Regular").capitalize()
        dias = int(_numero(_valor(fila, idx, "dias_mora", "dias_sin_pago", "dias")) or 0)
        if not dias and deuda > 0:
            dias = 14

        tarifa_pct = 0.10 if dias > 30 or (limite > 0 and deuda > limite) else 0.05
        mantenimiento = round(deuda * tarifa_pct, 2) if deuda > 0 else 0.0
        tarifa_str = f"{int(tarifa_pct * 100)}%"

        es_riesgo = False
        estado = "Normal"
        if deuda > 0.009:
            con_deuda += 1
            total_deuda += deuda
            if dias >= 30:
                mora_30 += 1
            if dias >= 60:
                mora_60 += 1
            if dias >= 90:
                mora_90 += 1

            if dias > 30 or (limite > 0 and deuda > limite):
                es_riesgo = True
                estado = "Atención"
                deuda_en_riesgo += deuda
                cuentas_en_riesgo += 1

            deudores.append({
                "id": _valor(fila, idx, "id"),
                "nombre": nombre,
                "telefono": tel,
                "dni": dni,
                "tipo": tipo,
                "estado": estado,
                "deuda": round(deuda, 2),
                "limite": round(limite, 2),
                "mantenimiento": mantenimiento,
                "dias": dias,
                "tarifa": tarifa_str,
                "en_riesgo": es_riesgo,
            })
        elif deuda < -0.009:
            a_favor += 1
            total_a_favor += abs(deuda)
        else:
            al_dia += 1

    deudores.sort(key=lambda x: x["deuda"], reverse=True)
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
        "cuentas": len(filas),
        "deuda": round(total_deuda, 2),
    }


def _filas_del_dia(tabla: str, dia: str, sucursal_id: int | None = None) -> tuple[dict[str, int], list[list]]:
    columnas, filas = filas_de(tabla, sucursal_id)
    idx = _indice(columnas)
    del_dia = [fila for fila in filas if _dia(_valor(fila, idx, "fecha")) == dia]
    return idx, del_dia


def _contabilidad(dia: str, resumen: dict, ventas: list[dict], sucursal_id: int | None = None) -> dict:
    del_dia = [v for v in ventas if v["dia"] == dia]
    medios_dict: dict[str, dict] = {}
    for v in del_dia:
        medio = str(v.get("pago") or "Efectivo").strip() or "Efectivo"
        monto = _numero(v.get("total"))
        if medio not in medios_dict:
            medios_dict[medio] = {"medio": medio, "monto": 0.0, "tickets": 0}
        medios_dict[medio]["monto"] += monto
        medios_dict[medio]["tickets"] += 1

    medios_lista = sorted(
        [
            {"medio": m["medio"], "monto": round(m["monto"], 2), "tickets": m["tickets"]}
            for m in medios_dict.values()
        ],
        key=lambda x: x["monto"],
        reverse=True,
    )

    idx_cc, movimientos = _filas_del_dia("cuenta_corriente", dia, sucursal_id)
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

    idx_g, gastos = _filas_del_dia("gastos", dia, sucursal_id)
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
    idx_caja, caja = _filas_del_dia("movimientos_caja", dia, sucursal_id)
    por_tipo: dict[str, float] = {}
    for fila in caja:
        tipo = str(_valor(fila, idx_caja, "tipo") or "Movimiento")
        por_tipo[tipo] = por_tipo.get(tipo, 0.0) + _numero(_valor(fila, idx_caja, "monto"))
    return {
        "ventas": resumen["ventas"],
        "tickets": resumen["tickets"],
        "medios_pago": medios_lista,
        "cobros": round(cobros, 2),
        "detalle_cobros": detalle_cobros[:20],
        "gastos": round(total_gastos, 2),
        "resultado": round(resumen["ventas"] + cobros - total_gastos, 2),
        "detalle_gastos": lista_gastos[:40],
        "caja": [{"tipo": tipo, "monto": round(monto, 2)} for tipo, monto in sorted(por_tipo.items())],
    }


def panel(nombre: str, sucursal_id: int | None = None) -> dict:
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
        digitales = _cobros_digitales(dia, sucursal_id)
        return {
            "ok": True,
            "libro": digitales.get("bruto_mp", 0) > 0 or len(digitales.get("transacciones", [])) > 0,
            "panel": "digitales",
            "resumen": resumen,
            "digitales": digitales,
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }

    if not ventas:
        return {
            "ok": True,
            "libro": False,
            "panel": nombre,
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }

    if nombre in ("jefe", "reporte"):
        ranking = _ranking_cortes(dia, sucursal_id)
        return {
            "ok": True,
            "libro": True,
            "panel": "jefe",
            "resumen": resumen,
            "desglose_sucursales": desglose_suc,
            "ranking_cortes": ranking,
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }
    if nombre in ("contabilidad", "tesoreria"):
        return {
            "ok": True,
            "libro": True,
            "panel": "contabilidad",
            "resumen": resumen,
            "cartera": _cartera_admin(sucursal_id),
            "contabilidad": _contabilidad(dia, resumen, ventas, sucursal_id),
            "desglose_sucursales": desglose_suc,
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }
    if nombre == "ticket":
        del_dia = [v for v in ventas if v["dia"] == dia]
        del_dia.sort(key=lambda v: v["fecha"], reverse=True)
        return {
            "ok": True,
            "libro": True,
            "panel": nombre,
            "resumen": resumen,
            "tickets": [
                {"id": v["id"], "fecha": v["fecha"], "total": round(v["total"], 2), "pago": v["pago"]}
                for v in del_dia[:80]
            ],
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
