"""Copia fiel de las tablas de Cobro Fácil. No pisa la cartera ni los remitos."""
from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any

from app.database import ensure_tenant_migrations, get_db

_TABLA = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SECRETOS = ("password", "passwd", "token", "secret", "api_key", "access_token", "refresh_token")
# El libro ya leído se reusa unos segundos. Cambiar de ventana no vuelve a bajar Neon.
_CACHE_TTL = 5.0
_cache_lock = threading.Lock()
_cache: dict[tuple, tuple[float, tuple, list, list]] = {}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sucursal_id(valor: Any) -> int | None:
    if valor in ("", None):
        return None
    return int(valor)


def columna_secreta(nombre: str) -> bool:
    n = str(nombre or "").lower()
    return any(marca in n for marca in _SECRETOS)


def _indice_id(columnas: list) -> int | None:
    for i, col in enumerate(columnas):
        if str(col).lower() == "id":
            return i
    return None


def _columna(columnas: list, *nombres: str) -> int | None:
    buscados = {nombre.lower() for nombre in nombres}
    for i, col in enumerate(columnas):
        if str(col).lower() in buscados:
            return i
    return None


def _digitos(valor: Any) -> str:
    return "".join(caracter for caracter in str(valor or "") if caracter.isdigit())


def _clave_cliente(columnas: list, fila: list) -> str:
    """Copia: mismo DNI y mismo id de caja. Otro id con el mismo DNI es la misma persona en otra sucursal y se queda."""
    dni_i = _columna(columnas, "dni", "cuit")
    id_i = _indice_id(columnas)
    caja = ""
    if id_i is not None and id_i < len(fila) and fila[id_i] not in (None, ""):
        caja = str(fila[id_i])
    if dni_i is not None and dni_i < len(fila):
        dni = _digitos(fila[dni_i])
        if dni:
            return "dni:" + dni + ":" + caja
    if not caja:
        return ""
    nombre_i = _columna(columnas, "nombre")
    nombre = ""
    if nombre_i is not None and nombre_i < len(fila):
        nombre = str(fila[nombre_i] or "").strip().casefold()
    return "id:" + caja + ":" + nombre


def _clave_venta(columnas: list, fila: list) -> tuple:
    """Mismo id y mismo número de ticket. Si el número es el id, la fecha confirma que es la misma venta."""
    id_i = _indice_id(columnas)
    if id_i is None or id_i >= len(fila) or fila[id_i] in (None, ""):
        return ()
    venta_id = str(fila[id_i])
    num_i = _columna(columnas, "numero_ticket", "numero", "nro", "ticket")
    if num_i is not None and num_i < len(fila) and str(fila[num_i] or "").strip():
        return (venta_id, str(fila[num_i]).strip())
    fecha_i = _columna(columnas, "fecha", "fecha_hora", "fecha_venta")
    fecha = str(fila[fecha_i] if fecha_i is not None and fecha_i < len(fila) else "")[:19]
    return (venta_id, fecha)


def _clave_linea(columnas: list, fila: list) -> tuple:
    id_i = _indice_id(columnas)
    venta_i = _columna(columnas, "id_venta", "venta_id")
    if id_i is None or venta_i is None or id_i >= len(fila) or venta_i >= len(fila):
        return ()
    if fila[id_i] in (None, "") or fila[venta_i] in (None, ""):
        return ()
    return (str(fila[id_i]), str(fila[venta_i]))


def _clave_movimiento(columnas: list, fila: list) -> tuple:
    id_i = _indice_id(columnas)
    if id_i is None or id_i >= len(fila) or fila[id_i] in (None, ""):
        return ()
    fecha_i = _columna(columnas, "fecha", "fecha_hora")
    fecha = str(fila[fecha_i] if fecha_i is not None and fecha_i < len(fila) else "")[:19]
    return (str(fila[id_i]), fecha)


