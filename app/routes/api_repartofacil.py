import json
import random
import uuid
from datetime import datetime
from flask import current_app, jsonify, request

from app.database import get_db
from app.routes.api import api_bp
from app.services.pos_base import filas_de
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


def _validar_stock_pedido(items, empresa_id=None, sucursal_id=None):
    """
    Valida el stock disponible para los items de un pedido.
    Retorna un dict con:
    - valido: bool
    - items_sin_stock: lista de items faltantes con stock requerido vs disponible
    - items_con_stock: lista de items que tienen stock suficiente
    """
    if not items or not isinstance(items, list):
        return {"valido": True, "items_sin_stock": [], "items_con_stock": items or []}

    eid = empresa_id if empresa_id is not None else (session.get("empresa_id") or 1)

    # Obtener catálogo de productos con stock
    col_p, filas_p = filas_de("productos", sucursal_id, empresa_id=eid)
    if not col_p:
        col_p, filas_p = filas_de("articulos", sucursal_id, empresa_id=eid)

    if not col_p or not filas_p:
        # Si no hay catálogo, no podemos validar, permitimos
        return {"valido": True, "items_sin_stock": [], "items_con_stock": items}

    idx = {col: i for i, col in enumerate(col_p)}
    mapa_stock = {}

    for fila in filas_p:
        pid = str(fila[idx.get("id", 0)] or "")
        stock = float(fila[idx.get("stock", 0)] or 0.0) if "stock" in idx else 0.0
        nombre = str(fila[idx.get("nombre", 1)] or "") if "nombre" in idx else ""
        codigo = str(fila[idx.get("codigo", 0)] or "") if "codigo" in idx else ""
        mapa_stock[pid] = {"stock": stock, "nombre": nombre, "codigo": codigo}

    items_sin_stock = []
    items_con_stock = []

    for item in items:
        item_id = str(item.get("id") or item.get("product_id") or "")
        cantidad = float(item.get("quantity") or item.get("cantidad") or 1)

        # Buscar por ID, nombre o código
        prod = mapa_stock.get(item_id)
        if not prod:
            # Intentar buscar por nombre
            item_nombre = str(item.get("name") or item.get("nombre") or "").lower()
            for pid, p_data in mapa_stock.items():
                if p_data["nombre"].lower() == item_nombre or p_data["codigo"] == item_id:
                    prod = p_data
                    break

        if prod:
            stock_disponible = prod["stock"]
            if stock_disponible < cantidad:
                items_sin_stock.append({
                    **item,
                    "stock_disponible": stock_disponible,
                    "stock_requerido": cantidad,
                    "producto_nombre": prod["nombre"]
                })
            else:
                items_con_stock.append(item)
        else:
            # Producto no encontrado en catálogo - tratamos como válido (puede ser nuevo)
            items_con_stock.append(item)

    return {
        "valido": len(items_sin_stock) == 0,
        "items_sin_stock": items_sin_stock,
        "items_con_stock": items_con_stock
    }


