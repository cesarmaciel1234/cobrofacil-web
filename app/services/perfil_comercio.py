"""Ficha pública de Reparto Fácil, separada de la configuración privada."""
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
        perfil = conn.execute(
            f"""SELECT nombre, descripcion, direccion, latitud, longitud, whatsapp, horario, rubro
               FROM {_tabla('repartofacil_empresa_perfiles')} WHERE empresa_id = ?""",
            (empresa_id,),
        ).fetchone()
        resenas = conn.execute(
            f"""SELECT estrellas, comentario, created_at FROM {_tabla('repartofacil_resenas')}
               WHERE empresa_id = ? ORDER BY created_at DESC LIMIT 50""",
            (empresa_id,),
        ).fetchall()
        resumen = conn.execute(
            f"""SELECT COUNT(*) AS cantidad, AVG(estrellas) AS promedio
               FROM {_tabla('repartofacil_resenas')} WHERE empresa_id = ?""",
            (empresa_id,),
        ).fetchone()
    return {
        "empresa_id": empresa_id,
        "perfil": dict(perfil) if perfil else {
            "nombre": empresa["nombre"], "descripcion": "", "direccion": "",
            "latitud": None, "longitud": None, "whatsapp": "", "horario": "",
            "rubro": "Carnicería",
        },
        "resenas": [dict(row) for row in resenas],
        "cantidad": resumen["cantidad"],
        "promedio": float(resumen["promedio"]) if resumen["promedio"] is not None else None,
    }


def guardar_perfil(empresa_id, datos):
    if not isinstance(datos, dict):
        raise ValueError("Los datos de la empresa no son válidos.")
    textos = {}
    for campo, limite in (("nombre", 120), ("descripcion", 500), ("direccion", 250),
                          ("whatsapp", 20), ("horario", 250), ("rubro", 60)):
        valor = datos.get(campo)
        if valor is None and campo == "rubro":
            valor = "Carnicería"
        elif not isinstance(valor, str) or len(valor.strip()) > limite:
            raise ValueError(f"El campo {campo} no es válido.")
        textos[campo] = valor.strip()
    if not textos["nombre"]:
        raise ValueError("Ingresá el nombre del comercio.")
    if not textos.get("rubro"):
        textos["rubro"] = "Carnicería"
    telefono = textos["whatsapp"]
    if telefono and (not telefono.isascii() or not telefono.isdigit() or not 7 <= len(telefono) <= 15):
        raise ValueError("Ingresá el WhatsApp con código de país, solo números.")
    coords = []
    for campo, limite in (("latitud", 90), ("longitud", 180)):
        valor = datos.get(campo)
        if valor is None or valor == "":
            coords.append(None)
            continue
        if isinstance(valor, bool):
            raise ValueError("La ubicación no es válida.")
        try:
            numero = float(valor)
        except (ValueError, TypeError):
            raise ValueError("La ubicación no es válida.")
        if not -limite <= numero <= limite:
            raise ValueError("La ubicación no es válida.")
        coords.append(numero)
    if (coords[0] is None) != (coords[1] is None):
        raise ValueError("Ingresá latitud y longitud juntas.")

    confirmada = bool(datos.get("ubicacion_confirmada", False))
    anterior = leer_perfil(empresa_id)["perfil"]
    # Si no se mandaron coordenadas pero había anteriores, conservarlas
    if coords[0] is None and coords[1] is None and anterior.get("latitud") is not None and anterior.get("longitud") is not None:
        coords = [anterior["latitud"], anterior["longitud"]]
    with get_db(empresa_id=0) as conn:
        conn.execute(
            f"""INSERT INTO {_tabla('repartofacil_empresa_perfiles')}
               (empresa_id, nombre, descripcion, direccion, latitud, longitud, whatsapp, horario, rubro)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (empresa_id) DO UPDATE SET
               nombre = excluded.nombre, descripcion = excluded.descripcion,
               direccion = excluded.direccion, latitud = excluded.latitud,
               longitud = excluded.longitud, whatsapp = excluded.whatsapp,
               horario = excluded.horario, rubro = excluded.rubro, updated_at = CURRENT_TIMESTAMP
               RETURNING empresa_id""",
            (empresa_id, textos["nombre"], textos["descripcion"], textos["direccion"],
             coords[0], coords[1], textos["whatsapp"], textos["horario"], textos["rubro"]),
        )
    return leer_perfil(empresa_id)