def _armar_clave(tabla: str, columnas: list, fila: list):
    if tabla == "clientes":
        return _clave_cliente(columnas, fila)
    if tabla == "ventas":
        return _clave_venta(columnas, fila)
    if tabla in ("detalles_ventas", "ventas_items"):
        return _clave_linea(columnas, fila)
    if tabla == "cuenta_corriente":
        return _clave_movimiento(columnas, fila)
    return None


def _claves_en(conn, tabla: str, sid: int | None, ajenas: bool) -> tuple[set, dict]:
    if ajenas:
        if sid is None:
            partes = conn.execute(
                "SELECT columnas, filas FROM pos_base WHERE tabla = ? AND sucursal_id IS NOT NULL",
                (tabla,),
            ).fetchall()
        else:
            partes = conn.execute(
                "SELECT columnas, filas FROM pos_base WHERE tabla = ? AND (sucursal_id IS NULL OR sucursal_id != ?)",
                (tabla, sid),
            ).fetchall()
    else:
        if sid is None:
            partes = conn.execute(
                "SELECT columnas, filas FROM pos_base WHERE tabla = ? AND sucursal_id IS NULL",
                (tabla,),
            ).fetchall()
        else:
            partes = conn.execute(
                "SELECT columnas, filas FROM pos_base WHERE tabla = ? AND sucursal_id = ?",
                (tabla, sid),
            ).fetchall()
    claves: set = set()
    duenos: dict = {}
    for parte in partes:
        columnas = json.loads(parte["columnas"])
        id_i = _indice_id(columnas)
        for fila in json.loads(parte["filas"]):
            clave = _armar_clave(tabla, columnas, fila)
            if not clave:
                continue
            claves.add(clave)
            if tabla == "clientes" and id_i is not None and id_i < len(fila):
                duenos.setdefault(clave, str(fila[id_i]))
    return claves, duenos


def _omitir_copias(conn, tabla: str, columnas: list, filas: list, sid: int | None, modo: str, parte: int) -> list:
    """La copia de otra PC no se agrega. La que ya está en el libro se queda."""
    if tabla not in ("clientes", "ventas", "detalles_ventas", "ventas_items", "cuenta_corriente"):
        return filas
    ajenas, _ = _claves_en(conn, tabla, sid, True)
    propias: set = set()
    duenos: dict = {}
    if not (modo == "reemplazo" and parte == 1):
        propias, duenos = _claves_en(conn, tabla, sid, False)
    salida = []
    vistas: set = set()
    for fila in filas:
        clave = _armar_clave(tabla, columnas, fila)
        if not clave:
            salida.append(fila)
            continue
        if clave in ajenas or clave in vistas:
            continue
        if clave in propias and modo == "reemplazo":
            continue
        vistas.add(clave)
        salida.append(fila)
    return salida


