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
_CACHE_TTL = 45.0
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
    """El DNI es el id de la persona. Sin DNI, el id de la caja junto con el nombre."""
    dni_i = _columna(columnas, "dni", "cuit")
    if dni_i is not None:
        dni = _digitos(fila[dni_i] if dni_i < len(fila) else "")
        if dni:
            return "dni:" + dni
    id_i = _indice_id(columnas)
    if id_i is None or id_i >= len(fila) or fila[id_i] in (None, ""):
        return ""
    nombre_i = _columna(columnas, "nombre")
    nombre = ""
    if nombre_i is not None and nombre_i < len(fila):
        nombre = str(fila[nombre_i] or "").strip().casefold()
    return "id:" + str(fila[id_i]) + ":" + nombre


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
    id_i = _indice_id(columnas)
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
        if clave in propias and tabla == "clientes" and modo == "delta":
            actual = str(fila[id_i]) if id_i is not None and id_i < len(fila) else ""
            if duenos.get(clave) not in (None, actual):
                continue
        vistas.add(clave)
        salida.append(fila)
    return salida


def ids_de_persona(buscado: Any) -> set[str]:
    """El id de la ficha puede ser el DNI. Devuelve los id de caja de esa persona."""
    texto = str(buscado or "")
    ids = {texto} if texto else set()
    columnas, filas = filas_de("clientes")
    id_i = _indice_id(columnas)
    dni_i = _columna(columnas, "dni", "cuit")
    if id_i is None:
        return ids
    for fila in filas:
        if id_i >= len(fila):
            continue
        cid = str(fila[id_i])
        dni = _digitos(fila[dni_i]) if dni_i is not None and dni_i < len(fila) else ""
        if cid == texto or (dni and dni == texto):
            ids.add(cid)
    return ids


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
    with _cache_lock:
        _cache[clave] = (time.monotonic(), stamp, columnas, filas)
    return columnas, filas
