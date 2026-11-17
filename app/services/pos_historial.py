"""Historial de cuenta de Cobro Fácil, leído de la copia en la nube."""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta

from app.services.pos_base import filas_de, hay_tabla
from app.services.pos_interes import MARCA_INTERES, clave_ticket, proyectar_interes

_ACTIVACION = "2026-01-01 00:00:00"


def _dicts(columnas: list[str], filas: list[list]) -> list[dict]:
    return [dict(zip(columnas, fila)) for fila in filas]


def _num(valor) -> float:
    try:
        return float(valor or 0)
    except (TypeError, ValueError):
        return 0.0


def _activacion(configs: list[dict]) -> str:
    for fila in configs:
        clave = str(fila.get("clave") or fila.get("key") or "").strip()
        if clave == "interes_ticket_activado_en" and fila.get("valor") not in (None, ""):
            return str(fila["valor"])
    return _ACTIVACION


def _detalle_visible(tipo: str, desc: str, venta_id, ticket: str) -> str:
    desc_lower = desc.lower()
    es_ticket = bool(venta_id) or str(ticket or "").startswith("#")
    if es_ticket:
        hallado = re.search(r"\((excepci[oó]n[^)]*)\)", desc, re.IGNORECASE)
        if hallado:
            texto = hallado.group(1).strip()
            return texto[:1].upper() + texto[1:]
        if "pin" in desc_lower:
            return "Excepción PIN"
        if "excepci" in desc_lower:
            return "Excepción admin"
        if "autoriz" in desc_lower:
            return "Autorización admin"
        if any(marca in desc_lower for marca in ("excepci", "pin", "alerta", "autoriz")):
            return desc or "—"
        return "—"
    if tipo == "ABONO":
        metodo = re.search(r"\(([^)]+)\)", desc)
        texto = metodo.group(1).strip() if metodo else (desc or "Abono a cuenta")
        texto = re.sub(r":\s*F9\s*MANUAL", "", texto, flags=re.IGNORECASE)
        texto = re.sub(r"F9\s*MANUAL", "Manual", texto, flags=re.IGNORECASE).strip()
        return texto or "Abono a cuenta"
    if desc.startswith(MARCA_INTERES):
        return MARCA_INTERES
    return desc or "—"


def _etiqueta(tipo: str, desc: str, venta_id) -> str:
    borrado = desc.startswith("BORRADO · ")
    cancelado = desc.startswith("CANCELADO · ")
    es_venta = bool(venta_id and str(venta_id) not in ("0", "None", ""))
    if tipo == "CARGO" and es_venta:
        if cancelado:
            return "VENTA · CANCELADA"
        if borrado:
            return "VENTA · BORRADA"
        return "VENTA"
    if tipo == "CARGO" and not es_venta:
        if cancelado:
            return "CARGO MANUAL · CANCELADO"
        if borrado:
            return "CARGO MANUAL · BORRADO"
        return "CARGO MANUAL"
    if tipo == "ABONO":
        return "COBRO"
    if tipo == "ANULACION" and "cancelado" in desc.lower():
        return "TICKET CANCELADO"
    if tipo == "ANULACION":
        return "ANULACIÓN"
    return tipo or "—"


def _referencia(tipo: str, venta_id, mov_id) -> str:
    if venta_id not in (None, "", 0, "0"):
        return f"#{venta_id}"
    if tipo == "ABONO" and mov_id not in (None, "", 0, "0"):
        return f"COB-{mov_id}"
    return ""


def _armar(fila: dict, tickets: dict) -> dict:
    tipo = str(fila.get("tipo") or "").upper()
    desc = str(fila.get("descripcion") or "").strip()
    venta_id = fila.get("venta_id")
    if venta_id in (None, "", 0, "0"):
        venta_id = ""
    mov_id = fila.get("id")
    borrado = tipo == "CARGO" and desc.startswith("BORRADO · ")
    cancelado = tipo == "CARGO" and desc.startswith("CANCELADO · ")
    ticket = _referencia(tipo, venta_id, mov_id)
    clave = clave_ticket(fila)
    interes = tickets.get(clave) or {}
    return {
        "id": mov_id,
        "fecha": str(fila.get("fecha") or "").split(".")[0],
        "tipo": tipo,
        "etiqueta": _etiqueta(tipo, desc, venta_id),
        "monto": _num(fila.get("monto")),
        "saldo": _num(fila.get("saldo_resultante")),
        "ticket": ticket or "—",
        "detalle": _detalle_visible(tipo, desc, venta_id, ticket),
        "dias": int(interes.get("dias") or 0) if tipo == "CARGO" and not (borrado or cancelado) else None,
        "mantenimiento": float(interes.get("interes_acumulado") or 0) if tipo == "CARGO" else None,
        "es_interes": tipo == "CARGO" and desc.startswith(MARCA_INTERES),
        "es_venta": bool(venta_id),
        "es_cobro": tipo == "ABONO",
        "borrado": borrado,
        "cancelado": cancelado,
    }


