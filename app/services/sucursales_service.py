"""Servicio piramidal y modular de gestión de Sucursales y Terminales."""
from datetime import datetime
from app.database import get_db, is_postgres


def _tabla(nombre):
    return f"public.{nombre}" if is_postgres() else nombre


def listar_sucursales(empresa_id):
    """Devuelve la lista de sucursales activas de la empresa con sus terminales."""
    with get_db(empresa_id=0) as conn:
        sucs = conn.execute(
            f"""SELECT id, empresa_id, nombre, codigo, direccion, latitud, longitud,
                      telefono, whatsapp, horario, es_centro_distribucion, activo, created_at, updated_at
               FROM {_tabla('sucursales')}
               WHERE empresa_id = ? AND activo = 1
               ORDER BY id ASC""",
            (empresa_id,),
        ).fetchall()

        sucursales_list = []
        for s in sucs:
            s_dict = dict(s)
            terms = conn.execute(
                f"""SELECT id, sucursal_id, empresa_id, nombre, identificador_pc, descripcion,
                          ip_local, activo, ultimo_sync
                   FROM {_tabla('terminales')}
                   WHERE sucursal_id = ?
                   ORDER BY id ASC""",
                (s["id"],),
            ).fetchall()
            s_dict["terminales"] = [dict(t) for t in terms]
            s_dict["cantidad_terminales"] = len(s_dict["terminales"])
            sucursales_list.append(s_dict)

        # Terminales pendientes de asignación o sin sucursal
        pendientes = conn.execute(
            f"""SELECT id, sucursal_id, empresa_id, nombre, identificador_pc, descripcion,
                      ip_local, activo, ultimo_sync
               FROM {_tabla('terminales')}
               WHERE empresa_id = ? AND (sucursal_id IS NULL OR sucursal_id = 0)
               ORDER BY id ASC""",
            (empresa_id,),
        ).fetchall()
        pendientes_list = [dict(t) for t in pendientes]

    es_unico = len(sucursales_list) <= 1
    return {
        "empresa_id": empresa_id,
        "sucursales": sucursales_list,
        "terminales_pendientes": pendientes_list,
        "es_negocio_unico": es_unico,
        "cantidad": len(sucursales_list),
    }


def actualizar_terminal(empresa_id: int, terminal_id: int, datos: dict) -> dict:
    """Actualiza sucursal, nombre o estado de una terminal."""
    with get_db(empresa_id=0) as conn:
        term = conn.execute(
            f"SELECT id, sucursal_id, empresa_id FROM {_tabla('terminales')} WHERE id = ? AND empresa_id = ?",
            (terminal_id, empresa_id)
        ).fetchone()
        if not term:
            raise ValueError("Terminal no encontrada.")

        nombre = datos.get("nombre")
        sucursal_id = datos.get("sucursal_id")
        activo = datos.get("activo")

        updates = ["updated_at = CURRENT_TIMESTAMP"]
        params = []
        if nombre is not None:
            updates.append("nombre = ?")
            params.append(str(nombre).strip()[:100])
        if sucursal_id is not None:
            updates.append("sucursal_id = ?")
            params.append(int(sucursal_id) if sucursal_id else None)
        if activo is not None:
            updates.append("activo = ?")
            params.append(int(activo))

        params.extend([terminal_id, empresa_id])
        conn.execute(
            f"UPDATE {_tabla('terminales')} SET {', '.join(updates)} WHERE id = ? AND empresa_id = ?",
            tuple(params)
        )
        if hasattr(conn, "commit"):
            conn.commit()
    return {"success": True, "terminal_id": terminal_id}


def eliminar_terminal(empresa_id: int, terminal_id: int) -> dict:
    """Elimina o desvincula una terminal."""
    with get_db(empresa_id=0) as conn:
        conn.execute(
            f"DELETE FROM {_tabla('terminales')} WHERE id = ? AND empresa_id = ?",
            (terminal_id, empresa_id)
        )
        if hasattr(conn, "commit"):
            conn.commit()
    return {"success": True}


