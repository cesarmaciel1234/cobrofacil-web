"""
Servicio de Auditoría de Inventario para Cobro Fácil POS / Web.
Mantiene paridad exacta con el motor de escritorio (src/cerebro_global/auditoria/motor_auditoria.py).
Permite conteo físico táctil, escaneo por cámara de celular y ajuste SET inmediato.
Soporta dualidad: MariaDB (192.168.0.8) en red directa y pos_base (PostgreSQL/SQLite) en la nube/offline.
"""

import json
import logging
import os
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("pos_inventario")

MARIADB_HOST = os.environ.get("POS_MARIADB_HOST", "192.168.0.8")
MARIADB_PORT = int(os.environ.get("POS_MARIADB_PORT", "3306"))
MARIADB_USER = os.environ.get("POS_MARIADB_USER", "root")
MARIADB_PASS = os.environ.get("POS_MARIADB_PASS", "1234")
MARIADB_DB = os.environ.get("POS_MARIADB_DB", "punpro_db")


def _conectar_mariadb(timeout: float = 0.5):
    # En entornos cloud (Render, Heroku, etc.) las IPs privadas 192.168.0.x no existen
    if os.environ.get("RENDER") or os.environ.get("DYNO"):
        return None

    # Pre-chequeo ultra rápido por socket (300ms) para evitar bloqueos del handshake TCP en Windows/Linux
    import socket
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(0.3)
        res = sock.connect_ex((MARIADB_HOST, MARIADB_PORT))
        sock.close()
        if res != 0:
            return None
    except Exception:
        return None

    try:
        import pymysql

        conn = pymysql.connect(
            host=MARIADB_HOST,
            port=MARIADB_PORT,
            user=MARIADB_USER,
            password=MARIADB_PASS,
            database=MARIADB_DB,
            connect_timeout=timeout,
            read_timeout=timeout + 1,
            write_timeout=timeout + 1,
            charset="utf8mb4",
            autocommit=True,
        )
        return conn
    except Exception as exc:
        logger.debug("MariaDB no disponible (%s): %s", MARIADB_HOST, exc)
        return None


