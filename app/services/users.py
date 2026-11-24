"""Usuarios, roles y configuración empresarial."""
from __future__ import annotations

import json
from typing import Any

from werkzeug.security import check_password_hash, generate_password_hash

from app.database import get_db
from app.config import Config

ROLES = frozenset({"admin", "operador", "visor"})
ROLE_RANK = {"visor": 0, "operador": 1, "admin": 2}

EMPRESA_DEFAULTS: dict[str, Any] = {
    "razon_social": "Cobro Fácil",
    "cuit": "",
    "direccion": "",
    "telefono": "",
    "email": "",
    "cotizacion_usd": 1000.0,
}


def normalize_empresa_config(data: dict | None) -> dict[str, Any]:
    """Unifica nombre/razon_social y completa campos faltantes."""
    if not data or not isinstance(data, dict):
        return dict(EMPRESA_DEFAULTS)
    try:
        cotizacion = float(data.get("cotizacion_usd") or EMPRESA_DEFAULTS["cotizacion_usd"])
    except (TypeError, ValueError):
        cotizacion = EMPRESA_DEFAULTS["cotizacion_usd"]
    razon = (data.get("razon_social") or data.get("nombre") or "").strip()
    return {
        "razon_social": razon or EMPRESA_DEFAULTS["razon_social"],
        "cuit": str(data.get("cuit") or "").strip(),
        "direccion": str(data.get("direccion") or "").strip(),
        "telefono": str(data.get("telefono") or "").strip(),
        "email": str(data.get("email") or "").strip(),
        "cotizacion_usd": cotizacion,
        "reporte_email_destinatarios": str(data.get("reporte_email_destinatarios") or "").strip(),
        "reporte_email_activo": bool(data.get("reporte_email_activo", True)),
        "reporte_email_hora": str(data.get("reporte_email_hora") or "05:00").strip() or "05:00",
        "smtp_host": str(data.get("smtp_host") or "").strip(),
        "smtp_port": int(data.get("smtp_port") or 465),
        "smtp_user": str(data.get("smtp_user") or "").strip(),
        "smtp_password": str(data.get("smtp_password") or "").strip(),
        "smtp_from": str(data.get("smtp_from") or "").strip(),
        "smtp_use_ssl": bool(data.get("smtp_use_ssl", True)),
        "resend_api_key": str(data.get("resend_api_key") or "").strip(),
    }


def _row_to_user(row) -> dict[str, Any]:
    r = dict(row)
    return {
        "id": r["id"],
        "username": r["username"],
        "nombre": r.get("nombre") or r["username"],
        "role": r["role"],
        "activo": bool(r.get("activo", 1)),
        "empresa_id": r.get("empresa_id"),
        "sucursal_id": r.get("sucursal_id"),
        "created_at": r.get("created_at"),
    }


def ensure_default_admin() -> None:
    """Crea usuarios admin y rumaul por defecto si no existen."""
    with get_db(empresa_id=0) as conn:
        # Check and insert admin
        admin_exists = conn.execute("SELECT 1 FROM usuarios WHERE username = 'admin'").fetchone()
        if not admin_exists:
            pwd = Config.ADMIN_INITIAL_PASSWORD or Config.master_password() or "admin"
            conn.execute(
                """
                INSERT INTO usuarios (username, nombre, password_hash, role, activo, empresa_id)
                VALUES ('admin', 'Administrador', ?, 'admin', 1, 1)
                """,
                (generate_password_hash(pwd),),
            )
        
        # Check and insert rumaul
        rumaul_exists = conn.execute("SELECT 1 FROM usuarios WHERE username = 'rumaul'").fetchone()
        if not rumaul_exists:
            conn.execute(
                """
                INSERT INTO usuarios (username, nombre, password_hash, role, activo, empresa_id)
                VALUES ('rumaul', 'Rumaul', ?, 'admin', 1, 1)
                """,
                (generate_password_hash("admin"),),
            )