def _politica(configs: list[dict]) -> tuple:
    from decimal import Decimal

    mapa = {
        str(fila.get("clave") or ""): fila.get("valor")
        for fila in configs
    }

    def numero(clave: str, default: float) -> float:
        bruto = mapa.get(clave)
        if bruto in (None, ""):
            return default
        try:
            return float(bruto)
        except (TypeError, ValueError):
            return default

    base = Decimal(str(numero("fiado_mantenimiento_pct", 5))) / Decimal("100")
    apal = Decimal(str(numero("fiado_apalancamiento_pct", 5))) / Decimal("100")
    plazo = max(1, int(numero("fiado_plazo_dias", 30)))
    return base, apal, plazo


def _proyeccion(movimientos: list[dict]) -> dict:
    columnas, crudas = filas_de("configuracion")
    configs = _dicts(columnas, crudas)
    base, apal, plazo = _politica(configs)
    try:
        return proyectar_interes(
            movimientos,
            _activacion(configs),
            ahora=datetime.now(),
            tasa_base=base,
            tasa_apal=apal,
            dias_plazo=plazo,
        )
    except Exception:
        return {"tickets": {}, "interes_acumulado": 0.0}


_mov_armado: dict[tuple, list[dict]] = {}


def _tickets_enlazados(persona: dict, ya: set) -> list[dict]:
    """Tickets de venta de cualquier sucursal cuyo nombre o id pertenece a ese DNI."""
    columnas, filas = filas_de("ventas")
    if not columnas:
        return []
    idx = {str(col).lower(): i for i, col in enumerate(columnas)}
    nombres = {nombre.casefold() for nombre in persona.get("nombres") or []}
    ids = {str(valor) for valor in persona.get("ids") or []}
    salida = []
    for fila in filas:
        vid = str(_tomar(fila, idx, "id") or "")
        if not vid or vid in ya:
            continue
        cliente = str(_tomar(fila, idx, "cliente_nombre") or "").strip()
        cid = str(_tomar(fila, idx, "cliente_id") or "")
        if not ((cliente and cliente.casefold() in nombres) or (cid and cid in ids)):
            continue
        estado = str(_tomar(fila, idx, "estado") or "").upper()
        sucursal = str(_tomar(fila, idx, "sucursal_nombre") or "").strip()
        detalle = cliente or "Ticket"
        if sucursal:
            detalle = f"{detalle} · {sucursal}"
        salida.append({
            "id": vid,
            "fecha": str(_tomar(fila, idx, "fecha") or "").split(".")[0],
            "tipo": "CARGO",
            "etiqueta": "TICKET",
            "monto": _num(_tomar(fila, idx, "total")),
            "saldo": None,
            "ticket": f"#{vid}",
            "detalle": detalle,
            "dias": None,
            "mantenimiento": None,
            "es_interes": False,
            "es_venta": True,
            "es_cobro": False,
            "borrado": False,
            "cancelado": estado.startswith("CANCEL"),
        })
    return salida


def movimientos_de(pos_id) -> list[dict]:
    columnas, crudas = filas_de("cuenta_corriente")
    from app.services.pos_base import enlaces_de_persona

    buscado = str(pos_id)
    persona = enlaces_de_persona(buscado)
    clave = (id(crudas), buscado)
    guardado = _mov_armado.get(clave)
    if guardado is not None:
        return guardado
    filas = []
    if columnas:
        filas = [
            fila for fila in _dicts(columnas, crudas)
            if str(fila.get("cliente_id")) in persona["ids"]
            and "MANTENIMIENTO" not in str(fila.get("descripcion") or "").upper()
        ]
    tickets = _proyeccion(filas).get("tickets") or {}
    armadas = [_armar(fila, tickets) for fila in filas]
    vistos = {str(fila.get("venta_id")) for fila in filas if fila.get("venta_id") not in (None, "", 0, "0")}
    armadas.extend(_tickets_enlazados(persona, vistos))
    armadas.sort(key=lambda fila: (str(fila["fecha"]), int(fila["id"] or 0)), reverse=True)
    if len(_mov_armado) > 300:
        _mov_armado.clear()
    _mov_armado[clave] = armadas
    return armadas


