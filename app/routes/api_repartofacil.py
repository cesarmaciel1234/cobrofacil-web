import json
import time
from datetime import datetime
from flask import jsonify, request

from app.database import get_db
from app.routes.api import api_bp


@api_bp.route("/repartofacil/pedidos", methods=["GET"])
def get_repartofacil_pedidos():
    """
    Devuelve los pedidos activos y recientes de Reparto Fácil
    desde la tabla compartida repartofacil_pedidos.
    """
    try:
        conn = get_db()
        sql = """
            SELECT 
                id,
                cliente_nombre,
                cliente_telefono,
                direccion_entrega,
                tipo_entrega,
                metodo_pago,
                estado,
                repartidor_id,
                repartidor_nombre,
                items,
                subtotal,
                costo_envio,
                total,
                ganancia_repartidor,
                minutos_estimados,
                distancia_km,
                notas,
                sucursal_origen,
                created_at,
                updated_at
            FROM repartofacil_pedidos
            ORDER BY created_at DESC
            LIMIT 50
        """
        rows = conn.execute(sql).fetchall()
        pedidos = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("items"), str):
                try:
                    d["items"] = json.loads(d["items"])
                except Exception:
                    d["items"] = []
            pedidos.append(d)
        return jsonify({"success": True, "pedidos": pedidos})
    except Exception as e:
        return jsonify({"success": False, "error": str(e), "pedidos": []}), 500


@api_bp.route("/repartofacil/pedidos/<order_id>/embalar", methods=["POST"])
def embalar_repartofacil_pedido(order_id):
    """
    Marca un pedido como embalado/listo en repartofacil_pedidos y
    envía automáticamente el mensaje de confirmación al chat tripartito:
    'Pedido a Frigorífico Maciel: Pedido listo y embalado 📦✅'.
    """
    try:
        conn = get_db()
        
        # 1. Actualizar estado en base de datos
        update_sql = "UPDATE repartofacil_pedidos SET estado = 'ready', updated_at = NOW() WHERE id = %s"
        conn.execute(update_sql, (order_id,))
        
        # 2. Insertar mensaje en el chat tripartito
        msg_id = f"msg-store-{int(time.time() * 1000)}"
        hora_str = datetime.now().strftime("%H:%M")
        texto = "Pedido a Frigorífico Maciel: Pedido listo y embalado 📦✅"
        
        chat_sql = """
            INSERT INTO repartofacil_chat_mensajes 
            (id, order_id, author_role, author_name, content, timestamp_str, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, NOW())
        """
        conn.execute(chat_sql, (msg_id, order_id, "store", "Frigorífico Maciel", texto, hora_str))
        
        if hasattr(conn, "commit"):
            conn.commit()
            
        return jsonify({
            "success": True,
            "order_id": order_id,
            "estado": "ready",
            "mensaje": texto,
            "timestamp": hora_str
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/repartofacil/chat/<order_id>", methods=["GET"])
def get_repartofacil_chat(order_id):
    """
    Devuelve los mensajes de chat para un pedido específico.
    """
    try:
        conn = get_db()
        sql = """
            SELECT id, order_id, author_role, author_name, content, timestamp_str, created_at
            FROM repartofacil_chat_mensajes
            WHERE order_id = %s
            ORDER BY created_at ASC
        """
        rows = conn.execute(sql, (order_id,)).fetchall()
        mensajes = [dict(r) for r in rows]
        return jsonify({"success": True, "order_id": order_id, "mensajes": mensajes})
    except Exception as e:
        return jsonify({"success": False, "error": str(e), "mensajes": []}), 500


@api_bp.route("/repartofacil/chat/<order_id>/mensaje", methods=["POST"])
def send_repartofacil_chat_mensaje(order_id):
    """
    Envía un mensaje desde el comercio Frigorífico Maciel al chat tripartito del pedido.
    """
    try:
        data = request.get_json(silent=True) or {}
        contenido = (data.get("content") or "").strip()
        if not contenido:
            return jsonify({"error": "Contenido de mensaje vacío"}), 400
            
        conn = get_db()
        msg_id = f"msg-store-{int(time.time() * 1000)}"
        hora_str = datetime.now().strftime("%H:%M")
        
        chat_sql = """
            INSERT INTO repartofacil_chat_mensajes 
            (id, order_id, author_role, author_name, content, timestamp_str, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, NOW())
        """
        conn.execute(chat_sql, (msg_id, order_id, "store", "Frigorífico Maciel", contenido, hora_str))
        
        if hasattr(conn, "commit"):
            conn.commit()
            
        return jsonify({
            "success": True,
            "mensaje": {
                "id": msg_id,
                "order_id": order_id,
                "author_role": "store",
                "author_name": "Frigorífico Maciel",
                "content": contenido,
                "timestamp_str": hora_str
            }
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
