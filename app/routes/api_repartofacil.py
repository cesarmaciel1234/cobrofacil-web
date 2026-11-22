import json
import random
import uuid
from datetime import datetime
from flask import current_app, jsonify, request

from app.database import get_db
from app.routes.api import api_bp
from flask import session


def _sesion_empresa_repartofacil(escritura=False):
    if session.get("authenticated") is not True:
        return None, (jsonify({"success": False, "error": "Iniciá sesión para usar Reparto Fácil."}), 401)
    empresa_id = session.get("empresa_id")
    rol = session.get("role")
    if type(empresa_id) is not int or empresa_id <= 0 or rol not in ("admin", "operador", "visor"):
        return None, (jsonify({"success": False, "error": "Sesión de comercio inválida."}), 403)
    if escritura and rol == "visor":
        return None, (jsonify({"success": False, "error": "Tu usuario solo tiene acceso de lectura."}), 403)
    return empresa_id, None


def _pedido_repartofacil_bloqueado(conn, order_id, empresa_id, estados):
    pedido = conn.execute(
        "SELECT * FROM public.repartofacil_pedidos WHERE id = %s AND empresa_id = %s FOR UPDATE",
        (order_id, empresa_id),
    ).fetchone()
    if not pedido:
        return None, (jsonify({"success": False, "error": "Pedido no disponible."}), 404)
    estado = str(pedido["estado"] or "").strip().lower()
    if estado not in estados:
        return None, (jsonify({"success": False, "error": "El pedido ya no permite esta acción."}), 409)
    return pedido, None


@api_bp.route("/repartofacil/pedidos", methods=["GET"])
def get_repartofacil_pedidos():
    """
    Devuelve los pedidos activos y recientes de Reparto Fácil
    desde la tabla compartida public.repartofacil_pedidos,
    filtrados ESTRICTAMENTE por la empresa en sesión para garantizar
    el aislamiento absoluto de datos entre comercios.
    """
    empresa_actual, error = _sesion_empresa_repartofacil()
    if error:
        return error
    try:
        with get_db(empresa_id=0) as conn:
            sql = """
                SELECT
                    id,
                    ticket_id,
                    cliente_id,
                    cliente_usuario_id,
                    cliente_nombre,
                    cliente_telefono,
                    direccion_entrega,
                    tipo_entrega,
                    metodo_pago,
                    estado,
                    empresa_id,
                    empresa_slug,
                    repartidor_id,
                    repartidor_nombre,
                    repartidor_usuario_id,
                    items,
                    subtotal,
                    costo_envio,
                    total,
                    ganancia_repartidor,
                    minutos_estimados,
                    distancia_km,
                    notas,
                    sucursal_origen,
                    custodio_estado,
                    custodio_advertencia_at,
                    driver_last_ping,
                    created_at,
                    updated_at
                FROM public.repartofacil_pedidos
                WHERE empresa_id = %s
                ORDER BY created_at DESC
                LIMIT 50
            """
            rows = conn.execute(sql, (empresa_actual,)).fetchall()
            pedidos = []
            for r in rows:
                d = dict(r)
                if isinstance(d.get("items"), str):
                    try:
                        d["items"] = json.loads(d["items"])
                    except Exception:
                        d["items"] = []
                # Pago siempre legible como Web o el método especificado
                pago_metodo = str(d.get("metodo_pago") or "Web").strip()
                if pago_metodo.lower() in ("web", "tarjeta", "card", "online", "repartofacil"):
                    d["metodo_pago"] = "Web"

                pedidos.append(d)
            return jsonify({"success": True, "empresa_id": empresa_actual, "pedidos": pedidos})
    except Exception as e:
        return jsonify({"success": False, "error": str(e), "pedidos": []}), 500


