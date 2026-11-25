"""
Servicio de Auditoría de Sincronización entre Cajas TPV.
Detecta y gestiona:
1. Tickets faltantes en la secuencia de correlatividad por terminal y sucursal.
2. Discrepancias de precios de mostrador entre distintas PCs de la misma sucursal.
"""

from __future__ import annotations

import logging
from typing import Any
from app.database import get_db, is_postgres

logger = logging.getLogger(__name__)


def asegurar_tablas_auditoria_sync(conn) -> None:
    """Crea de forma idempotente las tablas de auditoría de sincronización."""
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pos_tickets_faltantes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                empresa_id INTEGER NOT NULL DEFAULT 1,
                sucursal_id INTEGER NOT NULL,
                terminal_id INTEGER,
                machine_id TEXT,
                nro_ticket INTEGER NOT NULL,
                estado TEXT DEFAULT 'PENDIENTE',
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            )
        """)
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_falt_uq
                ON pos_tickets_faltantes(empresa_id, sucursal_id, nro_ticket)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS terminal_precios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                empresa_id INTEGER NOT NULL DEFAULT 1,
                sucursal_id INTEGER NOT NULL,
                terminal_id INTEGER NOT NULL,
                machine_id TEXT NOT NULL,
                producto_id TEXT NOT NULL,
                codigo TEXT,
                nombre TEXT,
                precio REAL NOT NULL DEFAULT 0.0,
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            )
        """)
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_term_precios_uq
                ON terminal_precios(empresa_id, terminal_id, producto_id)
        """)
        if hasattr(conn, "commit"):
            conn.commit()
    except Exception as exc:
        logger.warning("asegurar_tablas_auditoria_sync: %s", exc)


def registrar_tickets_sync(
    empresa_id: int,
    sucursal_id: int,
    terminal_id: int | None,
    machine_id: str,
    tickets_faltantes: list[int],
    tickets_recibidos: list[int],
    no_encontrados: list[int] | None = None,
) -> None:
    """Registra y actualiza el estado de los tickets faltantes detectados durante la subida."""
    no_encontrados = no_encontrados or []
    try:
        with get_db(empresa_id) as conn:
            asegurar_tablas_auditoria_sync(conn)

            # 1. Marcar tickets recibidos como ENCONTRADO
            for nro in tickets_recibidos:
                conn.execute(
                    """UPDATE pos_tickets_faltantes
                       SET estado = 'ENCONTRADO', updated_at = CURRENT_TIMESTAMP
                       WHERE empresa_id = ? AND sucursal_id = ? AND nro_ticket = ?""",
                    (empresa_id, sucursal_id, int(nro)),
                )

            # 2. Marcar tickets no encontrados localmente
            for nro in no_encontrados:
                conn.execute(
                    """UPDATE pos_tickets_faltantes
                       SET estado = 'NO_EXISTE_LOCAL', updated_at = CURRENT_TIMESTAMP
                       WHERE empresa_id = ? AND sucursal_id = ? AND nro_ticket = ?""",
                    (empresa_id, sucursal_id, int(nro)),
                )

            # 3. Registrar o reactivar faltantes como PENDIENTE
            for nro in tickets_faltantes:
                # Verificar si ya existe
                row = conn.execute(
                    """SELECT id, estado FROM pos_tickets_faltantes
                       WHERE empresa_id = ? AND sucursal_id = ? AND nro_ticket = ?
                       LIMIT 1""",
                    (empresa_id, sucursal_id, int(nro)),
                ).fetchone()

                if row:
                    if row["estado"] != "ENCONTRADO":
                        conn.execute(
                            """UPDATE pos_tickets_faltantes
                               SET estado = 'PENDIENTE', terminal_id = ?, machine_id = ?, updated_at = CURRENT_TIMESTAMP
                               WHERE id = ?""",
                            (terminal_id, machine_id, row["id"]),
                        )
                else:
                    conn.execute(
                        """INSERT INTO pos_tickets_faltantes
                           (empresa_id, sucursal_id, terminal_id, machine_id, nro_ticket, estado)
                           VALUES (?, ?, ?, ?, ?, 'PENDIENTE')""",
                        (empresa_id, sucursal_id, terminal_id, machine_id, int(nro)),
                    )

            if hasattr(conn, "commit"):
                conn.commit()
    except Exception as exc:
        logger.warning("registrar_tickets_sync error: %s", exc)


def registrar_precios_sync(
    empresa_id: int,
    sucursal_id: int,
    terminal_id: int,
    machine_id: str,
    articulos: list[dict[str, Any]],
) -> None:
    """Guarda el último precio reportado por cada terminal para cada artículo."""
    if not articulos or not terminal_id:
        return
    try:
        with get_db(empresa_id) as conn:
            asegurar_tablas_auditoria_sync(conn)

            for art in articulos:
                p_id = str(art.get("id_unico") or art.get("id") or "").strip()
                if not p_id:
                    continue
                precio = float(art.get("precio") or 0.0)
                cod = str(art.get("codigo_barras") or art.get("codigo_plu") or "").strip() or None
                nombre = str(art.get("nombre") or "").strip() or "Artículo"

                row = conn.execute(
                    """SELECT id FROM terminal_precios
                       WHERE empresa_id = ? AND terminal_id = ? AND producto_id = ?
                       LIMIT 1""",
                    (empresa_id, terminal_id, p_id),
                ).fetchone()

                if row:
                    conn.execute(
                        """UPDATE terminal_precios
                           SET sucursal_id = ?, machine_id = ?, codigo = ?, nombre = ?, precio = ?, updated_at = CURRENT_TIMESTAMP
                           WHERE id = ?""",
                        (sucursal_id, machine_id, cod, nombre, precio, row["id"]),
                    )
                else:
                    conn.execute(
                        """INSERT INTO terminal_precios
                           (empresa_id, sucursal_id, terminal_id, machine_id, producto_id, codigo, nombre, precio)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        (empresa_id, sucursal_id, terminal_id, machine_id, p_id, cod, nombre, precio),
                    )

            if hasattr(conn, "commit"):
                conn.commit()
    except Exception as exc:
        logger.warning("registrar_precios_sync error: %s", exc)