def guardar_sucursal(empresa_id, datos):
    """Crea o actualiza una sucursal para la empresa."""
    if not isinstance(datos, dict):
        raise ValueError("Datos de sucursal inválidos.")

    nombre = (datos.get("nombre") or "").strip()
    if not nombre:
        raise ValueError("Ingresá el nombre de la sucursal o local.")
    if len(nombre) > 120:
        raise ValueError("El nombre no puede superar 120 caracteres.")

    direccion = (datos.get("direccion") or "").strip()
    codigo = (datos.get("codigo") or "").strip()[:50]
    telefono = (datos.get("telefono") or "").strip()[:30]
    whatsapp = (datos.get("whatsapp") or "").strip()[:30]
    horario = (datos.get("horario") or "").strip()[:250]
    es_cd = bool(datos.get("es_centro_distribucion", False))

    latitud = None
    longitud = None
    if datos.get("latitud") is not None and datos.get("latitud") != "":
        try:
            latitud = float(datos["latitud"])
        except (ValueError, TypeError):
            pass
    if datos.get("longitud") is not None and datos.get("longitud") != "":
        try:
            longitud = float(datos["longitud"])
        except (ValueError, TypeError):
            pass

    sucursal_id = datos.get("id")
    with get_db(empresa_id=0) as conn:
        if sucursal_id:
            # Actualizar sucursal existente
            conn.execute(
                f"""UPDATE {_tabla('sucursales')}
                   SET nombre = ?, codigo = ?, direccion = ?, latitud = ?, longitud = ?,
                       telefono = ?, whatsapp = ?, horario = ?, es_centro_distribucion = ?,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = ? AND empresa_id = ?""",
                (nombre, codigo, direccion, latitud, longitud, telefono, whatsapp, horario,
                 es_cd, sucursal_id, empresa_id),
            )
            target_id = sucursal_id
        else:
            # Crear nueva sucursal
            cur = conn.execute(
                f"""INSERT INTO {_tabla('sucursales')}
                   (empresa_id, nombre, codigo, direccion, latitud, longitud,
                    telefono, whatsapp, horario, es_centro_distribucion, activo)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                   RETURNING id""",
                (empresa_id, nombre, codigo, direccion, latitud, longitud,
                 telefono, whatsapp, horario, es_cd),
            )
            row = cur.fetchone()
            target_id = row["id"] if row else None

        if hasattr(conn, "commit"):
            conn.commit()

    return listar_sucursales(empresa_id)


def eliminar_sucursal(empresa_id, sucursal_id):
    """Desactiva (soft-delete) una sucursal, previniendo eliminar la última activa."""
    with get_db(empresa_id=0) as conn:
        activas = conn.execute(
            f"SELECT COUNT(*) AS total FROM {_tabla('sucursales')} WHERE empresa_id = ? AND activo = 1",
            (empresa_id,),
        ).fetchone()
        if activas and activas["total"] <= 1:
            raise ValueError("No podés eliminar la única sucursal activa de la empresa.")

        conn.execute(
            f"UPDATE {_tabla('sucursales')} SET activo = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND empresa_id = ?",
            (sucursal_id, empresa_id),
        )
        # Desactivar también sus terminales
        conn.execute(
            f"UPDATE {_tabla('terminales')} SET activo = 0, updated_at = CURRENT_TIMESTAMP WHERE sucursal_id = ? AND empresa_id = ?",
            (sucursal_id, empresa_id),
        )
        if hasattr(conn, "commit"):
            conn.commit()

    return listar_sucursales(empresa_id)


def vincular_terminal(empresa_id, sucursal_id, datos):
    """Enlaza o registra una máquina local (PC / TPV) a una sucursal específica."""
    if not isinstance(datos, dict):
        raise ValueError("Datos de terminal inválidos.")

    identificador_pc = (datos.get("identificador_pc") or datos.get("nombre_maquina") or "").strip()
    if not identificador_pc:
        raise ValueError("Identificador de PC requerido.")

    nombre = (datos.get("nombre") or f"Caja {identificador_pc}").strip()[:100]
    descripcion = (datos.get("descripcion") or "").strip()[:200]
    ip_local = (datos.get("ip_local") or "").strip()[:50]

    with get_db(empresa_id=0) as conn:
        # Verificar que la sucursal pertenezca a la empresa
        suc = conn.execute(
            f"SELECT id FROM {_tabla('sucursales')} WHERE id = ? AND empresa_id = ? AND activo = 1",
            (sucursal_id, empresa_id),
        ).fetchone()
        if not suc:
            raise ValueError("La sucursal indicada no existe o no está activa.")

        # Buscar si ya existía esta terminal para actualizarla
        existente = conn.execute(
            f"SELECT id FROM {_tabla('terminales')} WHERE empresa_id = ? AND identificador_pc = ?",
            (empresa_id, identificador_pc),
        ).fetchone()

        if existente:
            conn.execute(
                f"""UPDATE {_tabla('terminales')}
                   SET sucursal_id = ?, nombre = ?, descripcion = ?, ip_local = ?,
                       activo = 1, ultimo_sync = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?""",
                (sucursal_id, nombre, descripcion, ip_local, existente["id"]),
            )
            target_id = existente["id"]
        else:
            cur = conn.execute(
                f"""INSERT INTO {_tabla('terminales')}
                   (sucursal_id, empresa_id, nombre, identificador_pc, descripcion, ip_local, activo, ultimo_sync)
                   VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
                   RETURNING id""",
                (sucursal_id, empresa_id, nombre, identificador_pc, descripcion, ip_local),
            )
            row = cur.fetchone()
            target_id = row["id"] if row else None

        if hasattr(conn, "commit"):
            conn.commit()

    return {"success": True, "terminal_id": target_id, "sucursal_id": sucursal_id, "identificador_pc": identificador_pc}