def asegurar_tabla_local(conn) -> None:
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS auditorias_inventario (
                id SERIAL PRIMARY KEY,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                producto_id INTEGER,
                nombre_producto TEXT,
                stock_sistema REAL,
                stock_fisico REAL,
                diferencia REAL,
                responsable TEXT,
                motivo TEXT,
                sync_id VARCHAR(36)
            )
        """)
        try:
            conn.commit()
        except Exception:
            pass
    except Exception as exc:
        logger.debug("No se pudo crear auditorias_inventario local: %s", exc)


def obtener_catalogo_auditoria(sucursal_id: Optional[int] = None, empresa_id: int = 1) -> Dict[str, Any]:
    """
    Retorna el catálogo completo con stock vivo, métricas y los conteos de hoy.
    Prioriza MariaDB 192.168.0.8 si está conectada; de lo contrario lee pos_base.
    """
    productos: List[Dict[str, Any]] = []
    auditorias_hoy: List[Dict[str, Any]] = []
    fuente = "local"

    # 1. Intentar MariaDB viva
    conn_mb = _conectar_mariadb()
    if conn_mb:
        try:
            with conn_mb.cursor() as cur:
                cur.execute("""
                    SELECT id, codigo, nombre, departamento, stock, precio, costo, unidad, es_pesable
                    FROM productos
                    ORDER BY nombre ASC
                """)
                filas_mb = cur.fetchall()
                for f in filas_mb:
                    unidad = str(f[7] or "UN").strip().upper()
                    pesable = bool(f[8]) or unidad in ("KG", "KILO", "KILOS")
                    productos.append({
                        "id": int(f[0]),
                        "codigo": str(f[1] or ""),
                        "nombre": str(f[2] or "").strip(),
                        "departamento": str(f[3] or "GENERAL").strip().upper(),
                        "stock": round(float(f[4] or 0.0), 3),
                        "precio": round(float(f[5] or 0.0), 2),
                        "costo": round(float(f[6] or 0.0), 2),
                        "unidad": "KG" if pesable else (unidad or "UN"),
                        "es_pesable": pesable,
                    })

                cur.execute("""
                    SELECT id, fecha, producto_id, nombre_producto, stock_sistema, stock_fisico, diferencia, responsable, motivo, sync_id
                    FROM auditorias_inventario
                    WHERE DATE(fecha) = CURDATE()
                    ORDER BY id DESC
                """)
                for a in cur.fetchall():
                    auditorias_hoy.append({
                        "id": a[0],
                        "fecha": str(a[1]) if a[1] else "",
                        "producto_id": a[2],
                        "nombre_producto": a[3] or "",
                        "stock_sistema": round(float(a[4] or 0.0), 3),
                        "stock_fisico": round(float(a[5] or 0.0), 3),
                        "diferencia": round(float(a[6] or 0.0), 3),
                        "responsable": a[7] or "",
                        "motivo": a[8] or "",
                        "sync_id": a[9] or "",
                    })
                fuente = "mariadb_maestra"
        except Exception as exc:
            logger.warning("Error leyendo catálogo de MariaDB: %s", exc)
        finally:
            try:
                conn_mb.close()
            except Exception:
                pass

    # 2. Si MariaDB no respondió, caer a pos_base (PostgreSQL)
    departamentos_tpv: List[str] = []
    from app.services.pos_base import filas_de

    for tabla_dep in ("departamentos", "categorias"):
        try:
            col_d, filas_d = filas_de(tabla_dep, sucursal_id, empresa_id=empresa_id)
            if col_d and filas_d:
                id_nom = col_d.index("nombre") if "nombre" in col_d else 1
                for fd in filas_d:
                    nom_d = str(fd[id_nom] or "").strip().upper()
                    if nom_d and nom_d not in departamentos_tpv:
                        departamentos_tpv.append(nom_d)
        except Exception:
            pass

    if not productos:
        col_p, filas_p = filas_de("productos", sucursal_id, empresa_id=empresa_id)
        if col_p:
            idx = {col: i for i, col in enumerate(col_p)}
            for fila in filas_p:
                pid = fila[idx.get("id", 0)]
                nombre = str(fila[idx.get("nombre", 1)] or "").strip()
                if not nombre:
                    continue
                codigo = str(fila[idx.get("codigo", 0)] or "" if "codigo" in idx else "").strip()
                raw_depto = str(fila[idx["departamento"]] or "").strip() if "departamento" in idx else ""
                raw_cat = str(fila[idx["categoria"]] or "").strip() if "categoria" in idx else ""
                depto = (raw_depto or raw_cat or "GENERAL").upper()
                if depto not in departamentos_tpv:
                    departamentos_tpv.append(depto)
                stock = float(fila[idx.get("stock", 0)] or 0.0 if "stock" in idx else 0.0)
                precio = float(fila[idx.get("precio", 0)] or 0.0 if "precio" in idx else 0.0)
                costo = float(fila[idx.get("costo", 0)] or 0.0 if "costo" in idx else 0.0)
                unidad = str(fila[idx.get("unidad", 0)] or "UN" if "unidad" in idx else "UN").strip().upper()
                pesable = bool(fila[idx.get("es_pesable", 0)] if "es_pesable" in idx else False) or unidad in ("KG", "KILO", "KILOS")

                productos.append({
                    "id": int(pid) if str(pid).isdigit() else pid,
                    "codigo": codigo,
                    "nombre": nombre,
                    "departamento": depto or "GENERAL",
                    "categoria": (raw_cat or depto or "GENERAL").upper(),
                    "stock": round(stock, 3),
                    "precio": round(precio, 2),
                    "costo": round(costo, 2),
                    "unidad": "KG" if pesable else (unidad or "UN"),
                    "es_pesable": pesable,
                })

        # Cargar auditorías de hoy de la base local
        from app.database import get_db

        try:
            with get_db(empresa_id) as conn:
                asegurar_tabla_local(conn)
                filas_aud = conn.execute("""
                    SELECT id, fecha, producto_id, nombre_producto, stock_sistema, stock_fisico, diferencia, responsable, motivo, sync_id
                    FROM auditorias_inventario
                    WHERE CAST(fecha AS DATE) = CURRENT_DATE
                    ORDER BY id DESC
                """).fetchall()
                for a in filas_aud:
                    auditorias_hoy.append({
                        "id": a[0],
                        "fecha": str(a[1]) if a[1] else "",
                        "producto_id": a[2],
                        "nombre_producto": a[3] or "",
                        "stock_sistema": round(float(a[4] or 0.0), 3),
                        "stock_fisico": round(float(a[5] or 0.0), 3),
                        "diferencia": round(float(a[6] or 0.0), 3),
                        "responsable": a[7] or "",
                        "motivo": a[8] or "",
                        "sync_id": a[9] or "",
                    })
        except Exception as exc:
            logger.debug("Error leyendo auditorías locales: %s", exc)

    # Mapear los últimos conteos de hoy a cada producto
    ultimos_conteos = {}
    for aud in auditorias_hoy:
        pid = aud["producto_id"]
        if pid not in ultimos_conteos:
            ultimos_conteos[pid] = aud

    auditados_cnt = 0
    con_diferencia_cnt = 0
    faltantes_cnt = 0
    sobrantes_cnt = 0
    quiebre_cnt = 0

    for prod in productos:
        pid = prod["id"]
        aud = ultimos_conteos.get(pid)
        if aud:
            prod["auditado_hoy"] = True
            prod["ultimo_conteo"] = aud["stock_fisico"]
            prod["diferencia"] = aud["diferencia"]
            prod["fecha_conteo"] = aud["fecha"]
            prod["responsable"] = aud["responsable"]
            auditados_cnt += 1
            if abs(aud["diferencia"]) > 0.001:
                con_diferencia_cnt += 1
                if aud["diferencia"] < 0:
                    faltantes_cnt += 1
                else:
                    sobrantes_cnt += 1
        else:
            prod["auditado_hoy"] = False
            prod["ultimo_conteo"] = None
            prod["diferencia"] = None

        if prod["stock"] <= 0.0001:
            quiebre_cnt += 1

    conteo_deptos: Dict[str, int] = {}
    for d in departamentos_tpv:
        conteo_deptos[d] = 0
    for prod in productos:
        d = (prod.get("departamento") or "GENERAL").upper()
        conteo_deptos[d] = conteo_deptos.get(d, 0) + 1

    lista_departamentos = [
        {"nombre": d, "cantidad": c}
        for d, c in sorted(conteo_deptos.items(), key=lambda x: (-x[1], x[0]))
        if d
    ]

    return {
        "ok": True,
        "fuente": fuente,
        "productos": productos,
        "departamentos": lista_departamentos,
        "resumen": {
            "total_sku": len(productos),
            "auditados": auditados_cnt,
            "pendientes": len(productos) - auditados_cnt,
            "con_diferencia": con_diferencia_cnt,
            "faltantes": faltantes_cnt,
            "sobrantes": sobrantes_cnt,
            "quiebre": quiebre_cnt,
        },
        "auditorias_hoy": auditorias_hoy,
    }


def crear_producto_catalogo(
    nombre: str,
    codigo: str = "",
    precio: float = 0.0,
    stock: float = 0.0,
    unidad: str = "UN",
    departamento: str = "GENERAL",
    sucursal_id: Optional[int] = None,
    empresa_id: int = 1,
) -> Dict[str, Any]:
    """
    Alta rápida de un artículo en el catálogo (pos_base.productos) del esquema
    de la empresa en sesión. Valida que el código de barras no esté repetido.
    """
    nombre = (nombre or "").strip()
    codigo = (codigo or "").strip()
    if not nombre:
        return {"ok": False, "error": "El nombre es obligatorio"}
    try:
        precio = round(float(precio or 0), 2)
        stock = round(float(stock or 0), 3)
    except (TypeError, ValueError):
        return {"ok": False, "error": "Precio o stock inválidos"}
    unidad = (unidad or "UN").strip().upper()
    pesable = unidad in ("KG", "KILO", "KILOS")
    departamento = (departamento or "GENERAL").strip().upper()

    from app.database import get_db

    try:
        with get_db(empresa_id) as conn:
            sql = "SELECT id, sucursal_id, columnas, filas FROM pos_base WHERE tabla = 'productos'"
            params: tuple = ()
            if sucursal_id is not None:
                sql += " AND sucursal_id = ?"
                params = (sucursal_id,)
            sql += " ORDER BY id DESC"
            partes = conn.execute(sql, params).fetchall()
            if not partes and sucursal_id is not None:
                partes = conn.execute(
                    "SELECT id, sucursal_id, columnas, filas FROM pos_base WHERE tabla = 'productos' ORDER BY id DESC"
                ).fetchall()
            if not partes:
                return {"ok": False, "error": "La sucursal todavía no sincronizó un catálogo base"}

            def _cargar(v):
                return v if isinstance(v, list) else json.loads(v or "[]")

            cols = _cargar(partes[0]["columnas"])
            idx = {c: i for i, c in enumerate(cols)}
            max_id = 0
            for parte in partes:
                for r in _cargar(parte["filas"]):
                    try:
                        max_id = max(max_id, int(r[idx.get("id", 0)]))
                    except (TypeError, ValueError):
                        pass
                    if codigo and "codigo" in idx and str(r[idx["codigo"]] or "").strip() == codigo:
                        return {"ok": False, "error": f"El código {codigo} ya existe ({r[idx.get('nombre', 1)]})"}
                    if str(r[idx.get("nombre", 1)] or "").strip().lower() == nombre.lower():
                        return {"ok": False, "error": f"Ya existe un artículo llamado {nombre}"}

            nuevo_id = max_id + 1
            if not codigo:
                codigo = str(nuevo_id)
            valores = {
                "id": nuevo_id, "nombre": nombre, "precio": precio, "stock": stock,
                "unidad": "KG" if pesable else unidad, "costo": 0, "codigo": codigo,
                "departamento": departamento, "categoria": None, "es_pesable": 1 if pesable else 0,
                "stock_minimo": 0, "stock_maximo": 0,
            }
            fila = [valores.get(c) for c in cols]

            destino = partes[0]
            filas = _cargar(destino["filas"])
            filas.append(fila)
            conn.execute(
                "UPDATE pos_base SET filas = ?, cantidad = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?",
                (json.dumps(filas), len(filas), destino["id"]),
            )
            try:
                conn.commit()
            except Exception:
                pass
    except Exception as exc:
        logger.error("Error creando producto en catálogo: %s", exc)
        return {"ok": False, "error": str(exc)}

    try:
        from app.services.pos_base import _olvidar_tabla
        _olvidar_tabla("productos")
    except Exception:
        pass

    return {
        "ok": True,
        "producto": {
            "id": nuevo_id, "codigo": codigo, "nombre": nombre, "departamento": departamento,
            "stock": stock, "precio": precio, "costo": 0.0,
            "unidad": "KG" if pesable else unidad, "es_pesable": pesable,
            "auditado_hoy": False, "ultimo_conteo": None, "diferencia": None,
        },
    }


def registrar_ajuste_inventario(
    producto_id: int,
    stock_fisico: float,
    responsable: str = "Admin",
    motivo: str = "Recuento físico",
    sucursal_id: Optional[int] = None,
    empresa_id: int = 1,
    precio: Optional[float] = None,
    departamento: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Aplica el ajuste SET inmediato de stock (y opcionalmente precio y departamento)
    en MariaDB y pos_base. Registra el evento en auditorias_inventario.
    """
    try:
        pid = int(producto_id)
        stock_nuevo = round(float(stock_fisico), 3)
        precio_nuevo = round(float(precio), 2) if precio is not None and str(precio) != "" else None
    except (TypeError, ValueError) as exc:
        return {"ok": False, "error": f"Valores numéricos inválidos: {exc}"}

    depto_nuevo = str(departamento).strip().upper() if departamento else None

    if stock_nuevo < 0:
        return {"ok": False, "error": "El stock físico no puede ser negativo"}

    sync_id = str(uuid.uuid4())
    fecha_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 1. Obtener producto y stock anterior
    stock_anterior = 0.0
    nombre_producto = ""

    conn_mb = _conectar_mariadb()
    actualizado_mb = False

    if conn_mb:
        try:
            with conn_mb.cursor() as cur:
                cur.execute("SELECT id, nombre, stock FROM productos WHERE id = %s", (pid,))
                row = cur.fetchone()
                if row:
                    nombre_producto = row[1] or ""
                    stock_anterior = round(float(row[2] or 0.0), 3)

                # Aplicar SET directo en MariaDB
                cur.execute("UPDATE productos SET stock = %s WHERE id = %s", (stock_nuevo, pid))
                diferencia = round(stock_nuevo - stock_anterior, 3)

                # Registrar auditoría
                cur.execute("""
                    INSERT INTO auditorias_inventario
                    (sync_id, fecha, producto_id, nombre_producto, stock_sistema, stock_fisico, diferencia, responsable, motivo)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    sync_id,
                    fecha_str,
                    pid,
                    nombre_producto,
                    stock_anterior,
                    stock_nuevo,
                    diferencia,
                    responsable or "Admin",
                    motivo or "Recuento físico",
                ))
                actualizado_mb = True
        except Exception as exc:
            logger.error("Error aplicando ajuste en MariaDB: %s", exc)
        finally:
            try:
                conn_mb.close()
            except Exception:
                pass

    # 2. Actualizar pos_base (PostgreSQL) y registrar localmente
    from app.database import get_db

    diferencia = round(stock_nuevo - stock_anterior, 3)

    try:
        with get_db(empresa_id) as conn:
            asegurar_tabla_local(conn)

            # Si MariaDB no estaba, leer nombre y stock anterior de pos_base
            partes_pb = conn.execute(
                "SELECT id, columnas, filas FROM pos_base WHERE tabla = 'productos'"
            ).fetchall()
            if not actualizado_mb and partes_pb:
                for row_base in partes_pb:
                    cols = row_base["columnas"] if isinstance(row_base["columnas"], list) else json.loads(row_base["columnas"])
                    filas = row_base["filas"] if isinstance(row_base["filas"], list) else json.loads(row_base["filas"])
                    id_idx = cols.index("id") if "id" in cols else 0
                    nom_idx = cols.index("nombre") if "nombre" in cols else 1
                    stk_idx = cols.index("stock") if "stock" in cols else 3
                    for r in filas:
                        if str(r[id_idx]) == str(pid):
                            nombre_producto = r[nom_idx]
                            stock_anterior = round(float(r[stk_idx] or 0.0), 3)
                            diferencia = round(stock_nuevo - stock_anterior, 3)
                            break

            # Guardar en tabla local de auditorías
            conn.execute("""
                INSERT INTO auditorias_inventario
                (sync_id, fecha, producto_id, nombre_producto, stock_sistema, stock_fisico, diferencia, responsable, motivo)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                sync_id,
                fecha_str,
                pid,
                nombre_producto,
                stock_anterior,
                stock_nuevo,
                diferencia,
                responsable or "Admin",
                motivo or "Ajuste de inventario",
            ))

            # Actualizar filas de productos en pos_base (stock, precio, departamento)
            for row_pb in partes_pb:
                cols = row_pb["columnas"] if isinstance(row_pb["columnas"], list) else json.loads(row_pb["columnas"])
                filas = row_pb["filas"] if isinstance(row_pb["filas"], list) else json.loads(row_pb["filas"])
                id_idx = cols.index("id") if "id" in cols else 0
                stk_idx = cols.index("stock") if "stock" in cols else 3
                pre_idx = cols.index("precio") if "precio" in cols else None
                dep_idx = cols.index("departamento") if "departamento" in cols else None
                cat_idx = cols.index("categoria") if "categoria" in cols else None
                modificado = False
                for r in filas:
                    if str(r[id_idx]) == str(pid):
                        r[stk_idx] = stock_nuevo
                        if precio_nuevo is not None and pre_idx is not None:
                            r[pre_idx] = precio_nuevo
                        if depto_nuevo:
                            if dep_idx is not None:
                                r[dep_idx] = depto_nuevo
                            if cat_idx is not None:
                                r[cat_idx] = depto_nuevo
                        modificado = True
                if modificado:
                    conn.execute(
                        "UPDATE pos_base SET filas = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?",
                        (json.dumps(filas), row_pb["id"]),
                    )
            try:
                conn.commit()
            except Exception:
                pass
    except Exception as exc:
        logger.error("Error actualizando pos_base: %s", exc)

    # 3. Limpiar memoria caché de pos_base
    try:
        from app.services.pos_base import _olvidar_tabla

        _olvidar_tabla("productos")
    except Exception:
        pass

    # 4. Difundir por WebSocket / SignalBus
    try:
        from app.services.signal_bus import broadcast_refresh

        broadcast_refresh(empresa_id, reason="inventario")
    except Exception:
        pass

    return {
        "ok": True,
        "sync_id": sync_id,
        "producto_id": pid,
        "nombre_producto": nombre_producto,
        "stock_anterior": stock_anterior,
        "stock_nuevo": stock_nuevo,
        "diferencia": diferencia,
        "fecha": fecha_str,
        "responsable": responsable,
        "mariadb_actualizada": actualizado_mb,
    }


