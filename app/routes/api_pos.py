"""
API de integración con servidor POS (TPV Pro 2026).

Endpoints para recibir datos del servidor POS:
- POST /api/pos/clientes - Sincronizar un cliente individual
- POST /api/pos/clientes/lote - Sincronizar un lote de clientes
- POST /api/pos/proveedores - Sincronizar un proveedor individual
- POST /api/pos/proveedores/lote - Sincronizar un lote de proveedores
- GET /api/pos/clientes - Exportar clientes en formato POS
- GET /api/pos/proveedores - Exportar proveedores en formato POS
- GET /api/pos/config - Obtener configuración de integración
- PUT /api/pos/config - Actualizar configuración de integración
- GET /api/pos/sync/logs - Obtener historial de sincronización
- GET /api/pos/sync/status - Obtener estado de última sincronización
"""
from flask import jsonify, request, session

from app.routes.api import api_bp
from app.services.pos_config import (
    get_pos_config,
    get_last_sync_status,
    get_sync_logs,
    log_sync_complete,
    log_sync_start,
    update_last_sync,
    update_pos_config,
)
from app.services.pos_integration import (
    exportar_clientes_para_pos,
    exportar_proveedores_para_pos,
    sincronizar_cliente,
    sincronizar_lote_clientes,
    sincronizar_lote_proveedores,
    sincronizar_proveedor,
)


def _config_publica(config: dict) -> dict:
    salida = dict(config)
    clave = str(salida.get("api_key") or "")
    salida["api_key_configurada"] = bool(clave)
    salida["api_key"] = ""
    return salida


@api_bp.route("/pos/config", methods=["GET"])
def api_pos_config_get():
    """Obtiene la configuración actual de integración POS, sin la clave."""
    return jsonify(_config_publica(get_pos_config()))


@api_bp.route("/pos/config", methods=["PUT"])
def api_pos_config_update():
    """Actualiza la configuración de integración POS."""
    data = request.get_json(silent=True) or {}
    config = update_pos_config(
        server_url=data.get("server_url"),
        api_key=data.get("api_key"),
        sync_interval_minutes=data.get("sync_interval_minutes"),
        auto_sync=data.get("auto_sync"),
    )
    return jsonify(_config_publica(config))


@api_bp.route("/pos/clientes", methods=["POST"])
def api_pos_cliente_sync():
    """
    Sincroniza un cliente individual desde el POS al CRM.

    Body esperado:
    {
        "nombre": "Juan Pérez",
        "telefono": "11-1234-5678",
        "direccion": "Calle Falsa 123",
        "cuit": "20-12345678-9",
        "email": "juan@email.com",
        "saldo": 15000.50,
        "limite_credito": 500000.0
    }
    """
    data = request.get_json(silent=True) or {}
    if not data:
        return jsonify({"error": "No se recibieron datos"}), 400

    log_id = log_sync_start("clientes", "push")

    try:
        resultado = sincronizar_cliente(data)
        if resultado.get("ok"):
            log_sync_complete(
                log_id,
                "success",
                records_processed=1,
                records_success=1,
                records_error=0,
            )
            update_last_sync()
            return jsonify(resultado)
        else:
            log_sync_complete(
                log_id,
                "error",
                records_processed=1,
                records_success=0,
                records_error=1,
                error_message=resultado.get("error"),
            )
            return jsonify(resultado), 400
    except Exception as e:
        log_sync_complete(
            log_id,
            "error",
            records_processed=1,
            records_success=0,
            records_error=1,
            error_message=str(e),
        )
        return jsonify({"error": str(e)}), 500