def _deducir_stock_items(items, empresa_id=None, sucursal_id=None):
    """
    Deduce el stock de los items del pedido del inventario.
    Prioriza MariaDB 192.168.0.8, si no está disponible usa pos_base.
    """
    if not items or not isinstance(items, list):
        return

    eid = empresa_id if empresa_id is not None else (session.get("empresa_id") or 1)

    # Primero intentar MariaDB (192.168.0.8)
    try:
        import os
        import pymysql
        import socket

        MARIADB_HOST = os.environ.get("POS_MARIADB_HOST", "192.168.0.8")
        MARIADB_PORT = int(os.environ.get("POS_MARIADB_PORT", "3306"))
        MARIADB_USER = os.environ.get("POS_MARIADB_USER", "root")
        MARIADB_PASS = os.environ.get("POS_MARIADB_PASS", "1234")
        MARIADB_DB = os.environ.get("POS_MARIADB_DB", "punpro_db")

        # Verificar si estamos en cloud (Render no tiene IPs privadas)
        if not (os.environ.get("RENDER") or os.environ.get("DYNO")):
            # Quick socket check
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(0.3)
                res = sock.connect_ex((MARIADB_HOST, MARIADB_PORT))
                sock.close()
                if res == 0:
                    # Conectar a MariaDB
                    conn_mb = pymysql.connect(
                        host=MARIADB_HOST,
                        port=MARIADB_PORT,
                        user=MARIADB_USER,
                        password=MARIADB_PASS,
                        database=MARIADB_DB,
                        connect_timeout=0.5,
                        charset="utf8mb4",
                        autocommit=True,
                    )
                    with conn_mb.cursor() as cur:
                        # Obtener mapa de productos por nombre/código
                        cur.execute("SELECT id, nombre, codigo, stock FROM productos")
                        productos_mb = {f"{r[1]}_{r[2]}": {"id": r[0], "stock": r[3]} for r in cur.fetchall()}

                        for item in items:
                            item_nombre = str(item.get("name") or item.get("nombre") or "")
                            item_codigo = str(item.get("codigo") or "")
                            cantidad = float(item.get("quantity") or item.get("cantidad") or 1)

                            key = f"{item_nombre}_{item_codigo}"
                            prod = productos_mb.get(key)
                            if prod:
                                nuevo_stock = max(0, prod["stock"] - cantidad)
                                cur.execute("UPDATE productos SET stock = %s WHERE id = %s", (nuevo_stock, prod["id"]))

                    conn_mb.close()
                    return
            except Exception:
                pass
    except Exception:
        pass

    # Si MariaDB no está disponible, usar pos_base
    try:
        from app.services.pos_base import _olvidar_tabla

        col_p, filas_p = filas_de("productos", sucursal_id, empresa_id=eid)
        if not col_p:
            col_p, filas_p = filas_de("articulos", sucursal_id, empresa_id=eid)

        if not col_p or not filas_p:
            return

        idx = {col: i for i, col in enumerate(col_p)}
        mapa_productos = {}

        for fila in filas_p:
            pid = str(fila[idx.get("id", 0)] or "")
            nombre = str(fila[idx.get("nombre", 1)] or "").lower() if "nombre" in idx else ""
            codigo = str(fila[idx.get("codigo", 0)] or "") if "codigo" in idx else ""
            stock = float(fila[idx.get("stock", 0)] or 0.0) if "stock" in idx else 0.0
            mapa_productos[f"{nombre}_{codigo}"] = {"pos_base_id": pid, "stock": stock}

        # Actualizar filas en pos_base
        partes = []
        with get_db(eid) as conn:
            partes = conn.execute(
                "SELECT id, columnas, filas FROM pos_base WHERE tabla = 'productos'"
            ).fetchall()

        if not partes:
            return

        for parte in partes:
            cols = parte["columnas"] if isinstance(parte["columnas"], list) else json.loads(parte["columnas"])
            filas = parte["filas"] if isinstance(parte["filas"], list) else json.loads(parte["filas"])
            idx_p = {col: i for i, col in enumerate(cols)}

            actualizada = False
            for fila in filas:
                nombre = str(fila[idx_p.get("nombre", 1)] or "").lower() if "nombre" in idx_p else ""
                codigo = str(fila[idx_p.get("codigo", 0)] or "") if "codigo" in idx_p else ""
                key = f"{nombre}_{codigo}"

                for item in items:
                    item_nombre = str(item.get("name") or item.get("nombre") or "").lower()
                    item_codigo = str(item.get("codigo") or "")
                    item_key = f"{item_nombre}_{item_codigo}"

                    if key == item_key and "stock" in idx_p:
                        cantidad = float(item.get("quantity") or item.get("cantidad") or 1)
                        stock_actual = float(fila[idx_p["stock"]] or 0.0)
                        fila[idx_p["stock"]] = max(0.0, stock_actual - cantidad)
                        actualizada = True
                        break

            if actualizada:
                with get_db(eid) as conn:
                    conn.execute(
                        "UPDATE pos_base SET filas = %s, actualizado_en = NOW() WHERE id = %s",
                        (json.dumps(filas), parte["id"])
                    )
                    if hasattr(conn, "commit"):
                        conn.commit()

        _olvidar_tabla("productos")
    except Exception as e:
        print(f"[Stock] Error al deducir stock de pos_base: {e}")


