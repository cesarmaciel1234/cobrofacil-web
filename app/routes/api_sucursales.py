"""Rutas de API REST para gestión de Sucursales y Terminales."""
from flask import jsonify, request, session
from app.routes.api import api_bp
from app.services import sucursales_service


def _sesion_empresa(escritura=False):
    if session.get("authenticated") is not True:
        return None, (jsonify({"success": False, "error": "Iniciá sesión para continuar."}), 401)
    empresa_id = session.get("empresa_id")
    rol = session.get("role")
    if type(empresa_id) is not int or empresa_id <= 0:
        return None, (jsonify({"success": False, "error": "Sesión inválida."}), 403)
    if escritura and rol == "visor":
        return None, (jsonify({"success": False, "error": "Tu usuario solo tiene acceso de lectura."}), 403)
    return empresa_id, None


@api_bp.route("/sucursales", methods=["GET"])
def get_sucursales():
    empresa_id, error = _sesion_empresa()
    if error:
        return error
    try:
        data = sucursales_service.listar_sucursales(empresa_id)
        return jsonify({"success": True, **data})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/sucursales", methods=["POST", "PUT"])
def post_sucursal():
    empresa_id, error = _sesion_empresa(escritura=True)
    if error:
        return error
    try:
        datos = request.get_json(silent=True) or {}
        resultado = sucursales_service.guardar_sucursal(empresa_id, datos)
        return jsonify({"success": True, **resultado})
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/sucursales/<int:sucursal_id>", methods=["DELETE"])
def delete_sucursal(sucursal_id):
    empresa_id, error = _sesion_empresa(escritura=True)
    if error:
        return error
    try:
        resultado = sucursales_service.eliminar_sucursal(empresa_id, sucursal_id)
        return jsonify({"success": True, **resultado})
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/sucursales/<int:sucursal_id>/vincular-terminal", methods=["POST"])
def post_vincular_terminal(sucursal_id):
    empresa_id, error = _sesion_empresa(escritura=True)
    if error:
        return error
    try:
        datos = request.get_json(silent=True) or {}
        resultado = sucursales_service.vincular_terminal(empresa_id, sucursal_id, datos)
        return jsonify(resultado)
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/sucursales/publicas/<int:empresa_id>", methods=["GET"])
def get_sucursales_publicas(empresa_id):
    """Endpoint público para que Reparto Fácil consulte sucursales activas."""
    try:
        data = sucursales_service.listar_sucursales(empresa_id)
        return jsonify({"success": True, **data})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
