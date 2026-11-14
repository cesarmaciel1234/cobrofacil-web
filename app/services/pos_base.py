"""Copia fiel de las tablas de Cobro Fácil. No pisa la cartera ni los remitos."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from app.database import ensure_tenant_migrations, get_db

_TABLA = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SECRETOS = ("password", "passwd", "token", "secret", "api_key", "access_token", "refresh_token")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sucursal_id(valor: Any) -> int | None:
    if valor in ("", None):
        return None
    return int(valor)


def columna_secreta(nombre: str) -> bool:
    n = str(nombre or "").lower()
    return any(marca in n for marca in _SECRETOS)


def guardar_parte(
    tabla: str,
    columnas: list,
    filas: list,
    parte: int,
    partes: int,
    sucursal_id: Any = None,
    sucursal_nombre: str | None = None,
) -> dict[str, Any]:
    if not _TABLA.match(tabla or ""):
        raise ValueError("Nombre de tabla inválido")
    if not isinstance(columnas, list) or not isinstance(filas, list):
        raise ValueError("La tabla tiene que traer columnas y filas")
    parte = int(parte or 1)
    partes = int(partes or 1)
    if parte < 1 or partes < 1 or parte > partes:
        raise ValueError("Parte de tabla inválida")
    sid = _sucursal_id(sucursal_id)
    limpias = []
    for fila in filas:
        if not isinstance(fila, list) or len(fila) != len(columnas):
            raise ValueError("Una fila no coincide con las columnas")
        limpias.append([
            None if columna_secreta(col) else valor
            for col, valor in zip(columnas, fila)
        ])
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        if parte == 1:
            if sid is None:
                conn.execute(
                    "DELETE FROM pos_base WHERE tabla = ? AND sucursal_id IS NULL",
                    (tabla,),
                )
            else:
                conn.execute(
                    "DELETE FROM pos_base WHERE tabla = ? AND sucursal_id = ?",
                    (tabla, sid),
                )
        else:
            if sid is None:
                conn.execute(
                    "DELETE FROM pos_base WHERE tabla = ? AND sucursal_id IS NULL AND parte = ?",
                    (tabla, parte),
                )
            else:
                conn.execute(
                    "DELETE FROM pos_base WHERE tabla = ? AND sucursal_id = ? AND parte = ?",
                    (tabla, sid, parte),
                )
        conn.execute(
            """
            INSERT INTO pos_base
            (sucursal_id, sucursal_nombre, tabla, parte, columnas, filas, cantidad, actualizado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sid,
                (sucursal_nombre or "").strip() or None,
                tabla,
                parte,
                json.dumps(columnas, ensure_ascii=False),
                json.dumps(limpias, ensure_ascii=False),
                len(limpias),
                _utc_now(),
            ),
        )
    return {"ok": True, "tabla": tabla, "parte": parte, "filas": len(limpias)}


def resumen_base() -> list[dict]:
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        rows = conn.execute(
            """
            SELECT tabla, sucursal_id, sucursal_nombre,
                   SUM(cantidad) AS cantidad, MAX(actualizado_en) AS actualizado_en
            FROM pos_base
            GROUP BY tabla, sucursal_id, sucursal_nombre
            ORDER BY tabla
            """
        ).fetchall()
    return [
        {
            "tabla": r["tabla"],
            "sucursal_id": r["sucursal_id"],
            "sucursal": r["sucursal_nombre"] or "",
            "filas": int(r["cantidad"] or 0),
            "actualizado_en": r["actualizado_en"],
        }
        for r in rows
    ]


def ultima_carga(sucursal_id: int | None = None) -> str | None:
    """Cuándo llegó el último trozo del libro a la nube."""
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        if sucursal_id is None:
            row = conn.execute("SELECT MAX(actualizado_en) AS marca FROM pos_base").fetchone()
        else:
            row = conn.execute(
                "SELECT MAX(actualizado_en) AS marca FROM pos_base WHERE sucursal_id = ?",
                (int(sucursal_id),),
            ).fetchone()
    if not row:
        return None
    return row["marca"] or None


def listar_sucursales() -> list[dict]:
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        rows = conn.execute(
            """
            SELECT DISTINCT sucursal_id, sucursal_nombre
            FROM pos_base
            WHERE sucursal_id IS NOT NULL
            ORDER BY sucursal_id
            """
        ).fetchall()
    return [
        {
            "id": int(r["sucursal_id"]),
            "nombre": r["sucursal_nombre"] or f"Sucursal {r['sucursal_id']}",
        }
        for r in rows
    ]


def filas_de(tabla: str, sucursal_id: int | None = None) -> tuple[list[str], list[list]]:
    if not _TABLA.match(tabla or ""):
        return [], []
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        if sucursal_id is not None:
            partes = conn.execute(
                "SELECT sucursal_id, sucursal_nombre, columnas, filas FROM pos_base WHERE tabla = ? AND sucursal_id = ? ORDER BY parte",
                (tabla, int(sucursal_id)),
            ).fetchall()
        else:
            partes = conn.execute(
                "SELECT sucursal_id, sucursal_nombre, columnas, filas FROM pos_base WHERE tabla = ? ORDER BY sucursal_id, parte",
                (tabla,),
            ).fetchall()
    if not partes:
        return [], []
    columnas = list(json.loads(partes[0]["columnas"]))
    tiene_suc = "sucursal_id" in [c.lower() for c in columnas]
    if not tiene_suc:
        columnas.append("sucursal_id")
        columnas.append("sucursal_nombre")

    filas: list[list] = []
    for parte in partes:
        sid = parte["sucursal_id"]
        snom = parte["sucursal_nombre"]
        part_filas = json.loads(parte["filas"])
        if not tiene_suc:
            for f in part_filas:
                f_copy = list(f)
                f_copy.append(sid)
                f_copy.append(snom)
                filas.append(f_copy)
        else:
            filas.extend(part_filas)
    return columnas, filas
