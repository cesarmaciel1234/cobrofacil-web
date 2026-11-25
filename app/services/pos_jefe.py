"""Cara del panel del jefe, contabilidad y admin. Los números salen del libro de Cobro Fácil guardado en la nube."""
from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.services.pos_base import _ambito_cache, filas_de, listar_sucursales, sellos_de, ultima_carga, unir_clientes
from app.services.pos_historial import desglose_articulos, historial_ventas, rango_fechas

_ZONA = ZoneInfo("America/Argentina/Buenos_Aires")
_cartera_lock = threading.Lock()
_cartera_cache: dict[tuple, tuple[tuple, dict]] = {}
_panel_lock = threading.Lock()
_panel_cache: dict[tuple, tuple[tuple, dict]] = {}
_TABLAS_SELLO = (
    "ventas",
    "detalles_ventas",
    "detalle_ventas",
    "ventas_items",
    "productos",
    "articulos",
    "clientes",
    "cuenta_corriente",
    "clientes_auditoria",
    "cobros_digitales",
    "mp_pagos",
    "proveedores",
    "configuracion",
)


def olvidar_cartera() -> None:
    """El libro cambió: la cartera armada y los paneles dejan de servir."""
    with _cartera_lock:
        _cartera_cache.clear()
    with _panel_lock:
        _panel_cache.clear()


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


def _comercio(sucursal_id: int | str | None, sucursales: list[dict]) -> str:
    sid_str = str(sucursal_id or "").strip().lower()
    if sid_str == "web":
        return "Tienda Web (Todas)"
    if sid_str.startswith("web-") or sid_str.startswith("web_"):
        sub_id = sid_str.replace("_", "-").split("-")[1]
        for s in sucursales:
            if str(s.get("id")) == sub_id:
                return f"Tienda Web · {s.get('nombre')}"
        return f"Tienda Web (Sucursal {sub_id})"
    if sucursal_id is not None:
        for sucursal in sucursales:
            if str(sucursal["id"]) == str(sucursal_id):
                return sucursal["nombre"]
    if len(sucursales) == 1:
        return sucursales[0]["nombre"]
    return "Todas las sucursales"


def _ventas(sucursal_id: int | str | None = None, desde: str | None = None, hasta: str | None = None):
    sid_str = str(sucursal_id or "").strip().lower()
    es_web = sid_str.startswith("web")
    web_sub_id = None
    if es_web and ("-" in sid_str or "_" in sid_str):
        partes = sid_str.replace("_", "-").split("-")
        if len(partes) > 1 and partes[1].isdigit():
            web_sub_id = int(partes[1])

    if es_web:
        columnas, filas = [], []
        idx = {}
    else:
        columnas, filas = filas_de("ventas", sucursal_id, desde=desde, hasta=hasta)
        idx = _indice(columnas) if columnas else {}

    vivas = []
    if columnas and filas:
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

    # Si es 'web' o consolidado (None), sumar ventas de pedidos web (Reparto Fácil)
    if sucursal_id is None or es_web:
        try:
            from app.database import get_db
            from app.services.pos_base import _empresa_activa
            eid_actual = _empresa_activa()
            with get_db() as conn:
                q_web = """
                    SELECT id, ticket_id, total, metodo_pago, estado, created_at, sucursal_id, sucursal_origen
                    FROM public.repartofacil_pedidos
                    WHERE empresa_id = %s AND ticket_id IS NOT NULL AND estado NOT IN ('cancelled', 'rejected', 'cancelled_by_client', 'cancelled_timeout')
                """
                params = [eid_actual]
                if web_sub_id is not None:
                    q_web += " AND (sucursal_id = %s OR sucursal_origen ILIKE %s)"
                    params.extend([web_sub_id, f"%{web_sub_id}%"])
                if desde and hasta:
                    q_web += " AND created_at >= %s AND created_at <= %s"
                    params.extend([str(desde)[:10] + " 00:00:00", str(hasta)[:10] + " 23:59:59"])
                q_web += " ORDER BY created_at DESC"
                web_rows = conn.execute(q_web, tuple(params)).fetchall()
                for wr in web_rows:
                    f_str = str(wr["created_at"] or "")
                    dia = f_str[:10]
                    sub_sid = wr.get("sucursal_id")
                    vivas.append({
                        "id": str(wr["ticket_id"] or wr["id"]),
                        "fecha": f_str.split(".")[0],
                        "dia": dia,
                        "total": float(wr["total"] or 0.0),
                        "pago": "Web",
                        "sucursal_id": f"web-{sub_sid}" if sub_sid else "web",
                    })
        except Exception as e:
            logger.warning("Error sumando pedidos web a _ventas: %s", e)

    return vivas, idx


def _dia_libro(ventas: list[dict]) -> str:
    hoy = datetime.now(_ZONA).date().isoformat()
    dias = {v["dia"] for v in ventas}
    if hoy in dias:
        return hoy
    return max(dias) if dias else hoy


def _resumen(ventas: list[dict], dia: str, hasta: str | None = None) -> dict:
    ini = (dia or "")[:10]
    fin = (hasta or dia or "")[:10]
    del_rango = [v for v in ventas if ini <= v["dia"] <= fin]
    tickets = len(del_rango)
    total = sum(v["total"] for v in del_rango)
    por_medio: dict[str, float] = {}
    digital = 0.0
    for venta in del_rango:
        medio = venta["pago"] or "Efectivo"
        por_medio[medio] = por_medio.get(medio, 0.0) + venta["total"]
        if _es_digital(medio):
            digital += venta["total"]
    pago = max(por_medio, key=por_medio.get) if por_medio else ""

    d0 = datetime.fromisoformat(ini).date()
    d1 = datetime.fromisoformat(fin).date()
    duracion = (d1 - d0).days + 1
    ant_fin = (d0 - timedelta(days=1)).isoformat()
    ant_ini = (d0 - timedelta(days=duracion)).isoformat()
    del_anterior = [v for v in ventas if ant_ini <= v["dia"] <= ant_fin]
    ventas_anterior = (
        round(sum(v["total"] for v in del_anterior), 2)
        if del_anterior else None
    )
    variacion = None
    if ventas_anterior and ventas_anterior > 0:
        variacion = round((total - ventas_anterior) / ventas_anterior * 100, 1)
    hoy_iso = datetime.now(_ZONA).date().isoformat()
    return {
        "dia": ini if ini == fin else f"{ini} → {fin}",
        "ventas": round(total, 2),
        "tickets": tickets,
        "promedio": round(total / tickets, 2) if tickets else 0.0,
        "pago": pago,
        "es_hoy": (ini == fin == hoy_iso),
        "dia_anterior": ant_fin,
        "ventas_anterior": ventas_anterior,
        "variacion_pct": variacion,
        "mix_digital_pct": round(digital / total * 100, 1) if total else 0.0,
    }


