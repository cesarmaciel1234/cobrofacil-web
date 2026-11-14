"""Historial de cuenta de Cobro Fácil, leído de la copia en la nube."""
from __future__ import annotations

import re
from datetime import datetime

from app.services.pos_base import filas_de
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


def movimientos_de(pos_id) -> list[dict]:
    columnas, crudas = filas_de("cuenta_corriente")
    if not columnas:
        return []
    buscado = str(pos_id)
    filas = [
        fila for fila in _dicts(columnas, crudas)
        if str(fila.get("cliente_id")) == buscado
        and "MANTENIMIENTO" not in str(fila.get("descripcion") or "").upper()
    ]
    tickets = _proyeccion(filas).get("tickets") or {}
    armadas = [_armar(fila, tickets) for fila in filas]
    armadas.sort(key=lambda fila: (str(fila["fecha"]), int(fila["id"] or 0)), reverse=True)
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
    partes = [f"{len(movs)} movimiento(s)"]
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