def enlaces_de_persona(buscado: Any) -> dict[str, Any]:
    """Un DNI junta los id de caja. Sin DNI, el mismo nombre en otra sucursal también es la misma persona."""
    texto = str(buscado or "")
    columnas, filas = filas_de("clientes")
    id_i = _indice_id(columnas)
    dni_i = _columna(columnas, "dni", "cuit")
    nom_i = _columna(columnas, "nombre")
    suc_i = _columna(columnas, "sucursal_id")
    dni_objetivo = _digitos(texto)
    if id_i is not None and dni_i is not None:
        conocidos = {
            _digitos(fila[dni_i])
            for fila in filas
            if dni_i < len(fila) and _digitos(fila[dni_i])
        }
        if dni_objetivo not in conocidos:
            dni_objetivo = ""
            for fila in filas:
                if id_i < len(fila) and str(fila[id_i]) == texto and dni_i < len(fila):
                    dni_objetivo = _digitos(fila[dni_i])
                    break
    ids = {texto} if texto else set()
    nombres: set[str] = set()
    if id_i is None:
        return {"dni": dni_objetivo, "ids": ids, "nombres": nombres}

    def _nombre(fila: list) -> str:
        if nom_i is None or nom_i >= len(fila):
            return ""
        return str(fila[nom_i] or "").strip()

    def _dni(fila: list) -> str:
        if dni_i is None or dni_i >= len(fila):
            return ""
        return _digitos(fila[dni_i])

    def _sucursal(fila: list) -> str:
        if suc_i is None or suc_i >= len(fila) or fila[suc_i] in (None, ""):
            return ""
        return str(fila[suc_i])

    nombre_buscado = ""
    for fila in filas:
        if id_i >= len(fila):
            continue
        cid = str(fila[id_i])
        if cid == texto or (dni_objetivo and _dni(fila) == dni_objetivo):
            if cid:
                ids.add(cid)
            nombre = _nombre(fila)
            if nombre:
                nombres.add(nombre)
                if not _dni(fila):
                    nombre_buscado = nombre.casefold()
    if nombre_buscado and not dni_objetivo:
        sucursales = {
            _sucursal(fila)
            for fila in filas
            if _nombre(fila).casefold() == nombre_buscado and not _dni(fila)
        }
        if len(sucursales) > 1:
            for fila in filas:
                if id_i >= len(fila):
                    continue
                if _nombre(fila).casefold() != nombre_buscado or _dni(fila):
                    continue
                cid = str(fila[id_i])
                if cid:
                    ids.add(cid)
                nombres.add(_nombre(fila))
    return {"dni": dni_objetivo, "ids": ids, "nombres": nombres}


def ids_de_persona(buscado: Any) -> set[str]:
    """El id de la ficha puede ser el DNI. Devuelve los id de caja de esa persona."""
    return set(enlaces_de_persona(buscado)["ids"])