def resumen_cliente(pos_id, deuda: float | None = None) -> dict:
    movs = movimientos_de(pos_id)
    mantenimiento = round(sum(
        float(fila["mantenimiento"] or 0)
        for fila in movs
        if fila["tipo"] == "CARGO" and not fila["es_interes"] and not fila["borrado"] and not fila["cancelado"]
    ), 2)
    if deuda is None:
        deuda = movs[0]["saldo"] if movs else 0.0
    deuda = float(deuda or 0)
    if deuda <= 0.009:
        mantenimiento = 0.0
        total = deuda
    else:
        total = round(deuda + mantenimiento, 2)
    ventas = sum(fila["monto"] for fila in movs if fila["es_venta"] and not fila["borrado"] and not fila["cancelado"])
    manuales = sum(
        fila["monto"] for fila in movs
        if fila["tipo"] == "CARGO" and not fila["es_venta"] and not fila["es_interes"]
        and not fila["borrado"] and not fila["cancelado"]
    )
    cobros = sum(fila["monto"] for fila in movs if fila["es_cobro"])
    from app.services.pos_base import enlaces_de_persona

    nombres = sorted(enlaces_de_persona(pos_id)["nombres"])
    partes = []
    if len(nombres) > 1:
        partes.append("También figura como " + ", ".join(nombres[1:]))
    partes.append(f"{len(movs)} movimiento(s)")
    cargos = ventas + manuales
    if cargos:
        partes.append(f"Ventas: ${cargos:,.2f}")
    if cobros:
        partes.append(f"Cobros: ${cobros:,.2f}")
    return {
        "pos_id": int(pos_id) if str(pos_id).isdigit() else pos_id,
        "movimientos": movs,
        "resumen": "  ·  ".join(partes),
        "mantenimiento": mantenimiento,
        "deuda": round(deuda, 2),
        "total_estimado": round(total, 2),
        "ventas": round(ventas, 2),
        "manuales": round(manuales, 2),
        "cobros": round(cobros, 2),
    }


def _id_texto(valor) -> str:
    texto = str(valor or "").strip()
    return texto[:-2] if texto.endswith(".0") else texto


def _tomar(fila: list, idx: dict, *nombres: str):
    for nombre in nombres:
        i = idx.get(nombre)
        if i is not None and i < len(fila):
            return fila[i]
    return None


def _items_del_ticket(venta_id: str) -> list[dict]:
    for tabla in ("detalles_ventas", "detalle_ventas", "ventas_items"):
        columnas, filas = filas_de(tabla)
        if not columnas:
            continue
        idx = {str(col).lower(): i for i, col in enumerate(columnas)}
        enlace = next((nombre for nombre in ("venta_id", "id_venta", "ticket_id", "venta") if nombre in idx), "")
        items = []
        for fila in filas:
            if enlace and _id_texto(_tomar(fila, idx, enlace)) != venta_id:
                continue
            nombre = str(_tomar(fila, idx, "nombre_producto", "nombre", "producto", "descripcion", "corte") or "").strip()
            if not nombre:
                continue
            items.append({
                "nombre": nombre,
                "cantidad": _num(_tomar(fila, idx, "cantidad", "kilos", "peso", "cant")),
                "precio": _num(_tomar(fila, idx, "precio_unitario", "precio")),
                "subtotal": _num(_tomar(fila, idx, "subtotal", "total", "monto")),
            })
        if items:
            return items
    return []