def _restituir_stock_items(items, empresa_id=None, sucursal_id=None):
    """
    Restituye el stock de los items al inventario cuando un pedido es cancelado o rechazado.
    Garantiza que la tienda física recupere exactamente el inventario reservado por e-commerce.
    """
    if not items or not isinstance(items, list):
        return

    eid = empresa_id if empresa_id is not None else (session.get("empresa_id") or 1)

    # 1. Intentar en MariaDB (si está en red local)
    try:
        import os
        import pymysql
        import socket

        MARIADB_HOST = os.environ.get("POS_MARIADB_HOST", "192.168.0.8")
        MARIADB_PORT = int(os.environ.get("POS_MARIADB_PORT", "3306"))
        MARIADB_USER = os.environ.get("POS_MARIADB_USER", "root")
        MARIADB_PASS = os.environ.get("POS_MARIADB_PASS", "1234")
        MARIADB_DB = os.environ.get("POS_MARIADB_DB", "punpro_db")

        if not (os.environ.get("RENDER") or os.environ.get("DYNO")):
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(0.3)
                res = sock.connect_ex((MARIADB_HOST, MARIADB_PORT))
                sock.close()
                if res == 0:
                    conn_mb = pymysql.connect(
                        host=MARIADB_HOST,
                        port=MARIADB_PORT,
                        user=MARIADB_USER,
                        password=MARIADB_PASS,
                        database=MARIADB_DB,
                        connect_timeout=0.5,
                        charset="utf8mb4",
                        autocommit=True,
                    )
                    with conn_mb.cursor() as cur:
                        cur.execute("SELECT id, nombre, codigo, stock FROM productos")
                        productos_mb = {f"{r[1]}_{r[2]}": {"id": r[0], "stock": r[3]} for r in cur.fetchall()}

                        for item in items:
                            item_nombre = str(item.get("name") or item.get("nombre") or "")
                            item_codigo = str(item.get("codigo") or "")
                            cantidad = float(item.get("quantity") or item.get("cantidad") or 1)

                            key = f"{item_nombre}_{item_codigo}"
                            prod = productos_mb.get(key)
                            if prod:
                                nuevo_stock = float(prod["stock"] or 0.0) + cantidad
                                cur.execute("UPDATE productos SET stock = %s WHERE id = %s", (nuevo_stock, prod["id"]))

                    conn_mb.close()
                    return
            except Exception:
                pass
    except Exception:
        pass

    # 2. pos_base (Base en PostgreSQL)
    try:
        from app.services.pos_base import _olvidar_tabla

        partes = []
        with get_db(eid) as conn:
            partes = conn.execute(
                "SELECT id, columnas, filas FROM pos_base WHERE tabla = 'productos'"
            ).fetchall()

        if not partes:
            return

        for parte in partes:
            cols = parte["columnas"] if isinstance(parte["columnas"], list) else json.loads(parte["columnas"])
            filas = parte["filas"] if isinstance(parte["filas"], list) else json.loads(parte["filas"])
            idx_p = {col: i for i, col in enumerate(cols)}

            actualizada = False
            for fila in filas:
                nombre = str(fila[idx_p.get("nombre", 1)] or "").lower() if "nombre" in idx_p else ""
                codigo = str(fila[idx_p.get("codigo", 0)] or "") if "codigo" in idx_p else ""
                key = f"{nombre}_{codigo}"

                for item in items:
                    item_nombre = str(item.get("name") or item.get("nombre") or "").lower()
                    item_codigo = str(item.get("codigo") or "")
                    item_key = f"{item_nombre}_{item_codigo}"

                    if key == item_key and "stock" in idx_p:
                        cantidad = float(item.get("quantity") or item.get("cantidad") or 1)
                        stock_actual = float(fila[idx_p["stock"]] or 0.0)
                        fila[idx_p["stock"]] = stock_actual + cantidad
                        actualizada = True
                        break

            if actualizada:
                with get_db(eid) as conn:
                    conn.execute(
                        "UPDATE pos_base SET filas = %s, actualizado_en = NOW() WHERE id = %s",
                        (json.dumps(filas), parte["id"])
                    )
                    if hasattr(conn, "commit"):
                        conn.commit()

        _olvidar_tabla("productos")
    except Exception as e:
        print(f"[Stock] Error al restituir stock a pos_base: {e}")