def _monto(valor: Any) -> float:
    try:
        return round(float(valor or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def unir_clientes(columnas: list, filas: list) -> tuple[list, list]:
    """Un DNI, un cliente. Sin DNI, el mismo nombre en otra sucursal también. La deuda copiada cuenta una vez."""
    if not columnas or not filas:
        return columnas, filas
    dni_i = _columna(columnas, "dni", "cuit")
    deu_i = _columna(columnas, "deuda_actual", "deuda")
    nom_i = _columna(columnas, "nombre")
    suc_i = _columna(columnas, "sucursal_id")
    sucnom_i = _columna(columnas, "sucursal_nombre")
    nombres_por_sucursal: dict[str, set] = {}
    for fila in filas:
        dni = _digitos(fila[dni_i]) if dni_i is not None and dni_i < len(fila) else ""
        if dni or nom_i is None or nom_i >= len(fila):
            continue
        nombre = str(fila[nom_i] or "").strip().casefold()
        sucursal = str(fila[suc_i]) if suc_i is not None and suc_i < len(fila) and fila[suc_i] not in (None, "") else ""
        if nombre:
            nombres_por_sucursal.setdefault(nombre, set()).add(sucursal)
    grupos: dict[str, list] = {}
    orden: list[str] = []
    for fila in filas:
        dni = _digitos(fila[dni_i]) if dni_i is not None and dni_i < len(fila) else ""
        nombre = str(fila[nom_i] or "").strip().casefold() if nom_i is not None and nom_i < len(fila) else ""
        if dni:
            clave = "dni:" + dni
        elif nombre and len(nombres_por_sucursal.get(nombre, ())) > 1:
            clave = "nombre:" + nombre
        else:
            clave = _clave_cliente(columnas, fila) or str(id(fila))
        if clave not in grupos:
            orden.append(clave)
            grupos[clave] = []
        grupos[clave].append(fila)
    columnas_out = list(columnas)
    if _columna(columnas_out, "nombres") is None:
        columnas_out.append("nombres")
    if _columna(columnas_out, "sucursales") is None:
        columnas_out.append("sucursales")
    salida = []
    for clave in orden:
        grupo = grupos[clave]
        base = list(grupo[0])
        nombres: list[str] = []
        sucursales: list[str] = []
        montos: list[float] = []
        for fila in grupo:
            if nom_i is not None and nom_i < len(fila):
                nombre = str(fila[nom_i] or "").strip()
                if nombre and nombre not in nombres:
                    nombres.append(nombre)
            if sucnom_i is not None and sucnom_i < len(fila):
                sucursal = str(fila[sucnom_i] or "").strip()
                if sucursal and sucursal not in sucursales:
                    sucursales.append(sucursal)
            if deu_i is not None and deu_i < len(fila):
                montos.append(_monto(fila[deu_i]))
        if deu_i is not None and montos:
            distintos = []
            for monto in montos:
                if monto not in distintos:
                    distintos.append(monto)
            base[deu_i] = distintos[0] if len(distintos) == 1 else round(sum(distintos), 2)
        while len(base) < len(columnas):
            base.append("")
        base.append(" · ".join(nombres))
        base.append(" · ".join(sucursales))
        salida.append(base)
    return columnas_out, salida


def _sin_copias(tabla: str, columnas: list, filas: list) -> list:
    """En el consolidado, el ticket que ya vino de otra PC no se cuenta otra vez."""
    if tabla not in ("ventas", "detalles_ventas", "ventas_items", "cuenta_corriente"):
        return filas
    vistas: set = set()
    salida = []
    for fila in filas:
        clave = _armar_clave(tabla, columnas, fila)
        if clave:
            if clave in vistas:
                continue
            vistas.add(clave)
        salida.append(fila)
    return salida


def _leer_crudo(conn, tabla: str, sid: int | None) -> tuple[list, list]:
    if sid is None:
        partes = conn.execute(
            "SELECT columnas, filas FROM pos_base WHERE tabla = ? AND sucursal_id IS NULL ORDER BY parte",
            (tabla,),
        ).fetchall()
    else:
        partes = conn.execute(
            "SELECT columnas, filas FROM pos_base WHERE tabla = ? AND sucursal_id = ? ORDER BY parte",
            (tabla, sid),
        ).fetchall()
    if not partes:
        return [], []
    columnas = list(json.loads(partes[0]["columnas"]))
    filas: list[list] = []
    for parte in partes:
        filas.extend(json.loads(parte["filas"]))
    return columnas, filas


def _borrar_partes(conn, tabla: str, sid: int | None) -> None:
    if sid is None:
        conn.execute("DELETE FROM pos_base WHERE tabla = ? AND sucursal_id IS NULL", (tabla,))
    else:
        conn.execute("DELETE FROM pos_base WHERE tabla = ? AND sucursal_id = ?", (tabla, sid))


def _escribir_partes(conn, tabla: str, sid: int | None, sucursal_nombre: str | None, columnas: list, filas: list, ahora: str) -> None:
    _borrar_partes(conn, tabla, sid)
    bloques = [filas[i : i + 150] for i in range(0, len(filas), 150)] or [[]]
    for numero, bloque in enumerate(bloques, start=1):
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
                numero,
                json.dumps(columnas, ensure_ascii=False),
                json.dumps(bloque, ensure_ascii=False),
                len(bloque),
                ahora,
            ),
        )


