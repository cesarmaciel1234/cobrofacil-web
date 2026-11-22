from flask import current_app, jsonify, request, session

from app.routes.api import api_bp
from app.services.perfil_comercio import guardar_perfil, leer_perfil


@api_bp.route("/repartofacil/mi-empresa", methods=["GET", "PUT"])
def perfil_comercio():
    empresa_id = session.get("empresa_id")
    rol = session.get("role")
    if session.get("authenticated") is not True:
        return jsonify({"error": "Iniciá sesión para consultar la empresa."}), 401
    if type(empresa_id) is not int or empresa_id <= 0 or rol not in ("admin", "operador", "visor"):
        return jsonify({"error": "Sesión de comercio inválida."}), 403
    if request.method == "PUT" and rol != "admin":
        return jsonify({"error": "Solo administradores pueden editar la ficha."}), 403
    datos = request.get_json(silent=True) if request.method == "PUT" else None
    if request.method == "PUT" and (not isinstance(datos, dict) or
                                    type(datos.get("empresa_id")) is not int or
                                    datos["empresa_id"] != empresa_id):
        return jsonify({"error": "La sesión cambió. Volvé a abrir la ficha."}), 409
    try:
        resultado = guardar_perfil(empresa_id, datos) if request.method == "PUT" else leer_perfil(empresa_id)
        return jsonify(resultado)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        current_app.logger.exception("No se pudo acceder a la ficha de comercio")
        return jsonify({"error": "No se pudo acceder a la ficha. Intentá nuevamente."}), 503
