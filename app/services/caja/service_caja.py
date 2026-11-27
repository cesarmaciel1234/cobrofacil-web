"""
Cerebro de Caja y Arqueo Diario (app/services/caja/service_caja.py).

Calcula el arqueo consolidado multi-sucursal:
- Ventas por medio de pago (Efectivo, Débito, Crédito, QR, etc.)
- Cobros de fiado (cuenta corriente) clasificados por medio
- Gastos de caja operativos
- Balance neto (resultado = ventas + cobros - gastos)

REGLA SAGRADA: Devuelve exclusivamente datos puros (dict, list, int, float, str).
Cero etiquetas HTML o estilos visuales.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Any

from app.services.pos_base import filas_de
from app.services.pos_historial import historial_ventas, rango_fechas

_ZONA = ZoneInfo("America/Argentina/Buenos_Aires")


def _indice(columnas: list) -> dict[str, int]:
    return {str(col).lower(): i for i, col in enumerate(columnas or [])}


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


def _dia(valor: Any) -> str:
    texto = str(valor or "").strip()
    return texto[:10] if len(texto) >= 10 else ""


def _filas_en_rango(
    tabla: str,
    ini: str | None,
    fin: str | None,
    sucursal_id: int | str | None = None,
) -> tuple[dict[str, int], list]:
    columnas, filas = filas_de(tabla, sucursal_id, desde=ini, hasta=fin)
    idx = _indice(columnas)
    if not ini and not fin:
        return idx, list(filas)
    desde = ini or ""
    hasta = fin or ini or "9999-99-99"
    return idx, [
        fila for fila in filas
        if (dia := _dia(_valor(fila, idx, "fecha"))) and desde <= dia <= hasta
    ]


def etiqueta_caja(pedido: dict, ini: str | None, fin: str | None, hoy: str) -> str:
    """Genera la etiqueta representativa del período de caja consultado."""
    if pedido.get("historico"):
        return "Todas"
    if str(pedido.get("alcance") or "dia").lower() == "mes":
        return "Mes · " + (ini or hoy)[:7]
    dia = ini or hoy
    return ("Hoy · " if dia == hoy else "Día · ") + dia


def obtener_contabilidad_caja(
    medios_pago: list[dict],
    ini: str | None,
    fin: str | None,
    sucursal_id: int | str | None,
    etiqueta: str,
) -> dict[str, Any]:
    """
    Consolida el arqueo de caja para una sucursal y rango de fechas dado.
    Calcula ventas por medio de pago, cobros de fiado, gastos y balance.
    """
    medios_lista = medios_pago or []
    total_medios = round(sum(_numero(m.get("monto") if m.get("monto") is not None else m.get("total")) for m in medios_lista), 2)
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
    etiq = str(etiqueta or "").strip().lower()
    if etiq.startswith("hoy") or etiq.startswith("día") or etiq.startswith("dia"):
        hoy_real = datetime.now(_ZONA).date().isoformat()
        corte_ini = min(ini, hoy_real) if ini else hoy_real
        corte_fin = max(fin, hoy_real) if fin else hoy_real

    # 1. Cobros de fiado (abonos en cuenta corriente)
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

    if cobros > 0 and not cobros_por_medio:
        cobros_por_medio["Efectivo"] = {"monto": round(cobros, 2), "cant": len(detalle_cobros) or 1}

    # 2. Gastos operativos
    idx_g, gastos = _filas_en_rango("gastos", corte_ini, corte_fin, sucursal_id)
    lista_gastos = []
    total_gastos = 0.0
    for fila in gastos:
        estado = str(_valor(fila, idx_g, "status", "estado") or "").upper()
        if estado in ("ANULADO", "CANCELADO", "RECHAZADO"):
            continue
        monto = _numero(_valor(fila, idx_g, "monto"))
        total_gastos += monto
        lista_gastos.append({
            "categoria": str(_valor(fila, idx_g, "categoria") or "Gasto"),
            "detalle": str(_valor(fila, idx_g, "descripcion") or ""),
            "monto": round(monto, 2),
        })

    # 3. Movimientos directos de caja
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


def armar_panel_caja(
    sucursal_id: int | str | None = None,
    periodo: str = "Hoy",
    desde: str | None = None,
    hasta: str | None = None,
    filtro: dict | None = None,
    sucursales_disp: list[dict] | None = None,
) -> dict[str, Any]:
    """
    Construye la respuesta completa del panel 'contabilidad' / 'caja'.
    Resuelve el rango temporal solicitado y compila el arqueo diario.
    """
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

    if pedido.get("fecha"):
        ini, fin = rango_fechas(
            str(pedido.get("alcance") or "dia"),
            str(pedido.get("fecha") or ""),
            bool(pedido.get("historico")),
            hoy,
        )
        pedido["fecha_ini"] = ini
        pedido["fecha_fin"] = fin
        etiqueta = etiqueta_caja(pedido, ini, fin, hoy)
    elif pedido.get("periodo"):
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
            ini, fin = hoy, hoy
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
        etiqueta = etiqueta_caja(pedido, ini, fin, hoy)

    libro = historial_ventas(sucursal_id, pedido, hoy)

    return {
        "ok": True,
        "libro": True,
        "panel": "contabilidad",
        "resumen": {"dia": ini, "es_hoy": (ini == hoy)},
        "cartera": {},
        "contabilidad": obtener_contabilidad_caja(
            libro.get("medios") or [],
            ini,
            fin,
            sucursal_id,
            etiqueta,
        ),
        "desglose_sucursales": [],
        "sucursales": sucursales_disp or [],
        "sucursal_id": sucursal_id,
    }
