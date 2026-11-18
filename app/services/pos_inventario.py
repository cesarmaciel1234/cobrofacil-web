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


def _conectar_mariadb(timeout: float = 2.0):
    try:
        import pymysql

        conn = pymysql.connect(
            host=MARIADB_HOST,
            port=MARIADB_PORT,
            user=MARIADB_USER,
            password=MARIADB_PASS,
            database=MARIADB_DB,
            connect_timeout=timeout,
            read_timeout=timeout + 2,
            write_timeout=timeout + 2,
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
    if not productos:
        from app.services.pos_base import filas_de

        col_p, filas_p = filas_de("productos", sucursal_id, empresa_id=empresa_id)
        if col_p:
            idx = {col: i for i, col in enumerate(col_p)}
            for fila in filas_p:
                pid = fila[idx.get("id", 0)]
                nombre = str(fila[idx.get("nombre", 1)] or "").strip()
                if not nombre:
                    continue
                codigo = str(fila[idx.get("codigo", 0)] if "codigo" in idx else "")
                depto = str(fila[idx.get("departamento", 0)] if "departamento" in idx else (fila[idx.get("categoria", 0)] if "categoria" in idx else "GENERAL")).strip().upper()
                stock = float(fila[idx.get("stock", 0)] if "stock" in idx else 0.0)
                precio = float(fila[idx.get("precio", 0)] if "precio" in idx else 0.0)
                costo = float(fila[idx.get("costo", 0)] if "costo" in idx else 0.0)
                unidad = str(fila[idx.get("unidad", 0)] if "unidad" in idx else "UN").strip().upper()
                pesable = bool(fila[idx.get("es_pesable", 0)] if "es_pesable" in idx else False) or unidad in ("KG", "KILO", "KILOS")

                productos.append({
                    "id": int(pid) if str(pid).isdigit() else pid,
                    "codigo": codigo,
                    "nombre": nombre,
                    "departamento": depto or "GENERAL",
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

    return {
        "ok": True,
        "fuente": fuente,
        "productos": productos,
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


def registrar_ajuste_inventario(
    producto_id: int,
    stock_fisico: float,
    responsable: str = "Admin",
    motivo: str = "Recuento físico",
    sucursal_id: Optional[int] = None,
    empresa_id: int = 1,
) -> Dict[str, Any]:
    """
    Aplica el ajuste SET inmediato de stock en MariaDB y pos_base.
    Registra el evento en auditorias_inventario con sync_id idempotente.
    """
    try:
        pid = int(producto_id)
        stock_nuevo = round(float(stock_fisico), 3)
    except (TypeError, ValueError) as exc:
        return {"ok": False, "error": f"Valores numéricos inválidos: {exc}"}

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
            if not actualizado_mb:
                row_base = conn.execute(
                    "SELECT columnas, filas FROM pos_base WHERE empresa_id = ? AND tabla = 'productos' LIMIT 1",
                    (empresa_id,),
                ).fetchone()
                if row_base:
                    cols = row_base["columnas"] if isinstance(row_base["columnas"], list) else json.loads(row_base["columnas"])
                    filas = row_base["filas"] if isinstance(row_base["filas"], list) else json.loads(row_base["filas"])
                    id_idx = cols.index("id") if "id" in cols else 0
                    nom_idx = cols.index("nombre") if "nombre" in cols else 1
                    stk_idx = cols.index("stock") if "stock" in cols else 3
                    for r in filas:
                        if r[id_idx] == pid:
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
                motivo or "Recuento físico",
            ))

            # Actualizar filas de productos en pos_base
            row_pb = conn.execute(
                "SELECT columnas, filas FROM pos_base WHERE empresa_id = ? AND tabla = 'productos'",
                (empresa_id,),
            ).fetchone()
            if row_pb:
                cols = row_pb["columnas"] if isinstance(row_pb["columnas"], list) else json.loads(row_pb["columnas"])
                filas = row_pb["filas"] if isinstance(row_pb["filas"], list) else json.loads(row_pb["filas"])
                id_idx = cols.index("id") if "id" in cols else 0
                stk_idx = cols.index("stock") if "stock" in cols else 3
                modificado = False
                for r in filas:
                    if r[id_idx] == pid:
                        r[stk_idx] = stock_nuevo
                        modificado = True
                        break
                if modificado:
                    conn.execute(
                        "UPDATE pos_base SET filas = ?, actualizado_en = CURRENT_TIMESTAMP WHERE empresa_id = ? AND tabla = 'productos'",
                        (json.dumps(filas), empresa_id),
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
