"""
Servicio de configuración para integración con servidor POS.

Maneja:
- Configuración de conexión al servidor POS
- Logs de sincronización
- Estado de sincronización
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.database import ensure_tenant_migrations, get_db


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_pos_config() -> dict[str, Any]:
    """
    Obtiene la configuración actual de integración POS.

    Retorna un diccionario con:
    - server_url: URL del servidor POS
    - api_key: Clave API para autenticación
    - sync_interval_minutes: Intervalo de sincronización automática
    - auto_sync: Si la sincronización automática está activa (0/1)
    - last_sync_at: Fecha/hora de la última sincronización
    """
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        row = conn.execute("SELECT * FROM pos_config WHERE id = 1").fetchone()

    if not row:
        # Configuración por defecto
        return {
            "id": 1,
            "server_url": "",
            "api_key": "",
            "sync_interval_minutes": 30,
            "auto_sync": 0,
            "last_sync_at": None,
        }

    return dict(row)


def update_pos_config(
    server_url: str = None,
    api_key: str = None,
    sync_interval_minutes: int = None,
    auto_sync: bool = None,
) -> dict[str, Any]:
    """
    Actualiza la configuración de integración POS.

    Solo actualiza los campos que se pasan como argumentos.
    """
    with get_db() as conn:
        ensure_tenant_migrations(conn)

        # Verificar si existe configuración
        exists = conn.execute("SELECT 1 FROM pos_config WHERE id = 1").fetchone()

        if not exists:
            # Crear configuración inicial
            conn.execute(
                """
                INSERT INTO pos_config
                (id, server_url, api_key, sync_interval_minutes, auto_sync, updated_at)
                VALUES (1, ?, ?, ?, ?, ?)
                """,
                (
                    server_url or "",
                    api_key or "",
                    sync_interval_minutes or 30,
                    1 if auto_sync else 0,
                    _utc_now(),
                ),
            )
        else:
            # Actualizar campos existentes
            updates = []
            params = []

            if server_url is not None:
                updates.append("server_url = ?")
                params.append(server_url)

            if api_key is not None:
                updates.append("api_key = ?")
                params.append(api_key)

            if sync_interval_minutes is not None:
                updates.append("sync_interval_minutes = ?")
                params.append(sync_interval_minutes)

            if auto_sync is not None:
                updates.append("auto_sync = ?")
                params.append(1 if auto_sync else 0)

            if updates:
                updates.append("updated_at = ?")
                params.append(_utc_now())
                params.append(1)  # WHERE id = 1

                conn.execute(
                    f"UPDATE pos_config SET {', '.join(updates)} WHERE id = ?",
                    params,
                )

    return get_pos_config()


def update_last_sync() -> None:
    """Actualiza el timestamp de última sincronización."""
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        conn.execute(
            "UPDATE pos_config SET last_sync_at = ? WHERE id = 1",
            (_utc_now(),),
        )


def _insert_sync_log(sync_type: str, direction: str, status: str) -> int:
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        cur = conn.execute(
            """
            INSERT INTO pos_sync_log (sync_type, direction, status, started_at)
            VALUES (?, ?, ?, ?)
            """,
            (sync_type, direction, status, _utc_now()),
        )
        return cur.lastrowid


def log_sync_start(
    sync_type: str,
    direction: str,
) -> int:
    """
    Registra el inicio de una sincronización.

    Bases ya creadas pueden tener el CHECK viejo, sin 'in_progress'.
    En ese caso el arranque queda como 'partial' hasta que se cierra.
    """
    try:
        return _insert_sync_log(sync_type, direction, "in_progress")
    except Exception as exc:
        mensaje = str(exc).lower()
        if "check" not in mensaje and "constraint" not in mensaje:
            raise
        return _insert_sync_log(sync_type, direction, "partial")


def log_sync_complete(
    log_id: int,
    status: str,
    records_processed: int = 0,
    records_success: int = 0,
    records_error: int = 0,
    error_message: str = None,
) -> None:
    """
    Completa el registro de una sincronización.
    """
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        conn.execute(
            """
            UPDATE pos_sync_log
            SET status = ?, records_processed = ?, records_success = ?,
                records_error = ?, error_message = ?, completed_at = ?
            WHERE id = ?
            """,
            (
                status,
                records_processed,
                records_success,
                records_error,
                error_message,
                _utc_now(),
                log_id,
            ),
        )


def get_sync_logs(limit: int = 50, offset: int = 0) -> list[dict]:
    """
    Obtiene el historial de sincronizaciones.

    Args:
        limit: Cantidad máxima de registros a retornar
        offset: Cantidad de registros a saltar (paginación)
    """
    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))

    with get_db() as conn:
        ensure_tenant_migrations(conn)
        rows = conn.execute(
            """
            SELECT * FROM pos_sync_log
            ORDER BY id DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()

    return [dict(row) for row in rows]


def get_last_sync_status() -> dict[str, Any]:
    """
    Obtiene el estado de la última sincronización.

    Útil para mostrar en el dashboard si la sincronización está funcionando.
    """
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        row = conn.execute(
            """
            SELECT * FROM pos_sync_log
            ORDER BY id DESC
            LIMIT 1
            """
        ).fetchone()

    if not row:
        return {
            "last_sync": None,
            "status": "never",
            "message": "Nunca se ha sincronizado",
        }

    log = dict(row)
    if not log.get("completed_at") or log["status"] == "in_progress":
        return {
            "last_sync": log["started_at"],
            "status": "in_progress",
            "message": "Sincronización en curso",
        }
    elif log["status"] == "success":
        return {
            "last_sync": log["completed_at"],
            "status": "success",
            "message": f"Última sincronización exitosa ({log['records_success']} registros)",
        }
    elif log["status"] == "error":
        return {
            "last_sync": log["completed_at"],
            "status": "error",
            "message": f"Error en última sincronización: {log['error_message']}",
        }
    else:  # partial
        return {
            "last_sync": log["completed_at"],
            "status": "partial",
            "message": f"Sincronización parcial ({log['records_success']} exitosos, {log['records_error']} errores)",
        }