def resolver_empresa_id(empresa_query: str) -> int | None:
    if not empresa_query:
        return None
    eq = str(empresa_query).strip()
    if eq.isdigit():
        return int(eq)
    with get_db(empresa_id=0) as conn:
        row = conn.execute("SELECT id FROM empresas WHERE LOWER(slug) = LOWER(?) AND activo = 1", (eq,)).fetchone()
        if row:
            return int(row["id"])
        row = conn.execute("SELECT id FROM empresas WHERE LOWER(nombre) = LOWER(?) AND activo = 1", (eq,)).fetchone()
        if row:
            return int(row["id"])
        row = conn.execute("SELECT id FROM empresas WHERE LOWER(nombre) LIKE LOWER(?) AND activo = 1 LIMIT 1", (f"%{eq}%",)).fetchone()
        if row:
            return int(row["id"])
    return None


def authenticate_user(username: str, password: str, empresa: str | None = None) -> dict[str, Any] | None:
    import re
    raw_username = username.strip().lower()
    slug_username = re.sub(r'[^a-zA-Z0-9]', '', raw_username)

    if empresa:
        target_empresa_id = resolver_empresa_id(empresa)
        if not target_empresa_id:
            return None
    else:
        target_empresa_id = None

    with get_db(empresa_id=0) as conn:
        if target_empresa_id:
            row = conn.execute(
                """SELECT u.id, u.username, u.nombre, u.password_hash, u.role, u.activo, u.empresa_id, u.sucursal_id, u.created_at,
                          s.nombre as sucursal_nombre
                   FROM usuarios u
                   LEFT JOIN sucursales s ON s.id = u.sucursal_id
                   WHERE (u.username = ? OR u.username = ?) AND u.empresa_id = ? AND u.activo = 1""",
                (raw_username, slug_username, target_empresa_id),
            ).fetchone()
        else:
            row = conn.execute(
                """SELECT u.id, u.username, u.nombre, u.password_hash, u.role, u.activo, u.empresa_id, u.sucursal_id, u.created_at,
                          s.nombre as sucursal_nombre
                   FROM usuarios u
                   LEFT JOIN sucursales s ON s.id = u.sucursal_id
                   WHERE (u.username = ? OR u.username = ?) AND u.activo = 1""",
                (raw_username, slug_username),
            ).fetchone()
    if not row or not check_password_hash(row["password_hash"], password):
        return None
    d = _row_to_user(row)
    d["sucursal_nombre"] = row["sucursal_nombre"]
    return d


def get_user(user_id: int) -> dict[str, Any] | None:
    with get_db(empresa_id=0) as conn:
        row = conn.execute(
            """SELECT u.id, u.username, u.nombre, u.role, u.activo, u.empresa_id, u.sucursal_id, u.created_at,
                      s.nombre as sucursal_nombre
               FROM usuarios u
               LEFT JOIN sucursales s ON s.id = u.sucursal_id
               WHERE u.id = ?""",
            (user_id,),
        ).fetchone()
    if not row:
        return None
    d = _row_to_user(row)
    d["sucursal_nombre"] = row["sucursal_nombre"]
    return d