def ticket_de(venta_id) -> dict:
    buscado = _id_texto(venta_id).lstrip("#")
    if not buscado:
        return {"encontrado": False, "id": ""}
    columnas, filas = filas_de("ventas")
    idx = {str(col).lower(): i for i, col in enumerate(columnas)}
    venta = next((fila for fila in filas if _id_texto(_tomar(fila, idx, "id")) == buscado), None)
    if venta is None:
        return {"encontrado": False, "id": buscado}
    return {
        "encontrado": True,
        "id": buscado,
        "fecha": str(_tomar(venta, idx, "fecha") or "").split(".")[0],
        "total": _num(_tomar(venta, idx, "total")),
        "pago": str(_tomar(venta, idx, "metodo_pago", "medio_pago") or "—"),
        "estado": str(_tomar(venta, idx, "estado") or ""),
        "usuario": str(_tomar(venta, idx, "usuario") or ""),
        "caja": _id_texto(_tomar(venta, idx, "caja_id")) or "1",
        "cliente": str(_tomar(venta, idx, "cliente_nombre") or ""),
        "descuento": _num(_tomar(venta, idx, "descuento")),
        "recargo": _num(_tomar(venta, idx, "recargo")),
        "items": _items_del_ticket(buscado),
    }


def resumen_todos() -> list[dict]:
    columnas, crudas = filas_de("cuenta_corriente")
    ids = sorted({
        fila.get("cliente_id")
        for fila in _dicts(columnas, crudas)
        if fila.get("cliente_id") not in (None, "")
    }, key=lambda valor: int(valor) if str(valor).isdigit() else 0)
    salida = []
    for pos_id in ids:
        dato = resumen_cliente(pos_id)
        salida.append({
            "pos_id": dato["pos_id"],
            "mantenimiento": dato["mantenimiento"],
            "deuda": dato["deuda"],
            "total_estimado": dato["total_estimado"],
            "movimientos": len(dato["movimientos"]),
        })
    return salida


_TOPE_LISTA = 400


def es_credito(filtro: str) -> bool:
    return str(filtro or "").strip().upper() in ("CRÉDITO", "CREDITO", "FIADO", "CLIENTES")


def _minutos(hm: str | None):
    if not hm:
        return None
    try:
        partes = str(hm).strip().replace(".", ":").split(":")
        return int(partes[0]) * 60 + int(partes[1] if len(partes) > 1 else 0)
    except (TypeError, ValueError, IndexError):
        return None


def _dia_iso(valor) -> str:
    texto = str(valor or "").strip().replace("T", " ")
    return texto[:10] if len(texto) >= 10 and texto[4] == "-" else ""


def _hora_minutos(valor):
    texto = str(valor or "").strip().replace("T", " ")
    if len(texto) < 16 or texto[13] != ":":
        return None
    try:
        return int(texto[11:13]) * 60 + int(texto[14:16])
    except ValueError:
        return None


def rango_fechas(alcance: str, fecha: str, historico: bool, hoy: str) -> tuple[str | None, str | None]:
    """Día, semana o mes del calendario. El histórico no recorta fechas."""
    if historico:
        return None, None
    nombre = str(alcance or "").lower()
    dia = _dia_iso(fecha) or hoy
    if nombre == "mes":
        anio, mes = int(dia[:4]), int(dia[5:7])
        import calendar
        ultimo = calendar.monthrange(anio, mes)[1]
        return f"{anio:04d}-{mes:02d}-01", f"{anio:04d}-{mes:02d}-{ultimo:02d}"
    if nombre == "semana":
        base = date.fromisoformat(dia)
        lunes = base - timedelta(days=base.weekday())
        return lunes.isoformat(), base.isoformat()
    return dia, dia


def _libro_vacio(sucursal_id: int | None) -> dict:
    """El período no tiene filas. Si la tabla existe, el libro ya llegó."""
    return {
        "libro": hay_tabla("ventas", sucursal_id),
        "tickets": [],
        "filtrado": 0.0,
        "tickets_ok": 0,
        "cajas": [],
        "medios": [],
        "recorte": False,
    }


