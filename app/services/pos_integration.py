"""
Servicio de integración con servidor POS (TPV Pro 2026).

Este módulo permite que el CRM reciba datos del servidor POS:
- Clientes (clientes del TPV)
- Proveedores (entidades bancarias en el CRM)
- Ventas (se pueden convertir a remitos o operaciones financieras)

El servidor POS envía datos a través de endpoints REST y este servicio
se encarga de transformarlos al formato del CRM y persistirlos.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.database import ensure_tenant_migrations, get_db


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalizar_telefono(telefono: str | None) -> str | None:
    """Deja el teléfono tal como está en Cobro Fácil."""
    if telefono is None:
        return None
    telefono = str(telefono).strip()
    return telefono or None


def _normalizar_direccion(direccion: str | None) -> str | None:
    """Deja la dirección tal como está en Cobro Fácil."""
    if direccion is None:
        return None
    direccion = str(direccion).strip()
    return direccion or None


def _texto(valor: Any) -> str | None:
    if valor is None:
        return None
    texto = str(valor).strip()
    return texto or None


def _numero(valor: Any) -> float | None:
    if valor is None or valor == "":
        return None
    return float(valor)


def transformar_cliente_pos(cliente_pos: dict) -> dict:
    """
    Ficha de Cobro Fácil (punpro.db.clientes) hacia el CRM.

    La deuda del mostrador queda en deuda_pos. saldo_actual lo calcula
    el CRM con remitos y no se pisa desde el servidor local.
    """
    nombre = str(cliente_pos.get("nombre") or "").strip()
    if not nombre:
        raise ValueError("El cliente debe tener un nombre")

    pos_id = cliente_pos.get("id", cliente_pos.get("pos_id"))
    if pos_id in ("", None):
        pos_id = None
    else:
        pos_id = int(pos_id)

    limite = _numero(cliente_pos.get("limite_credito", cliente_pos.get("techo_deuda")))
    deuda = _numero(
        cliente_pos.get("deuda_actual", cliente_pos.get("deuda_pos", cliente_pos.get("saldo")))
    )
    plazo = cliente_pos.get("plazo_dias")
    if plazo in ("", None):
        plazo = None
    else:
        plazo = int(plazo)

    return {
        "nombre": nombre,
        "pos_id": pos_id,
        "pos_uid": _texto(cliente_pos.get("uid") or cliente_pos.get("pos_uid")),
        "techo_deuda": limite,
        "deuda_pos": deuda if deuda is not None else 0.0,
        "telefono": _normalizar_telefono(cliente_pos.get("telefono")),
        "cuit": _texto(cliente_pos.get("dni") or cliente_pos.get("cuit")),
        "direccion": _normalizar_direccion(cliente_pos.get("direccion")),
        "email": _texto(cliente_pos.get("email")),
        "tipo_cliente": _texto(cliente_pos.get("tipo_cliente")) or "regular",
        "estado_cuenta": _texto(cliente_pos.get("estado_cuenta")) or "activo",
        "pos_actualizado_en": _texto(cliente_pos.get("actualizado_en") or cliente_pos.get("pos_actualizado_en")),
        "sucursal_id": _sucursal_id(cliente_pos.get("sucursal_id")),
        "sucursal_nombre": _texto(cliente_pos.get("sucursal") or cliente_pos.get("sucursal_nombre")),
        "plazo_dias": plazo,
    }


def _sucursal_id(valor: Any) -> int | None:
    if valor in ("", None):
        return None
    return int(valor)


def transformar_proveedor_pos(proveedor_pos: dict) -> dict:
    """
    Transforma un proveedor del formato POS al formato CRM (entidad bancaria).

    Esperado del POS:
    {
        "id": 456,
        "nombre": "Frigorífico XYZ",
        "cuit": "30-98765432-1",
        "telefono": "11-9876-5432",
        "limite_credito": 1000000.0
    }

    Formato CRM (entidades_bancarias):
    {
        "nombre": "Frigorífico XYZ",
        "limite": 1000000.0
    }
    """
    nombre = str(proveedor_pos.get("nombre") or "").strip()
    if not nombre:
        raise ValueError("El proveedor debe tener un nombre")

    return {
        "nombre": nombre,
        "limite": float(proveedor_pos.get("limite_credito") or proveedor_pos.get("limite") or 0),
    }


def _fila_cliente(conn, where: str, params: tuple):
    return conn.execute(
        f"SELECT id, nombre, pos_uid, pos_id, sucursal_id FROM clientes WHERE {where}",
        params,
    ).fetchone()


def _donde_sucursal(cliente: dict) -> tuple[str, tuple]:
    if cliente.get("sucursal_id") is None:
        return "sucursal_id IS NULL", ()
    return "sucursal_id = ?", (cliente["sucursal_id"],)


def _buscar_cliente_pos(conn, cliente: dict):
    """El mismo uid en otra sucursal es otro cliente. La empresa ya la eligió la conexión."""
    filtro, extra = _donde_sucursal(cliente)
    if cliente["pos_uid"]:
        row = _fila_cliente(conn, f"pos_uid = ? AND {filtro}", (cliente["pos_uid"], *extra))
        if row:
            return row
    if cliente["pos_id"] is not None:
        row = _fila_cliente(conn, f"pos_id = ? AND {filtro}", (cliente["pos_id"], *extra))
        if row:
            return row
    if cliente["cuit"]:
        row = _fila_cliente(conn, f"cuit = ? AND {filtro}", (cliente["cuit"], *extra))
        if row:
            return row
    row = _fila_cliente(conn, f"LOWER(nombre) = LOWER(?) AND {filtro}", (cliente["nombre"], *extra))
    if not row:
        return None
    uid_previo = (row["pos_uid"] or "").strip()
    if uid_previo and uid_previo != (cliente["pos_uid"] or ""):
        return None
    if row["pos_id"] is not None and cliente["pos_id"] is not None and int(row["pos_id"]) != int(cliente["pos_id"]):
        return None
    return row


def _nombre_para_guardar(conn, cliente: dict, propio_id: int | None = None) -> str:
    nombre = cliente["nombre"]
    row = conn.execute(
        "SELECT id FROM clientes WHERE LOWER(nombre) = LOWER(?)",
        (nombre,),
    ).fetchone()
    if not row or (propio_id is not None and int(row["id"]) == int(propio_id)):
        return nombre
    id_marca = cliente["pos_id"] if cliente["pos_id"] is not None else (cliente["pos_uid"] or "pos")
    if cliente.get("sucursal_nombre"):
        return f"{nombre} · {cliente['sucursal_nombre']} {id_marca}"
    return f"{nombre} · POS {id_marca}"


def _aplicar_cliente(conn, cliente: dict) -> dict[str, Any]:
    row = _buscar_cliente_pos(conn, cliente)
    ahora = _utc_now()
    if row:
        cliente_id = row["id"]
        nombre = _nombre_para_guardar(conn, cliente, cliente_id)
        sets = [
            "nombre=?",
            "telefono=?",
            "cuit=?",
            "direccion=?",
            "email=?",
            "deuda_pos=?",
            "tipo_cliente=?",
            "estado_cuenta=?",
            "pos_actualizado_en=?",
            "sucursal_id=?",
            "sucursal_nombre=?",
            "plazo_dias=?",
            "updated_at_utc=?",
        ]
        params: list[Any] = [
            nombre,
            cliente["telefono"],
            cliente["cuit"],
            cliente["direccion"],
            cliente["email"],
            cliente["deuda_pos"],
            cliente["tipo_cliente"],
            cliente["estado_cuenta"],
            cliente["pos_actualizado_en"],
            cliente["sucursal_id"],
            cliente["sucursal_nombre"],
            cliente["plazo_dias"],
            ahora,
        ]
        if cliente["pos_id"] is not None:
            sets.append("pos_id=?")
            params.append(cliente["pos_id"])
        if cliente["pos_uid"]:
            sets.append("pos_uid=?")
            params.append(cliente["pos_uid"])
        if cliente["techo_deuda"] is not None:
            sets.append("techo_deuda=?")
            params.append(cliente["techo_deuda"])
        params.append(cliente_id)
        conn.execute(f"UPDATE clientes SET {', '.join(sets)} WHERE id=?", params)
        accion = "actualizado"
    else:
        nombre = _nombre_para_guardar(conn, cliente)
        techo = cliente["techo_deuda"] if cliente["techo_deuda"] is not None else 0.0
        cur = conn.execute(
            """
            INSERT INTO clientes
            (nombre, scoring, techo_deuda, saldo_actual, saldo_inicial,
             telefono, cuit, direccion, email, updated_at_utc,
             pos_id, pos_uid, deuda_pos, tipo_cliente, estado_cuenta, pos_actualizado_en,
             sucursal_id, sucursal_nombre, plazo_dias)
            VALUES (?, 'A', ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                nombre,
                techo,
                cliente["telefono"],
                cliente["cuit"],
                cliente["direccion"],
                cliente["email"],
                ahora,
                cliente["pos_id"],
                cliente["pos_uid"],
                cliente["deuda_pos"],
                cliente["tipo_cliente"],
                cliente["estado_cuenta"],
                cliente["pos_actualizado_en"],
                cliente["sucursal_id"],
                cliente["sucursal_nombre"],
                cliente["plazo_dias"],
            ),
        )
        cliente_id = cur.lastrowid
        accion = "creado"

    return {
        "ok": True,
        "accion": accion,
        "cliente_id": cliente_id,
        "nombre": nombre,
    }