def list_users(empresa_id: int | None = None) -> list[dict[str, Any]]:
    with get_db(empresa_id=0) as conn:
        if empresa_id:
            rows = conn.execute(
                """SELECT u.id, u.username, u.nombre, u.role, u.activo, u.empresa_id, u.sucursal_id, u.created_at,
                          s.nombre as sucursal_nombre
                   FROM usuarios u
                   LEFT JOIN sucursales s ON s.id = u.sucursal_id
                   WHERE u.empresa_id = ?
                   ORDER BY u.username""",
                (empresa_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT u.id, u.username, u.nombre, u.role, u.activo, u.empresa_id, u.sucursal_id, u.created_at,
                          s.nombre as sucursal_nombre
                   FROM usuarios u
                   LEFT JOIN sucursales s ON s.id = u.sucursal_id
                   ORDER BY u.username"""
            ).fetchall()
    users = []
    for r in rows:
        d = _row_to_user(r)
        d["sucursal_nombre"] = r["sucursal_nombre"]
        users.append(d)
    return users


def create_user(
    username: str,
    password: str,
    role: str = "operador",
    nombre: str = "",
    empresa_id: int | None = None,
    sucursal_id: int | None = None,
) -> int:
    role = (role or "operador").lower()
    if role not in ROLES:
        raise ValueError("Rol inválido")
    username = username.strip().lower()
    if len(username) < 3:
        raise ValueError("Usuario demasiado corto")
    if len(password) < 6:
        raise ValueError("La contraseña debe tener al menos 6 caracteres")
    sid = int(sucursal_id) if sucursal_id not in (None, "") else None
    with get_db(empresa_id=0) as conn:
        exists = conn.execute("SELECT 1 FROM usuarios WHERE username = ?", (username,)).fetchone()
        if exists:
            raise ValueError("El nombre de usuario ya está registrado")
        cur = conn.execute(
            """
            INSERT INTO usuarios (username, nombre, password_hash, role, activo, empresa_id, sucursal_id)
            VALUES (?, ?, ?, ?, 1, ?, ?)
            """,
            (username, nombre or username, generate_password_hash(password), role, empresa_id, sid),
        )
        if hasattr(conn, "commit"):
            conn.commit()
        return int(cur.lastrowid)


def update_user(
    user_id: int,
    *,
    role: str | None = None,
    activo: bool | None = None,
    nombre: str | None = None,
    sucursal_id: Any = "NO_CHANGE",
) -> dict[str, Any]:
    with get_db(empresa_id=0) as conn:
        row = conn.execute("SELECT id FROM usuarios WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise ValueError("Usuario no encontrado")
        if role is not None:
            role = role.lower()
            if role not in ROLES:
                raise ValueError("Rol inválido")
            conn.execute("UPDATE usuarios SET role = ? WHERE id = ?", (role, user_id))
        if activo is not None:
            conn.execute("UPDATE usuarios SET activo = ? WHERE id = ?", (1 if activo else 0, user_id))
        if nombre is not None:
            conn.execute("UPDATE usuarios SET nombre = ? WHERE id = ?", (nombre.strip() or "", user_id))
        if sucursal_id != "NO_CHANGE":
            sid = int(sucursal_id) if sucursal_id not in (None, "") else None
            conn.execute("UPDATE usuarios SET sucursal_id = ? WHERE id = ?", (sid, user_id))
        if hasattr(conn, "commit"):
            conn.commit()
    user = get_user(user_id)
    if not user:
        raise ValueError("Usuario no encontrado")
    return user


def get_empresa_config() -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute("SELECT datos FROM empresa_config WHERE id = 1").fetchone()
    if not row or not row["datos"]:
        return dict(EMPRESA_DEFAULTS)
    try:
        data = json.loads(row["datos"])
        if isinstance(data, dict):
            return normalize_empresa_config(data)
        return dict(EMPRESA_DEFAULTS)
    except (TypeError, json.JSONDecodeError):
        return dict(EMPRESA_DEFAULTS)


def save_empresa_config(datos: dict[str, Any]) -> dict[str, Any]:
    payload = json.dumps(normalize_empresa_config(datos), ensure_ascii=False)
    with get_db() as conn:
        exists = conn.execute("SELECT 1 FROM empresa_config WHERE id = 1").fetchone()
        if exists:
            conn.execute(
                "UPDATE empresa_config SET datos = ?, updated_at = datetime('now', 'localtime') WHERE id = 1",
                (payload,),
            )
        else:
            conn.execute(
                "INSERT INTO empresa_config (id, datos) VALUES (1, ?)",
                (payload,),
            )
    return get_empresa_config()
