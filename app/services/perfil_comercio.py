"""Ficha pública de Marca de Empresa (Datos Generales de la Marca).

De acuerdo con la arquitectura piramidal unificada:
- La Empresa es únicamente la Marca (Nombre comercial, Rubro, Descripción y Logo).
- Las direcciones, sucursales, WhatsApp y coordenadas pertenecen a la Sucursal.
"""
from app.database import get_db, is_postgres


def _tabla(nombre):
    return f"public.{nombre}" if is_postgres() else nombre


def leer_perfil(empresa_id):
    with get_db(empresa_id=0) as conn:
        empresa = conn.execute(
            f"SELECT nombre FROM {_tabla('empresas')} WHERE id = ?", (empresa_id,)
        ).fetchone()
        if not empresa:
            raise ValueError("La empresa no existe.")

        perfil = None
        try:
            perfil = conn.execute(
                f"""SELECT nombre, descripcion, rubro, logo_url
                   FROM {_tabla('repartofacil_empresa_perfiles')} WHERE empresa_id = ?""",
                (empresa_id,),
            ).fetchone()
        except Exception:
            try:
                perfil = conn.execute(
                    f"""SELECT nombre, descripcion
                       FROM {_tabla('repartofacil_empresa_perfiles')} WHERE empresa_id = ?""",
                    (empresa_id,),
                ).fetchone()
            except Exception:
                perfil = None

        resenas = []
        try:
            resenas = conn.execute(
                f"""SELECT estrellas, comentario, created_at FROM {_tabla('repartofacil_resenas')}
                   WHERE empresa_id = ? ORDER BY created_at DESC LIMIT 50""",
                (empresa_id,),
            ).fetchall()
        except Exception:
            pass

        resumen = None
        try:
            resumen = conn.execute(
                f"""SELECT COUNT(*) AS cantidad, AVG(estrellas) AS promedio
                   FROM {_tabla('repartofacil_resenas')} WHERE empresa_id = ?""",
                (empresa_id,),
            ).fetchone()
        except Exception:
            pass

    p_dict = dict(perfil) if perfil else {}
    return {
        "empresa_id": empresa_id,
        "perfil": {
            "nombre": p_dict.get("nombre") or empresa["nombre"],
            "descripcion": p_dict.get("descripcion") or "",
            "rubro": p_dict.get("rubro") or "Carnicería",
            "logo_url": p_dict.get("logo_url") or "",
        },
        "resenas": [dict(row) for row in resenas],
        "cantidad": resumen["cantidad"] if resumen else 0,
        "promedio": float(resumen["promedio"]) if resumen and resumen["promedio"] is not None else None,
    }


def guardar_perfil(empresa_id, datos):
    if not isinstance(datos, dict):
        raise ValueError("Los datos de la empresa no son válidos.")
    textos = {}
    for campo, limite in (("nombre", 120), ("descripcion", 500), ("rubro", 60), ("logo_url", 500)):
        valor = datos.get(campo)
        if valor is None:
            valor = "Carnicería" if campo == "rubro" else ""
        elif not isinstance(valor, str) or len(valor.strip()) > limite:
            raise ValueError(f"El campo {campo} no es válido.")
        textos[campo] = valor.strip()
    if not textos["nombre"]:
        raise ValueError("Ingresá el nombre del comercio.")
    if not textos.get("rubro"):
        textos["rubro"] = "Carnicería"

    with get_db(empresa_id=0) as conn:
        conn.execute(
            f"UPDATE {_tabla('empresas')} SET nombre = ? WHERE id = ?",
            (textos["nombre"], empresa_id)
        )
        conn.execute(
            f"""INSERT INTO {_tabla('repartofacil_empresa_perfiles')}
               (empresa_id, nombre, descripcion, rubro, logo_url)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (empresa_id) DO UPDATE SET
               nombre = excluded.nombre, descripcion = excluded.descripcion,
               rubro = excluded.rubro, logo_url = excluded.logo_url, updated_at = CURRENT_TIMESTAMP
               RETURNING empresa_id""",
            (empresa_id, textos["nombre"], textos["descripcion"], textos["rubro"], textos["logo_url"]),
        )
        if hasattr(conn, "commit"):
            conn.commit()
    return leer_perfil(empresa_id)