def evaluar_ticket(
    venta: dict,
    nombres: str = "",
    *,
    texto: str = "",
    metodo: str = "TODOS",
    caja: str = "",
    hora_desde: str = "00:00",
    hora_hasta: str = "23:59",
    fecha_ini: str | None = None,
    fecha_fin: str | None = None,
) -> tuple[bool, float]:
    """Misma regla que el historial de Cobro Fácil. El segundo valor entra en la suma."""
    dia = _dia_iso(venta.get("fecha"))
    if fecha_ini and (not dia or dia < fecha_ini or dia > (fecha_fin or fecha_ini)):
        return False, 0.0
    m0 = _minutos(hora_desde)
    m1 = _minutos(hora_hasta)
    if m0 is not None and m1 is not None and not (m0 == 0 and m1 >= 23 * 60 + 59):
        mins = _hora_minutos(venta.get("fecha"))
        if mins is not None and not (m0 <= mins <= m1):
            return False, 0.0
    pago = str(venta.get("metodo_pago") or "").upper()
    metodo_u = (metodo or "TODOS").upper()
    credito = es_credito(metodo_u)
    descuento = _num(venta.get("descuento"))
    recargo = _num(venta.get("recargo"))
    aporte = None
    if metodo_u == "REDONDEO":
        if descuento <= 0:
            return False, 0.0
    elif metodo_u == "RECARGO":
        if recargo <= 0:
            return False, 0.0
    elif metodo_u != "TODOS":
        if pago.startswith("MIXTO"):
            if metodo_u == "EFECTIVO":
                aporte = _num(venta.get("pago_efectivo")) - _num(venta.get("cambio"))
                if aporte <= 0:
                    return False, 0.0
            else:
                if credito and "CLIENTE" not in pago and "FIADO" not in pago:
                    return False, 0.0
                if not credito and "CLIENTE" in pago:
                    return False, 0.0
                if not credito and "(" in pago and metodo_u not in pago:
                    return False, 0.0
                otro = _num(venta.get("pago_otro"))
                tot = _num(venta.get("total"))
                # Si pago_otro excede el total, contiene un número de referencia/código de barras, no un monto
                aporte = min(otro, tot) if (otro > 0 and tot > 0) else otro
            if aporte <= 0:
                return False, 0.0
        elif credito:
            if pago not in ("FIADO", "CLIENTES"):
                return False, 0.0
        elif metodo_u not in pago:
            return False, 0.0
    if str(caja or "").strip():
        try:
            if int(float(venta.get("caja_id") or 1)) != int(float(caja)):
                return False, 0.0
        except (TypeError, ValueError):
            pass
    busqueda = (texto or "").strip().lower()
    if busqueda:
        pool = (
            f"{venta.get('id')} {venta.get('usuario') or ''} {venta.get('fecha') or ''} "
            f"{venta.get('metodo_pago') or ''} {venta.get('total') or ''} {nombres or ''}"
        ).lower()
        if busqueda not in pool:
            return False, 0.0
    cancelada = str(venta.get("estado") or "").upper().startswith("CANCELAD")
    if cancelada:
        return True, 0.0
    if aporte is not None:
        return True, float(aporte)
    return True, _num(venta.get("total"))