def _anotar_novedad(conn, sid: int | None, tabla: str, columnas: list, fila: list | None, fila_id: str, baja: bool, ahora: str) -> None:
    conn.execute(
        """
        INSERT INTO pos_novedad
        (sucursal_id, tabla, fila_id, columnas, filas, baja, actualizado_en)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            sid,
            tabla,
            fila_id,
            json.dumps(columnas, ensure_ascii=False),
            json.dumps(fila, ensure_ascii=False) if fila is not None else "null",
            1 if baja else 0,
            ahora,
        ),
    )


def novedades_desde(desde: str | None, sucursal_id: int | None = None) -> dict[str, Any]:
    """Filas que llegaron después de la marca. Sin marca, no manda el libro."""
    ahora = _utc_now()
    if not desde:
        return {"ok": True, "cantidad": 0, "filas": [], "actualizado_en": ahora}
    sid = _sucursal_id(sucursal_id)
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        if sid is None:
            rows = conn.execute(
                """
                SELECT tabla, fila_id, columnas, filas, baja, actualizado_en
                FROM pos_novedad
                WHERE actualizado_en > ?
                ORDER BY actualizado_en, id
                LIMIT 500
                """,
                (desde,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT tabla, fila_id, columnas, filas, baja, actualizado_en
                FROM pos_novedad
                WHERE actualizado_en > ? AND (sucursal_id = ? OR sucursal_id IS NULL)
                ORDER BY actualizado_en, id
                LIMIT 500
                """,
                (desde, sid),
            ).fetchall()
    marca = desde
    filas = []
    for row in rows:
        marca = row["actualizado_en"] or marca
        filas.append({
            "tabla": row["tabla"],
            "id": row["fila_id"],
            "columnas": json.loads(row["columnas"]),
            "fila": json.loads(row["filas"]) if row["filas"] not in (None, "null") else None,
            "baja": bool(row["baja"]),
            "actualizado_en": row["actualizado_en"],
        })
    return {"ok": True, "cantidad": len(filas), "filas": filas, "actualizado_en": marca if filas else ahora}