@api_bp.route("/pos/clientes/lote", methods=["POST"])
def api_pos_clientes_lote_sync():
    """
    Sincroniza un lote de clientes desde el POS al CRM.

    Body esperado:
    {
        "clientes": [
            { "nombre": "Juan Pérez", ... },
            { "nombre": "María López", ... }
        ]
    }
    """
    data = request.get_json(silent=True) or {}
    clientes = data.get("clientes", [])

    if not isinstance(clientes, list):
        return jsonify({"error": "clientes debe ser una lista"}), 400

    sucursal_id = data.get("sucursal_id")
    sucursal_nombre = data.get("sucursal") or data.get("sucursal_nombre")
    for cliente in clientes:
        if not isinstance(cliente, dict):
            continue
        if sucursal_id not in (None, "") and cliente.get("sucursal_id") in (None, ""):
            cliente["sucursal_id"] = sucursal_id
        if sucursal_nombre and not cliente.get("sucursal") and not cliente.get("sucursal_nombre"):
            cliente["sucursal"] = sucursal_nombre

    log_id = log_sync_start("clientes", "push")

    try:
        resultado = sincronizar_lote_clientes(clientes)
        log_sync_complete(
            log_id,
            "success" if not resultado["errores"] else "partial",
            records_processed=resultado["total"],
            records_success=resultado["creados"] + resultado["actualizados"],
            records_error=len(resultado["errores"]),
        )
        update_last_sync()
        return jsonify(resultado)
    except Exception as e:
        log_sync_complete(
            log_id,
            "error",
            records_processed=len(clientes),
            records_success=0,
            records_error=len(clientes),
            error_message=str(e),
        )
        return jsonify({"error": str(e)}), 500


@api_bp.route("/pos/proveedores", methods=["POST"])
def api_pos_proveedor_sync():
    """
    Sincroniza un proveedor individual desde el POS al CRM.

    Body esperado:
    {
        "nombre": "Frigorífico XYZ",
        "cuit": "30-98765432-1",
        "telefono": "11-9876-5432",
        "limite_credito": 1000000.0
    }
    """
    data = request.get_json(silent=True) or {}
    if not data:
        return jsonify({"error": "No se recibieron datos"}), 400

    log_id = log_sync_start("proveedores", "push")

    try:
        resultado = sincronizar_proveedor(data)
        if resultado.get("ok"):
            log_sync_complete(
                log_id,
                "success",
                records_processed=1,
                records_success=1,
                records_error=0,
            )
            update_last_sync()
            return jsonify(resultado)
        else:
            log_sync_complete(
                log_id,
                "error",
                records_processed=1,
                records_success=0,
                records_error=1,
                error_message=resultado.get("error"),
            )
            return jsonify(resultado), 400
    except Exception as e:
        log_sync_complete(
            log_id,
            "error",
            records_processed=1,
            records_success=0,
            records_error=1,
            error_message=str(e),
        )
        return jsonify({"error": str(e)}), 500


@api_bp.route("/pos/proveedores/lote", methods=["POST"])
def api_pos_proveedores_lote_sync():
    """
    Sincroniza un lote de proveedores desde el POS al CRM.

    Body esperado:
    {
        "proveedores": [
            { "nombre": "Frigorífico XYZ", ... },
            { "nombre": "Carnes ABC", ... }
        ]
    }
    """
    data = request.get_json(silent=True) or {}
    proveedores = data.get("proveedores", [])

    if not isinstance(proveedores, list):
        return jsonify({"error": "proveedores debe ser una lista"}), 400

    log_id = log_sync_start("proveedores", "push")

    try:
        resultado = sincronizar_lote_proveedores(proveedores)
        log_sync_complete(
            log_id,
            "success" if not resultado["errores"] else "partial",
            records_processed=resultado["total"],
            records_success=resultado["creados"] + resultado["actualizados"],
            records_error=len(resultado["errores"]),
        )
        update_last_sync()
        return jsonify(resultado)
    except Exception as e:
        log_sync_complete(
            log_id,
            "error",
            records_processed=len(proveedores),
            records_success=0,
            records_error=len(proveedores),
            error_message=str(e),
        )
        return jsonify({"error": str(e)}), 500


