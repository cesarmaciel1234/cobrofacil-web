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
import time
from flask import current_app, jsonify, request, session

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
    from app.security import current_sucursal_id

    user_sid = current_sucursal_id()
    if user_sid is not None:
        sucursal = user_sid
    else:
        s_raw = request.args.get("sucursal_id") or request.args.get("branch_id")
        sucursal = int(s_raw) if s_raw and str(s_raw).isdigit() else None
    return jsonify(novedades_desde(
        request.args.get("desde") or request.args.get("last_sync") or "",
        sucursal,
    ))


@api_bp.route("/pos/espejo", methods=["GET"])
def api_pos_espejo():
    """Sello del libro. Cada aparato baja la tabla que todavía no tiene."""
    from app.services.pos_base import indice_espejo

    return jsonify(indice_espejo())


def _resolver_sid(sid_raw):
    if sid_raw is None:
        return None
    s = str(sid_raw).strip().lower()
    if s == "web" or s.startswith("web-") or s.startswith("web_"):
        return s
    if s.isdigit():
        return int(s)
    return None


@api_bp.route("/pos/nodo", methods=["GET"])
def api_pos_nodo():
    """Pieza ya armada del libro. La PWA la pide en segundo plano."""
    from app.services.nodo import estado, filtro_de, leer

    pieza = (request.args.get("pieza") or "estado").strip().lower()
    from app.security import current_sucursal_id
    user_sid = current_sucursal_id()
    if user_sid is not None:
        sucursal_id = user_sid
    else:
        sid_raw = request.args.get("sucursal_id") or request.args.get("branch_id")
        sucursal_id = _resolver_sid(sid_raw)
    if pieza == "estado":
        return jsonify(estado(sucursal_id))
    filtro = filtro_de(pieza, request.args.to_dict())
    try:
        return jsonify(leer(
            pieza,
            sucursal_id=sucursal_id,
            periodo=(request.args.get("periodo") or "Hoy").strip(),
            desde=request.args.get("desde"),
            hasta=request.args.get("hasta"),
            filtro=filtro,
        ))
    except ValueError:
        return jsonify({"error": "Pieza desconocida"}), 400
    except Exception as exc:
        current_app.logger.warning("nodo %s no respondió: %s", pieza, type(exc).__name__)
        return jsonify({"ok": False, "libro": False, "error": "La base no responde en este momento."}), 503


@api_bp.route("/pos/espejo/tabla", methods=["GET"])
def api_pos_espejo_tabla():
    """Una tabla del libro, para guardarla en el teléfono, la PC o la tablet."""
    from app.services.pos_base import tabla_espejo

    try:
        return jsonify(tabla_espejo(request.args.get("tabla") or ""))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@api_bp.route("/pos/espejo/delta", methods=["GET"])