@api_bp.route("/repartofacil/pedidos", methods=["GET"])
def get_repartofacil_pedidos():
    """
    Devuelve los pedidos activos y recientes de Reparto Fácil
    desde la tabla compartida public.repartofacil_pedidos,
    filtrados ESTRICTAMENTE por la empresa en sesión para garantizar
    el aislamiento absoluto de datos entre comercios.
    Incluye validación de stock para cada pedido.
    """
    empresa_actual, error = _sesion_empresa_repartofacil()
    if error:
        return error
    try:
        with get_db(empresa_id=0) as conn:
            usuario_comercio = f"store-{empresa_actual}"
            sql = """
                SELECT
                    p.id,
                    p.ticket_id,
                    p.cliente_id,
                    p.cliente_usuario_id,
                    p.cliente_nombre,
                    p.cliente_telefono,
                    p.direccion_entrega,
                    p.tipo_entrega,
                    p.metodo_pago,
                    p.estado,
                    p.empresa_id,
                    p.empresa_slug,
                    p.repartidor_id,
                    p.repartidor_nombre,
                    p.repartidor_usuario_id,
                    p.items,
                    COALESCE(p.subtotal, 0) AS subtotal,
                    COALESCE(p.costo_envio, 0) AS costo_envio,
                    COALESCE(p.total, 0) AS total,
                    p.ganancia_repartidor,
                    p.minutos_estimados,
                    p.distancia_km,
                    p.notas,
                    p.sucursal_origen,
                    p.custodio_estado,
                    p.custodio_advertencia_at,
                    p.driver_last_ping,
                    p.created_at,
                    p.updated_at,
                    COALESCE((
                        SELECT COUNT(*)
                        FROM public.repartofacil_chat_mensajes m
                        WHERE m.order_id = p.id
                          AND LOWER(COALESCE(m.author_role, '')) <> 'store'
                          AND NOT EXISTS (
                              SELECT 1 FROM public.repartofacil_chat_lecturas l
                              WHERE l.mensaje_id = m.id AND l.usuario_id = %s
                          )
                    ), 0) AS unread_chat_count
                FROM public.repartofacil_pedidos p
                WHERE p.empresa_id = %s
                ORDER BY p.created_at DESC
                LIMIT 50
            """
            rows = conn.execute(sql, (usuario_comercio, empresa_actual)).fetchall()
            pedidos = []
            for r in rows:
                d = dict(r)
                if isinstance(d.get("items"), str):
                    try:
                        d["items"] = json.loads(d["items"])
                    except Exception:
                        d["items"] = []

                # Convert numeric/Decimal fields to float for clean JSON serialization
                for k in ("subtotal", "costo_envio", "total", "ganancia_repartidor", "distancia_km"):
                    if d.get(k) is not None:
                        try:
                            d[k] = float(d[k])
                        except Exception:
                            pass
                d["unread_chat_count"] = int(d.get("unread_chat_count") or 0)

                # Método de pago normalizado y descriptivo
                pago_raw = str(d.get("metodo_pago") or "cash").strip().lower()
                if pago_raw in ("cash", "efectivo"):
                    d["metodo_pago"] = "Efectivo"
                    d["metodo_pago_tipo"] = "cash"
                    d["pago_contra_entrega"] = True
                elif pago_raw in ("transfer", "transferencia"):
                    d["metodo_pago"] = "Transferencia"
                    d["metodo_pago_tipo"] = "transfer"
                    d["pago_contra_entrega"] = False
                elif pago_raw in ("card", "tarjeta"):
                    d["metodo_pago"] = "Tarjeta"
                    d["metodo_pago_tipo"] = "card"
                    d["pago_contra_entrega"] = False
                elif pago_raw in ("qr", "mercadopago", "mp"):
                    d["metodo_pago"] = "Mercado Pago"
                    d["metodo_pago_tipo"] = "qr"
                    d["pago_contra_entrega"] = False
                else:
                    d["metodo_pago"] = "Pago Web"
                    d["metodo_pago_tipo"] = "web"
                    d["pago_contra_entrega"] = False

                # Validar stock para este pedido
                validacion = _validar_stock_pedido(d.get("items"), empresa_actual)
                d["stock_valido"] = validacion["valido"]
                d["items_sin_stock"] = validacion["items_sin_stock"]
                d["items_con_stock"] = validacion["items_con_stock"]

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
    valida el stock y deduce automáticamente del inventario,
    y publica el primer mensaje en el chat tripartito.

    Payload opcional:
    - items_aceptados: lista de items a aceptar (para aceptación parcial)
    - forzar_sin_stock: bool para aceptar aunque falte stock
    """
    empresa_id, error = _sesion_empresa_repartofacil(escritura=True)
    if error:
        return error
    try:
        data = request.get_json(silent=True) or {}
        items_aceptados = data.get("items_aceptados")
        forzar_sin_stock = data.get("forzar_sin_stock", False)
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
            items_pedido = order_row["items"]
            if isinstance(items_pedido, str):
                try:
                    items_pedido = json.loads(items_pedido)
                except Exception:
                    items_pedido = []

            # Determinar items a procesar (todos o parcial)
            items_a_procesar = items_aceptados if items_aceptados else items_pedido

            # Validar stock
            validacion = _validar_stock_pedido(items_a_procesar, empresa_id)

            if not validacion["valido"] and not forzar_sin_stock:
                return jsonify({
                    "success": False,
                    "error": "Stock insuficiente",
                    "items_sin_stock": validacion["items_sin_stock"],
                    "items_con_stock": validacion["items_con_stock"],
                    "puede_aceptar_parcial": len(validacion["items_con_stock"]) > 0
                }), 400

            # Deducción de stock (si hay items con stock)
            if validacion["items_con_stock"]:
                _deducir_stock_items(validacion["items_con_stock"], empresa_id)

            tipo_entrega = str(order_row.get("tipo_entrega") or "").strip().lower()
            es_retiro = tipo_entrega in ("pickup", "takeaway", "retiro", "tienda", "mostrador")
            if es_retiro:
                texto = f"{nombre_sucursal} aceptó tu pedido (Retiro en mostrador). Ticket #{ticket_id} emitido. ¡Lo estamos preparando!"
            else:
                texto = f"{nombre_sucursal} aceptó el pedido. Ticket #{ticket_id} emitido. Buscando repartidor en zona..."
            if items_aceptados:
                texto += f" (Aceptación parcial: {len(items_aceptados)} de {len(items_pedido)} items)"

            # 1. Actualizar estado y ticket del pedido con pago Web
            update_sql = "UPDATE public.repartofacil_pedidos SET estado = 'confirmed', ticket_id = %s, metodo_pago = 'Web', updated_at = NOW() WHERE id = %s"
            conn.execute(update_sql, (ticket_id, order_id))

            # 2. Notificar en chat tripartito
            chat_sql = """
                INSERT INTO public.repartofacil_chat_mensajes
                (id, order_id, author_role, author_name, content, timestamp_str, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, NOW())
            """
            conn.execute(chat_sql, (msg_id, order_id, "store", nombre_sucursal, texto, hora_str))

            if hasattr(conn, "commit"):
                conn.commit()

        # 3. Asentamiento auxiliar en Cartera de Clientes y Ventas Mostrador (aislado, no bloqueante)
        try:
            with get_db(empresa_id=empresa_id) as aux_conn:
                existente = None
                try:
                    existente = aux_conn.execute(
                        "SELECT id FROM clientes WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(%s)) OR (telefono IS NOT NULL AND telefono != '' AND telefono = %s) LIMIT 1",
                        (nombre_cliente, tel_cliente)
                    ).fetchone()
                    if not existente:
                        aux_conn.execute(
                            """
                            INSERT INTO clientes (nombre, telefono, direccion, scoring, tipo_cliente, techo_deuda, saldo_actual, saldo_inicial, created_at)
                            VALUES (%s, %s, %s, 'A', 'Web', 0, 0, 0, NOW())
                            """,
                            (nombre_cliente, tel_cliente, dir_cliente)
                        )
                        existente = aux_conn.execute(
                            "SELECT id FROM clientes WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(%s)) LIMIT 1",
                            (nombre_cliente,)
                        ).fetchone()
                    else:
                        aux_conn.execute(
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

                try:
                    cli_id_val = existente["id"] if existente else None
                    total_val = float(order_row["total"] or 0.0) if order_row else 0.0
                    summary_items = ", ".join([
                        f"{it.get('quantity', 1)} {it.get('unit', 'KG')} {it.get('name', 'Corte')}"
                        for it in (items_a_procesar or [])
                    ]) or "Pedido Web Reparto Fácil"
                    fecha_hoy = datetime.now().strftime("%Y-%m-%d")
                    tipo_str = "En Tienda" if str(order_row.get("tipo_entrega") or "").lower() in ("pickup", "takeaway", "retiro", "tienda") else "Delivery"
                    aux_conn.execute(
                        """
                        INSERT INTO ventas_mostrador (cliente_id, producto, monto, tipo_pago, fecha, created_at)
                        VALUES (%s, %s, %s, 'CONTADO', %s, NOW())
                        """,
                        (cli_id_val, f"Ticket #{ticket_id}: {summary_items[:180]} (Web - {tipo_str})", total_val, fecha_hoy)
                    )
                except Exception as vm_err:
                    print(f"[VentasMostrador] Aviso no bloqueante al asentar venta web: {vm_err}")

                if hasattr(aux_conn, "commit"):
                    aux_conn.commit()
        except Exception as aux_err:
            print(f"[Auxiliar] Aviso general al sincronizar cartera/ventas: {aux_err}")

        return jsonify({
            "success": True,
            "order_id": order_id,
            "ticket_id": ticket_id,
            "estado": "confirmed",
            "pago": "Web",
            "mensaje": texto,
            "stock_deducido": True,
            "items_sin_stock": validacion.get("items_sin_stock", [])
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/repartofacil/pedidos/<order_id>/rechazar", methods=["POST"])
def rechazar_repartofacil_pedido(order_id):
    """
    Cobro Fácil rechaza el pedido (por falta de stock o fuera de horario).
    Pasa a 'rejected', restituye el stock reservado si correspondía, no sale a repartidores y notifica en el chat.
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
            order_row, error = _pedido_repartofacil_bloqueado(conn, order_id, empresa_id, {"pending", "pending_store", "confirmed"})
            if error:
                return error

            items_pedido = order_row["items"] if order_row else []
            if isinstance(items_pedido, str):
                try:
                    items_pedido = json.loads(items_pedido)
                except Exception:
                    items_pedido = []

            # Si el pedido estaba confirmado con stock descontado, restituirlo a la tienda física
            if order_row and str(order_row.get("estado") or "").lower() in ("confirmed", "accepted"):
                _restituir_stock_items(items_pedido, empresa_id)

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
            "mensaje": texto,
            "stock_restituido": True
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/repartofacil/metricas-omnicanal", methods=["GET"])
def get_repartofacil_metricas_omnicanal():
    """
    Devuelve las métricas consolidadas en tiempo real:
    - Ventas físicas de mostrador hoy (total y cantidad)
    - Ventas web Reparto Fácil hoy (total y cantidad)
    - Total facturado omnicanal del día
    - Pedidos web activos por estado
    - Estado de sincronización con el servidor de la tienda física
    """
    empresa_id, error = _sesion_empresa_repartofacil()
    if error:
        return error

    try:
        with get_db(empresa_id=empresa_id) as conn:
            fecha_hoy = datetime.now().strftime("%Y-%m-%d")

            # 1. Ventas físicas en mostrador
            vm_row = conn.execute(
                "SELECT COALESCE(SUM(monto), 0) AS total, COUNT(*) AS cant FROM ventas_mostrador WHERE fecha = %s",
                (fecha_hoy,)
            ).fetchone()
            total_mostrador = float(vm_row["total"] or 0.0) if vm_row else 0.0
            cant_mostrador = int(vm_row["cant"] or 0) if vm_row else 0

            # Si en ventas_mostrador no hay filas, consultar las ventas del TPV físico sincronizadas en pos_base
            if total_mostrador == 0 or cant_mostrador == 0:
                try:
                    from app.services.pos_base import filas_de
                    from app.services.pos_jefe import _indice, _valor, _numero
                    cols, rows = filas_de("ventas", sucursal_id=None, desde=fecha_hoy, hasta=fecha_hoy, empresa_id=empresa_id)
                    if rows:
                        idx = _indice(cols)
                        total_mostrador = round(sum(_numero(_valor(r, idx, "total", "monto", "importe")) for r in rows), 2)
                        cant_mostrador = len(rows)
                except Exception:
                    pass

            # 2. Ventas web Reparto Fácil hoy (separando Retiro en Local vs Con Delivery)
            rf_rows = conn.execute(
                """
                SELECT 
                    LOWER(COALESCE(tipo_entrega, 'delivery')) as tipo_entrega,
                    estado,
                    COUNT(*) as cant,
                    COALESCE(SUM(total), 0) as total
                FROM public.repartofacil_pedidos
                WHERE empresa_id = %s AND created_at >= CURRENT_DATE
                GROUP BY LOWER(COALESCE(tipo_entrega, 'delivery')), estado
                """,
                (empresa_id,)
            ).fetchall()

            retiro_monto = 0.0
            retiro_cant = 0
            retiro_activos = 0

            delivery_monto = 0.0
            delivery_cant = 0
            delivery_activos = 0

            ventas_web_hoy = 0.0
            pedidos_web_hoy = 0
            pedidos_activos_web = 0
            pedidos_entregados_hoy = 0
            monto_pendientes_hoy = 0.0
            cant_pendientes_hoy = 0

            for r in rf_rows:
                tipo = str(r["tipo_entrega"] or "").strip().lower()
                est = str(r["estado"] or "").strip().lower()
                c = int(r["cant"] or 0)
                tot = float(r["total"] or 0.0)

                pedidos_web_hoy += c
                es_retiro = tipo in ("pickup", "takeaway", "retiro", "tienda", "mostrador")
                es_activo = est in ("pending", "pending_store", "confirmed", "assigned", "ready", "embalado", "picked up", "in transit")

                if es_retiro:
                    retiro_cant += c
                    retiro_monto += tot
                    if es_activo:
                        retiro_activos += c
                else:
                    delivery_cant += c
                    delivery_monto += tot
                    if es_activo:
                        delivery_activos += c

                if est in ("confirmed", "assigned", "ready", "embalado", "picked up", "in transit", "delivered"):
                    ventas_web_hoy += tot
                if est in ("pending", "pending_store"):
                    monto_pendientes_hoy += tot
                    cant_pendientes_hoy += c
                if es_activo:
                    pedidos_activos_web += c
                if est == "delivered":
                    pedidos_entregados_hoy += c

            total_web_monto = retiro_monto + delivery_monto
            total_web_cant = retiro_cant + delivery_cant
            total_web_activos = retiro_activos + delivery_activos

            # 3. Estado de sincronización de catálogo TPV en pos_base
            pos_info = conn.execute(
                "SELECT COUNT(*) as cant, MAX(actualizado_en) as ult_sync FROM pos_base WHERE empresa_id = %s",
                (empresa_id,)
            ).fetchone()
            cant_tablas_pos = int(pos_info["cant"] or 0) if pos_info else 0
            ult_sync = str(pos_info["ult_sync"] or "") if pos_info else ""

            return jsonify({
                "success": True,
                "fecha": fecha_hoy,
                "ventas_mostrador_hoy": total_mostrador,
                "cant_ventas_mostrador_hoy": cant_mostrador,
                "ventas_web_hoy": ventas_web_hoy,
                "monto_pendientes_hoy": monto_pendientes_hoy,
                "cant_pendientes_hoy": cant_pendientes_hoy,
                "monto_web_total": total_web_monto,
                "cant_pedidos_web_hoy": total_web_cant,
                "pedidos_activos_web": total_web_activos,
                "pedidos_entregados_hoy": pedidos_entregados_hoy,
                "retiro_local_monto": retiro_monto,
                "retiro_local_cant": retiro_cant,
                "retiro_local_activos": retiro_activos,
                "delivery_monto": delivery_monto,
                "delivery_cant": delivery_cant,
                "delivery_activos": delivery_activos,
                "total_web_monto": total_web_monto,
                "total_web_cant": total_web_cant,
                "total_web_activos": total_web_activos,
                "total_omnicanal_hoy": round(total_mostrador + total_web_monto, 2),
                "tpv_conectado": cant_tablas_pos > 0,
                "ultima_sync_tpv": ult_sync or "Automática en tiempo real"
            })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/repartofacil/sincronizar-stock-tpv", methods=["POST"])