def historial_ventas(sucursal_id: int | None, filtro: dict | None, hoy: str) -> dict:
    """Lista del historial. La suma no cuenta canceladas ni la parte de un mixto que no pidieron."""
    pedido = filtro or {}
    if pedido.get("fecha_ini"):
        ini = str(pedido.get("fecha_ini"))[:10]
        fin = str(pedido.get("fecha_fin") or ini)[:10]
    else:
        ini, fin = rango_fechas(
            str(pedido.get("alcance") or "dia"),
            str(pedido.get("fecha") or ""),
            bool(pedido.get("historico")),
            hoy,
        )
    if ini and fin:
        columnas, filas = filas_de("ventas", sucursal_id, desde=ini, hasta=fin)
    else:
        columnas, filas = filas_de("ventas", sucursal_id)
    if not columnas:
        return _libro_vacio(sucursal_id)
    idx = {str(col).lower(): i for i, col in enumerate(columnas)}
    texto = str(pedido.get("texto") or "")
    nombres: dict[str, str] = {}
    if texto.strip():
        dcols, dfilas = filas_de("detalles_ventas", sucursal_id)
        didx = {str(col).lower(): i for i, col in enumerate(dcols)}
        enlace = next((nombre for nombre in ("id_venta", "venta_id", "ticket_id", "venta") if nombre in didx), "")
        nombre_col = next((nombre for nombre in ("nombre_producto", "nombre", "producto") if nombre in didx), "")
        if enlace and nombre_col:
            for fila in dfilas:
                vid = _id_texto(_tomar(fila, didx, enlace))
                nombre = str(_tomar(fila, didx, nombre_col) or "").strip()
                if vid and nombre:
                    nombres[vid] = (nombres.get(vid, "") + " " + nombre).strip()
    cajas = set()
    elegidas = []
    medios: dict[str, dict] = {}
    suma = 0.0
    ok = 0
    for fila in filas:
        venta = {
            "id": _id_texto(_tomar(fila, idx, "id")),
            "fecha": str(_tomar(fila, idx, "fecha") or "").split(".")[0],
            "total": _num(_tomar(fila, idx, "total")),
            "usuario": str(_tomar(fila, idx, "usuario") or ""),
            "estado": str(_tomar(fila, idx, "estado") or ""),
            "metodo_pago": str(_tomar(fila, idx, "metodo_pago", "medio_pago") or "Efectivo"),
            "descuento": _num(_tomar(fila, idx, "descuento")),
            "recargo": _num(_tomar(fila, idx, "recargo")),
            "caja_id": _tomar(fila, idx, "caja_id"),
            "pago_efectivo": _num(_tomar(fila, idx, "pago_efectivo")),
            "pago_otro": _num(_tomar(fila, idx, "pago_otro")),
            "cambio": _num(_tomar(fila, idx, "cambio")),
            "cliente_nombre": str(_tomar(fila, idx, "cliente_nombre") or ""),
        }
        try:
            cajas.add(int(float(venta["caja_id"] or 1)))
        except (TypeError, ValueError):
            cajas.add(1)
        mostrar, aporte = evaluar_ticket(
            venta,
            nombres.get(venta["id"], ""),
            texto=texto,
            metodo=str(pedido.get("metodo") or "TODOS"),
            caja=str(pedido.get("caja") or ""),
            hora_desde=str(pedido.get("hora_desde") or "00:00"),
            hora_hasta=str(pedido.get("hora_hasta") or "23:59"),
            fecha_ini=ini,
            fecha_fin=fin,
        )
        if not mostrar:
            continue
        suma += aporte
        if not str(venta["estado"] or "").upper().startswith("CANCELAD"):
            ok += 1
            medio = str(venta["metodo_pago"] or "Efectivo").strip() or "Efectivo"
            slot = medios.setdefault(medio, {"medio": medio, "monto": 0.0, "tickets": 0})
            slot["monto"] += float(aporte or 0)
            slot["tickets"] += 1
        elegidas.append(venta)
    elegidas.sort(key=lambda item: (item["fecha"], item["id"]), reverse=True)
    offset = max(0, int(pedido.get("offset") or 0))
    limite = max(1, int(pedido.get("limite") or _TOPE_LISTA))
    recorte = len(elegidas) > (offset + limite)
    visibles = elegidas[offset : offset + limite]
    return {
        "libro": True,
        "tickets": [
            {
                "id": item["id"],
                "fecha": item["fecha"],
                "total": round(item["total"], 2),
                "pago": item["metodo_pago"],
                "estado": item["estado"],
                "caja": _id_texto(item["caja_id"]) or "1",
                "cliente": item["cliente_nombre"],
            }
            for item in visibles
        ],
        "filtrado": round(suma, 2),
        "tickets_ok": ok,
        "cajas": sorted(cajas),
        "medios": sorted(
            (
                {"medio": item["medio"], "monto": round(item["monto"], 2), "tickets": item["tickets"]}
                for item in medios.values()
            ),
            key=lambda item: item["monto"],
            reverse=True,
        ),
        "recorte": recorte,
        "hay_mas": recorte,
        "offset": offset,
        "limite": limite,
    }


def _medida(es_pesable, unidad) -> str:
    marca = str(es_pesable or "").strip().lower()
    if marca in ("1", "true", "t", "si", "sí"):
        return "kg"
    texto = str(unidad or "").strip().lower()
    if texto in ("kg", "kilo", "kilos"):
        return "kg"
    if texto in ("lt", "l", "litro", "litros"):
        return "lt"
    if texto in ("m", "metro", "metros"):
        return "m"
    if texto in ("g", "gramo", "gramos"):
        return "g"
    return "un"