def sincronizar_cliente(cliente_pos: dict) -> dict[str, Any]:
    """Recibe un cliente de Cobro Fácil. No modifica saldo_actual ni scoring."""
    try:
        cliente_crm = transformar_cliente_pos(cliente_pos)
    except (TypeError, ValueError) as e:
        return {"ok": False, "error": str(e)}

    with get_db() as conn:
        ensure_tenant_migrations(conn)
        return _aplicar_cliente(conn, cliente_crm)


def sincronizar_proveedor(proveedor_pos: dict) -> dict[str, Any]:
    """
    Sincroniza un proveedor individual desde el POS al CRM.

    Si el proveedor ya existe (por nombre), actualiza sus datos.
    Si no existe, lo crea como entidad bancaria.
    """
    try:
        proveedor_crm = transformar_proveedor_pos(proveedor_pos)
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    with get_db() as conn:
        ensure_tenant_migrations(conn)

        # Buscar si existe por nombre (case-insensitive)
        nombre = proveedor_crm["nombre"]
        row = conn.execute(
            "SELECT id FROM entidades_bancarias WHERE LOWER(nombre) = LOWER(?)",
            (nombre,),
        ).fetchone()

        if row:
            # Actualizar proveedor existente
            conn.execute(
                """
                UPDATE entidades_bancarias
                SET nombre=?, limite=?, updated_at_utc=?
                WHERE id=?
                """,
                (nombre, proveedor_crm["limite"], _utc_now(), row["id"]),
            )
            accion = "actualizado"
        else:
            # Crear nuevo proveedor
            conn.execute(
                """
                INSERT INTO entidades_bancarias (nombre, limite, updated_at_utc)
                VALUES (?, ?, ?)
                """,
                (nombre, proveedor_crm["limite"], _utc_now()),
            )
            accion = "creado"

    return {
        "ok": True,
        "accion": accion,
        "nombre": nombre,
    }