@api_bp.route("/repartofacil/pedidos/<order_id>/aceptar", methods=["POST"])
def aceptar_repartofacil_pedido(order_id):
    """
    Cobro Fácil acepta el pedido del comprador.
    Genera el número de Ticket (#109XXXX), cambia el estado a 'confirmed',
    asigna metodo_pago = 'Web' (para que figure como Web en el libro y tickets),
    registra/vincula al cliente en la Cartera de Clientes (clientes) para historial unificado,
    y publica el primer mensaje en el chat tripartito.
    """
    empresa_id, error = _sesion_empresa_repartofacil(escritura=True)
    if error:
        return error
    try:
        ticket_id = str(random.randint(1090000, 1099999))
        msg_id = f"msg-store-{uuid.uuid4()}"
        hora_str = datetime.now().strftime("%H:%M")

        with get_db(empresa_id=empresa_id) as conn:
            # Traer datos del pedido
            order_row, error = _pedido_repartofacil_bloqueado(
                conn, order_id, empresa_id, {"pending", "pending_store"}
            )
            if error:
                return error

            nombre_cliente = (order_row["cliente_nombre"] if order_row else None) or "Cliente Web"
            tel_cliente = (order_row["cliente_telefono"] if order_row else None) or ""
            dir_cliente = (order_row["direccion_entrega"] if order_row else None) or ""
            nombre_sucursal = (order_row["sucursal_origen"] if order_row else None) or "Frigorífico Maciel"
            texto = f"{nombre_sucursal} aceptó el pedido. Ticket #{ticket_id} emitido. Buscando repartidor en zona..."

            # 1. Actualizar estado y ticket del pedido con pago Web
            update_sql = "UPDATE public.repartofacil_pedidos SET estado = 'confirmed', ticket_id = %s, metodo_pago = 'Web', updated_at = NOW() WHERE id = %s"
            conn.execute(update_sql, (ticket_id, order_id))

            # 2. Registrar/vincular cliente en la Cartera de Clientes local y web compartida
            try:
                existente = conn.execute(
                    "SELECT id FROM clientes WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(%s)) OR (telefono IS NOT NULL AND telefono != '' AND telefono = %s) LIMIT 1",
                    (nombre_cliente, tel_cliente)
                ).fetchone()
                if not existente:
                    conn.execute(
                        """
                        INSERT INTO clientes (nombre, telefono, direccion, scoring, tipo_cliente, techo_deuda, saldo_actual, saldo_inicial, created_at)
                        VALUES (%s, %s, %s, 'A', 'Web', 0, 0, 0, NOW())
                        """,
                        (nombre_cliente, tel_cliente, dir_cliente)
                    )
                else:
                    conn.execute(
                        """
                        UPDATE clientes
                        SET direccion = COALESCE(NULLIF(direccion, ''), %s),
                            telefono = COALESCE(NULLIF(telefono, ''), %s)
                        WHERE id = %s
                        """,
                        (dir_cliente, tel_cliente, existente["id"])
                    )
            except Exception as cli_err:
                print(f"[Cartera] Aviso no bloqueante al sincronizar cliente web: {cli_err}")

            # 3. Notificar en chat tripartito
            chat_sql = """
                INSERT INTO public.repartofacil_chat_mensajes
                (id, order_id, author_role, author_name, content, timestamp_str, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, NOW())
            """
            conn.execute(chat_sql, (msg_id, order_id, "store", nombre_sucursal, texto, hora_str))

            if hasattr(conn, "commit"):
                conn.commit()

        return jsonify({
            "success": True,
            "order_id": order_id,
            "ticket_id": ticket_id,
            "estado": "confirmed",
            "pago": "Web",
            "mensaje": texto
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/repartofacil/pedidos/<order_id>/rechazar", methods=["POST"])
def rechazar_repartofacil_pedido(order_id):
    """
    Cobro Fácil rechaza el pedido (por falta de stock o fuera de horario).
    Pasa a 'rejected', no sale a repartidores y notifica en el chat.
    """
    empresa_id, error = _sesion_empresa_repartofacil(escritura=True)
    if error:
        return error
    try:
        data = request.get_json(silent=True) or {}
        motivo = data.get("motivo") or "Falta de stock o fuera de horario comercial"
        msg_id = f"msg-store-{uuid.uuid4()}"
        hora_str = datetime.now().strftime("%H:%M")
        texto = f"Pedido no aceptado por Frigorífico Maciel: {motivo}."

        with get_db(empresa_id=empresa_id) as conn:
            _, error = _pedido_repartofacil_bloqueado(conn, order_id, empresa_id, {"pending", "pending_store"})
            if error:
                return error
            update_sql = "UPDATE public.repartofacil_pedidos SET estado = 'rejected', updated_at = NOW() WHERE id = %s"
            conn.execute(update_sql, (order_id,))
            
            chat_sql = """
                INSERT INTO public.repartofacil_chat_mensajes 
                (id, order_id, author_role, author_name, content, timestamp_str, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, NOW())
            """
            conn.execute(chat_sql, (msg_id, order_id, "store", "Frigorífico Maciel", texto, hora_str))
            
            if hasattr(conn, "commit"):
                conn.commit()
            
        return jsonify({
            "success": True,
            "order_id": order_id,
            "estado": "rejected",
            "mensaje": texto
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/repartofacil/pedidos/<order_id>/embalar", methods=["POST"])
def marcar_pedido_embalado(order_id):
    """
    Cobro Fácil presiona 'Embalado':
    Cambia estado a 'ready' (Listo para retirar)
    y notifica inmediatamente al repartidor en su mensajería:
    'Pedido a frigorífico maciel : pedido listo y embalado'
    """
    empresa_id, error = _sesion_empresa_repartofacil(escritura=True)
    if error:
        return error
    try:
        msg_id = f"msg-store-{uuid.uuid4()}"
        hora_str = datetime.now().strftime("%H:%M")
        texto = "Pedido a Frigorífico Maciel: Pedido listo y embalado 📦✅"

        with get_db(empresa_id=empresa_id) as conn:
            pedido, error = _pedido_repartofacil_bloqueado(
                conn, order_id, empresa_id, {"confirmed", "accepted", "assigned", "ready", "embalado"}
            )
            if error:
                return error
            if str(pedido["estado"]).strip().lower() in {"ready", "embalado"}:
                return jsonify({"success": True, "order_id": order_id, "estado": pedido["estado"]})
            update_sql = "UPDATE public.repartofacil_pedidos SET estado = 'ready', updated_at = NOW() WHERE id = %s"
            conn.execute(update_sql, (order_id,))
            
            chat_sql = """
                INSERT INTO public.repartofacil_chat_mensajes 
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


@api_bp.route("/repartofacil/pedidos/<order_id>/custodio/liberar", methods=["POST"])
def liberar_pedido_custodio(order_id):
    """
    Custodio Intermediario activado por Cobro Fácil:
    Si el repartidor asignado se desconectó, no responde o no se mueve,
    el sistema lo desvincula, devuelve el pedido a la bandeja disponible
    y notifica en el chat blindado a todos los participantes.
    """
    empresa_id, error = _sesion_empresa_repartofacil(escritura=True)
    if error:
        return error
    try:
        data = request.get_json(silent=True) or {}
        motivo = data.get("motivo") or "inactividad y falta de respuesta del chofer"
        msg_id = f"msg-custodio-{uuid.uuid4()}"
        hora_str = datetime.now().strftime("%H:%M")

        with get_db(empresa_id=empresa_id) as conn:
            # Obtener estado actual
            row, error = _pedido_repartofacil_bloqueado(
                conn, order_id, empresa_id, {"assigned", "ready", "embalado"}
            )
            if error:
                return error
            if not row["repartidor_id"]:
                return jsonify({"success": False, "error": "El pedido no tiene repartidor asignado."}), 409
                
            estado_previo = row["estado"]
            chofer_previo = row["repartidor_nombre"] or "el chofer asignado"
            nuevo_estado = "ready" if str(estado_previo).strip().lower() in ("ready", "embalado") else "confirmed"

            update_sql = """
                UPDATE public.repartofacil_pedidos 
                SET repartidor_id = NULL,
                    repartidor_usuario_id = NULL,
                    repartidor_nombre = NULL,
                    estado = %s,
                    custodio_estado = 'reingresado',
                    custodio_advertencia_at = NULL,
                    updated_at = NOW() 
                WHERE id = %s
            """
            conn.execute(update_sql, (nuevo_estado, order_id))

            texto = f"🚨 [Custodio del Sistema]: Frigorífico Maciel reincorporó el pedido a la bandeja disponible debido a {motivo}. El chofer ({chofer_previo}) fue desasociado. Buscando un nuevo repartidor en zona..."
            chat_sql = """
                INSERT INTO public.repartofacil_chat_mensajes 
                (id, order_id, author_role, author_name, content, timestamp_str, created_at)
                VALUES (%s, %s, 'system', 'Sistema Reparto Fácil (Custodio)', %s, %s, NOW())
            """
            conn.execute(chat_sql, (msg_id, order_id, texto, hora_str))

            if hasattr(conn, "commit"):
                conn.commit()

        return jsonify({
            "success": True,
            "order_id": order_id,
            "estado": nuevo_estado,
            "mensaje": texto,
            "timestamp": hora_str
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/repartofacil/ticket/<target_id>", methods=["GET"])
def get_repartofacil_ticket(target_id):
    """
    Devuelve el ticket digital de un pedido de la empresa autenticada.
    El campo Pago siempre se muestra como 'Web'.
    """
    empresa_id, error = _sesion_empresa_repartofacil()
    if error:
        return error
    try:
        with get_db(empresa_id=0) as conn:
            sql = """
                SELECT 
                    id,
                    ticket_id,
                    cliente_nombre,
                    cliente_telefono,
                    direccion_entrega,
                    metodo_pago,
                    estado,
                    repartidor_nombre,
                    items,
                    subtotal,
                    costo_envio,
                    total,
                    notas,
                    sucursal_origen,
                    created_at
                FROM public.repartofacil_pedidos
                WHERE (id = %s OR ticket_id = %s) AND empresa_id = %s
                LIMIT 1
            """
            row = conn.execute(sql, (target_id, target_id, empresa_id)).fetchone()
            if not row:
                return jsonify({"encontrado": False, "error": "Ticket no encontrado"}), 404
                
            d = dict(row)
            items = []
            if isinstance(d.get("items"), str):
                try:
                    items = json.loads(d["items"])
                except Exception:
                    items = []
            elif isinstance(d.get("items"), list):
                items = d["items"]
                
            fecha_str = d["created_at"].strftime("%Y-%m-%d %H:%M:%S") if d.get("created_at") else ""
            
            ticket_data = {
                "encontrado": True,
                "id": d.get("ticket_id") or d.get("id"),
                "order_id": d.get("id"),
                "ticket_numero": d.get("ticket_id") or d.get("id"),
                "fecha": fecha_str,
                "pago": "Web",
                "cajero": "—",
                "caja": "—",
                "cliente": d.get("cliente_nombre") or "Cliente",
                "direccion": d.get("direccion_entrega") or "",
                "estado": d.get("estado"),
                "items": items,
                "subtotal": float(d.get("subtotal") or 0),
                "costo_envio": float(d.get("costo_envio") or 0),
                "total": float(d.get("total") or 0),
                "notas": d.get("notas") or ""
            }
            return jsonify(ticket_data)
    except Exception as e:
        return jsonify({"encontrado": False, "error": str(e)}), 500


@api_bp.route("/repartofacil/chat/<order_id>", methods=["GET"])
def get_repartofacil_chat(order_id):
    """
    Devuelve los mensajes de un pedido de la empresa autenticada.
    """
    empresa_id, error = _sesion_empresa_repartofacil()
    if error:
        return error
    try:
        with get_db(empresa_id=0) as conn:
            sql = """
                SELECT m.id, m.order_id, m.author_role, m.author_name, m.content, m.timestamp_str, m.created_at
                FROM public.repartofacil_pedidos p
                LEFT JOIN public.repartofacil_chat_mensajes m ON m.order_id = p.id
                WHERE p.id = %s AND p.empresa_id = %s
                ORDER BY m.created_at ASC, m.id ASC
            """
            rows = conn.execute(sql, (order_id, empresa_id)).fetchall()
            if not rows:
                return jsonify({"success": False, "error": "Conversación no disponible."}), 404
            mensajes = [dict(r) for r in rows if r["id"] is not None]
            return jsonify({"success": True, "order_id": order_id, "mensajes": mensajes})
    except Exception:
        current_app.logger.exception("No se pudo consultar el chat de Reparto Fácil")
        return jsonify({"success": False, "error": "No se pudo consultar la conversación."}), 500


@api_bp.route("/repartofacil/chat/<order_id>/mensaje", methods=["POST"])
def send_repartofacil_chat_mensaje(order_id):
    """
    Envía un mensaje del comercio autenticado al chat de su pedido.
    """
    empresa_id, error = _sesion_empresa_repartofacil(escritura=True)
    if error:
        return error
    try:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"success": False, "error": "Contenido de mensaje inválido."}), 400
        contenido = data.get("content")
        if not isinstance(contenido, str):
            return jsonify({"success": False, "error": "Contenido de mensaje inválido."}), 400
        contenido = contenido.strip()
        if not contenido:
            return jsonify({"success": False, "error": "Contenido de mensaje vacío."}), 400
        if len(contenido) > 4000:
            return jsonify({"success": False, "error": "El mensaje es demasiado largo."}), 400
            
        msg_id = f"msg-store-{uuid.uuid4()}"
        hora_str = datetime.now().strftime("%H:%M")
        
        with get_db(empresa_id=0) as conn:
            pedido = conn.execute(
                """SELECT sucursal_origen FROM public.repartofacil_pedidos
                   WHERE id = %s AND empresa_id = %s
                   FOR SHARE""",
                (order_id, empresa_id),
            ).fetchone()
            if not pedido:
                return jsonify({"success": False, "error": "Conversación no disponible."}), 404
            nombre_comercio = pedido["sucursal_origen"] or "Comercio"
            chat_sql = """
                INSERT INTO public.repartofacil_chat_mensajes 
                (id, order_id, author_role, author_name, content, timestamp_str, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, NOW())
            """
            conn.execute(chat_sql, (msg_id, order_id, "store", nombre_comercio, contenido, hora_str))
            
            if hasattr(conn, "commit"):
                conn.commit()
            
        return jsonify({
            "success": True,
            "mensaje": {
                "id": msg_id,
                "order_id": order_id,
                "author_role": "store",
                "author_name": nombre_comercio,
                "content": contenido,
                "timestamp_str": hora_str
            }
        })
    except Exception:
        current_app.logger.exception("No se pudo enviar el chat de Reparto Fácil")
        return jsonify({"success": False, "error": "No se pudo enviar el mensaje."}), 500