def sincronizar_stock_tpv_con_web():
    """
    Fuerza la sincronización inmediata del stock y catálogo del TPV físico con la web.
    Invalida cachés locales y emite señal broadcast.
    """
    empresa_id, error = _sesion_empresa_repartofacil(escritura=True)
    if error:
        return error
    try:
        from app.services.pos_base import _olvidar_tabla
        _olvidar_tabla("productos")
        _olvidar_tabla("articulos")
        _olvidar_tabla("categorias")
        _olvidar_tabla("stock")

        from app.services.signal_bus import broadcast_refresh
        broadcast_refresh(empresa_id, source_device_id="tpv-sync-manual", reason="stock_sincronizado")

        return jsonify({
            "success": True,
            "mensaje": "Stock de tienda física sincronizado con la tienda online Reparto Fácil con éxito."
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
        data = request.get_json(silent=True) or {}
        recargo_espera = 0
        try:
            recargo_espera = int(data.get("recargo_espera") or 0)
        except Exception:
            recargo_espera = 0

        msg_id = f"msg-store-{uuid.uuid4()}"
        hora_str = datetime.now().strftime("%H:%M")

        with get_db(empresa_id=empresa_id) as conn:
            pedido, error = _pedido_repartofacil_bloqueado(
                conn, order_id, empresa_id, {"confirmed", "accepted", "assigned", "ready", "embalado"}
            )
            if error:
                return error
            if str(pedido["estado"]).strip().lower() in {"ready", "embalado"}:
                return jsonify({"success": True, "order_id": order_id, "estado": pedido["estado"]})
            
            tipo_entrega = str(pedido.get("tipo_entrega") or "").strip().lower()
            es_retiro = tipo_entrega in ("pickup", "takeaway", "retiro", "tienda", "mostrador")
            if es_retiro:
                texto = "¡Tu pedido ya está listo para retirar en el mostrador! 🛍️🏪 Te esperamos."
            elif recargo_espera > 0:
                texto = f"Pedido a Frigorífico Maciel: Pedido listo y embalado 📦✅ (Demora de mostrador: se acreditó +${recargo_espera:,} extra de compensación por espera al repartidor ⏱️)"
            else:
                texto = "Pedido a Frigorífico Maciel: Pedido listo y embalado 📦✅"

            if recargo_espera > 0 and pedido.get("repartidor_id"):
                ganancia_actual = float(pedido.get("ganancia_repartidor") or 0)
                nueva_ganancia = ganancia_actual + float(recargo_espera)
                update_sql = "UPDATE public.repartofacil_pedidos SET estado = 'ready', ganancia_repartidor = %s, updated_at = NOW() WHERE id = %s"
                conn.execute(update_sql, (nueva_ganancia, order_id))
            else:
                update_sql = "UPDATE public.repartofacil_pedidos SET estado = 'ready', updated_at = NOW() WHERE id = %s"
                conn.execute(update_sql, (order_id,))
            
            chat_sql = """
                INSERT INTO public.repartofacil_chat_mensajes 
                (id, order_id, author_role, author_name, content, timestamp_str, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, NOW())
            """
            conn.execute(chat_sql, (msg_id, order_id, "store", "Comercio", texto, hora_str))
            
            if hasattr(conn, "commit"):
                conn.commit()
            
        return jsonify({
            "success": True,
            "order_id": order_id,
            "estado": "ready",
            "recargo_espera": recargo_espera,
            "mensaje": texto,
            "timestamp": hora_str
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@api_bp.route("/repartofacil/pedidos/<order_id>/entregar-mostrador", methods=["POST"])
def entregar_pedido_mostrador(order_id):
    """
    Cobro Fácil confirma que el cliente retiró su compra en el mostrador:
    Cambia estado a 'delivered' y notifica en el chat tripartito.
    """
    empresa_id, error = _sesion_empresa_repartofacil(escritura=True)
    if error:
        return error
    try:
        msg_id = f"msg-store-{uuid.uuid4()}"
        hora_str = datetime.now().strftime("%H:%M")
        texto = "Pedido entregado con éxito en el mostrador 🏪✅ ¡Muchas gracias por tu compra!"

        with get_db(empresa_id=empresa_id) as conn:
            pedido, error = _pedido_repartofacil_bloqueado(
                conn, order_id, empresa_id, {"confirmed", "accepted", "ready", "embalado", "delivered"}
            )
            if error:
                return error
            if str(pedido["estado"]).strip().lower() == "delivered":
                return jsonify({"success": True, "order_id": order_id, "estado": "delivered"})

            conn.execute(
                "UPDATE public.repartofacil_pedidos SET estado = 'delivered', updated_at = NOW() WHERE id = %s",
                (order_id,)
            )
            conn.execute(
                """INSERT INTO public.repartofacil_chat_mensajes 
                (id, order_id, author_role, author_name, content, timestamp_str, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, NOW())""",
                (msg_id, order_id, "store", "Comercio", texto, hora_str)
            )
            if hasattr(conn, "commit"):
                conn.commit()

        return jsonify({
            "success": True,
            "order_id": order_id,
            "estado": "delivered",
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
                    tipo_entrega,
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
                "tipo_entrega": d.get("tipo_entrega") or "delivery",
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
            # Registrar lectura por parte del comercio
            try:
                conn.execute(
                    """
                    INSERT INTO public.repartofacil_chat_lecturas (usuario_id, mensaje_id)
                    SELECT %s, m.id FROM public.repartofacil_chat_mensajes m
                    WHERE m.order_id = %s AND LOWER(COALESCE(m.author_role, '')) <> 'store'
                    ON CONFLICT (usuario_id, mensaje_id) DO NOTHING
                    """,
                    (f"store-{empresa_id}", order_id)
                )
                if hasattr(conn, "commit"):
                    conn.commit()
            except Exception:
                if hasattr(conn, "rollback"):
                    conn.rollback()

            sql = """
                SELECT m.id, m.order_id, m.author_role, m.author_name, m.content, m.timestamp_str, m.created_at,
                       EXISTS (
                           SELECT 1 FROM public.repartofacil_chat_lecturas l
                           WHERE l.mensaje_id = m.id AND l.usuario_id <> %s
                       ) AS is_read
                FROM public.repartofacil_pedidos p
                LEFT JOIN public.repartofacil_chat_mensajes m ON m.order_id = p.id
                WHERE p.id = %s AND p.empresa_id = %s
                ORDER BY m.created_at ASC, m.id ASC
            """
            rows = conn.execute(sql, (f"store-{empresa_id}", order_id, empresa_id)).fetchall()
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
