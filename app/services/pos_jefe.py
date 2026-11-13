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


def _filas_del_dia(tabla: str, dia: str, sucursal_id: int | None = None) -> tuple[dict[str, int], list[list]]:
    columnas, filas = filas_de(tabla, sucursal_id)
    idx = _indice(columnas)
    del_dia = [fila for fila in filas if _dia(_valor(fila, idx, "fecha")) == dia]
    return idx, del_dia


def _cartera_admin(sucursal_id: int | None = None) -> dict:
    columnas, filas = filas_de("clientes", sucursal_id)
    idx = _indice(columnas)
    total_deuda = 0.0
    total_a_favor = 0.0
    con_deuda = 0
    al_dia = 0
    a_favor = 0
    deudores = []

    for fila in filas:
        deuda = _numero(_valor(fila, idx, "deuda_actual", "deuda"))
        nombre = str(_valor(fila, idx, "nombre") or "Cliente").strip()
        tel = str(_valor(fila, idx, "telefono", "celular") or "").strip()
        dni = str(_valor(fila, idx, "dni", "cuit") or "").strip()
        limite = _numero(_valor(fila, idx, "limite_credito", "cupo"))

        if deuda > 0.009:
            con_deuda += 1
            total_deuda += deuda
            deudores.append({
                "id": _valor(fila, idx, "id"),
                "nombre": nombre,
                "telefono": tel,
                "dni": dni,
                "deuda": round(deuda, 2),
                "limite": round(limite, 2),
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
        "al_dia": al_dia,
        "a_favor": a_favor,
        "saldo_a_favor_total": round(total_a_favor, 2),
        "top_deudores": deudores[:50],
        "cuentas": len(filas),
        "deuda": round(total_deuda, 2),
    }


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
    if not ventas:
        return {
            "ok": True,
            "libro": False,
            "panel": nombre,
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }
    dia = _dia_libro(ventas)
    resumen = _resumen(ventas, dia)
    desglose_suc = _desglose_sucursales(ventas, dia)

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