def sincronizar_lote_clientes(clientes_pos: list[dict]) -> dict[str, Any]:
    """
    Sincroniza un lote de clientes desde el POS al CRM.

    Retorna un resumen con:
    - creados: cantidad de clientes nuevos
    - actualizados: cantidad de clientes actualizados
    - errores: lista de errores con sus índices
    """
    if not isinstance(clientes_pos, list):
        return {"ok": False, "error": "clientes_pos debe ser una lista"}

    resumen = {
        "ok": True,
        "total": len(clientes_pos),
        "creados": 0,
        "actualizados": 0,
        "errores": [],
    }

    with get_db() as conn:
        ensure_tenant_migrations(conn)
        for idx, cliente_pos in enumerate(clientes_pos):
            nombre_log = "sin nombre"
            if isinstance(cliente_pos, dict):
                nombre_log = str(cliente_pos.get("nombre") or "sin nombre")
            conn.execute("SAVEPOINT sp_pos_cliente")
            try:
                cliente_crm = transformar_cliente_pos(cliente_pos)
                resultado = _aplicar_cliente(conn, cliente_crm)
                conn.execute("RELEASE SAVEPOINT sp_pos_cliente")
                if resultado["accion"] == "creado":
                    resumen["creados"] += 1
                else:
                    resumen["actualizados"] += 1
            except Exception as e:
                conn.execute("ROLLBACK TO SAVEPOINT sp_pos_cliente")
                resumen["errores"].append({
                    "indice": idx,
                    "error": str(e),
                    "cliente": nombre_log,
                })

    return resumen