@api_bp.route("/pos/clientes", methods=["GET"])
def api_pos_clientes_export():
    """
    Exporta clientes del CRM en formato compatible con el POS.

    Útil para sincronización bidireccional.
    """
    clientes = exportar_clientes_para_pos()
    return jsonify({"clientes": clientes, "total": len(clientes)})


@api_bp.route("/pos/proveedores", methods=["GET"])
def api_pos_proveedores_export():
    """
    Exporta proveedores del CRM en formato compatible con el POS.

    Útil para sincronización bidireccional.
    """
    proveedores = exportar_proveedores_para_pos()
    return jsonify({"proveedores": proveedores, "total": len(proveedores)})


@api_bp.route("/pos/novedades", methods=["GET"])
def api_pos_novedades():
    """Los tickets nuevos desde la última bajada. Sin marca, no manda el libro."""
    from app.services.pos_base import novedades_desde

    sucursal = request.args.get("sucursal_id", type=int)
    if sucursal is None:
        sucursal = request.args.get("branch_id", type=int)
    return jsonify(novedades_desde(
        request.args.get("desde") or request.args.get("last_sync") or "",
        sucursal,
    ))


@api_bp.route("/pos/base", methods=["GET"])
def api_pos_base():
    """Lista las tablas de Cobro Fácil que ya están en la nube."""
    from app.services.pos_base import resumen_base

    tablas = resumen_base()
    return jsonify({
        "tablas": tablas,
        "cantidad": len(tablas),
        "filas": sum(item["filas"] for item in tablas),
    })


