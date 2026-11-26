from datetime import date
from app.database import get_db
from app.utils import current_empresa_id, current_sucursal_id

def registrar_lote_bulk(
    kg_totales: float,
    costo_total_bulk: float,
    costo_reparto: float = 0,
    fecha: str = None,
    numero_lote: str = None,
    fecha_vencimiento: str = None,
    proveedor: str = None,
    empresa_id: int = None,
    sucursal_id: int = None,
) -> int:
    if kg_totales <= 0:
        raise ValueError("Los kilos totales deben ser mayores a 0")
    if costo_total_bulk <= 0:
        raise ValueError("El costo total bulk debe ser mayor a 0")
    if costo_reparto < 0:
        raise ValueError("El costo de reparto no puede ser negativo")
    
    if not fecha:
        fecha = date.today().isoformat()
        
    eid = empresa_id if empresa_id is not None else current_empresa_id()
    sid = sucursal_id if sucursal_id is not None else current_sucursal_id()
    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT INTO compras_bulk (fecha, kg_totales, kg_remanentes, costo_total_bulk, costo_reparto, numero_lote, fecha_vencimiento, proveedor, empresa_id, sucursal_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fecha,
                kg_totales,
                kg_totales,
                costo_total_bulk,
                costo_reparto,
                numero_lote.strip() if numero_lote else None,
                fecha_vencimiento.strip() if fecha_vencimiento else None,
                proveedor.strip() if proveedor else None,
                eid,
                sid,
            ),
        )
        lote_id = cur.lastrowid
    return lote_id

def list_bulk_lots(empresa_id: int = None) -> list[dict]:
    eid = empresa_id if empresa_id is not None else current_empresa_id()
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, fecha, kg_totales, kg_remanentes, costo_total_bulk, costo_reparto,
                   numero_lote, fecha_vencimiento, proveedor, created_at
            FROM compras_bulk WHERE empresa_id = ? ORDER BY id DESC
            """,
            (eid,),
        ).fetchall()
        
    out = []
    for row in rows:
        r = dict(row)
        costo_kg = r["costo_total_bulk"] / r["kg_totales"]
        out.append({
            "id": r["id"],
            "fecha": r["fecha"],
            "kg_totales": r["kg_totales"],
            "kg_remanentes": r["kg_remanentes"],
            "costo_total_bulk": r["costo_total_bulk"],
            "costo_reparto": r["costo_reparto"],
            "costo_kg": round(costo_kg, 2),
            "activo": r["kg_remanentes"] > 0,
            "numero_lote": r.get("numero_lote") or "",
            "fecha_vencimiento": r.get("fecha_vencimiento") or "",
            "proveedor": r.get("proveedor") or "",
            "created_at": r["created_at"]
        })
    return out

def eliminar_lote_bulk(lote_id: int, empresa_id: int = None) -> dict:
    """Elimina un lote bulk sin ventas asociadas (carga errónea)."""
    eid = empresa_id if empresa_id is not None else current_empresa_id()
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, kg_totales, kg_remanentes, numero_lote FROM compras_bulk WHERE id = ? AND empresa_id = ?",
            (lote_id, eid),
        ).fetchone()
        if not row:
            raise ValueError("Lote no encontrado")
        used_row = conn.execute(
            "SELECT COALESCE(SUM(kg_descontados), 0) AS kg FROM remitos_fracciones WHERE lote_id = ?",
            (lote_id,),
        ).fetchone()
        kg_usados = float(used_row["kg"] or 0) if used_row else 0.0
        if kg_usados > 0:
            raise ValueError(
                "No se puede eliminar: este lote ya tiene remitos de venta asociados. "
                "Eliminá esos remitos primero."
            )
        conn.execute("DELETE FROM compras_bulk WHERE id = ? AND empresa_id = ?", (lote_id, eid))
    return {
        "id": int(row["id"]),
        "kg_totales": float(row["kg_totales"]),
        "numero_lote": row["numero_lote"] or "",
    }

def fraccionar_lote_fifo(conn, kg_venta: float, empresa_id: int = None) -> tuple[float, list[dict]]:
    """
    Descuenta kg_venta de los lotes de compras_bulk activos siguiendo la estrategia FIFO.
    Debe llamarse dentro de una transacción activa (usando la conexión `conn`).
    Retorna (costo_total_carne, fracciones_descontadas).
    """
    if kg_venta <= 0:
        raise ValueError("Los kilos a fraccionar deben ser mayores a 0")
        
    eid = empresa_id if empresa_id is not None else current_empresa_id()
    # Verificar stock total disponible
    stock_row = conn.execute("SELECT COALESCE(SUM(kg_remanentes), 0) AS total FROM compras_bulk WHERE empresa_id = ?", (eid,)).fetchone()
    stock_disponible = float(stock_row["total"])
    
    if stock_disponible < kg_venta:
        raise ValueError(f"Stock insuficiente en lotes bulk. Solicitado: {kg_venta:.2f} kg | Disponible: {stock_disponible:.2f} kg")
        
    # Obtener lotes activos por FIFO (ID ascendente)
    lotes = conn.execute(
        """
        SELECT id, kg_remanentes, kg_totales, costo_total_bulk, costo_reparto
        FROM compras_bulk
        WHERE kg_remanentes > 0 AND empresa_id = ?
        ORDER BY id ASC
        """,
        (eid,)
    ).fetchall()
    
    restante = kg_venta
    costo_total_carne = 0.0
    fracciones = []
    
    for lote in lotes:
        if restante <= 0:
            break
            
        l_id = lote["id"]
        l_remanente = float(lote["kg_remanentes"])
        l_totales = float(lote["kg_totales"])
        l_costo_total = float(lote["costo_total_bulk"])
        l_costo_reparto = float(lote["costo_reparto"])
        costo_unitario = l_costo_total / l_totales
        costo_reparto_unitario = l_costo_reparto / l_totales
        
        if l_remanente >= restante:
            # El lote actual cubre todo lo restante
            nuevo_remanente = l_remanente - restante
            costo_porcion = restante * costo_unitario
            costo_logistica_porcion = restante * costo_reparto_unitario
            
            conn.execute(
                "UPDATE compras_bulk SET kg_remanentes = ? WHERE id = ?",
                (nuevo_remanente, l_id)
            )
            
            fracciones.append({
                "lote_id": l_id,
                "kg_descontados": restante,
                "costo_porcion": costo_porcion,
                "costo_logistica_porcion": costo_logistica_porcion
            })
            
            costo_total_carne += costo_porcion
            restante = 0.0
        else:
            # El lote actual se agota por completo
            costo_porcion = l_remanente * costo_unitario
            costo_logistica_porcion = l_remanente * costo_reparto_unitario
            
            conn.execute(
                "UPDATE compras_bulk SET kg_remanentes = 0 WHERE id = ?",
                (l_id,)
            )
            
            fracciones.append({
                "lote_id": l_id,
                "kg_descontados": l_remanente,
                "costo_porcion": costo_porcion,
                "costo_logistica_porcion": costo_logistica_porcion
            })
            
            costo_total_carne += costo_porcion
            restante -= l_remanente
            
    return round(costo_total_carne, 2), fracciones
