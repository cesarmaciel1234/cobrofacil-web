"""La nube arma el nodo. Cada PWA lo copia en segundo plano y la cara lee esa copia."""
from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

from app.services.pos_base import _ambito_cache, ultimo_dia_ventas
from app.database import get_db

logger = logging.getLogger(__name__)

_PANELES = {
    "reporte": "reporte",
    "contabilidad": "contabilidad",
    "caja": "contabilidad",
    "ticket": "ticket",
    "ventas": "ticket",
    "desglose": "desglose",
    "cartera": "admin",
    "admin": "admin",
    "digitales": "digitales",
    "pedidos": "pedidos",
    "proveedor": "proveedor",
}

def filtro_de(pieza: str, valores: dict | None) -> dict | None:
    """El mismo pedido que arma la ruta, para que la copia caliente coincida con la PWA."""
    if pieza not in ("ticket", "ventas", "desglose", "contabilidad", "caja"):
        return None
    datos = valores or {}
    filtro = {
        "texto": datos.get("q") or "",
        "metodo": datos.get("pago") or "TODOS",
        "alcance": datos.get("alcance") or "dia",
        "fecha": datos.get("fecha") or "",
        "fecha_ini": datos.get("fecha_ini") or "",
        "fecha_fin": datos.get("fecha_fin") or "",
        "historico": str(datos.get("historico") or "") in ("1", "true", "si"),
        "hora_desde": datos.get("hora_desde") or "00:00",
        "hora_hasta": datos.get("hora_hasta") or "23:59",
        "caja": datos.get("caja") or "",
        "offset": int(datos.get("offset") or 0),
        "limite": int(datos.get("limite") or 400),
    }
    if datos.get("periodo"):
        filtro["periodo"] = datos.get("periodo")
        filtro["desde"] = datos.get("desde") or ""
        filtro["hasta"] = datos.get("hasta") or ""
    return filtro


_BASE = (
    ("reporte", "Hoy", None, None, None),
    ("contabilidad", "Hoy", None, None, filtro_de("contabilidad", {"periodo": "Hoy"})),
    ("ticket", "Hoy", None, None, filtro_de("ticket", {"alcance": "mes"})),
    ("cartera", "Hoy", None, None, None),
)

_lock = threading.Lock()
_candados: dict[tuple, threading.Lock] = {}
_copias: dict[tuple, tuple[str, dict]] = {}
_hilo: threading.Thread | None = None
_empresa_caliente = 1


def _candado(clave: tuple) -> threading.Lock:
    with _lock:
        candado = _candados.get(clave)
        if candado is None:
            candado = threading.Lock()
            _candados[clave] = candado
        return candado


def _marca(sucursal_id: int | None) -> tuple[str, str]:
    sid = int(sucursal_id) if sucursal_id is not None else None
    with get_db() as conn:
        if sid is None:
            fila = conn.execute("SELECT MAX(actualizado_en) FROM pos_base").fetchone()
        else:
            fila = conn.execute(
                "SELECT MAX(actualizado_en) FROM pos_base WHERE sucursal_id = ?",
                (sid,),
            ).fetchone()
    sello = str((fila[0] if fila else "") or "")
    return sello, ultimo_dia_ventas(sid)


def _clave(
    pieza: str,
    sucursal_id: int | None,
    periodo: str,
    desde: str | None,
    hasta: str | None,
    filtro: dict | None,
) -> tuple:
    return (
        _ambito_cache(),
        pieza,
        int(sucursal_id) if sucursal_id is not None else None,
        periodo or "",
        desde or "",
        hasta or "",
        json.dumps(filtro or {}, sort_keys=True, default=str, ensure_ascii=False),
    )


def estado(sucursal_id: int | None = None) -> dict[str, Any]:
    """Sello del libro y qué piezas ya están armadas. No calcula los paneles."""
    sello, dia = _marca(sucursal_id)
    ambito = _ambito_cache()
    sid = int(sucursal_id) if sucursal_id is not None else None
    with _lock:
        piezas = sorted({
            clave[1]
            for clave, (marca, _dato) in _copias.items()
            if clave[0] == ambito and clave[2] == sid and marca == sello
        })
    return {"ok": True, "sello": sello, "dia": dia, "piezas": piezas}


def _armar(
    pieza: str,
    sucursal_id: int | None,
    periodo: str,
    desde: str | None,
    hasta: str | None,
    filtro: dict | None,
) -> dict:
    from app.services.pos_jefe import panel

    nombre = _PANELES.get(pieza)
    if not nombre:
        raise ValueError("Pieza desconocida")
    return panel(
        nombre,
        sucursal_id=sucursal_id,
        periodo=periodo or "Hoy",
        desde=desde,
        hasta=hasta,
        filtro=filtro,
    )


def leer(
    pieza: str,
    sucursal_id: int | None = None,
    periodo: str = "Hoy",
    desde: str | None = None,
    hasta: str | None = None,
    filtro: dict | None = None,
) -> dict[str, Any]:
    """Devuelve la pieza ya armada. Si el sello cambió, la vuelve a armar."""
    nombre = (pieza or "").strip().lower()
    if nombre not in _PANELES:
        raise ValueError("Pieza desconocida")
    sello, dia = _marca(sucursal_id)
    clave = _clave(nombre, sucursal_id, periodo, desde, hasta, filtro)
    with _lock:
        guardada = _copias.get(clave)
    if guardada and guardada[0] == sello:
        return guardada[1]
    with _candado(clave):
        with _lock:
            guardada = _copias.get(clave)
        if guardada and guardada[0] == sello:
            return guardada[1]
        dato = _armar(nombre, sucursal_id, periodo, desde, hasta, filtro)
        dato["nodo"] = {"sello": sello, "dia": dia, "pieza": nombre}
        with _lock:
            _copias[clave] = (sello, dato)
        return dato


def alimentar() -> None:
    """Arma primero el reporte y después el resto. Un sello igual no vuelve a calcular."""
    sello, _dia = _marca(None)
    ambito = _ambito_cache()
    with _lock:
        ya = any(
            clave[0] == ambito and clave[1] == "reporte" and marca == sello
            for clave, (marca, _dato) in _copias.items()
        )
    if ya and sello:
        return
    for pieza, periodo, desde, hasta, filtro in _BASE:
        try:
            leer(pieza, None, periodo, desde, hasta, filtro)
        except Exception as exc:
            logger.warning("nodo %s no se armó: %s", pieza, type(exc).__name__)


def arrancar(app) -> None:
    """Hilo de la nube. En los tests no corre."""
    global _hilo
    if app.config.get("TESTING"):
        return
    if app.debug and __import__("os").environ.get("WERKZEUG_RUN_MAIN") != "true":
        return
    with _lock:
        if _hilo and _hilo.is_alive():
            return

        def ciclo() -> None:
            time.sleep(2)
            while True:
                try:
                    with app.app_context():
                        with app.test_request_context("/api/pos/nodo"):
                            from flask import session

                            session["empresa_id"] = _empresa_caliente
                            alimentar()
                except Exception as exc:
                    logger.warning("nodo en pausa: %s", type(exc).__name__)
                time.sleep(5)

        _hilo = threading.Thread(target=ciclo, name="nodo-espejo", daemon=True)
        _hilo.start()