@api_bp.route("/pos/base/tabla", methods=["POST"])
def api_pos_base_tabla():
    """Guarda una parte de una tabla. La primera parte reemplaza la copia anterior."""
    from app.services.pos_base import guardar_parte

    data = request.get_json(silent=True) or {}
    try:
        resultado = guardar_parte(
            str(data.get("tabla") or ""),
            data.get("columnas") or [],
            data.get("filas") or [],
            data.get("parte") or 1,
            data.get("partes") or 1,
            data.get("sucursal_id") if data.get("sucursal_id") not in (None, "") else data.get("branch_id"),
            data.get("sucursal") or data.get("sucursal_nombre"),
            str(data.get("modo") or "reemplazo"),
            data.get("bajas") or [],
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    parte = int(data.get("parte") or 1)
    partes = int(data.get("partes") or 1)
    completo = str(data.get("modo") or "reemplazo") == "delta" or parte >= partes
    if completo and resultado.get("ok"):
        from app.services.signal_bus import broadcast_refresh

        broadcast_refresh(int(session.get("empresa_id") or 1), reason="libro")
    return jsonify(resultado)


@api_bp.route("/pos/historial", methods=["GET"])
def api_pos_historial():
    """Libro de cuenta de un cliente de Cobro Fácil, con días y mantenimiento."""
    from app.services.pos_historial import resumen_cliente, resumen_todos

    pos_id = request.args.get("pos_id")
    if not pos_id:
        return jsonify({"clientes": resumen_todos()})
    return jsonify(resumen_cliente(pos_id, request.args.get("deuda", type=float)))


@api_bp.route("/pos/ticket", methods=["GET"])
def api_pos_ticket():
    """Un ticket de venta del libro, con sus cortes si llegaron a la nube."""
    from app.services.pos_historial import ticket_de

    return jsonify(ticket_de(request.args.get("id")))


@api_bp.route("/pos/sync/logs", methods=["GET"])
def api_pos_sync_logs():
    """
    Obtiene el historial de sincronizaciones.

    Query params:
    - limit: Cantidad máxima de registros (default: 50)
    - offset: Cantidad de registros a saltar (default: 0)
    """
    limit = request.args.get("limit", 50, type=int)
    offset = request.args.get("offset", 0, type=int)
    logs = get_sync_logs(limit=limit, offset=offset)
    return jsonify({"logs": logs, "total": len(logs)})


@api_bp.route("/pos/empresas/resolver", methods=["GET"])
def api_pos_resolver_empresa():
    """El nombre con el que entra la empresa devuelve su número."""
    from app.database import get_db

    nombre = (request.args.get("nombre") or "").strip()
    if not nombre:
        return jsonify({"error": "Falta el nombre de la empresa"}), 400
    clave = nombre.casefold()
    with get_db(empresa_id=0) as conn:
        filas = conn.execute(
            "SELECT id, nombre, slug FROM empresas WHERE activo = 1"
        ).fetchall()
    exactas = [
        fila
        for fila in filas
        if str(fila["nombre"] or "").casefold() == clave
        or str(fila["slug"] or "").casefold() == clave
    ]
    if len(exactas) > 1:
        return jsonify({"error": "Hay más de una empresa con ese nombre"}), 409
    if len(exactas) == 1:
        elegida = exactas[0]
    else:
        parciales = [
            fila
            for fila in filas
            if clave in str(fila["nombre"] or "").casefold()
            or clave in str(fila["slug"] or "").casefold()
        ]
        if len(parciales) > 1:
            return jsonify({"error": "Hay más de una empresa con ese nombre"}), 409
        if not parciales:
            return jsonify({"error": "No está esa empresa"}), 404
        elegida = parciales[0]
    return jsonify(
        {"id": int(elegida["id"]), "nombre": elegida["nombre"], "slug": elegida["slug"]}
    )


@api_bp.route("/pos/jefe", methods=["GET"])
def api_pos_jefe():
    """Reporte, jefe, contabilidad, admin, proveedor, promedio o ticket. Con filtro multi-sucursal y período."""
    from app.services.pos_jefe import panel

    nombre = (request.args.get("panel") or "reporte").strip().lower()
    sucursal_id = request.args.get("sucursal_id", type=int)
    periodo = (request.args.get("periodo") or "Hoy").strip()
    desde = request.args.get("desde")
    hasta = request.args.get("hasta")
    filtro = None
    if nombre in ("ticket", "contabilidad"):
        filtro = {
            "texto": request.args.get("q") or "",
            "metodo": request.args.get("pago") or "TODOS",
            "alcance": request.args.get("alcance") or "dia",
            "fecha": request.args.get("fecha") or "",
            "historico": request.args.get("historico") in ("1", "true", "si"),
            "hora_desde": request.args.get("hora_desde") or "00:00",
            "hora_hasta": request.args.get("hora_hasta") or "23:59",
            "caja": request.args.get("caja") or "",
        }
        if nombre == "contabilidad" and request.args.get("periodo"):
            filtro["periodo"] = request.args.get("periodo")
            filtro["desde"] = request.args.get("desde") or ""
            filtro["hasta"] = request.args.get("hasta") or ""
    if nombre not in (
        "reporte", "jefe", "vitrina", "contabilidad", "admin", "cartera", "clientes",
        "digitales", "cobros_digitales", "pedidos", "abastecimiento",
        "proveedor", "promedio", "ticket", "desglose"
    ):
        return jsonify({"error": "Panel desconocido"}), 400
    return jsonify(panel(nombre, sucursal_id=sucursal_id, periodo=periodo, desde=desde, hasta=hasta, filtro=filtro))


@api_bp.route("/pos/sucursales", methods=["GET"])
def api_pos_sucursales():
    """Lista de sucursales activas registradas en la base espejo."""
    from app.services.pos_base import listar_sucursales

    return jsonify({"ok": True, "sucursales": listar_sucursales()})


@api_bp.route("/pos/sync/status", methods=["GET"])
def api_pos_sync_status():
    """
    Obtiene el estado de la última sincronización.

    Útil para mostrar en el dashboard.
    """
    status = get_last_sync_status()
    return jsonify(status)
