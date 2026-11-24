from flask import current_app, jsonify, request, session
import urllib.request
import urllib.parse
import json

from app.routes.api import api_bp
from app.services.perfil_comercio import guardar_perfil, leer_perfil


@api_bp.route("/repartofacil/geo/search", methods=["GET"])
def geo_search():
    query = (request.args.get("q") or "").strip()
    if not query:
        return jsonify([])
    try:
        # Priorizar búsqueda local en Argentina
        query_arg = query if "argentina" in query.lower() else f"{query}, Buenos Aires, Argentina"
        encoded = urllib.parse.quote(query_arg)
        url = f"https://nominatim.openstreetmap.org/search?format=json&q={encoded}&limit=5&countrycodes=ar&addressdetails=1"
        req = urllib.request.Request(url, headers={"User-Agent": "CobroFacil-Geo/1.0", "Accept-Language": "es"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not data and query_arg != query:
            # Fallback a texto directo
            encoded_raw = urllib.parse.quote(query)
            url_raw = f"https://nominatim.openstreetmap.org/search?format=json&q={encoded_raw}&limit=5&countrycodes=ar&addressdetails=1"
            req_raw = urllib.request.Request(url_raw, headers={"User-Agent": "CobroFacil-Geo/1.0", "Accept-Language": "es"})
            with urllib.request.urlopen(req_raw, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        return jsonify(data or [])
    except Exception as e:
        current_app.logger.warning("Error en geo_search: %s", e)
        return jsonify([])


@api_bp.route("/repartofacil/geo/reverse", methods=["GET"])
def geo_reverse():
    lat = request.args.get("lat")
    lng = request.args.get("lng")
    if not lat or not lng:
        return jsonify({})
    try:
        url = f"https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat={lat}&lon={lng}"
        req = urllib.request.Request(url, headers={"User-Agent": "CobroFacil-Geo/1.0", "Accept-Language": "es"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return jsonify(data or {})
    except Exception as e:
        current_app.logger.warning("Error en geo_reverse: %s", e)
        return jsonify({})


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