def desglose_articulos(sucursal_id: int | None, fecha_ini: str, fecha_fin: str) -> dict:
    """Suma los cortes de las ventas cerradas del rango. La cancelada no entra."""
    ini = str(fecha_ini or "")[:10]
    fin = str(fecha_fin or ini)[:10]
    if ini and fin and ini > fin:
        ini, fin = fin, ini
    if ini and fin:
        columnas, filas = filas_de("ventas", sucursal_id, desde=ini, hasta=fin)
    else:
        columnas, filas = filas_de("ventas", sucursal_id)
    if not columnas:
        return {
            "libro": hay_tabla("ventas", sucursal_id),
            "filas": [],
            "articulos": 0,
            "kilos": 0.0,
            "unidades": 0.0,
            "monto": 0.0,
            "tickets": 0,
        }
    idx = {str(col).lower(): i for i, col in enumerate(columnas)}
    vivas: set[str] = set()
    for fila in filas:
        estado = str(_tomar(fila, idx, "estado") or "").strip().upper()
        if estado.startswith("CANCELAD"):
            continue
        dia = _dia_iso(_tomar(fila, idx, "fecha"))
        if ini and (not dia or dia < ini or dia > fin):
            continue
        vid = _id_texto(_tomar(fila, idx, "id"))
        if not vid:
            continue
        suc = _id_texto(_tomar(fila, idx, "sucursal_id"))
        vivas.add(suc + ":" + vid)
    if not vivas:
        return {"libro": True, "filas": [], "articulos": 0, "kilos": 0.0, "unidades": 0.0, "monto": 0.0, "tickets": 0}

    pcols, pfilas = filas_de("productos", sucursal_id)
    if not pcols:
        pcols, pfilas = filas_de("articulos", sucursal_id)
    pidx = {str(col).lower(): i for i, col in enumerate(pcols)}
    productos: dict[str, tuple] = {}
    for fila in pfilas:
        pid = _id_texto(_tomar(fila, pidx, "id"))
        if not pid:
            continue
        suc = _id_texto(_tomar(fila, pidx, "sucursal_id"))
        productos[suc + ":" + pid] = (
            _tomar(fila, pidx, "es_pesable"),
            _tomar(fila, pidx, "unidad", "unidad_medida"),
        )

    if ini and fin:
        dcols, dfilas = filas_de("detalles_ventas", sucursal_id, desde=ini, hasta=fin)
        if not dcols:
            dcols, dfilas = filas_de("detalle_ventas", sucursal_id, desde=ini, hasta=fin)
    else:
        dcols, dfilas = filas_de("detalles_ventas", sucursal_id)
        if not dcols:
            dcols, dfilas = filas_de("detalle_ventas", sucursal_id)
    didx = {str(col).lower(): i for i, col in enumerate(dcols)}
    enlace = next((nombre for nombre in ("id_venta", "venta_id", "ticket_id", "venta") if nombre in didx), "")
    grupos: dict[str, dict] = {}
    for fila in dfilas:
        if not enlace:
            break
        vid = _id_texto(_tomar(fila, didx, enlace))
        suc = _id_texto(_tomar(fila, didx, "sucursal_id"))
        if suc + ":" + vid not in vivas:
            continue
        nombre = str(_tomar(fila, didx, "nombre_producto", "nombre", "producto", "descripcion", "corte") or "").strip()
        if not nombre:
            continue
        pid = _id_texto(_tomar(fila, didx, "id_producto", "producto_id"))
        ficha = productos.get(suc + ":" + pid)
        if ficha:
            medida = _medida(ficha[0], ficha[1])
        else:
            medida = _medida(
                _tomar(fila, didx, "es_pesable"),
                _tomar(fila, didx, "unidad", "unidad_medida"),
            )
        slot = grupos.setdefault(nombre, {"nombre": nombre, "cantidad": 0.0, "monto": 0.0, "medida": medida})
        if medida == "kg":
            slot["medida"] = "kg"
        slot["cantidad"] += _num(_tomar(fila, didx, "cantidad", "kilos", "peso", "cant"))
        slot["monto"] += _num(_tomar(fila, didx, "subtotal", "total", "monto"))
    filas_out = sorted(grupos.values(), key=lambda item: item["cantidad"], reverse=True)
    kilos = 0.0
    unidades = 0.0
    monto = 0.0
    salida = []
    for item in filas_out:
        cant = round(item["cantidad"], 3)
        plata = round(item["monto"], 2)
        monto += plata
        if item["medida"] == "kg":
            kilos += cant
        else:
            unidades += cant
        salida.append({
            "nombre": item["nombre"],
            "cantidad": cant,
            "monto": plata,
            "medida": item["medida"],
        })
    return {
        "libro": True,
        "filas": salida,
        "articulos": len(salida),
        "kilos": round(kilos, 3),
        "unidades": round(unidades, 3),
        "monto": round(monto, 2),
        "tickets": len(vivas),
    }