def guardar_parte(
    tabla: str,
    columnas: list,
    filas: list,
    parte: int,
    partes: int,
    sucursal_id: Any = None,
    sucursal_nombre: str | None = None,
    modo: str = "reemplazo",
    bajas: list | None = None,
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
    modo_txt = "delta" if str(modo or "reemplazo") == "delta" else "reemplazo"
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        limpias = _omitir_copias(conn, tabla, columnas, limpias, sid, modo_txt, parte)
    if modo_txt == "delta":
        return _guardar_delta(tabla, columnas, limpias, sid, sucursal_nombre, list(bajas or []))
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
    _olvidar_tabla(tabla)
    return {"ok": True, "tabla": tabla, "parte": parte, "filas": len(limpias)}


def _guardar_delta(tabla: str, columnas: list, limpias: list, sid: int | None, sucursal_nombre: str | None, bajas: list) -> dict[str, Any]:
    """Mete las filas nuevas en la copia. No borra el resto del libro."""
    ahora = _utc_now()
    idx = _indice_id(columnas)
    with get_db() as conn:
        ensure_tenant_migrations(conn)
        previas_col, previas = _leer_crudo(conn, tabla, sid)
        if previas_col and previas_col != columnas:
            previas_col, previas = columnas, []
        if not previas_col:
            previas_col = columnas
        por_id: dict[str, list] = {}
        orden: list[str] = []
        idx_prev = _indice_id(previas_col) if previas_col else None
        if idx_prev is not None:
            for fila in previas:
                clave = str(fila[idx_prev])
                if clave not in por_id:
                    orden.append(clave)
                por_id[clave] = fila
        elif not limpias and not bajas:
            return {"ok": True, "tabla": tabla, "parte": 1, "filas": 0, "modo": "delta"}
        else:
            _escribir_partes(conn, tabla, sid, sucursal_nombre, columnas, limpias, ahora)
            _olvidar_tabla(tabla)
            return {"ok": True, "tabla": tabla, "parte": 1, "filas": len(limpias), "modo": "reemplazo"}
        tocadas = 0
        if idx is None:
            raise ValueError("El cambio no trae id")
        for fila in limpias:
            clave = str(fila[idx])
            if clave not in por_id:
                orden.append(clave)
            por_id[clave] = fila
            _anotar_novedad(conn, sid, tabla, columnas, fila, clave, False, ahora)
            tocadas += 1
        for baja in bajas:
            clave = str(baja)
            if clave in por_id:
                del por_id[clave]
                orden = [item for item in orden if item != clave]
                _anotar_novedad(conn, sid, tabla, columnas, None, clave, True, ahora)
                tocadas += 1
        finales = [por_id[clave] for clave in orden if clave in por_id]
        _escribir_partes(conn, tabla, sid, sucursal_nombre, previas_col, finales, ahora)
        corte = datetime.now(timezone.utc).timestamp() - 48 * 3600
        conn.execute("DELETE FROM pos_novedad WHERE actualizado_en < ?", (datetime.fromtimestamp(corte, timezone.utc).isoformat(),))
    _olvidar_tabla(tabla)
    return {"ok": True, "tabla": tabla, "parte": 1, "filas": tocadas, "modo": "delta"}


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


def _ambito_cache() -> str:
    """La copia en memoria no se mezcla entre empresas ni entre bases de prueba."""
    from app.config import Config

    if Config.DATABASE_URL and not Config.TESTING:
        try:
            from flask import has_request_context, session

            if has_request_context():
                return "pg:" + str(int(session.get("empresa_id") or 1))
        except Exception:
            pass
        return "pg:0"
    return "sqlite:" + str(Config.DB_PATH)


def _olvidar_tabla(tabla: str) -> None:
    with _cache_lock:
        for clave in list(_cache):
            if clave[1] == tabla:
                _cache.pop(clave, None)
    if tabla in ("clientes", "cuenta_corriente", "configuracion"):
        try:
            from app.services.pos_jefe import olvidar_cartera
            olvidar_cartera()
        except Exception:
            pass


def sellos_de(tablas: tuple[str, ...], sucursal_id: int | None = None) -> tuple:
    """Marca barata de las tablas. Si no cambió, la cartera armada sigue sirviendo."""
    pedidas = [tabla for tabla in tablas if _TABLA.match(tabla or "")]
    if not pedidas:
        return ()
    sid = int(sucursal_id) if sucursal_id is not None else None
    ambito = _ambito_cache()
    ahora = time.monotonic()

    # Si ya están en caché en memoria dentro del TTL, devolver sus sellos sin consultar la DB
    with _cache_lock:
        sellos_mem = []
        todos_en_mem = True
        for t in pedidas:
            hit = _cache.get((ambito, t, sid))
            if hit and ahora - hit[0] < _CACHE_TTL:
                sellos_mem.append(hit[1])
            else:
                todos_en_mem = False
                break
        if todos_en_mem:
            return tuple(sellos_mem)

    marcas = ", ".join("?" for _ in pedidas)
    with get_db() as conn:
        if sid is not None:
            rows = conn.execute(
                f"SELECT tabla, MAX(actualizado_en) AS marca, COALESCE(SUM(cantidad), 0) AS n FROM pos_base WHERE tabla IN ({marcas}) AND sucursal_id = ? GROUP BY tabla",
                (*pedidas, sid),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT tabla, MAX(actualizado_en) AS marca, COALESCE(SUM(cantidad), 0) AS n FROM pos_base WHERE tabla IN ({marcas}) GROUP BY tabla",
                pedidas,
            ).fetchall()
    por_tabla = {row["tabla"]: (row["marca"], int(row["n"] or 0)) for row in rows}
    return tuple(por_tabla.get(tabla, (None, 0)) for tabla in pedidas)


def _sello(conn, tabla: str, sucursal_id: int | None) -> tuple:
    if sucursal_id is not None:
        row = conn.execute(
            "SELECT MAX(actualizado_en) AS marca, COALESCE(SUM(cantidad), 0) AS n FROM pos_base WHERE tabla = ? AND sucursal_id = ?",
            (tabla, int(sucursal_id)),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT MAX(actualizado_en) AS marca, COALESCE(SUM(cantidad), 0) AS n FROM pos_base WHERE tabla = ?",
            (tabla,),
        ).fetchone()
    if not row:
        return (None, 0)
    return (row["marca"], int(row["n"] or 0))


def _armar_filas(partes) -> tuple[list[str], list[list]]:
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


def filas_de(tabla: str, sucursal_id: int | None = None) -> tuple[list[str], list[list]]:
    if not _TABLA.match(tabla or ""):
        return [], []
    sid = int(sucursal_id) if sucursal_id is not None else None
    clave = (_ambito_cache(), tabla, sid)
    ahora = time.monotonic()
    with _cache_lock:
        hit = _cache.get(clave)
        if hit and ahora - hit[0] < _CACHE_TTL:
            return hit[2], hit[3]
    with get_db() as conn:
        stamp = _sello(conn, tabla, sid)
        with _cache_lock:
            hit = _cache.get(clave)
            if hit and hit[1] == stamp:
                _cache[clave] = (time.monotonic(), stamp, hit[2], hit[3])
                return hit[2], hit[3]
        if sid is not None:
            partes = conn.execute(
                "SELECT sucursal_id, sucursal_nombre, columnas, filas FROM pos_base WHERE tabla = ? AND sucursal_id = ? ORDER BY parte",
                (tabla, sid),
            ).fetchall()
        else:
            partes = conn.execute(
                "SELECT sucursal_id, sucursal_nombre, columnas, filas FROM pos_base WHERE tabla = ? ORDER BY sucursal_id, parte",
                (tabla,),
            ).fetchall()
    columnas, filas = _armar_filas(partes)
    if sid is None:
        filas = _sin_copias(tabla, columnas, filas)
    with _cache_lock:
        _cache[clave] = (time.monotonic(), stamp, columnas, filas)
    return columnas, filas


def precargar_tablas(tablas: tuple[str, ...] | list[str], sucursal_id: int | None = None) -> None:
    """Carga múltiples tablas en un solo query contra Neon, poblando la caché en memoria."""
    pedidas = [t for t in tablas if _TABLA.match(t or "")]
    if not pedidas:
        return
    sid = int(sucursal_id) if sucursal_id is not None else None
    ambito = _ambito_cache()
    ahora = time.monotonic()

    faltantes = []
    with _cache_lock:
        for t in pedidas:
            hit = _cache.get((ambito, t, sid))
            if not (hit and ahora - hit[0] < _CACHE_TTL):
                faltantes.append(t)
    if not faltantes:
        return

    placeholders = ", ".join("?" for _ in faltantes)
    with get_db() as conn:
        if sid is not None:
            partes = conn.execute(
                f"SELECT tabla, sucursal_id, sucursal_nombre, columnas, filas, cantidad, actualizado_en "
                f"FROM pos_base WHERE tabla IN ({placeholders}) AND sucursal_id = ? ORDER BY tabla, parte",
                (*faltantes, sid),
            ).fetchall()
        else:
            partes = conn.execute(
                f"SELECT tabla, sucursal_id, sucursal_nombre, columnas, filas, cantidad, actualizado_en "
                f"FROM pos_base WHERE tabla IN ({placeholders}) ORDER BY tabla, sucursal_id, parte",
                faltantes,
            ).fetchall()

    por_tabla: dict[str, list] = {}
    for p in partes:
        por_tabla.setdefault(p["tabla"], []).append(p)

    with _cache_lock:
        for t in faltantes:
            t_partes = por_tabla.get(t, [])
            columnas, filas = _armar_filas(t_partes)
            if sid is None:
                filas = _sin_copias(t, columnas, filas)
            stamp = (
                max((p["actualizado_en"] for p in t_partes if p["actualizado_en"]), default=None),
                sum(int(p["cantidad"] or 0) for p in t_partes),
            )
            clave = (ambito, t, sid)
            _cache[clave] = (ahora, stamp, columnas, filas)