def obtener_historial_auditorias(limite: int = 50, empresa_id: int = 1) -> List[Dict[str, Any]]:
    """Devuelve las últimas auditorías registradas."""
    historial: List[Dict[str, Any]] = []

    conn_mb = _conectar_mariadb()
    if conn_mb:
        try:
            with conn_mb.cursor() as cur:
                cur.execute("""
                    SELECT id, fecha, producto_id, nombre_producto, stock_sistema, stock_fisico, diferencia, responsable, motivo, sync_id
                    FROM auditorias_inventario
                    ORDER BY id DESC
                    LIMIT %s
                """, (limite,))
                for a in cur.fetchall():
                    historial.append({
                        "id": a[0],
                        "fecha": str(a[1]) if a[1] else "",
                        "producto_id": a[2],
                        "nombre_producto": a[3] or "",
                        "stock_sistema": round(float(a[4] or 0.0), 3),
                        "stock_fisico": round(float(a[5] or 0.0), 3),
                        "diferencia": round(float(a[6] or 0.0), 3),
                        "responsable": a[7] or "",
                        "motivo": a[8] or "",
                        "sync_id": a[9] or "",
                    })
                return historial
        except Exception as exc:
            logger.warning("Error leyendo historial de MariaDB: %s", exc)
        finally:
            try:
                conn_mb.close()
            except Exception:
                pass

    # Si MariaDB no está disponible, leer de la base local
    from app.database import get_db

    try:
        with get_db(empresa_id) as conn:
            asegurar_tabla_local(conn)
            filas = conn.execute("""
                SELECT id, fecha, producto_id, nombre_producto, stock_sistema, stock_fisico, diferencia, responsable, motivo, sync_id
                FROM auditorias_inventario
                ORDER BY id DESC
                LIMIT ?
            """, (limite,)).fetchall()
            for a in filas:
                historial.append({
                    "id": a[0],
                    "fecha": str(a[1]) if a[1] else "",
                    "producto_id": a[2],
                    "nombre_producto": a[3] or "",
                    "stock_sistema": round(float(a[4] or 0.0), 3),
                    "stock_fisico": round(float(a[5] or 0.0), 3),
                    "diferencia": round(float(a[6] or 0.0), 3),
                    "responsable": a[7] or "",
                    "motivo": a[8] or "",
                    "sync_id": a[9] or "",
                })
    except Exception as exc:
        logger.debug("Error leyendo historial local: %s", exc)

    return historial