def api_pos_espejo_delta():
    """
    Delta de cambios en el espejo desde un sello dado.
    Devuelve solo las tablas que cambiaron, optimizando ancho de banda.
    Soporta compresión gzip/brotli vía headers del servidor Flask.
    """
    from app.services.pos_base import delta_espejo

    sello_desde = (request.args.get("sello") or "").strip().replace(" ", "+")
    try:
        response = jsonify(delta_espejo(sello_desde))
        # El servidor Flask/Render comprime automáticamente si el cliente Accept-Encoding incluye gzip/br
        # Forzamos que se envíe el content-type correcto
        response.headers['Content-Type'] = 'application/json; charset=utf-8'
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        return response
    except Exception as exc:
        current_app.logger.warning("delta espejo falló: %s", type(exc).__name__)
        return jsonify({"ok": False, "error": str(exc)}), 500


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
    emp_raw = session.get("empresa_id") or request.headers.get("X-Empresa-ID") or request.headers.get("X-Company-ID") or data.get("empresa_id")
    emp_id = int(emp_raw) if str(emp_raw or "").isdigit() else 1
    
    # Resolución jerárquica: PC/Terminal -> Sucursal -> Empresa
    identificador_pc = str(data.get("identificador_pc") or data.get("nombre_maquina") or data.get("host_name") or "").strip()
    suc_id_input = data.get("sucursal_id") if data.get("sucursal_id") not in (None, "") else data.get("branch_id")
    try:
        from app.services.sucursales_service import resolver_sucursal_terminal
        suc_id_resuelto = resolver_sucursal_terminal(emp_id, identificador_pc, suc_id_input)
    except Exception:
        suc_id_resuelto = suc_id_input

    try:
        resultado = guardar_parte(
            str(data.get("tabla") or ""),
            data.get("columnas") or [],
            data.get("filas") or [],
            data.get("parte") or 1,
            data.get("partes") or 1,
            suc_id_resuelto,
            data.get("sucursal") or data.get("sucursal_nombre"),
            str(data.get("modo") or "reemplazo"),
            data.get("bajas") or [],
            empresa_id=emp_id,
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        current_app.logger.exception("Error en api_pos_base_tabla: %s", e)
        return jsonify({"error": f"Fallo al guardar {data.get('tabla')}: {str(e)}"}), 500
    parte = int(data.get("parte") or 1)
    partes = int(data.get("partes") or 1)
    if str(data.get("tabla") or "") == "ventas" and data.get("total_filas") not in (None, ""):
        from app.services.pos_base import anotar_carga

        anotar_carga(
            emp_id,
            int(data.get("enviadas") or 0),
            int(data.get("total_filas") or 0),
            bool(data.get("dia")),
        )
    completo = str(data.get("modo") or "reemplazo") == "delta" or parte >= partes
    if completo and resultado.get("ok"):
        from app.services.signal_bus import broadcast_refresh

        limpiar_solicitud_sync(data.get("sucursal_id") or 1)
        broadcast_refresh(emp_id, reason="libro")
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
    from app.security import current_sucursal_id

    nombre = (request.args.get("panel") or "reporte").strip().lower()
    user_sid = current_sucursal_id()
    if user_sid is not None:
        sucursal_id = user_sid
    else:
        suc_raw = request.args.get("sucursal_id") or request.args.get("branch_id")
        sucursal_id = _resolver_sid(suc_raw)
    periodo = (request.args.get("periodo") or "Hoy").strip()
    desde = request.args.get("desde")
    hasta = request.args.get("hasta")
    filtro = None
    if nombre in ("ticket", "contabilidad", "desglose", "cargos", "cobros", "auditoria", "auditoria_cartera", "financiero", "reporte_financiero"):
        filtro = {
            "texto": request.args.get("q") or "",
            "metodo": request.args.get("pago") or "TODOS",
            "alcance": request.args.get("alcance") or "dia",
            "fecha": request.args.get("fecha") or "",
            "fecha_ini": request.args.get("fecha_ini") or "",
            "fecha_fin": request.args.get("fecha_fin") or "",
            "historico": request.args.get("historico") in ("1", "true", "si"),
            "hora_desde": request.args.get("hora_desde") or "00:00",
            "hora_hasta": request.args.get("hora_hasta") or "23:59",
            "caja": request.args.get("caja") or "",
            "offset": request.args.get("offset", type=int) or 0,
            "limite": request.args.get("limite", type=int) or 400,
            "estado": request.args.get("estado") or "",
            "medio": request.args.get("medio") or "",
            "accion": request.args.get("accion") or "",
            "comparar": request.args.get("comparar") in ("1", "true", "si"),
        }
        if request.args.get("periodo"):
            filtro["periodo"] = request.args.get("periodo")
            filtro["desde"] = request.args.get("desde") or ""
            filtro["hasta"] = request.args.get("hasta") or ""
    if nombre not in (
        "reporte", "jefe", "vitrina", "contabilidad", "admin", "cartera", "clientes",
        "digitales", "cobros_digitales", "pedidos", "abastecimiento",
        "proveedor", "promedio", "ticket", "desglose",
        "cargos", "cobros", "auditoria", "auditoria_cartera",
        "financiero", "reporte_financiero"
    ):
        return jsonify({"error": "Panel desconocido"}), 400
    try:
        return jsonify(panel(nombre, sucursal_id=sucursal_id, periodo=periodo, desde=desde, hasta=hasta, filtro=filtro))
    except Exception as exc:
        current_app.logger.warning("panel %s no respondió: %s", nombre, type(exc).__name__)
        return jsonify({"ok": False, "libro": False, "error": "La base no responde en este momento."}), 503


@api_bp.route("/pos/sucursales", methods=["GET"])
def api_pos_sucursales():
    """Lista de sucursales activas registradas en la base espejo."""
    from app.services.pos_base import listar_sucursales
    from app.security import current_sucursal_id

    emp_id = int(session.get("empresa_id") or request.headers.get("X-Empresa-ID") or request.args.get("empresa_id") or 1)
    sucursales = listar_sucursales(empresa_id=emp_id)
    user_sid = current_sucursal_id()
    if user_sid is not None:
        sucursales = [s for s in sucursales if s.get("id") == user_sid]
    return jsonify({"ok": True, "sucursales": sucursales})


@api_bp.route("/pos/carga", methods=["GET"])
def api_pos_carga():
    """Barra de arriba: el día ya entró y el resto del libro sigue llegando."""
    from app.services.pos_base import leer_carga

    emp_id = int(session.get("empresa_id") or request.headers.get("X-Empresa-ID") or request.args.get("empresa_id") or 1)
    dato = leer_carga(emp_id)
    subidos = int(dato.get("subidos") or 0)
    total = int(dato.get("total") or 0)
    if total < subidos:
        total = subidos
    cargando = total > 0 and subidos < total
    progreso_texto = dato.get("progreso_texto") or (f"{subidos}/{total}" if total > 0 else "")
    return jsonify({
        "ok": True,
        "visible": cargando,
        "cargando": cargando,
        "completo": total > 0 and subidos >= total,
        "subidos": subidos,
        "total": total,
        "progreso_texto": progreso_texto,
        "dia": bool(dato.get("dia")),
    })


@api_bp.route("/pos/sync/status", methods=["GET"])
def api_pos_sync_status():
    """
    Obtiene el estado de la última sincronización.

    Útil para mostrar en el dashboard.
    """
    status = get_last_sync_status()
    return jsonify(status)


_solicitudes_sync: dict[str, float] = {}


def marcar_solicitud_sync(sucursal_id: str | int = 1) -> None:
    clave = str(sucursal_id or "1").strip()
    _solicitudes_sync[clave] = time.time()


def hay_solicitud_sync_pendiente(sucursal_id: str | int = 1, ventana_seg: float = 900.0) -> bool:
    clave = str(sucursal_id or "1").strip()
    t = _solicitudes_sync.get(clave, 0.0)
    if t and (time.time() - t) <= ventana_seg:
        return True
    return False


def limpiar_solicitud_sync(sucursal_id: str | int = 1) -> None:
    clave = str(sucursal_id or "1").strip()
    _solicitudes_sync.pop(clave, None)


@api_bp.route("/pos/sync/solicitar", methods=["POST", "GET"])
def api_pos_sync_solicitar():
    """La web o PWA pide al TPV local que despierte y sincronice."""
    sid = request.args.get("sucursal_id") or (request.get_json(silent=True) or {}).get("sucursal_id") or "1"
    marcar_solicitud_sync(sid)
    return jsonify({"ok": True, "mensaje": "Solicitud de sincronización registrada", "sucursal_id": sid})


@api_bp.route("/pos/sync/pendiente", methods=["GET"])
def api_pos_sync_pendiente():
    """El TPV local consulta si hay una petición de envío pendiente de la web."""
    sid = request.args.get("sucursal_id") or "1"
    pendiente = hay_solicitud_sync_pendiente(sid)
    return jsonify({"ok": True, "pedir_envio": pendiente, "sucursal_id": sid})


@api_bp.route("/pos/sync/confirmar", methods=["POST", "GET"])
def api_pos_sync_confirmar():
    """El TPV local avisa que ya leyó y revisó la base tras la petición."""
    sid = request.args.get("sucursal_id") or (request.get_json(silent=True) or {}).get("sucursal_id") or "1"
    limpiar_solicitud_sync(sid)
    return jsonify({"ok": True, "mensaje": "Sincronización confirmada", "sucursal_id": sid})


@api_bp.route("/pos/inventario/auditoria", methods=["GET"])
def api_pos_inventario_auditoria():
    """Retorna el catálogo completo para auditoría con stock vivo y conteos."""
    from app.services.pos_inventario import obtener_catalogo_auditoria
    from app.security import current_sucursal_id

    emp_raw = session.get("empresa_id") or request.headers.get("X-Empresa-ID") or request.args.get("empresa_id") or 1
    emp_id = int(emp_raw) if str(emp_raw).isdigit() else 1
    user_sid = current_sucursal_id()
    if user_sid is not None:
        sid = user_sid
    else:
        sid_raw = request.args.get("sucursal_id")
        sid = _resolver_sid(sid_raw)
    dato = obtener_catalogo_auditoria(sucursal_id=sid, empresa_id=emp_id)
    return jsonify(dato)


@api_bp.route("/pos/inventario/ajuste", methods=["POST"])
def api_pos_inventario_ajuste():
    """Aplica un ajuste de stock SET inmediato y registra auditoría."""
    from app.services.pos_inventario import registrar_ajuste_inventario
    from app.security import current_sucursal_id

    data = request.get_json(silent=True) or {}
    emp_raw = session.get("empresa_id") or request.headers.get("X-Empresa-ID") or data.get("empresa_id") or 1
    emp_id = int(emp_raw) if str(emp_raw).isdigit() else 1
    pid = data.get("producto_id")
    stock_fisico = data.get("stock_fisico")
    responsable = str(data.get("responsable") or session.get("user") or "Admin").strip()
    motivo = str(data.get("motivo") or "Recuento físico").strip()
    user_sid = current_sucursal_id()
    if user_sid is not None:
        sid = user_sid
    else:
        sid_raw = data.get("sucursal_id")
        sid = _resolver_sid(sid_raw)

    if pid is None or stock_fisico is None:
        return jsonify({"ok": False, "error": "producto_id y stock_fisico son obligatorios"}), 400

    resultado = registrar_ajuste_inventario(
        producto_id=pid,
        stock_fisico=stock_fisico,
        responsable=responsable,
        motivo=motivo,
        sucursal_id=sid,
        empresa_id=emp_id,
        precio=data.get("precio"),
        departamento=data.get("departamento"),
    )
    status_code = 200 if resultado.get("ok") else 400
    return jsonify(resultado), status_code


@api_bp.route("/pos/inventario/producto", methods=["POST"])
def api_pos_inventario_crear_producto():
    """Alta rápida de artículo desde el buscador del Inventario (nombre + código de barras)."""
    from app.services.pos_inventario import crear_producto_catalogo
    from app.security import current_sucursal_id

    data = request.get_json(silent=True) or {}
    emp_raw = session.get("empresa_id") or request.headers.get("X-Empresa-ID") or data.get("empresa_id") or 1
    emp_id = int(emp_raw) if str(emp_raw).isdigit() else 1
    user_sid = current_sucursal_id()
    if user_sid is not None:
        sid = user_sid
    else:
        sid_raw = data.get("sucursal_id")
        sid = int(sid_raw) if sid_raw and str(sid_raw).isdigit() else None
    resultado = crear_producto_catalogo(
        nombre=data.get("nombre"),
        codigo=str(data.get("codigo") or ""),
        precio=data.get("precio") or 0,
        stock=data.get("stock") or 0,
        unidad=data.get("unidad") or "UN",
        departamento=data.get("departamento") or "GENERAL",
        sucursal_id=sid,
        empresa_id=emp_id,
    )
    return jsonify(resultado), (200 if resultado.get("ok") else 400)


@api_bp.route("/pos/inventario/historial", methods=["GET"])
def api_pos_inventario_historial():
    """Retorna los últimos registros de auditoría de inventario."""
    from app.services.pos_inventario import obtener_historial_auditorias

    emp_raw = session.get("empresa_id") or request.headers.get("X-Empresa-ID") or request.args.get("empresa_id") or 1
    emp_id = int(emp_raw) if str(emp_raw).isdigit() else 1
    limite = int(request.args.get("limite") or 50)
    historial = obtener_historial_auditorias(limite=limite, empresa_id=emp_id)
    return jsonify({"ok": True, "historial": historial})