def resolver_sucursal_terminal(empresa_id, identificador_pc, sucursal_id_sugerido=None):
    """
    Resuelve a qué sucursal pertenece una terminal/PC de forma blindada.
    1. Si la terminal/PC envía explícitamente sucursal_id_sugerido (configurado en el TPV),
       esa es la sucursal soberana asignada a los datos. Se actualiza o registra la PC en esa sucursal.
    2. Si la PC no especifica sucursal, consulta su registro oficial en `terminales`.
    3. Si es una PC no registrada sin sugerencia, se asigna a la primera sucursal activa.
    NUNCA secuestra ni sobreescribe la sucursal enviada explícitamente por el cliente TPV.
    """
    id_pc = str(identificador_pc or "").strip()
    
    # Si viene sugerido explícitamente, validar
    sid_sugerido = None
    if sucursal_id_sugerido not in (None, ""):
        try:
            sid_sugerido = int(sucursal_id_sugerido)
        except (ValueError, TypeError):
            sid_sugerido = None

    if not id_pc:
        return sid_sugerido if sid_sugerido is not None else 1

    with get_db(empresa_id=0) as conn:
        term = conn.execute(
            f"""SELECT id, sucursal_id
               FROM {_tabla('terminales')}
               WHERE empresa_id = ? AND identificador_pc = ? AND activo = 1
               LIMIT 1""",
            (empresa_id, id_pc),
        ).fetchone()

        if sid_sugerido is not None:
            # La terminal especifica explícitamente su sucursal de origen: respetarla de forma inquebrantable
            if term:
                if term["sucursal_id"] != sid_sugerido:
                    conn.execute(
                        f"UPDATE {_tabla('terminales')} SET sucursal_id = ?, ultimo_sync = CURRENT_TIMESTAMP WHERE id = ?",
                        (sid_sugerido, term["id"]),
                    )
                else:
                    conn.execute(
                        f"UPDATE {_tabla('terminales')} SET ultimo_sync = CURRENT_TIMESTAMP WHERE id = ?",
                        (term["id"],),
                    )
            else:
                conn.execute(
                    f"""INSERT INTO {_tabla('terminales')}
                       (sucursal_id, empresa_id, nombre, identificador_pc, descripcion, activo, ultimo_sync)
                       VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)""",
                    (sid_sugerido, empresa_id, f"Caja {id_pc}", id_pc, "Terminal auto-detectada TPV"),
                )
            if hasattr(conn, "commit"):
                conn.commit()
            return sid_sugerido

        # Si no vino sugerido, usar el que ya tiene la terminal
        if term and term["sucursal_id"]:
            conn.execute(
                f"UPDATE {_tabla('terminales')} SET ultimo_sync = CURRENT_TIMESTAMP WHERE id = ?",
                (term["id"],),
            )
            if hasattr(conn, "commit"):
                conn.commit()
            return int(term["sucursal_id"])

        # Si es una PC nueva sin sucursal sugerida, buscar la primera activa
        primera_suc = conn.execute(
            f"SELECT id FROM {_tabla('sucursales')} WHERE empresa_id = ? AND activo = 1 ORDER BY id ASC LIMIT 1",
            (empresa_id,),
        ).fetchone()
        sid_target = int(primera_suc["id"]) if primera_suc else 1

        conn.execute(
            f"""INSERT INTO {_tabla('terminales')}
               (sucursal_id, empresa_id, nombre, identificador_pc, descripcion, activo, ultimo_sync)
               VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)""",
            (sid_target, empresa_id, f"Caja {id_pc}", id_pc, "Terminal auto-detectada TPV"),
        )
        if hasattr(conn, "commit"):
            conn.commit()

        return sid_target