def _desglose_sucursales(ventas: list[dict], dia: str, hasta: str | None = None) -> list[dict]:
    ini = (dia or "")[:10]
    fin = (hasta or dia or "")[:10]
    del_rango = [v for v in ventas if ini <= v["dia"] <= fin]
    sucursales = listar_sucursales()
    nombres_suc = {str(s["id"]): s["nombre"] for s in sucursales}

    agrupado: dict[str, dict] = {}
    total_general = sum(v["total"] for v in del_rango) or 0.0

    for v in del_rango:
        sid = v.get("sucursal_id")
        sid_str = str(sid) if sid is not None else "1"
        if sid_str not in agrupado:
            es_web = sid_str.startswith("web")
            agrupado[sid_str] = {
                "sucursal_id": sid_str if es_web else (int(sid_str) if sid_str.isdigit() else sid_str),
                "nombre": nombres_suc.get(sid_str, f"Sucursal {sid_str}"),
                "canal": "web" if es_web else "fisico",
                "ventas": 0.0,
                "tickets": 0,
            }
        agrupado[sid_str]["ventas"] += v["total"]
        agrupado[sid_str]["tickets"] += 1

    lista = []
    for item in agrupado.values():
        t = item["tickets"]
        m = item["ventas"]
        pct = round((m / total_general * 100), 1) if total_general > 0 else 0.0
        lista.append({
            "sucursal_id": item["sucursal_id"],
            "nombre": item["nombre"],
            "canal": item["canal"],
            "ventas": round(m, 2),
            "tickets": t,
            "promedio": round(m / t, 2) if t else 0.0,
            "participacion_pct": pct,
        })
    lista.sort(key=lambda x: x["ventas"], reverse=True)
    for idx, item in enumerate(lista):
        item["ranking"] = idx + 1
    return lista


def _ranking_cortes(dia: str, sucursal_id: int | None, ventas: list[dict], hasta: str | None = None) -> list[dict]:
    ini = (dia or "")[:10]
    fin = (hasta or dia or "")[:10]
    columnas, filas = filas_de("ventas_items", sucursal_id, desde=ini, hasta=fin)
    if not columnas:
        columnas, filas = filas_de("detalle_ventas", sucursal_id, desde=ini, hasta=fin)
    if not columnas:
        columnas, filas = filas_de("detalles_ventas", sucursal_id, desde=ini, hasta=fin)
    if not columnas:
        return []
    idx = _indice(columnas)
    ids_dia = {_clave(v["id"]) for v in ventas if (ini <= v["dia"] <= fin) and _clave(v.get("id"))}
    enlace = next((nombre for nombre in ("venta_id", "id_venta", "ticket_id", "venta") if nombre in idx), "")
    cortes: dict[str, dict] = {}
    for fila in filas:
        if enlace and ids_dia and _clave(_valor(fila, idx, enlace)) not in ids_dia:
            continue
        if not enlace:
            fecha_item = _dia(_valor(fila, idx, "fecha"))
            if fecha_item and not (ini <= fecha_item <= fin):
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
    if not ini and not fin:
        return True
    dia = _dia(fecha)
    return bool(dia) and (ini or "") <= dia <= (fin or "9999-99-99")


def _ref(valor) -> str:
    texto = _clave(valor)
    if texto.upper() in ("", "—", "-", "NONE", "NULL"):
        return ""
    return texto


def _cobros_digitales(dia: str, sucursal_id: int | None = None, hasta: str | None = None) -> dict:
    """Cruza tickets e ids de todas las sucursales. Un ticket y un id digital entran una sola vez."""
    ini = (dia or "")[:10]
    fin = (hasta or "")[:10] if not dia else (hasta or dia or "")[:10]
    if dia and not hasta:
        fin = ini
    pedido = _clave(sucursal_id) if sucursal_id is not None else ""

    col_v, filas_v = filas_de("ventas", sucursal_id, desde=ini or None, hasta=fin or None)
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
                "id": _ref(_valor(f, idx_v, "id")),
                "sucursal": _ref(_valor(f, idx_v, "sucursal_id")),
                "fecha": str(_valor(f, idx_v, "fecha") or ""),
                "pago": str(pago or "QR"),
                "total": monto,
                "id_pago": _ref(_valor(f, idx_v, "id_pago", "mp_id", "payment_id")),
            })

    col_cc, filas_cc = filas_de("cuenta_corriente", sucursal_id)
    idx_cc = _indice(col_cc)
    abonos = []
    if col_cc:
        for f in filas_cc:
            if not _en_dias(_valor(f, idx_cc, "fecha"), ini, fin):
                continue
            if str(_valor(f, idx_cc, "tipo") or "").upper() != "ABONO":
                continue
            desc = str(_valor(f, idx_cc, "descripcion") or "")
            if not _es_digital(desc):
                continue
            abonos.append({
                "id": _ref(_valor(f, idx_cc, "id")),
                "sucursal": _ref(_valor(f, idx_cc, "sucursal_id")),
                "monto": _numero(_valor(f, idx_cc, "monto")),
                "desc": desc or "Cobro digital fiado",
                "fecha": str(_valor(f, idx_cc, "fecha") or ""),
            })

    col_cd, filas_cd = filas_de("cobros_digitales", sucursal_id)
    idx_cd = _indice(col_cd)
    cobros = []
    if col_cd:
        for f in filas_cd:
            if not _en_dias(_valor(f, idx_cd, "fecha"), ini, fin):
                continue
            neto = _valor(f, idx_cd, "neto", "monto_neto", "liquido")
            cobros.append({
                "id": _ref(_valor(f, idx_cd, "id")),
                "sucursal": _ref(_valor(f, idx_cd, "sucursal_id")),
                "id_pago": _ref(_valor(f, idx_cd, "id_pago", "mp_id")),
                "fecha": str(_valor(f, idx_cd, "fecha") or ""),
                "cuenta": str(_valor(f, idx_cd, "cuenta", "titular") or "—"),
                "concepto": str(_valor(f, idx_cd, "concepto", "tipo") or "Cobro digital"),
                "monto": _numero(_valor(f, idx_cd, "monto")),
                "neto": None if neto in (None, "") else _numero(neto),
                "ticket": _ref(_valor(f, idx_cd, "ticket_venta", "ticket_id")),
                "ticket_cobro": _ref(_valor(f, idx_cd, "ticket_cobro")),
            })

    por_pago: dict[str, dict] = {}
    por_ticket: dict[tuple[str, str], dict] = {}
    for cobro in cobros:
        if cobro["id_pago"] and cobro["id_pago"] not in por_pago:
            por_pago[cobro["id_pago"]] = cobro
        if cobro["ticket"]:
            por_ticket.setdefault((cobro["sucursal"], cobro["ticket"]), cobro)

    usados = set()
    usados_vista: dict[str, set] = {}
    pagos_usados = set()
    tickets_usados = set()
    registros = []

    def tomar_cobro(venta: dict) -> dict | None:
        if venta["id_pago"] and venta["id_pago"] in por_pago:
            return por_pago[venta["id_pago"]]
        mismo = por_ticket.get((venta["sucursal"], venta["id"]))
        if mismo:
            return mismo
        if not venta["id"]:
            return None
        candidatos = [c for c in cobros if c["ticket"] == venta["id"] and id(c) not in usados]
        return candidatos[0] if len(candidatos) == 1 else None

    for venta in vivas:
        ticket_clave = (venta["sucursal"], venta["id"])
        if ticket_clave in tickets_usados:
            continue
        cobro = tomar_cobro(venta)
        id_pago = venta["id_pago"] or (cobro["id_pago"] if cobro else "")
        if id_pago and id_pago in pagos_usados:
            continue
        tickets_usados.add(ticket_clave)
        if id_pago:
            pagos_usados.add(id_pago)
        if cobro:
            usados.add(id(cobro))
            usados_vista.setdefault(venta["sucursal"], set()).add(id(cobro))
        registros.append({
            "id": venta["id"],
            "sucursal": venta["sucursal"],
            "id_pago": id_pago or "—",
            "fecha": venta["fecha"],
            "cuenta": venta["pago"],
            "concepto": f"Ticket {venta['pago']}",
            "monto": venta["total"],
            "estado": "OK" if id_pago else "SIN ID",
            "origen": "ticket",
            "ticket_venta": venta["id"] or "—",
            "ticket_cobro": (cobro["ticket_cobro"] if cobro and cobro["ticket_cobro"] else "—"),
            "del_libro": cobro is not None,
        })

    for cobro in cobros:
        if id(cobro) in usados:
            continue
        if cobro["id_pago"] and cobro["id_pago"] in pagos_usados:
            continue
        if cobro["id_pago"]:
            pagos_usados.add(cobro["id_pago"])
        usados.add(id(cobro))
        registros.append({
            "id": cobro["id"],
            "sucursal": cobro["sucursal"],
            "id_pago": cobro["id_pago"] or "—",
            "fecha": cobro["fecha"],
            "cuenta": cobro["cuenta"],
            "concepto": cobro["concepto"],
            "monto": cobro["monto"],
            "estado": "SIN TICKET",
            "origen": "cobro",
            "ticket_venta": cobro["ticket"] or "—",
            "ticket_cobro": cobro["ticket_cobro"] or "—",
            "del_libro": True,
        })

    for abono in abonos:
        registros.append({
            "id": abono["id"],
            "sucursal": abono["sucursal"],
            "id_pago": "—",
            "fecha": abono["fecha"],
            "cuenta": "Cuenta corriente",
            "concepto": abono["desc"],
            "monto": abono["monto"],
            "estado": "COBRADO",
            "origen": "abono",
            "ticket_venta": "—",
            "ticket_cobro": abono["id"] or "—",
            "del_libro": False,
        })

    if pedido:
        registros = [fila for fila in registros if fila["sucursal"] == pedido]
        vivas = [venta for venta in vivas if venta["sucursal"] == pedido]
        abonos = [abono for abono in abonos if abono["sucursal"] == pedido]
        cobros = [cobro for cobro in cobros if cobro["sucursal"] == pedido or id(cobro) in usados_vista.get(pedido, set())]

    hay_libro = any(fila.get("del_libro") for fila in registros)
    fuente = "libro" if hay_libro else ("ticket" if (vivas or abonos or registros) else "vacio")
    bruto = sum(fila["monto"] for fila in registros)
    tickets_digitales = sum(venta["total"] for venta in vivas)
    netos_reales = [cobro["neto"] for cobro in cobros if cobro["neto"] is not None]
    if fuente == "libro" and netos_reales:
        neto = round(sum(netos_reales), 2)
        neto_estimado = False
    else:
        neto = round(bruto, 2)
        neto_estimado = True
    monto_cobros = sum(cobro["monto"] for cobro in cobros)
    return {
        "fuente": fuente,
        "bruto_mp": round(bruto, 2),
        "neto_mp": neto,
        "neto_estimado": neto_estimado,
        "tickets_digitales": round(tickets_digitales, 2),
        "brecha_ticket": round(tickets_digitales - monto_cobros, 2) if cobros else 0.0,
        "firmados_ticket": round(sum(fila["monto"] for fila in registros if fila["estado"] == "OK"), 2),
        "sin_firmar": round(sum(fila["monto"] for fila in registros if fila["estado"] == "SIN ID"), 2),
        "sin_ticket": round(sum(fila["monto"] for fila in registros if fila["estado"] == "SIN TICKET"), 2),
        "cliente_cobros": round(sum(abono["monto"] for abono in abonos), 2),
        "cancelados": round(cancelados, 2),
        "transacciones": sorted(registros, key=lambda fila: str(fila.get("fecha") or ""), reverse=True),
        "recorte": False,
    }