def sincronizar_lote_proveedores(proveedores_pos: list[dict]) -> dict[str, Any]:
    """
    Sincroniza un lote de proveedores desde el POS al CRM.

    Retorna un resumen con:
    - creados: cantidad de proveedores nuevos
    - actualizados: cantidad de proveedores actualizados
    - errores: lista de errores con sus índices
    """
    if not isinstance(proveedores_pos, list):
        return {"ok": False, "error": "proveedores_pos debe ser una lista"}

    resumen = {
        "ok": True,
        "total": len(proveedores_pos),
        "creados": 0,
        "actualizados": 0,
        "errores": [],
    }

    for idx, proveedor_pos in enumerate(proveedores_pos):
        try:
            resultado = sincronizar_proveedor(proveedor_pos)
            if resultado.get("ok"):
                if resultado["accion"] == "creado":
                    resumen["creados"] += 1
                else:
                    resumen["actualizados"] += 1
            else:
                resumen["errores"].append({
                    "indice": idx,
                    "error": resultado.get("error"),
                    "proveedor": proveedor_pos.get("nombre", "sin nombre"),
                })
        except Exception as e:
            resumen["errores"].append({
                "indice": idx,
                "error": str(e),
                "proveedor": proveedor_pos.get("nombre", "sin nombre"),
            })

    return resumen


def exportar_clientes_para_pos() -> list[dict]:
    """
    Exporta clientes del CRM en formato compatible con el POS.

    Útil para sincronización bidireccional.
    """
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        rows = conn.execute(
            """
            SELECT id, nombre, scoring, techo_deuda, saldo_actual,
                   telefono, cuit, direccion, email
            FROM clientes
            ORDER BY nombre ASC
            """
        ).fetchall()

    return [
        {
            "id": r["id"],
            "nombre": r["nombre"],
            "scoring": r["scoring"],
            "limite_credito": r["techo_deuda"],
            "saldo": r["saldo_actual"],
            "telefono": r["telefono"],
            "cuit": r["cuit"],
            "direccion": r["direccion"],
            "email": r["email"],
        }
        for r in rows
    ]


def exportar_proveedores_para_pos() -> list[dict]:
    """
    Exporta proveedores (entidades bancarias) del CRM en formato compatible con el POS.

    Útil para sincronización bidireccional.
    """
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        rows = conn.execute(
            """
            SELECT id, nombre, limite
            FROM entidades_bancarias
            ORDER BY nombre ASC
            """
        ).fetchall()

    return [
        {
            "id": r["id"],
            "nombre": r["nombre"],
            "limite_credito": r["limite"],
        }
        for r in rows
    ]