def obtener_alertas_sync(empresa_id: int = 1, sucursal_id: int | str | None = None) -> dict[str, Any]:
    """
    Obtiene las alertas consolidadas de:
    - Tickets faltantes
    - Discrepancias de precio entre cajas TPV de la misma sucursal
    """
    sid = None
    if sucursal_id is not None and str(sucursal_id).isdigit():
        sid = int(sucursal_id)

    tickets_faltantes: list[dict[str, Any]] = []
    discrepancias_precios: list[dict[str, Any]] = []

    try:
        with get_db(empresa_id) as conn:
            asegurar_tablas_auditoria_sync(conn)

            # 1. Consultar tickets pendientes de sincronización
            query_tf = """
                SELECT tf.nro_ticket, tf.sucursal_id, tf.terminal_id, tf.machine_id, tf.created_at,
                       COALESCE(t.nombre, tf.machine_id) AS terminal_nombre,
                       COALESCE(s.nombre, 'Sucursal ' || tf.sucursal_id) AS sucursal_nombre
                FROM pos_tickets_faltantes tf
                LEFT JOIN terminales t ON tf.terminal_id = t.id
                LEFT JOIN sucursales s ON tf.sucursal_id = s.id
                WHERE tf.empresa_id = ? AND tf.estado = 'PENDIENTE'
            """
            params_tf: list[Any] = [empresa_id]
            if sid is not None:
                query_tf += " AND tf.sucursal_id = ?"
                params_tf.append(sid)
            query_tf += " ORDER BY tf.nro_ticket ASC LIMIT 50"

            rows_tf = conn.execute(query_tf, tuple(params_tf)).fetchall()
            for r in rows_tf:
                tickets_faltantes.append({
                    "nro_ticket": r["nro_ticket"],
                    "sucursal_id": r["sucursal_id"],
                    "sucursal_nombre": r["sucursal_nombre"],
                    "terminal_id": r["terminal_id"],
                    "terminal_nombre": r["terminal_nombre"],
                    "machine_id": r["machine_id"],
                })

            # 2. Consultar discrepancias de precios entre terminales activas de la misma sucursal
            query_disc = """
                SELECT p1.producto_id, p1.nombre, p1.codigo, p1.sucursal_id,
                       COALESCE(s.nombre, 'Sucursal ' || p1.sucursal_id) AS sucursal_nombre,
                       t1.id AS t1_id, COALESCE(t1.nombre, p1.machine_id) AS t1_nombre, p1.precio AS precio_1,
                       t2.id AS t2_id, COALESCE(t2.nombre, p2.machine_id) AS t2_nombre, p2.precio AS precio_2
                FROM terminal_precios p1
                JOIN terminal_precios p2 ON p1.empresa_id = p2.empresa_id
                                        AND p1.sucursal_id = p2.sucursal_id
                                        AND p1.producto_id = p2.producto_id
                                        AND p1.terminal_id < p2.terminal_id
                JOIN terminales t1 ON p1.terminal_id = t1.id
                JOIN terminales t2 ON p2.terminal_id = t2.id
                LEFT JOIN sucursales s ON p1.sucursal_id = s.id
                WHERE p1.empresa_id = ?
                  AND t1.activo = 1 AND t2.activo = 1
                  AND ABS(p1.precio - p2.precio) > 0.01
            """
            params_disc: list[Any] = [empresa_id]
            if sid is not None:
                query_disc += " AND p1.sucursal_id = ?"
                params_disc.append(sid)
            query_disc += " ORDER BY ABS(p1.precio - p2.precio) DESC LIMIT 50"

            rows_disc = conn.execute(query_disc, tuple(params_disc)).fetchall()
            for r in rows_disc:
                p1_val = float(r["precio_1"] or 0.0)
                p2_val = float(r["precio_2"] or 0.0)
                discrepancias_precios.append({
                    "producto_id": r["producto_id"],
                    "nombre": r["nombre"],
                    "codigo": r["codigo"],
                    "sucursal_id": r["sucursal_id"],
                    "sucursal_nombre": r["sucursal_nombre"],
                    "precios": [
                        {"terminal": r["t1_nombre"], "precio": p1_val},
                        {"terminal": r["t2_nombre"], "precio": p2_val},
                    ],
                    "diferencia": round(abs(p1_val - p2_val), 2),
                })

    except Exception as exc:
        logger.warning("obtener_alertas_sync error: %s", exc)

    # 3. También detectar huecos de tickets en las ventas del período si no hubiera en la tabla de faltantes
    if not tickets_faltantes:
        try:
            from app.services.pos_base import filas_de
            cols, filas = filas_de("ventas", sid, empresa_id=empresa_id)
            if cols and filas:
                from app.services.pos_jefe import _indice, _valor
                idx = _indice(cols)
                nums = []
                for f in filas[:200]:
                    val = _valor(f, idx, "id", "nro_ticket", "ticket_id")
                    if str(val).isdigit():
                        nums.append(int(val))
                if len(nums) > 1:
                    min_n = min(nums)
                    max_n = max(nums)
                    if 1 < (max_n - min_n) <= 200:
                        set_n = set(nums)
                        for n in range(min_n, max_n + 1):
                            if n not in set_n:
                                tickets_faltantes.append({
                                    "nro_ticket": n,
                                    "sucursal_id": sid,
                                    "sucursal_nombre": f"Sucursal {sid}" if sid else "General",
                                    "terminal_id": None,
                                    "terminal_nombre": "Detectado por secuencia",
                                    "machine_id": "",
                                })
                                if len(tickets_faltantes) >= 20:
                                    break
        except Exception:
            pass

    tiene_alertas = bool(tickets_faltantes or discrepancias_precios)
    numeros_faltantes = [t["nro_ticket"] for t in tickets_faltantes]

    return {
        "tiene_alertas": tiene_alertas,
        "tickets_faltantes": tickets_faltantes,
        "numeros_faltantes": numeros_faltantes,
        "discrepancias_precios": discrepancias_precios,
        "total_faltantes": len(tickets_faltantes),
        "total_discrepancias": len(discrepancias_precios),
        "total_alertas": len(tickets_faltantes) + len(discrepancias_precios),
    }