def _unir_faltantes(faltantes: list) -> list:
    """El mismo producto con el mismo stock es una copia. Si el stock cambia, queda la línea y dice la sucursal."""
    grupos: dict[tuple, dict] = {}
    orden: list[tuple] = []
    for item in faltantes:
        clave = (item["producto"].casefold(), round(float(item["stock_actual"]), 1), item["unidad"])
        if clave not in grupos:
            orden.append(clave)
            copia = dict(item)
            copia["sucursales"] = [item["sucursal"]] if item.get("sucursal") else []
            grupos[clave] = copia
            continue
        sucursal = item.get("sucursal") or ""
        if sucursal and sucursal not in grupos[clave]["sucursales"]:
            grupos[clave]["sucursales"].append(sucursal)
    salida = []
    for clave in orden:
        item = grupos[clave]
        item["sucursal"] = " · ".join(nombre for nombre in item.pop("sucursales") if nombre)
        salida.append(item)
    return salida


def _pedidos_abastecimiento(sucursal_id: int | str | None = None) -> dict:
    sid_target = None
    sid_str = str(sucursal_id or "").strip().lower()
    if sid_str.startswith("web-") or sid_str.startswith("web_"):
        partes = sid_str.replace("_", "-").split("-")
        if len(partes) > 1 and partes[1].isdigit():
            sid_target = int(partes[1])
    elif sid_str.isdigit():
        sid_target = int(sid_str)
    elif sid_str == "web":
        sid_target = None

    col_p, filas_p = filas_de("productos", sid_target)
    if not col_p:
        col_p, filas_p = filas_de("articulos", sid_target)
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
                sucursal = str(_valor(f, idx_p, "sucursal_nombre") or "").strip()
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
                    "sucursal": sucursal,
                })

    faltantes = _unir_faltantes(faltantes)
    faltantes.sort(key=lambda x: x["subtotal"], reverse=True)
    inversion_estimada = round(sum(item["subtotal"] for item in faltantes), 2)
    proveedores_set = {item["proveedor"] for item in faltantes if item.get("proveedor")}

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
            lineas_wsp.append(f"- {int(item['a_pedir'])}x {item['producto']}" + (f" ({item['sucursal']})" if item.get("sucursal") else ""))
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
    configs = _dicts(col_cfg, filas_cfg) if col_cfg else []
    activacion = _activacion(configs, sucursal_id)
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


