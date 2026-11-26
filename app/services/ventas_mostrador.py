from app.database import get_db, is_postgres, table_exists
from app.utils import current_empresa_id, current_sucursal_id


def list_ventas_mostrador(limit: int = 100, empresa_id: int = None) -> list[dict]:
    eid = empresa_id if empresa_id is not None else current_empresa_id()
    with get_db() as conn:
        if not table_exists(conn, "ventas_mostrador"):
            return []
        rows = conn.execute(
            """
            SELECT v.id, v.cliente_id, v.producto, v.monto, v.tipo_pago, v.fecha, v.created_at,
                   c.nombre AS cliente_nombre
            FROM ventas_mostrador v
            LEFT JOIN clientes c ON c.id = v.cliente_id
            WHERE v.empresa_id = ?
            ORDER BY v.id DESC LIMIT ?
            """,
            (eid, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def sync_ventas_offline(ventas: list[dict], empresa_id: int = None, sucursal_id: int = None) -> list[int]:
    """Inserta ventas desde cola offline. Retorna offline_ids sincronizados (idempotente)."""
    synced_ids = []
    eid = empresa_id if empresa_id is not None else current_empresa_id()
    sid = sucursal_id if sucursal_id is not None else current_sucursal_id()
    with get_db() as conn:
        if not table_exists(conn, "ventas_mostrador"):
            _ensure_table(conn)
        for v in ventas:
            offline_id = v.get("offline_id")
            if offline_id is not None:
                existing = conn.execute(
                    "SELECT id FROM ventas_mostrador WHERE offline_id = ? AND empresa_id = ?",
                    (int(offline_id), eid),
                ).fetchone()
                if existing:
                    synced_ids.append(int(offline_id))
                    continue

            producto = str(v.get("producto") or "").strip()
            monto = float(v.get("monto") or 0)
            tipo_pago = str(v.get("tipo_pago") or "CONTADO").upper()
            fecha = str(v.get("fecha") or "").strip() or None
            if not producto or monto <= 0:
                continue
            if tipo_pago not in ("CONTADO", "FIADO"):
                tipo_pago = "CONTADO"

            cols = ["cliente_id", "producto", "monto", "tipo_pago", "empresa_id", "sucursal_id"]
            vals = [None, producto, monto, tipo_pago, eid, sid]
            if offline_id is not None:
                cols.append("offline_id")
                vals.append(int(offline_id))
            if fecha:
                cols.append("fecha")
                vals.append(fecha)

            conn.execute(
                f"INSERT INTO ventas_mostrador ({', '.join(cols)}) "
                f"VALUES ({', '.join('?' for _ in vals)})",
                vals,
            )
            if offline_id is not None:
                synced_ids.append(int(offline_id))
    return synced_ids


def _ensure_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ventas_mostrador (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cliente_id INTEGER,
            producto TEXT NOT NULL DEFAULT '',
            monto REAL NOT NULL CHECK(monto > 0),
            tipo_pago TEXT NOT NULL CHECK(tipo_pago IN ('CONTADO', 'FIADO')) DEFAULT 'CONTADO',
            fecha TEXT NOT NULL DEFAULT (date('now', 'localtime')),
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            offline_id INTEGER UNIQUE,
            empresa_id INTEGER NOT NULL DEFAULT 1,
            sucursal_id INTEGER,
            FOREIGN KEY (cliente_id) REFERENCES clientes(id)
        );
        """
    )
