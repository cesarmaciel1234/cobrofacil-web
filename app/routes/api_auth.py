"""Blueprint de Autenticación Unificada para RepartoFácil y CobroFácil.
Maneja autenticación por JWT para clientes, repartidores y usuarios del sistema.
Compatible con el backend legado de RepartoFácil y conectado a la base central.
"""

import hashlib
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from flask import Blueprint, jsonify, request
from werkzeug.security import check_password_hash

from app.config import Config
from app.database import get_db, is_postgres

auth_bp = Blueprint("api_auth", __name__, url_prefix="/api/auth")

JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY") or os.environ.get("JWT_SECRET") or Config.SECRET_KEY or "repartofacil-secret-key-2026"
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.environ.get("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))
LOGIN_ATTEMPTS = 5
LOGIN_WINDOW_MINUTES = 15


def _users_table():
    return "public.local_users" if is_postgres() else "local_users"


def _throttles_table():
    return "public.login_throttles" if is_postgres() else "login_throttles"


def ensure_auth_tables(conn):
    """Garantiza la existencia de las tablas de autenticación unificadas."""
    if is_postgres():
        conn.execute("""
            CREATE TABLE IF NOT EXISTS public.local_users (
                id VARCHAR(64) PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255),
                display_name VARCHAR(255),
                role VARCHAR(32) NOT NULL DEFAULT 'Driver',
                is_anonymous VARCHAR(10) NOT NULL DEFAULT 'true',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS public.login_throttles (
                account_key VARCHAR(64) PRIMARY KEY,
                attempts INTEGER NOT NULL,
                expires_at TIMESTAMP NOT NULL
            )
        """)
    else:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS local_users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT,
                display_name TEXT,
                role TEXT NOT NULL DEFAULT 'Driver',
                is_anonymous TEXT NOT NULL DEFAULT 'true',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS login_throttles (
                account_key TEXT PRIMARY KEY,
                attempts INTEGER NOT NULL,
                expires_at TIMESTAMP NOT NULL
            )
        """)
    conn.commit()


def hash_password(password: str) -> str:
    """PBKDF2 HMAC SHA-256 con 120.000 iteraciones (idéntico al backend legado)."""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000).hex()
    return f"{salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    """Verifica hash PBKDF2 salt$digest o Werkzeug scrypt como fallback."""
    if not stored:
        return False
    if "$" in stored:
        parts = stored.split("$")
        if len(parts) == 2:
            salt, digest = parts
            actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000).hex()
            return secrets.compare_digest(actual, digest)
    try:
        return check_password_hash(stored, password)
    except Exception:
        return False


def create_token(user_id: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "role": role,
        "exp": now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        "iat": now,
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except Exception:
        return None


def user_data(user: dict) -> dict:
    is_anon = str(user.get("is_anonymous", "true")).strip().lower() == "true"
    name = user.get("display_name") or ""
    uid = str(user.get("id"))
    return {
        "uid": uid,
        "id": uid,
        "email": user.get("email") or "",
        "displayName": name,
        "firstName": name,
        "role": user.get("role") or "Driver",
        "isAnonymous": is_anon,
    }


def _parse_dt(val) -> datetime:
    if isinstance(val, datetime):
        return val if val.tzinfo is not None else val.replace(tzinfo=timezone.utc)
    if isinstance(val, str):
        val_clean = val.replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(val_clean)
            return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
        except Exception:
            try:
                base = val_clean.split(".")[0]
                return datetime.strptime(base, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            except Exception:
                pass
    return datetime.now(timezone.utc)


@auth_bp.route("/anonymous", methods=["POST"])
def anonymous():
    """Genera una cuenta de conductor anónima temporal y emite token JWT."""
    body = request.get_json(silent=True) or {}
    display_name = (body.get("display_name") or "Conductor").strip()

    user_id = str(uuid.uuid4())
    email = f"{user_id}@rutarapida.local"
    role = "Driver"
    is_anonymous = "true"

    with get_db(empresa_id=0) as conn:
        ensure_auth_tables(conn)
        tbl = _users_table()
        conn.execute(
            f"INSERT INTO {tbl} (id, email, password_hash, display_name, role, is_anonymous) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, email, None, display_name, role, is_anonymous),
        )
        conn.commit()

    token = create_token(user_id, role)
    user_payload = {
        "uid": user_id,
        "id": user_id,
        "email": email,
        "displayName": display_name,
        "firstName": display_name,
        "role": role,
        "isAnonymous": True,
    }
    return jsonify({"access_token": token, "token_type": "bearer", "user": user_payload}), 200


@auth_bp.route("/register", methods=["POST"])
def register():
    """Registra un nuevo usuario (Cliente o Conductor)."""
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    display_name = (body.get("display_name") or "").strip()
    role_raw = (body.get("role") or "Driver").strip().lower()

    if not email:
        return jsonify({"detail": "Email is required"}), 400

    if len(password) < 8:
        return jsonify({"detail": "Password must contain at least 8 characters"}), 400

    roles_map = {"client": "Client", "driver": "Driver"}
    role = roles_map.get(role_raw)
    if role is None:
        return jsonify({"detail": "Role must be Client or Driver"}), 400

    with get_db(empresa_id=0) as conn:
        ensure_auth_tables(conn)
        tbl = _users_table()
        existing = conn.execute(f"SELECT id FROM {tbl} WHERE LOWER(email) = ?", (email,)).fetchone()
        if existing:
            return jsonify({"detail": "Email already registered"}), 400

        user_id = str(uuid.uuid4())
        pw_hash = hash_password(password)
        conn.execute(
            f"INSERT INTO {tbl} (id, email, password_hash, display_name, role, is_anonymous) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, email, pw_hash, display_name or None, role, "false"),
        )
        conn.commit()

    token = create_token(user_id, role)
    user_payload = {
        "uid": user_id,
        "id": user_id,
        "email": email,
        "displayName": display_name,
        "firstName": display_name,
        "role": role,
        "isAnonymous": False,
    }
    return jsonify({"access_token": token, "token_type": "bearer", "user": user_payload}), 200


@auth_bp.route("/login", methods=["POST"])
def login():
    """Autentica usuario con email/usuario y contraseña con protección anti-fuerza bruta."""
    body = request.get_json(silent=True) or {}
    email_or_user = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    if not email_or_user or not password:
        return jsonify({"detail": "Incorrect email or password"}), 401

    canonical = email_or_user if "@" in email_or_user else f"{email_or_user}@repartofacil.com"
    account_key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=LOGIN_WINDOW_MINUTES)

    with get_db(empresa_id=0) as conn:
        ensure_auth_tables(conn)
        th_tbl = _throttles_table()
        cur = conn.execute(
            f"SELECT attempts, expires_at FROM {th_tbl} WHERE account_key = ?",
            (account_key,),
        )
        throttle_row = cur.fetchone()

        attempts = 1
        if throttle_row:
            exp_dt = _parse_dt(throttle_row["expires_at"])
            if exp_dt > now:
                attempts = throttle_row["attempts"] + 1
                conn.execute(
                    f"UPDATE {th_tbl} SET attempts = ? WHERE account_key = ?",
                    (attempts, account_key),
                )
            else:
                attempts = 1
                conn.execute(
                    f"UPDATE {th_tbl} SET attempts = 1, expires_at = ? WHERE account_key = ?",
                    (expires, account_key),
                )
        else:
            conn.execute(
                f"INSERT INTO {th_tbl} (account_key, attempts, expires_at) VALUES (?, ?, ?)",
                (account_key, 1, expires),
            )
        conn.commit()

        if attempts > LOGIN_ATTEMPTS:
            retry_seconds = max(1, int((expires - now).total_seconds()))
            resp = jsonify({"detail": "Demasiados intentos. Intentá nuevamente más tarde."})
            resp.status_code = 429
            resp.headers["Retry-After"] = str(retry_seconds)
            return resp

        tbl = _users_table()
        cur = conn.execute(
            f"SELECT id, email, password_hash, display_name, role, is_anonymous FROM {tbl} WHERE LOWER(email) = ? OR LOWER(email) = ?",
            (email_or_user, canonical),
        )
        user_row = cur.fetchone()

        # Si no está en local_users, buscar en public.usuarios (admin/caja)
        if not user_row and is_postgres():
            cur_adm = conn.execute(
                "SELECT id, username, nombre, password_hash, role FROM public.usuarios WHERE LOWER(username) = ?",
                (email_or_user.split("@")[0],),
            )
            admin_row = cur_adm.fetchone()
            if admin_row and verify_password(password, admin_row["password_hash"]):
                conn.execute(f"DELETE FROM {th_tbl} WHERE account_key = ?", (account_key,))
                conn.commit()
                u_id = f"user-{admin_row['id']}"
                role_val = "Driver" if admin_row["role"] == "repartidor" else "Client"
                token = create_token(u_id, role_val)
                user_payload = {
                    "uid": u_id,
                    "id": u_id,
                    "email": f"{admin_row['username']}@cobrofacil.local",
                    "displayName": admin_row["nombre"] or admin_row["username"],
                    "firstName": admin_row["nombre"] or admin_row["username"],
                    "role": role_val,
                    "isAnonymous": False,
                }
                return jsonify({"access_token": token, "token_type": "bearer", "user": user_payload}), 200

        if not user_row or not user_row["password_hash"] or not verify_password(password, user_row["password_hash"]):
            return jsonify({"detail": "Incorrect email or password"}), 401

        # Limpiar throttle al autenticar exitosamente
        conn.execute(f"DELETE FROM {th_tbl} WHERE account_key = ?", (account_key,))
        conn.commit()

        u_dict = {
            "id": user_row["id"],
            "email": user_row["email"],
            "display_name": user_row["display_name"],
            "role": user_row["role"],
            "is_anonymous": user_row["is_anonymous"],
        }
        token = create_token(str(u_dict["id"]), u_dict["role"])
        return jsonify({"access_token": token, "token_type": "bearer", "user": user_data(u_dict)}), 200


@auth_bp.route("/me", methods=["GET"])
def me():
    """Valida el token Bearer JWT y retorna el perfil del usuario."""
    auth_header = request.headers.get("Authorization") or ""
    if not auth_header.startswith("Bearer "):
        return jsonify({"detail": "Authentication required"}), 401

    token = auth_header[7:].strip()
    payload = decode_token(token)
    if not payload or not payload.get("sub"):
        return jsonify({"detail": "Invalid token"}), 401

    user_id = payload.get("sub")

    with get_db(empresa_id=0) as conn:
        ensure_auth_tables(conn)
        tbl = _users_table()
        cur = conn.execute(
            f"SELECT id, email, display_name, role, is_anonymous FROM {tbl} WHERE id = ?",
            (user_id,),
        )
        row = cur.fetchone()

        if not row and str(user_id).startswith("user-") and is_postgres():
            raw_id = str(user_id).replace("user-", "")
            if raw_id.isdigit():
                cur_adm = conn.execute(
                    "SELECT id, username, nombre, role FROM public.usuarios WHERE id = ?",
                    (int(raw_id),),
                )
                admin_row = cur_adm.fetchone()
                if admin_row:
                    role_val = "Driver" if admin_row["role"] == "repartidor" else "Client"
                    return jsonify({
                        "uid": user_id,
                        "id": user_id,
                        "email": f"{admin_row['username']}@cobrofacil.local",
                        "displayName": admin_row["nombre"] or admin_row["username"],
                        "firstName": admin_row["nombre"] or admin_row["username"],
                        "role": role_val,
                        "isAnonymous": False,
                    }), 200

        if not row:
            return jsonify({"detail": "User not found"}), 401

        u_dict = {
            "id": row["id"],
            "email": row["email"],
            "display_name": row["display_name"],
            "role": row["role"],
            "is_anonymous": row["is_anonymous"],
        }
        return jsonify(user_data(u_dict)), 200