def _filas_clientes(sucursal_id: int | str | None) -> tuple[list[str], list[list]]:
    es_web = str(sucursal_id or "").strip().lower().startswith("web")
    if es_web:
        columnas, filas = [], []
    else:
        columnas, filas = filas_de("clientes", sucursal_id)
    if not columnas:
        columnas = ['id', 'nombre', 'telefono', 'limite_credito', 'deuda_actual', 'fecha_registro', 'dni', 'tipo_cliente', 'direccion', 'uid', 'origen_pc', 'creado_por', 'creado_en', 'actualizado_en', 'plazo_dias', 'estado_cuenta', 'promesa_fecha', 'promesa_nota', 'sucursal_id', 'sucursal_nombre']
        filas = []

    # Convivencia e-commerce y cartera física: integrar clientes de Reparto Fácil web SOLO si es consolidado o Tienda Web
    if sucursal_id is None or es_web:
        try:
            from app.database import get_db
            from app.services.pos_base import _empresa_activa
            eid_actual = _empresa_activa()
            with get_db() as conn:
                web_rows = conn.execute(
                    """
                    SELECT DISTINCT ON (LOWER(TRIM(cliente_nombre)))
                        cliente_nombre, cliente_telefono, direccion_entrega, created_at
                    FROM public.repartofacil_pedidos
                    WHERE empresa_id = %s AND cliente_nombre IS NOT NULL AND cliente_nombre != ''
                    ORDER BY LOWER(TRIM(cliente_nombre)), created_at DESC
                    """,
                    (eid_actual,)
                ).fetchall()
                
                idx = _indice(columnas)
                nom_idx = idx.get("nombre")
                nombres_existentes = set()
                if nom_idx is not None:
                    for f in filas:
                        if nom_idx < len(f) and f[nom_idx]:
                            nombres_existentes.add(str(f[nom_idx]).strip().casefold())
                
                for wr in web_rows:
                    c_nom = str(wr["cliente_nombre"] or "").strip()
                    if not c_nom or c_nom.casefold() in nombres_existentes:
                        continue
                    nueva = [None] * len(columnas)
                    for cname, cval in [
                        ("id", f"web-{len(filas) + 1}"),
                        ("nombre", c_nom),
                        ("telefono", str(wr["cliente_telefono"] or "")),
                        ("direccion", str(wr["direccion_entrega"] or "")),
                        ("tipo_cliente", "Web"),
                        ("deuda_actual", 0.0),
                        ("limite_credito", 0.0),
                        ("estado_cuenta", "activo"),
                        ("fecha_registro", str(wr["created_at"] or "")[:19]),
                    ]:
                        pos = idx.get(cname)
                        if pos is not None and pos < len(nueva):
                            nueva[pos] = cval
                    filas.append(nueva)
                    nombres_existentes.add(c_nom.casefold())
        except Exception as e:
            logger.warning("Error combinando clientes web en cartera: %s", e)

    if filas:
        if sucursal_id is None:
            sucs_activas = {int(s["id"]) for s in listar_sucursales() if s.get("id") is not None and str(s["id"]).isdigit()}
            if sucs_activas:
                idx = _indice(columnas)
                idx_suc = idx.get("sucursal_id")
                if idx_suc is not None:
                    filas = [
                        f for f in filas
                        if idx_suc >= len(f) or f[idx_suc] in (None, "") or int(float(f[idx_suc])) in sucs_activas or str(f[0]).startswith("web-")
                    ]
        return unir_clientes(columnas, filas)
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
    total_capital = 0.0
    total_interes = 0.0
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
        mant_val = float(mantenimiento) if mantenimiento and float(mantenimiento) > 0 else 0.0
        total_cliente = round(deuda + mant_val, 2) if deuda > 0.009 else round(deuda, 2)
        if deuda > 0.009:
            con_deuda += 1
            total_capital += deuda
            total_interes += mant_val
            total_deuda += (deuda + mant_val)
            if dias is not None and dias >= 30:
                mora_30 += 1
            if dias is not None and dias >= 60:
                mora_60 += 1
            if dias is not None and dias >= 90:
                mora_90 += 1

            if (dias is not None and dias > 30) or sobre_cupo or libro.get("en_apalancamiento"):
                es_riesgo = True
                estado = "Atención"
                deuda_en_riesgo += (deuda + mant_val)
                cuentas_en_riesgo += 1
        elif deuda < -0.009:
            a_favor += 1
            total_a_favor += abs(deuda)
        else:
            al_dia += 1

        dni_principal = "".join(caracter for caracter in dni if caracter.isdigit())
        nombres = [parte.strip() for parte in str(_valor(fila, idx, "nombres") or "").split("·") if parte.strip()]
        sucursales = [parte.strip() for parte in str(_valor(fila, idx, "sucursales") or "").split("·") if parte.strip()]
        ficha = {
            "id": dni_principal or _valor(fila, idx, "id"),
            "nombre": nombre,
            "nombres": nombres or ([nombre] if nombre else []),
            "sucursales": sucursales,
            "telefono": tel,
            "dni": dni,
            "tipo": tipo,
            "estado": estado,
            "deuda": round(deuda, 2),
            "limite": round(limite, 2),
            "mantenimiento": mantenimiento,
            "mantenimiento_origen": origen,
            "total_a_pagar": total_cliente,
            "dias": dias,
            "tarifa": tarifa_str,
            "en_riesgo": es_riesgo,
        }
        clientes.append(ficha)
        if deuda > 0.009:
            deudores.append(ficha)

    deudores.sort(key=lambda x: x.get("total_a_pagar", x["deuda"]), reverse=True)
    clientes.sort(key=lambda x: (x["deuda"] <= 0, -x.get("total_a_pagar", x["deuda"]), x["nombre"]))
    return {
        "total_cuentas": len(filas),
        "con_deuda": con_deuda,
        "deuda_total": round(total_deuda, 2),
        "cartera_en_calle": round(total_deuda, 2),
        "capital_total": round(total_capital, 2),
        "interes_total": round(total_interes, 2),
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


def _cargos_cartera(
    sucursal_id: int | None = None,
    periodo: str = "Mes",
    desde: str | None = None,
    hasta: str | None = None,
    filtro: dict | None = None,
) -> dict:
    from app.services.pos_vitrina import resolver_rango

    ini_iso, fin_iso, nombre_periodo = resolver_rango(
        str(periodo or "Mes"),
        desde_custom=desde,
        hasta_custom=hasta,
    )
    col_cc, filas_cc = filas_de("cuenta_corriente", sucursal_id)
    idx_cc = _indice(col_cc)

    col_cli, filas_cli = _filas_clientes(sucursal_id)
    idx_cli = _indice(col_cli)
    clientes_map: dict[str, dict] = {}
    for f in filas_cli:
        cid = _clave(_valor(f, idx_cli, "id"))
        if cid:
            clientes_map[cid] = {
                "nombre": str(_valor(f, idx_cli, "nombre") or "Cliente").strip(),
                "dni": str(_valor(f, idx_cli, "dni", "cuit") or "").strip(),
            }

    cargos = []
    total_vivo = 0.0
    total_borrado = 0.0
    total_cancelado = 0.0

    q = str(filtro.get("texto") or "").strip().lower() if filtro else ""
    estado_filtro = str(filtro.get("estado") or "").strip().lower() if filtro else ""
    if estado_filtro in ("todos", ""):
        estado_filtro = ""

    for fila in filas_cc:
        tipo = str(_valor(fila, idx_cc, "tipo") or "").upper()
        if tipo != "CARGO":
            continue
        desc = str(_valor(fila, idx_cc, "descripcion") or "").strip()
        if "MANTENIMIENTO" in desc.upper():
            continue

        fecha_raw = str(_valor(fila, idx_cc, "fecha") or "")
        if nombre_periodo != "Todas":
            dia_f = fecha_raw[:10]
            if dia_f < ini_iso[:10] or dia_f > fin_iso[:10]:
                continue

        cid = _clave(_valor(fila, idx_cc, "cliente_id"))
        cli_info = clientes_map.get(cid) or {}
        nombre = cli_info.get("nombre") or str(_valor(fila, idx_cc, "nombre") or "").strip() or f"Cliente #{cid}"
        dni = cli_info.get("dni") or str(_valor(fila, idx_cc, "dni") or "").strip()

        monto = _numero(_valor(fila, idx_cc, "monto"))
        saldo = _numero(_valor(fila, idx_cc, "saldo_resultante", "saldo"))
        venta_id = _valor(fila, idx_cc, "venta_id")
        venta_txt = str(venta_id).strip() if venta_id not in (None, "", 0, "0") else ""

        d_up = desc.upper()
        es_interes = desc.startswith("[INTERES]") or desc.startswith("INTERES:")
        if "CANCELADO" in d_up or "CANCELADA" in d_up:
            estado = "Cancelado"
            estado_clave = "cancelado"
            total_cancelado += monto
        elif "BORRADO" in d_up or "ANULADO" in d_up or "ANULADA" in d_up:
            estado = "Borrado"
            estado_clave = "borrado"
            total_borrado += monto
        else:
            estado = "Vivo"
            estado_clave = "vivo"
            total_vivo += monto

        if estado_filtro and estado_clave != estado_filtro:
            continue

        if es_interes:
            ticket = "INTERÉS"
            origen = "Interés por ticket"
        elif venta_txt:
            ticket = f"#{venta_txt}"
            origen = "Venta"
        else:
            ticket = "MANUAL"
            origen = "Manual"

        fecha_fmt = fecha_raw
        if len(fecha_raw) >= 16 and fecha_raw[4] == "-" and fecha_raw[7] == "-":
            fecha_fmt = f"{fecha_raw[8:10]}/{fecha_raw[5:7]}/{fecha_raw[:4]} {fecha_raw[11:16]}"

        if q:
            match_txt = f"{nombre} {dni} {ticket} {desc} {venta_txt}".lower()
            if q not in match_txt:
                continue

        cargos.append({
            "id": _valor(fila, idx_cc, "id"),
            "ticket": ticket,
            "venta_id": venta_txt,
            "fecha": fecha_fmt,
            "fecha_raw": fecha_raw,
            "nombre": nombre,
            "dni": dni,
            "monto": monto,
            "origen": origen,
            "es_interes": es_interes,
            "estado": estado,
            "estado_clave": estado_clave,
            "descripcion": desc or "—",
            "saldo": saldo,
            "sucursal_id": _valor(fila, idx_cc, "sucursal_id"),
            "sucursal_nombre": _valor(fila, idx_cc, "sucursal_nombre") or "",
        })

    cargos.sort(key=lambda item: item["fecha_raw"], reverse=True)
    return {
        "ok": True,
        "libro": len(cargos) > 0,
        "panel": "cargos",
        "periodo": nombre_periodo,
        "cargos": cargos,
        "resumen": {
            "total_cargos": len(cargos),
            "total_vivos": round(total_vivo, 2),
            "total_borrados": round(total_borrado, 2),
            "total_cancelados": round(total_cancelado, 2),
        },
        "sucursales": listar_sucursales(),
        "sucursal_id": sucursal_id,
    }


def _cobros_cartera(
    sucursal_id: int | None = None,
    periodo: str = "Mes",
    desde: str | None = None,
    hasta: str | None = None,
    filtro: dict | None = None,
) -> dict:
    from app.services.pos_vitrina import resolver_rango

    ini_iso, fin_iso, nombre_periodo = resolver_rango(
        str(periodo or "Mes"),
        desde_custom=desde,
        hasta_custom=hasta,
    )
    col_cc, filas_cc = filas_de("cuenta_corriente", sucursal_id)
    idx_cc = _indice(col_cc)

    col_cli, filas_cli = _filas_clientes(sucursal_id)
    idx_cli = _indice(col_cli)
    clientes_map: dict[str, dict] = {}
    for f in filas_cli:
        cid = _clave(_valor(f, idx_cli, "id"))
        if cid:
            clientes_map[cid] = {
                "nombre": str(_valor(f, idx_cli, "nombre") or "Cliente").strip(),
                "dni": str(_valor(f, idx_cli, "dni", "cuit") or "").strip(),
            }

    cobros = []
    total_cobrado = 0.0
    desglose_medios: dict[str, float] = {}

    q = str(filtro.get("texto") or "").strip().lower() if filtro else ""
    medio_filtro = str(filtro.get("medio") or "").strip().lower() if filtro else ""
    if medio_filtro in ("todos", ""):
        medio_filtro = ""

    for fila in filas_cc:
        tipo = str(_valor(fila, idx_cc, "tipo") or "").upper()
        if tipo != "ABONO":
            continue

        fecha_raw = str(_valor(fila, idx_cc, "fecha") or "")
        if nombre_periodo != "Todas":
            dia_f = fecha_raw[:10]
            if dia_f < ini_iso[:10] or dia_f > fin_iso[:10]:
                continue

        cid = _clave(_valor(fila, idx_cc, "cliente_id"))
        cli_info = clientes_map.get(cid) or {}
        nombre = cli_info.get("nombre") or str(_valor(fila, idx_cc, "nombre") or "").strip() or f"Cliente #{cid}"
        dni = cli_info.get("dni") or str(_valor(fila, idx_cc, "dni") or "").strip()

        monto = _numero(_valor(fila, idx_cc, "monto"))
        saldo = _numero(_valor(fila, idx_cc, "saldo_resultante", "saldo"))
        desc = str(_valor(fila, idx_cc, "descripcion") or "").strip()
        medio_raw = str(_valor(fila, idx_cc, "medio_pago") or "").strip()

        # Extraer medio y detalle como en cobradas/lista.py de TPV 2026
        medio = medio_raw.split(":", 1)[0].strip() if medio_raw else ""
        if not medio:
            if desc.endswith(")") and "(" in desc:
                dentro = desc.rsplit("(", 1)[-1].rstrip(")").strip()
                medio = dentro.split(":", 1)[0].strip() if ":" in dentro else dentro
        if not medio:
            medio = "Efectivo"

        detalle = ""
        if desc.endswith(")") and "(" in desc:
            dentro = desc.rsplit("(", 1)[-1].rstrip(")").strip()
            if ":" in dentro:
                detalle = dentro.split(":", 1)[1].strip()
        if not detalle and medio.lower() == "efectivo":
            detalle = "Caja"

        if medio_filtro and medio.lower() != medio_filtro:
            continue

        cid_cobro = _valor(fila, idx_cc, "id")
        cobro_ticket = f"COB-{cid_cobro}" if cid_cobro else "COB"

        if q:
            match_txt = f"{nombre} {dni} {cobro_ticket} {detalle} {medio} {desc}".lower()
            if q not in match_txt:
                continue

        total_cobrado += monto
        m_key = medio.capitalize()
        desglose_medios[m_key] = desglose_medios.get(m_key, 0.0) + monto

        fecha_fmt = fecha_raw
        if len(fecha_raw) >= 16 and fecha_raw[4] == "-" and fecha_raw[7] == "-":
            fecha_fmt = f"{fecha_raw[8:10]}/{fecha_raw[5:7]}/{fecha_raw[:4]} {fecha_raw[11:16]}"

        perfil = str(_valor(fila, idx_cc, "perfil") or "").strip()
        quien = str(_valor(fila, idx_cc, "registrado_por") or "").strip() or perfil

        cobros.append({
            "id": cid_cobro,
            "ticket_cobro": cobro_ticket,
            "fecha": fecha_fmt,
            "fecha_raw": fecha_raw,
            "nombre": nombre,
            "dni": dni,
            "monto": monto,
            "medio": medio,
            "detalle": detalle or "—",
            "perfil": perfil or "—",
            "quien": quien or "—",
            "saldo": saldo,
            "digital": medio.lower() in ("qr", "transferencia", "tarjeta", "mixto"),
            "sucursal_id": _valor(fila, idx_cc, "sucursal_id"),
            "sucursal_nombre": _valor(fila, idx_cc, "sucursal_nombre") or "",
        })

    cobros.sort(key=lambda item: item["fecha_raw"], reverse=True)
    return {
        "ok": True,
        "libro": len(cobros) > 0,
        "panel": "cobros",
        "periodo": nombre_periodo,
        "cobros": cobros,
        "resumen": {
            "total_cobros": len(cobros),
            "monto_cobrado": round(total_cobrado, 2),
            "desglose_medios": {k: round(v, 2) for k, v in desglose_medios.items()},
        },
        "sucursales": listar_sucursales(),
        "sucursal_id": sucursal_id,
    }


def _auditoria_cartera(
    sucursal_id: int | None = None,
    filtro: dict | None = None,
) -> dict:
    col_aud, filas_aud = filas_de("clientes_auditoria", sucursal_id)
    idx_aud = _indice(col_aud)

    # Cuadre de integridad general:
    col_cc, filas_cc = filas_de("cuenta_corriente", sucursal_id)
    idx_cc = _indice(col_cc)
    col_cli, filas_cli = _filas_clientes(sucursal_id)
    idx_cli = _indice(col_cli)

    total_deuda_clientes = sum(_numero(_valor(f, idx_cli, "deuda_actual", "deuda")) for f in filas_cli)
    cargos_vivos = sum(
        _numero(_valor(f, idx_cc, "monto"))
        for f in filas_cc
        if str(_valor(f, idx_cc, "tipo") or "").upper() == "CARGO"
        and "MANTENIMIENTO" not in str(_valor(f, idx_cc, "descripcion") or "").upper()
        and "BORRADO" not in str(_valor(f, idx_cc, "descripcion") or "").upper()
        and "CANCELADO" not in str(_valor(f, idx_cc, "descripcion") or "").upper()
    )
    abonos_totales = sum(
        _numero(_valor(f, idx_cc, "monto"))
        for f in filas_cc
        if str(_valor(f, idx_cc, "tipo") or "").upper() == "ABONO"
    )

    cuadre_diferencia = round(cargos_vivos - abonos_totales - total_deuda_clientes, 2)

    ACCIONES_MAP = {
        "ALTA": "Alta",
        "EDICION": "Edición",
        "LIMITE": "Límite",
        "CARGO": "Cargo",
        "ABONO": "Abono",
        "ANULACION": "Anulación",
        "BORRADO": "Borrado",
        "FUSION": "Unido",
        "SUSPENDIDO": "Suspendido",
    }

    FILTRO_ACCION_MAP = {
        "cargos": ("CARGO",),
        "abonos": ("ABONO",),
        "borrados": ("BORRADO", "ANULACION"),
        "ficha": ("ALTA", "EDICION", "LIMITE", "FUSION", "SUSPENDIDO"),
    }

    q = str(filtro.get("texto") or "").strip().lower() if filtro else ""
    accion_chip = str(filtro.get("accion") or "").strip().lower() if filtro else ""
    if accion_chip in ("todas", "todos", ""):
        accion_chip = ""

    filas_out = []
    for fila in filas_aud:
        accion_raw = str(_valor(fila, idx_aud, "accion") or "").upper()
        if accion_chip and accion_chip in FILTRO_ACCION_MAP:
            if accion_raw not in FILTRO_ACCION_MAP[accion_chip]:
                continue

        fecha_raw = str(_valor(fila, idx_aud, "fecha") or "")
        nombre = str(_valor(fila, idx_aud, "nombre") or "").strip()
        pc = str(_valor(fila, idx_aud, "pc") or "").strip()
        caja = str(_valor(fila, idx_aud, "caja") or "").strip()
        usuario = str(_valor(fila, idx_aud, "usuario") or "").strip()
        llego_via = str(_valor(fila, idx_aud, "llego_via") or "").strip()
        llego_en = str(_valor(fila, idx_aud, "llego_en") or "").strip()
        detalle_raw = _valor(fila, idx_aud, "detalle")

        det = {}
        if isinstance(detalle_raw, dict):
            det = detalle_raw
        elif isinstance(detalle_raw, str):
            try:
                det = json.loads(detalle_raw)
            except Exception:
                det = {"raw": detalle_raw}

        # Formatear detalle legible
        resumen_txt = ""
        referencia = ""
        medio = str(det.get("medio") or "").strip()
        id_pago = ""

        if det.get("cobro_id"):
            referencia = f"COB-{det['cobro_id']}"
        elif det.get("venta_id"):
            referencia = f"#{det['venta_id']}"
        elif det.get("cargo_id"):
            referencia = f"Cargo #{det['cargo_id']}"

        desc_ev = str(det.get("descripcion") or "")
        if ":" in desc_ev and desc_ev.endswith(")"):
            id_pago = desc_ev.rsplit("(", 1)[-1].rstrip(")").split(":", 1)[-1].strip()

        if accion_raw == "ALTA":
            ficha_d = det.get("ficha") or {}
            partes = [f"desde {det.get('via') or llego_via or 'tienda'}"]
            if ficha_d.get("dni"):
                partes.append(f"DNI {ficha_d['dni']}")
            if ficha_d.get("limite_credito") is not None:
                partes.append(f"límite ${_numero(ficha_d['limite_credito']):,.2f}")
            resumen_txt = " · ".join(partes)
        elif accion_raw in ("EDICION", "LIMITE"):
            desp = det.get("despues") or {}
            antes = det.get("antes") or {}
            resumen_txt = "; ".join(f"{k}: {antes.get(k, '—')} → {desp.get(k, '—')}" for k in desp) or "Actualización de ficha"
        elif accion_raw in ("CARGO", "ABONO", "ANULACION", "BORRADO"):
            m = det.get("monto")
            m_txt = f"${_numero(m):,.2f}" if m is not None else ""
            partes = [p for p in (m_txt, referencia, id_pago) if p]
            resumen_txt = " · ".join(partes) or desc_ev or "Movimiento de cuenta"
        elif accion_raw == "FUSION":
            resumen_txt = f"Unificado con ID {det.get('id_destino') or '—'}"
        else:
            resumen_txt = desc_ev or str(det.get("raw") or "Evento")

        if llego_via in ("OFFLINE", "LOCAL"):
            llegada = "Sin red (esta PC)"
        elif llego_via == "DIRECTO" or not llego_via:
            llegada = "En esta tienda"
        else:
            llegada = llego_via
        if llego_en:
            llegada += f" · {llego_en[:16]}"

        fecha_fmt = fecha_raw
        if len(fecha_raw) >= 16 and fecha_raw[4] == "-" and fecha_raw[7] == "-":
            fecha_fmt = f"{fecha_raw[8:10]}/{fecha_raw[5:7]}/{fecha_raw[:4]} {fecha_raw[11:16]}"

        if q:
            match_txt = f"{nombre} {pc} {usuario} {accion_raw} {referencia} {id_pago} {resumen_txt}".lower()
            if q not in match_txt:
                continue

        filas_out.append({
            "evento": _valor(fila, idx_aud, "evento"),
            "fecha": fecha_fmt,
            "fecha_raw": fecha_raw,
            "accion": ACCIONES_MAP.get(accion_raw, accion_raw.capitalize()),
            "accion_raw": accion_raw,
            "cliente": nombre,
            "referencia": referencia or "—",
            "medio": medio or "—",
            "id_pago": id_pago or "—",
            "pc": pc or "—",
            "caja": caja or "—",
            "usuario": usuario or "—",
            "llegada": llegada,
            "detalle": resumen_txt,
            "sucursal_id": _valor(fila, idx_aud, "sucursal_id"),
            "sucursal_nombre": _valor(fila, idx_aud, "sucursal_nombre") or "",
        })

    filas_out.sort(key=lambda item: item["fecha_raw"], reverse=True)
    return {
        "ok": True,
        "libro": len(filas_out) > 0,
        "panel": "auditoria_cartera",
        "auditoria": filas_out,
        "resumen": {
            "total_eventos": len(filas_out),
            "total_deuda_clientes": round(total_deuda_clientes, 2),
            "cargos_vivos": round(cargos_vivos, 2),
            "abonos_totales": round(abonos_totales, 2),
            "cuadre_diferencia": cuadre_diferencia,
            "cuadre_ok": abs(cuadre_diferencia) < 1.0,
        },
        "sucursales": listar_sucursales(),
        "sucursal_id": sucursal_id,
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


def _contabilidad(medios_pago: list[dict], ini: str | None, fin: str | None, sucursal_id: int | str | None, etiqueta: str) -> dict:
    medios_lista = medios_pago or []
    total_medios = round(sum(_numero(m.get("monto")) for m in medios_lista), 2)
    tickets = sum(int(m.get("tickets") or 0) for m in medios_lista)

    es_web = str(sucursal_id or "").strip().lower().startswith("web")
    if es_web:
        return {
            "ventas": total_medios,
            "tickets": tickets,
            "etiqueta": etiqueta,
            "medios_pago": medios_lista,
            "cobros": 0.0,
            "cobros_cant": 0,
            "cobros_por_medio": {},
            "detalle_cobros": [],
            "gastos": 0.0,
            "resultado": total_medios,
            "detalle_gastos": [],
            "caja": [],
        }

    corte_ini, corte_fin = ini, fin
    if str(etiqueta or "").strip().startswith("Hoy"):
        hoy_real = datetime.now(_ZONA).date().isoformat()
        corte_ini = min(ini, hoy_real) if ini else hoy_real
        corte_fin = max(fin, hoy_real) if fin else hoy_real

    idx_cc, movimientos = _filas_en_rango("cuenta_corriente", corte_ini, corte_fin, sucursal_id)
    cobros = 0.0
    detalle_cobros = []
    cobros_por_medio: dict[str, dict] = {}
    for fila in movimientos:
        tipo = str(_valor(fila, idx_cc, "tipo") or "").upper()
        if tipo == "ABONO":
            monto = _numero(_valor(fila, idx_cc, "monto"))
            cobros += monto
            desc = str(_valor(fila, idx_cc, "descripcion") or "Cobro fiado").strip()
            medio_raw = str(_valor(fila, idx_cc, "medio_pago") or "").strip()
            medio = medio_raw.split(":", 1)[0].strip() if medio_raw else ""
            if not medio and desc.endswith(")") and "(" in desc:
                dentro = desc.rsplit("(", 1)[-1].rstrip(")").strip()
                medio = dentro.split(":", 1)[0].strip() if ":" in dentro else dentro
            if not medio:
                medio = "Efectivo"
            medio = medio.capitalize()
            if medio.lower() in ("mercadopago", "mp"):
                medio = "QR"

            if medio not in cobros_por_medio:
                cobros_por_medio[medio] = {"monto": 0.0, "cant": 0}
            cobros_por_medio[medio]["monto"] = round(cobros_por_medio[medio]["monto"] + monto, 2)
            cobros_por_medio[medio]["cant"] += 1

            detalle_cobros.append({
                "monto": round(monto, 2),
                "descripcion": desc,
                "medio": medio,
            })

    idx_g, gastos = _filas_en_rango("gastos", corte_ini, corte_fin, sucursal_id)
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
    idx_caja, caja = _filas_en_rango("movimientos_caja", corte_ini, corte_fin, sucursal_id)
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
        "cobros_cant": len(detalle_cobros),
        "cobros_por_medio": cobros_por_medio,
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


def _clave_panel(nombre: str, sid: int | None, periodo: str, desde: str | None, hasta: str | None, filtro: dict | None) -> tuple:
    filtro_txt = json.dumps(filtro or {}, sort_keys=True, default=str, ensure_ascii=False)
    hoy = datetime.now(_ZONA).date().isoformat()
    return (
        _ambito_cache(),
        hoy,
        nombre,
        sid,
        str(periodo or ""),
        desde or "",
        hasta or "",
        filtro_txt,
    )


def panel(
    nombre: str,
    sucursal_id: int | str | None = None,
    periodo: str = "Hoy",
    desde: str | None = None,
    hasta: str | None = None,
    filtro: dict | None = None,
) -> dict:
    sid = str(sucursal_id).strip().lower() if str(sucursal_id or "").strip().lower().startswith("web") else (int(sucursal_id) if sucursal_id is not None and str(sucursal_id).isdigit() else None)
    clave = _clave_panel(nombre, sid, periodo, desde, hasta, filtro)
    with _panel_lock:
        guardado = _panel_cache.get(clave)
    if guardado:
        sellos = sellos_de(_TABLAS_SELLO, sid)
        if guardado[0] == sellos:
            return guardado[1]
    from app.services.pos_base import anclar_vista, soltar_vista

    anclar_vista()
    try:
        dato = _armar_panel(
            nombre,
            sucursal_id,
            periodo=periodo,
            desde=desde,
            hasta=hasta,
            filtro=filtro,
        )
        sellos = sellos_de(_TABLAS_SELLO, sid)
    finally:
        soltar_vista()
    marcas = [sello[0] for sello in sellos if sello and sello[0]]
    dato["actualizado_en"] = max(marcas) if marcas else None
    with _panel_lock:
        _panel_cache[clave] = (sellos, dato)
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

    if nombre in ("financiero", "reporte_financiero"):
        from app.services.pos_vitrina import calcular_reporte_financiero
        comparar = bool(filtro and filtro.get("comparar"))
        return calcular_reporte_financiero(
            periodo=periodo,
            sucursal_id=sucursal_id,
            desde=desde,
            hasta=hasta,
            comparar=comparar,
        )

    if nombre in ("cargos", "cartera_cargos"):
        return _cargos_cartera(sucursal_id, periodo=periodo, desde=desde, hasta=hasta, filtro=filtro)
    if nombre in ("cobros", "cartera_cobros"):
        return _cobros_cartera(sucursal_id, periodo=periodo, desde=desde, hasta=hasta, filtro=filtro)
    if nombre in ("auditoria", "auditoria_cartera", "cartera_auditoria"):
        return _auditoria_cartera(sucursal_id, filtro=filtro)

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

    from app.services.pos_vitrina import resolver_rango
    from app.services.pos_base import preparar_vista

    desde_iso, hasta_iso, nombre_periodo = resolver_rango(
        str(periodo or "Hoy"),
        desde_custom=desde or None,
        hasta_custom=hasta or None,
    )
    ini = desde_iso[:10]
    fin = hasta_iso[:10]
    hoy_real = datetime.now(_ZONA).date().isoformat()
    if nombre == "ticket":
        pedido = dict(filtro or {})
        if pedido.get("fecha_ini"):
            ini = str(pedido.get("fecha_ini"))[:10]
            fin = str(pedido.get("fecha_fin") or ini)[:10]
        else:
            ini, fin = rango_fechas(
                str(pedido.get("alcance") or "dia"),
                str(pedido.get("fecha") or ""),
                bool(pedido.get("historico")),
                hoy_real,
            )
        if (
            str(pedido.get("alcance") or "dia").lower() == "dia"
            and not pedido.get("historico")
            and not pedido.get("fecha_ini")
        ):
            pedido["fecha_ini"] = ini or hoy_real
            pedido["fecha_fin"] = fin or hoy_real
        libro = historial_ventas(sucursal_id, pedido, hoy_real)
        t_ok = libro.get("tickets_ok", 0)
        t_fil = libro.get("filtrado", 0.0)
        return {
            "ok": True,
            "libro": libro["libro"],
            "panel": nombre,
            "resumen": {
                "dia": ini or hoy_real,
                "ventas": t_fil,
                "tickets": t_ok,
                "promedio": round(t_fil / t_ok, 2) if t_ok else 0.0,
                "pago": "",
                "es_hoy": (ini == hoy_real),
            },
            "tickets": libro["tickets"],
            "filtrado": t_fil,
            "tickets_ok": t_ok,
            "cajas": libro["cajas"],
            "recorte": libro["recorte"],
            "hay_mas": libro.get("hay_mas", False),
            "offset": libro.get("offset", 0),
            "limite": libro.get("limite", 400),
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }

    if nombre == "desglose":
        pedido = dict(filtro or {})
        if pedido.get("fecha_ini"):
            ini = str(pedido.get("fecha_ini"))[:10]
            fin = str(pedido.get("fecha_fin") or ini)[:10]
        else:
            ini, fin = rango_fechas(
                str(pedido.get("alcance") or "dia"),
                str(pedido.get("fecha") or ""),
                bool(pedido.get("historico")),
                hoy_real,
            )
        if ini and fin and ini == fin == hoy_real:
            nombre_periodo = "Hoy"
        elif not ini or not fin:
            nombre_periodo = "Todo"
        else:
            nombre_periodo = "Período"
    if not ini or not fin:
        ventas, _idx = _ventas(sucursal_id)
        dias = [v["dia"] for v in ventas if v.get("dia")]
        ini = min(dias) if dias else hoy_real
        fin = max(dias) if dias else hoy_real
    elif nombre_periodo == "Hoy":
        ini = fin = preparar_vista(sucursal_id, hoy_real, hoy_real, desplazar_hoy=True)
        d0 = datetime.fromisoformat(ini).date()
        ant_ini = (d0 - timedelta(days=1)).isoformat()
        ventas, _idx = _ventas(sucursal_id, desde=ant_ini, hasta=fin)
    else:
        preparar_vista(sucursal_id, ini, fin, desplazar_hoy=False)
        d0 = datetime.fromisoformat(ini).date()
        d1 = datetime.fromisoformat(fin).date()
        duracion = (d1 - d0).days + 1
        ant_ini = (d0 - timedelta(days=duracion)).isoformat()
        ventas, _idx = _ventas(sucursal_id, desde=ant_ini, hasta=fin)
    dia_activo = ini
    libro_ini, libro_fin = ini, fin

    resumen = _resumen(ventas, ini, fin) if ventas else {
        "dia": ini, "ventas": 0.0, "tickets": 0, "promedio": 0.0, "pago": "", "es_hoy": (ini == hoy_real)
    }
    desglose_suc = _desglose_sucursales(ventas, ini, fin) if ventas else []

    if nombre in ("digitales", "cobros_digitales", "mercadopago", "mp"):
        if str(periodo or "").strip().lower() in ("todo", "todos", "historico", "histórico"):
            digitales = _cobros_digitales("", sucursal_id, "")
            nombre_periodo = "Todo"
        else:
            digitales = _cobros_digitales(ini, sucursal_id, fin)
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

    if nombre == "desglose":
        libro = desglose_articulos(sucursal_id, ini, fin)

        def _corta(iso: str) -> str:
            anio, mes, dia = iso[:10].split("-")
            return f"{dia}/{mes}/{anio}"

        etiqueta = _corta(ini) if ini == fin else (_corta(ini) + " → " + _corta(fin))
        return {
            "ok": True,
            "libro": libro["libro"],
            "panel": "desglose",
            "resumen": resumen,
            "desglose": {**libro, "etiqueta": etiqueta, "periodo": nombre_periodo},
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }

    if nombre == "ticket":
        pedido = dict(filtro or {})
        if (
            str(pedido.get("alcance") or "dia").lower() == "dia"
            and not pedido.get("historico")
            and not pedido.get("fecha_ini")
        ):
            pedido["fecha_ini"] = libro_ini
            pedido["fecha_fin"] = libro_fin
        libro = historial_ventas(sucursal_id, pedido, datetime.now(_ZONA).date().isoformat())
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
            "hay_mas": libro.get("hay_mas", False),
            "offset": libro.get("offset", 0),
            "limite": libro.get("limite", 400),
            "sucursales": sucursales_disp,
            "sucursal_id": sucursal_id,
        }

    from app.services.pos_vitrina import calcular_vitrina

    vitrina = calcular_vitrina(
        periodo="Período",
        sucursal_id=sucursal_id,
        desde=ini,
        hasta=fin,
    )
    vitrina["periodo"] = nombre_periodo
    vitrina["es_hoy"] = nombre_periodo == "Hoy"
    if nombre_periodo == "Hoy":
        vitrina["tickets"]["titulo"] = "Tickets del día"
        vitrina["ganancia_parcial"]["titulo"] = "Ganancia parcial"
        vitrina["cancelaciones"]["titulo"] = "Cancelaciones del día"

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
        ranking = _ranking_cortes(ini, sucursal_id, ventas, hasta=fin)
        digitales = _cobros_digitales(ini, sucursal_id, hasta=fin)
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
        if not pedido.get("periodo") and periodo:
            pedido["periodo"] = periodo
        if not pedido.get("desde") and desde:
            pedido["desde"] = desde
        if not pedido.get("hasta") and hasta:
            pedido["hasta"] = hasta
        pedido.setdefault("alcance", "dia")
        pedido.setdefault("metodo", "TODOS")
        if pedido.get("periodo"):
            from app.services.pos_vitrina import resolver_rango
            desde_iso, hasta_iso, nombre_periodo = resolver_rango(
                str(pedido.get("periodo")),
                desde_custom=pedido.get("desde") or None,
                hasta_custom=pedido.get("hasta") or None,
            )
            pedido["fecha_ini"] = desde_iso[:10]
            pedido["fecha_fin"] = hasta_iso[:10]
            ini, fin = pedido["fecha_ini"], pedido["fecha_fin"]
            if nombre_periodo == "Hoy":
                ini, fin = libro_ini, libro_fin
                pedido["fecha_ini"] = ini
                pedido["fecha_fin"] = fin
                etiqueta = "Hoy · " + ini
            elif nombre_periodo == "Período":
                etiqueta = "Período · " + ini + (" → " + fin if fin != ini else "")
            else:
                etiqueta = nombre_periodo
        else:
            ini, fin = rango_fechas(
                str(pedido.get("alcance") or "dia"),
                str(pedido.get("fecha") or ""),
                bool(pedido.get("historico")),
                hoy,
            )
            etiqueta = _etiqueta_caja(pedido, ini, fin, hoy)
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
                etiqueta,
            ),
            "desglose_sucursales": desglose_suc,
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
