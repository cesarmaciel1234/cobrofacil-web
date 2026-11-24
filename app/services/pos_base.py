"""Copia fiel de las tablas de Cobro Fácil. No pisa la cartera ni los remitos."""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any

from app.database import ensure_tenant_migrations, get_db

logger = logging.getLogger(__name__)

_TABLA = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SECRETOS = ("password", "passwd", "token", "secret", "api_key", "access_token", "refresh_token")
# El libro ya leído se reusa unos segundos. Cambiar de ventana no vuelve a bajar Neon.
_CACHE_TTL = 5.0
_cache_lock = threading.Lock()
_cache: dict[tuple, tuple[float, tuple, list, list]] = {}
_cache_dia: dict[tuple, tuple[float, list, list]] = {}
# Mientras se arma UNA pantalla, la foto ya leída no caduca a mitad de camino.
_ancla: dict[str, float] = {}
_sucursales_mem: dict[str, tuple[float, list]] = {}
_TABLAS_DIA = ("ventas", "ventas_items", "detalles_ventas", "detalle_ventas")
_carga_lock = threading.Lock()
_carga: dict[int, dict] = {}


def anclar_vista() -> None:
    """La pantalla que se está armando se queda con la foto que acaba de leer."""
    with _cache_lock:
        _ancla[_ambito_cache()] = time.monotonic()


def soltar_vista() -> None:
    with _cache_lock:
        _ancla.pop(_ambito_cache(), None)


def _vigente(momento: float, ahora: float, ambito: str | None = None) -> bool:
    amb = ambito if ambito is not None else _ambito_cache()
    ancla = _ancla.get(amb)
    if ancla is not None and momento >= ancla:
        return True
    return ahora - momento < _CACHE_TTL


def anotar_carga(empresa_id: int, enviadas: int, total: int, dia: bool) -> None:
    """El día entra primero. Acá queda cuánto del libro ya llegó, para la barra de arriba."""
    with _carga_lock:
        previa = _carga.get(int(empresa_id)) or {}
        sub_n = max(int(enviadas or 0), int(previa.get("subidos") or 0))
        tot_n = max(int(total or 0), int(previa.get("total") or 0))
        if tot_n < sub_n:
            tot_n = sub_n
        _carga[int(empresa_id)] = {
            "subidos": sub_n,
            "total": tot_n,
            "progreso_texto": f"{sub_n}/{tot_n}" if tot_n > 0 else f"{sub_n}",
            "dia": bool(dia) or bool(previa.get("dia")),
        }


def leer_carga(empresa_id: int | None = None) -> dict:
    eid = _empresa_activa(empresa_id)
    with _carga_lock:
        dato = _carga.get(int(eid))
        if dato and int(dato.get("total") or 0) > 0:
            return dict(dato)
    # Si Render reinició o no hay dato en memoria, consultar la base
    try:
        with get_db(eid) as conn:
            ensure_tenant_migrations(conn)
            row = conn.execute("SELECT COALESCE(SUM(cantidad), 0) AS total_ventas FROM pos_base WHERE empresa_id = ? AND tabla = 'ventas'", (eid,)).fetchone()
            subidos = int(row["total_ventas"] or 0) if row else 0
            if subidos > 0:
                return {
                    "subidos": subidos,
                    "total": subidos,
                    "progreso_texto": f"{subidos}/{subidos}",
                    "dia": True,
                }
    except Exception:
        pass
    with _carga_lock:
        dato = _carga.get(int(eid))
        return dict(dato) if dato else {}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sucursal_id(valor: Any) -> int | None:
    if valor in ("", None):
        return None
    try:
        sid = int(valor)
        return sid if sid > 0 else 1
    except (TypeError, ValueError):
        return 1


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


def _leer_crudo(conn, tabla: str, sid: int | None, eid: int = 1) -> tuple[list, list]:
    if sid is None:
        partes = conn.execute(
            "SELECT columnas, filas FROM pos_base WHERE empresa_id = ? AND tabla = ? AND sucursal_id IS NULL ORDER BY parte",
            (eid, tabla),
        ).fetchall()
    else:
        partes = conn.execute(
            "SELECT columnas, filas FROM pos_base WHERE empresa_id = ? AND tabla = ? AND sucursal_id = ? ORDER BY parte",
            (eid, tabla, sid),
        ).fetchall()
    if not partes:
        return [], []
    columnas = list(json.loads(partes[0]["columnas"]))
    filas: list[list] = []
    for parte in partes:
        filas.extend(json.loads(parte["filas"]))
    return columnas, filas


def _borrar_partes(conn, tabla: str, sid: int | None, eid: int = 1) -> None:
    if sid is None:
        conn.execute("DELETE FROM pos_base WHERE empresa_id = ? AND tabla = ? AND sucursal_id IS NULL", (eid, tabla))
    else:
        conn.execute("DELETE FROM pos_base WHERE empresa_id = ? AND tabla = ? AND sucursal_id = ?", (eid, tabla, sid))


def _bloques_por_dia(columnas: list, filas: list) -> list[tuple[str | None, list]]:
    """Cada trozo queda de un solo día. Así el reporte no tiene que bajar el libro entero."""
    if not filas:
        return [(None, [])]
    idx = _columna(columnas, "fecha", "fecha_hora", "fecha_venta", "created_at")
    if idx is None:
        return [(None, filas)]
    grupos: dict[str, list] = {}
    for fila in filas:
        texto = str(fila[idx] or "")[:10] if idx < len(fila) else ""
        dia = texto if len(texto) == 10 and texto[4] == "-" and texto[7] == "-" else ""
        grupos.setdefault(dia, []).append(fila)
    bloques: list[tuple[str | None, list]] = []
    for dia in sorted(grupos, reverse=True):
        grupo = grupos[dia]
        for inicio in range(0, len(grupo), 150):
            bloques.append((dia or None, grupo[inicio : inicio + 150]))
    return bloques or [(None, [])]


def _nombre_que_ya_tiene(conn, sid: int | None, pedido: str | None, eid: int = 1) -> str | None:
    """Una sucursal que ya tiene nombre se queda con ese. No abre otra por un texto distinto."""
    texto = (pedido or "").strip() or None
    if texto and (texto.upper().startswith("DESKTOP-") or texto.upper().startswith("LAPTOP-")):
        texto = None
    if sid is None:
        return texto or "Maciel"
    filas = conn.execute(
        """
        SELECT DISTINCT sucursal_nombre
        FROM pos_base
        WHERE empresa_id = ? AND sucursal_id = ? AND sucursal_nombre IS NOT NULL AND TRIM(sucursal_nombre) <> ''
          AND UPPER(SUBSTR(sucursal_nombre, 1, 8)) <> 'DESKTOP-'
        """,
        (eid, int(sid)),
    ).fetchall()
    nombres = []
    for fila in filas:
        nombre = str(fila["sucursal_nombre"] or "").strip()
        if nombre and nombre not in nombres:
            nombres.append(nombre)
    if nombres:
        return nombres[0]
    return texto or "Maciel"


def _escribir_partes(conn, tabla: str, sid: int | None, sucursal_nombre: str | None, columnas: list, filas: list, ahora: str, eid: int = 1) -> None:
    sucursal_nombre = _nombre_que_ya_tiene(conn, sid, sucursal_nombre, eid=eid)
    _borrar_partes(conn, tabla, sid, eid=eid)
    for numero, (dia, bloque) in enumerate(_bloques_por_dia(columnas, filas), start=1):
        conn.execute(
            """
            INSERT INTO pos_base
            (empresa_id, sucursal_id, sucursal_nombre, tabla, parte, columnas, filas, cantidad, actualizado_en, dia)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                eid,
                sid,
                (sucursal_nombre or "").strip() or None,
                tabla,
                numero,
                json.dumps(columnas, ensure_ascii=False),
                json.dumps(bloque, ensure_ascii=False),
                len(bloque),
                ahora,
                dia or _dia_de_filas(columnas, bloque),
            ),
        )


def _anotar_novedad(conn, sid: int | None, tabla: str, columnas: list, fila: list | None, fila_id: str, baja: bool, ahora: str, eid: int = 1) -> None:
    conn.execute(
        """
        INSERT INTO pos_novedad
        (empresa_id, sucursal_id, tabla, fila_id, columnas, filas, baja, actualizado_en)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            eid,
            sid,
            tabla,
            fila_id,
            json.dumps(columnas, ensure_ascii=False),
            json.dumps(fila, ensure_ascii=False) if fila is not None else "null",
            1 if baja else 0,
            ahora,
        ),
    )


def novedades_desde(desde: str | None, sucursal_id: int | None = None, empresa_id: int | None = None) -> dict[str, Any]:
    """Filas que llegaron después de la marca. Sin marca, no manda el libro."""
    ahora = _utc_now()
    if not desde:
        return {"ok": True, "cantidad": 0, "filas": [], "actualizado_en": ahora}
    eid = _empresa_activa(empresa_id)
    sid = _sucursal_id(sucursal_id)
    with get_db(eid) as conn:
        ensure_tenant_migrations(conn)
        if sid is None:
            rows = conn.execute(
                """
                SELECT tabla, fila_id, columnas, filas, baja, actualizado_en
                FROM pos_novedad
                WHERE empresa_id = ? AND actualizado_en > ?
                ORDER BY actualizado_en, id
                LIMIT 500
                """,
                (eid, desde),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT tabla, fila_id, columnas, filas, baja, actualizado_en
                FROM pos_novedad
                WHERE empresa_id = ? AND actualizado_en > ? AND (sucursal_id = ? OR sucursal_id IS NULL)
                ORDER BY actualizado_en, id
                LIMIT 500
                """,
                (eid, desde, sid),
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
    empresa_id: int | None = None,
) -> dict[str, Any]:
    if not _TABLA.match(tabla or ""):
        raise ValueError("Nombre de tabla inválido")
    if not isinstance(columnas, list) or not isinstance(filas, list):
        raise ValueError("La tabla tiene que traer columnas y filas")
    parte = int(parte or 1)
    partes = int(partes or 1)
    if parte < 1 or partes < 1 or parte > partes:
        raise ValueError("Parte de tabla inválida")
    eid = _empresa_activa(empresa_id)
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
    with get_db(eid) as conn:
        ensure_tenant_migrations(conn)
        limpias = _omitir_copias(conn, tabla, columnas, limpias, sid, modo_txt, parte)
    if modo_txt == "delta":
        return _guardar_delta(tabla, columnas, limpias, sid, sucursal_nombre, list(bajas or []), eid=eid)
    with get_db(eid) as conn:
        ensure_tenant_migrations(conn)
        sucursal_nombre = _nombre_que_ya_tiene(conn, sid, sucursal_nombre, eid=eid)
        if parte == 1:
            if sid is None:
                conn.execute(
                    "DELETE FROM pos_base WHERE empresa_id = ? AND tabla = ? AND sucursal_id IS NULL",
                    (eid, tabla),
                )
            else:
                conn.execute(
                    "DELETE FROM pos_base WHERE empresa_id = ? AND tabla = ? AND sucursal_id = ?",
                    (eid, tabla, sid),
                )
        else:
            if sid is None:
                conn.execute(
                    "DELETE FROM pos_base WHERE empresa_id = ? AND tabla = ? AND sucursal_id IS NULL AND parte = ?",
                    (eid, tabla, parte),
                )
            else:
                conn.execute(
                    "DELETE FROM pos_base WHERE empresa_id = ? AND tabla = ? AND sucursal_id = ? AND parte = ?",
                    (eid, tabla, sid, parte),
                )
        conn.execute(
            """
            INSERT INTO pos_base
            (empresa_id, sucursal_id, sucursal_nombre, tabla, parte, columnas, filas, cantidad, actualizado_en, dia)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                eid,
                sid,
                (sucursal_nombre or "").strip() or None,
                tabla,
                parte,
                json.dumps(columnas, ensure_ascii=False),
                json.dumps(limpias, ensure_ascii=False),
                len(limpias),
                _utc_now(),
                _dia_de_filas(columnas, limpias),
            ),
        )
    _olvidar_tabla(tabla)
    return {"ok": True, "tabla": tabla, "parte": parte, "filas": len(limpias)}


def _guardar_delta(tabla: str, columnas: list, limpias: list, sid: int | None, sucursal_nombre: str | None, bajas: list, eid: int = 1) -> dict[str, Any]:
    """Mete las filas nuevas en la copia. No borra el resto del libro."""
    ahora = _utc_now()
    idx = _indice_id(columnas)
    with get_db(eid) as conn:
        ensure_tenant_migrations(conn)
        previas_col, previas = _leer_crudo(conn, tabla, sid, eid=eid)
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
            _escribir_partes(conn, tabla, sid, sucursal_nombre, columnas, limpias, ahora, eid=eid)
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
            _anotar_novedad(conn, sid, tabla, columnas, fila, clave, False, ahora, eid=eid)
            tocadas += 1
        for baja in bajas:
            clave = str(baja)
            if clave in por_id:
                del por_id[clave]
                orden = [item for item in orden if item != clave]
                _anotar_novedad(conn, sid, tabla, columnas, None, clave, True, ahora, eid=eid)
                tocadas += 1
        finales = [por_id[clave] for clave in orden if clave in por_id]
        _escribir_partes(conn, tabla, sid, sucursal_nombre, previas_col, finales, ahora, eid=eid)
        corte = datetime.now(timezone.utc).timestamp() - 48 * 3600
        conn.execute("DELETE FROM pos_novedad WHERE empresa_id = ? AND actualizado_en < ?", (eid, datetime.fromtimestamp(corte, timezone.utc).isoformat(),))
    _olvidar_tabla(tabla)
    return {"ok": True, "tabla": tabla, "parte": 1, "filas": tocadas, "modo": "delta"}


def indice_espejo(empresa_id: int | None = None) -> dict[str, Any]:
    """Sello de cada tabla. El teléfono, la PC y la tablet bajan solo la que cambió."""
    eid = _empresa_activa(empresa_id)
    with get_db(eid) as conn:
        ensure_tenant_migrations(conn)
        rows = conn.execute(
            """
            SELECT tabla, sucursal_id, MAX(actualizado_en) AS marca, COALESCE(SUM(cantidad), 0) AS n
            FROM pos_base
            WHERE empresa_id = ?
            GROUP BY tabla, sucursal_id
            ORDER BY tabla
            """,
            (eid,),
        ).fetchall()
    sello = ""
    tablas = []
    for row in rows:
        marca = str(row["marca"] or "")
        if marca > sello:
            sello = marca
        tablas.append({
            "tabla": row["tabla"],
            "sucursal_id": row["sucursal_id"],
            "sello": marca,
            "filas": int(row["n"] or 0),
        })
    return {"ok": True, "sello": sello, "tablas": tablas}


def tabla_espejo(tabla: str, empresa_id: int | None = None) -> dict[str, Any]:
    """Una tabla del libro, junta, para guardarla en el aparato."""
    if not _TABLA.match(tabla or ""):
        raise ValueError("Nombre de tabla inválido")
    eid = _empresa_activa(empresa_id)
    with get_db(eid) as conn:
        ensure_tenant_migrations(conn)
        partes = conn.execute(
            """
            SELECT sucursal_id, sucursal_nombre, columnas, filas, actualizado_en
            FROM pos_base WHERE empresa_id = ? AND tabla = ?
            ORDER BY sucursal_id, parte
            """,
            (eid, tabla),
        ).fetchall()
    grupos: dict[Any, dict] = {}
    orden: list[Any] = []
    sello = ""
    for parte in partes:
        marca = str(parte["actualizado_en"] or "")
        if marca > sello:
            sello = marca
        sid = parte["sucursal_id"]
        if sid not in grupos:
            orden.append(sid)
            grupos[sid] = {
                "sucursal_id": sid,
                "sucursal": parte["sucursal_nombre"] or "",
                "columnas": json.loads(parte["columnas"]),
                "filas": [],
            }
        grupos[sid]["filas"].extend(json.loads(parte["filas"]))
    return {"ok": True, "tabla": tabla, "sello": sello, "sucursales": [grupos[sid] for sid in orden]}


def delta_espejo(sello_desde: str = "") -> dict[str, Any]:
    """
    Delta de cambios en el espejo desde un sello dado.
    Devuelve solo las tablas que cambiaron después del sello con sus datos completos.
    Si no hay sello, devuelve el índice completo (para primer sync).
    """
    with get_db() as conn:
        ensure_tenant_migrations(conn)

        if not sello_desde:
            # Sin sello: devolver índice completo (no datos)
            ind = indice_espejo()
            ind["es_indice"] = True
            ind["cambios"] = []
            return ind

        # Con sello: buscar tablas con actualizado_en > sello_desde
        rows = conn.execute(
            """
            SELECT DISTINCT tabla
            FROM pos_base
            WHERE actualizado_en > ?
            ORDER BY tabla
            """,
            (sello_desde,),
        ).fetchall()

    tablas_cambiadas = [row["tabla"] for row in rows]

    if not tablas_cambiadas:
        return {
            "ok": True,
            "sello": sello_desde,
            "cambios": [],
            "cantidad": 0,
        }

    # Para cada tabla cambiada, obtener sus datos completos
    cambios = []
    sello_global = sello_desde

    for nombre_tabla in tablas_cambiadas:
        if not _TABLA.match(nombre_tabla or ""):
            continue

        try:
            tabla_data = tabla_espejo(nombre_tabla)
            if tabla_data.get("ok"):
                cambios.append({
                    "tabla": nombre_tabla,
                    "sello": tabla_data.get("sello", ""),
                    "sucursales": tabla_data.get("sucursales", []),
                })
                marca = tabla_data.get("sello", "")
                if marca > sello_global:
                    sello_global = marca
        except Exception:
            # Si falla una tabla, la skippeamos
            continue

    return {
        "ok": True,
        "sello": sello_global,
        "cambios": cambios,
        "cantidad": len(cambios),
    }


def resumen_base(empresa_id: int | None = None) -> list[dict]:
    eid = _empresa_activa(empresa_id)
    with get_db(eid) as conn:
        ensure_tenant_migrations(conn)
        rows = conn.execute(
            """
            SELECT tabla, sucursal_id, sucursal_nombre,
                   SUM(cantidad) AS cantidad, MAX(actualizado_en) AS actualizado_en
            FROM pos_base
            WHERE empresa_id = ?
            GROUP BY tabla, sucursal_id, sucursal_nombre
            ORDER BY tabla
            """,
            (eid,),
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


def _sid_int(sucursal_id) -> int | None:
    if sucursal_id is None:
        return None
    s = str(sucursal_id).strip().lower()
    if not s or s in ("none", "null", "todas", "web"):
        return None
    try:
        return int(sucursal_id)
    except (TypeError, ValueError):
        return None


def ultima_carga(sucursal_id: int | str | None = None, empresa_id: int | None = None) -> str | None:
    """Cuándo llegó el último trozo del libro a la nube."""
    eid = _empresa_activa(empresa_id)
    ambito = _ambito_cache(eid)
    if str(sucursal_id or "").strip().lower() == "web":
        with get_db(eid) as conn:
            row = conn.execute(
                "SELECT MAX(created_at) AS marca FROM public.repartofacil_pedidos WHERE empresa_id = %s",
                (eid,),
            ).fetchone()
            return str(row["marca"]) if row and row["marca"] else None
    sid = _sid_int(sucursal_id)
    with _cache_lock:
        marcas = [
            hit[1][0]
            for clave, hit in _cache.items()
            if clave[0] == ambito and hit[1] and hit[1][0] and (sid is None or clave[2] in (sid, None))
        ]
    if marcas:
        return max(marcas)
    with get_db(eid) as conn:
        ensure_tenant_migrations(conn)
        if sid is None:
            row = conn.execute("SELECT MAX(actualizado_en) AS marca FROM pos_base WHERE empresa_id = ?", (eid,)).fetchone()
        else:
            row = conn.execute(
                "SELECT MAX(actualizado_en) AS marca FROM pos_base WHERE empresa_id = ? AND sucursal_id = ?",
                (eid, sid),
            ).fetchone()
    if not row:
        return None
    return row["marca"] or None


def consolidar_sucursales(conn) -> None:
    """Unifica terminales registradas con el hostname del equipo si se duplicó el nodo."""
    try:
        conn.execute(
            """
            DELETE FROM pos_base
            WHERE sucursal_id = 2 AND empresa_id = 1
              AND (tabla, parte) IN (
                  SELECT tabla, parte FROM pos_base WHERE sucursal_id = 1 AND empresa_id = 1
              )
            """
        )
        conn.execute(
            """
            UPDATE pos_base
            SET sucursal_id = 1, sucursal_nombre = 'Casa Central - Alfaro 1964'
            WHERE sucursal_id = 2 AND empresa_id = 1
            """
        )
        if hasattr(conn, "commit"):
            conn.commit()
    except Exception as exc:
        logger.warning("consolidar_sucursales: %s", exc)


def _empresa_activa(empresa_id: int | None = None) -> int:
    if empresa_id is not None and int(empresa_id) > 0:
        return int(empresa_id)
    try:
        from flask import has_request_context, session, request
        if has_request_context():
            eid = session.get("empresa_id")
            if eid and int(eid) > 0:
                return int(eid)
            hdr = request.headers.get("X-Empresa-ID") or request.headers.get("X-Company-ID")
            if hdr and hdr.isdigit():
                return int(hdr)
            arg = request.args.get("empresa_id") or request.args.get("company_id")
            if arg and arg.isdigit():
                return int(arg)
    except Exception:
        pass
    return 1


def listar_sucursales(empresa_id: int | None = None) -> list[dict]:
    eid = _empresa_activa(empresa_id)
    ambito = _ambito_cache(eid)
    ahora = time.monotonic()
    with _cache_lock:
        hit = _sucursales_mem.get(ambito)
        if hit and _vigente(hit[0], ahora, ambito):
            return hit[1]

    # Prioridad: Consultar tabla de sucursales configuradas oficialmente
    try:
        from app.services import sucursales_service
        info = sucursales_service.listar_sucursales(eid)
        if info and info.get("sucursales"):
            salida = []
            for s in info["sucursales"]:
                salida.append({
                    "id": s["id"],
                    "nombre": s["nombre"],
                    "codigo": s.get("codigo") or "",
                    "direccion": s.get("direccion") or "",
                    "telefono": s.get("telefono") or "",
                    "whatsapp": s.get("whatsapp") or "",
                    "horario": s.get("horario") or "",
                    "es_centro_distribucion": bool(s.get("es_centro_distribucion", False)),
                    "terminales": s.get("terminales") or [],
                    "cantidad_terminales": len(s.get("terminales") or []),
                })
            salida.append({"id": "web", "nombre": "Tienda Web · Todas", "direccion": "Consolidado de todas las ventas online", "canal": "web"})
            fisicas = [x for x in salida if str(x["id"]) != "web" and not str(x["id"]).startswith("web-")]
            if len(fisicas) > 1:
                for s in fisicas:
                    salida.append({
                        "id": f"web-{s['id']}",
                        "nombre": f"Tienda Web · {s['nombre']}",
                        "direccion": f"Pedidos online y despacho de {s['nombre']}",
                        "canal": "web"
                    })
            with _cache_lock:
                _sucursales_mem[ambito] = (time.monotonic(), salida)
            return salida
    except Exception as exc:
        logger.warning("listar_sucursales usando sucursales_service falló: %s", exc)

    with get_db(eid) as conn:
        ensure_tenant_migrations(conn)
        consolidar_sucursales(conn)
        rows = conn.execute(
            """
            SELECT DISTINCT sucursal_id, sucursal_nombre
            FROM pos_base
            WHERE empresa_id = ? AND sucursal_id IS NOT NULL
            ORDER BY sucursal_id
            """,
            (eid,),
        ).fetchall()
    suc_map = {}
    for r in rows:
        sid = int(r["sucursal_id"])
        nom = str(r["sucursal_nombre"] or "").strip()
        if not nom:
            nom = f"Sucursal #{sid}"
        suc_map[sid] = nom

    salida = [{"id": sid, "nombre": nom} for sid, nom in sorted(suc_map.items())]
    # Canal online integrado: Reparto Fácil
    salida.append({"id": "web", "nombre": "Tienda Web"})
    with _cache_lock:
        _sucursales_mem[ambito] = (time.monotonic(), salida)
    return salida


def _ambito_cache(empresa_id: int | None = None) -> str:
    """La copia en memoria no se mezcla entre empresas ni entre bases de prueba."""
    from app.config import Config
    eid = _empresa_activa(empresa_id)
    if Config.DATABASE_URL and not Config.TESTING:
        return f"pg:{eid}"
    return f"sqlite:{eid}:{Config.DB_PATH}"


def _dia_texto(valor) -> str:
    texto = str(valor or "")[:10]
    if len(texto) == 10 and texto[4] == "-" and texto[7] == "-":
        return texto
    return ""


def _recortar_dias(columnas: list, filas: list, desde: str, hasta: str) -> list:
    """Deja las filas cuya fecha cae en el rango. Un trozo sin sello también entra."""
    idx = _columna(columnas, "fecha", "fecha_hora", "fecha_venta", "created_at")
    if idx is None:
        return filas
    return [
        fila for fila in filas
        if (dia := _dia_texto(fila[idx] if idx < len(fila) else "")) and desde <= dia <= hasta
    ]


def _dia_de_filas(columnas: list, filas: list) -> str | None:
    """Si la parte es un solo día, queda anotado para no bajar el libro entero."""
    idx = _columna(columnas, "fecha", "fecha_hora", "fecha_venta", "created_at")
    if idx is None:
        return None
    dias = set()
    for fila in filas:
        if idx >= len(fila):
            continue
        texto = str(fila[idx] or "")[:10]
        if len(texto) == 10 and texto[4] == "-" and texto[7] == "-":
            dias.add(texto)
    if len(dias) == 1:
        return dias.pop()
    return None


def _olvidar_tabla(tabla: str) -> None:
    with _cache_lock:
        for clave in list(_cache):
            if clave[1] == tabla:
                _cache.pop(clave, None)
        for clave in list(_cache_dia):
            if clave[1] == tabla:
                _cache_dia.pop(clave, None)
        _sucursales_mem.clear()
    if tabla in ("clientes", "cuenta_corriente", "configuracion"):
        try:
            from app.services.pos_jefe import olvidar_cartera
            olvidar_cartera()
        except Exception:
            pass


def sellos_de(tablas: tuple[str, ...], sucursal_id: int | str | None = None, empresa_id: int | None = None) -> tuple:
    """Marca barata de las tablas. Si no cambió, la cartera armada sigue sirviendo."""
    pedidas = [tabla for tabla in tablas if _TABLA.match(tabla or "")]
    if not pedidas:
        return ()
    if str(sucursal_id or "").strip().lower().startswith("web"):
        return tuple((None, 0) for _ in pedidas)
    eid = _empresa_activa(empresa_id)
    sid = _sid_int(sucursal_id)
    ambito = _ambito_cache(eid)
    ahora = time.monotonic()

    # Si ya están en caché en memoria dentro del TTL, devolver sus sellos sin consultar la DB
    with _cache_lock:
        sellos_mem = []
        todos_en_mem = True
        for t in pedidas:
            hit = _cache.get((ambito, t, sid))
            if hit and _vigente(hit[0], ahora, ambito):
                sellos_mem.append(hit[1])
            else:
                todos_en_mem = False
                break
        if todos_en_mem:
            return tuple(sellos_mem)

    marcas = ", ".join("?" for _ in pedidas)
    with get_db(eid) as conn:
        if sid is not None:
            rows = conn.execute(
                f"SELECT tabla, MAX(actualizado_en) AS marca, COALESCE(SUM(cantidad), 0) AS n FROM pos_base WHERE empresa_id = ? AND tabla IN ({marcas}) AND sucursal_id = ? GROUP BY tabla",
                (eid, *pedidas, sid),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT tabla, MAX(actualizado_en) AS marca, COALESCE(SUM(cantidad), 0) AS n FROM pos_base WHERE empresa_id = ? AND tabla IN ({marcas}) GROUP BY tabla",
                (eid, *pedidas),
            ).fetchall()
    por_tabla = {row["tabla"]: (row["marca"], int(row["n"] or 0)) for row in rows}
    return tuple(por_tabla.get(tabla, (None, 0)) for tabla in pedidas)


def _sello(conn, tabla: str, sucursal_id: int | str | None, empresa_id: int | None = None) -> tuple:
    eid = _empresa_activa(empresa_id)
    sid = _sid_int(sucursal_id)
    if sid is not None:
        row = conn.execute(
            "SELECT MAX(actualizado_en) AS marca, COALESCE(SUM(cantidad), 0) AS n FROM pos_base WHERE empresa_id = ? AND tabla = ? AND sucursal_id = ?",
            (eid, tabla, sid),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT MAX(actualizado_en) AS marca, COALESCE(SUM(cantidad), 0) AS n FROM pos_base WHERE empresa_id = ? AND tabla = ?",
            (eid, tabla),
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


def _sello_partes(partes) -> tuple:
    marca = None
    cantidad = 0
    for parte in partes:
        cantidad += int(parte["cantidad"] or 0)
        acto = parte["actualizado_en"]
        if acto and (marca is None or str(acto) > str(marca)):
            marca = acto
    return (marca, cantidad)


def _sello_combinado(por_sid: dict) -> tuple:
    marca = None
    cantidad = 0
    for sello in por_sid.values():
        cantidad += int(sello[1] or 0)
        acto = sello[0]
        if acto and (marca is None or str(acto) > str(marca)):
            marca = acto
    return (marca, cantidad)


def _sellos_tablas(conn, tablas: list[str], eid: int = 1) -> dict[str, dict]:
    marcas = ", ".join("?" for _ in tablas)
    rows = conn.execute(
        f"SELECT tabla, sucursal_id, MAX(actualizado_en) AS marca, COALESCE(SUM(cantidad), 0) AS n "
        f"FROM pos_base WHERE empresa_id = ? AND tabla IN ({marcas}) GROUP BY tabla, sucursal_id",
        (eid, *tablas),
    ).fetchall()
    salida: dict[str, dict] = {tabla: {} for tabla in tablas}
    for row in rows:
        sid = row["sucursal_id"]
        clave_sid = int(sid) if sid is not None else None
        salida.setdefault(row["tabla"], {})[clave_sid] = (row["marca"], int(row["n"] or 0))
    return salida


def _libro_fresco(ambito: str, tabla: str, sid: int | None, ahora: float) -> bool:
    with _cache_lock:
        hit = _cache.get((ambito, tabla, sid))
        if hit and _vigente(hit[0], ahora, ambito):
            return True
        base = _cache.get((ambito, tabla, None))
        return bool(sid is not None and not hit and base and _vigente(base[0], ahora, ambito))


def _tabla_vigente(ambito: str, tabla: str, por_sid: dict, ahora: float) -> bool:
    """El sello no cambió: se renueva la memoria y no se vuelven a leer las filas."""
    esperado = _sello_combinado(por_sid)
    with _cache_lock:
        base = _cache.get((ambito, tabla, None))
        if not base or base[1] != esperado:
            return False
        vivos = set()
        for sid, sello in por_sid.items():
            if sid is None:
                continue
            hit = _cache.get((ambito, tabla, int(sid)))
            if not hit or hit[1] != sello:
                return False
            vivos.add(int(sid))
        for clave in _cache:
            if clave[0] == ambito and clave[1] == tabla and clave[2] is not None and clave[2] not in vivos:
                return False
        for clave in list(_cache):
            if clave[0] == ambito and clave[1] == tabla:
                previo = _cache[clave]
                _cache[clave] = (ahora, previo[1], previo[2], previo[3])
        return True


def _publicar_tabla(ambito: str, tabla: str, partes: list, ahora: float, sellos: dict | None = None) -> None:
    """Una lectura llena Todas y cada sucursal. El sello queda igual al de la base."""
    grupos: dict = {}
    for parte in partes:
        grupos.setdefault(parte["sucursal_id"], []).append(parte)
    ramas = {}
    for sid, grupo in grupos.items():
        if sid is None:
            continue
        columnas, filas = _armar_filas(grupo)
        sello = (sellos or {}).get(int(sid)) or _sello_partes(grupo)
        ramas[int(sid)] = (sello, columnas, filas)
    columnas, filas = _armar_filas(partes)
    filas = _sin_copias(tabla, columnas, filas)
    consolidado = (_sello_combinado(sellos or {}), columnas, filas) if sellos is not None else (_sello_partes(partes), columnas, filas)
    with _cache_lock:
        for clave in list(_cache):
            if clave[0] == ambito and clave[1] == tabla:
                _cache.pop(clave, None)
        for sid, (stamp, cols, rows) in ramas.items():
            _cache[(ambito, tabla, sid)] = (ahora, stamp, cols, rows)
        _cache[(ambito, tabla, None)] = (ahora, consolidado[0], consolidado[1], consolidado[2])


def preparar_vista(
    sucursal_id: int | str | None,
    desde: str,
    hasta: str,
    desplazar_hoy: bool = False,
    empresa_id: int | None = None,
) -> str:
    """Una sola lectura trae el día y los catálogos. Devuelve el día que quedó."""
    if str(sucursal_id or "").strip().lower() == "web":
        return desde
    eid = _empresa_activa(empresa_id)
    sid = _sid_int(sucursal_id)
    ambito = _ambito_cache(eid)
    ahora = time.monotonic()
    dia_tablas = list(_TABLAS_DIA)
    completas = (
        "clientes", "productos", "articulos", "cuenta_corriente",
        "cobros_digitales", "mp_pagos", "proveedores", "configuracion",
    )
    marcas = ", ".join("?" for _ in dia_tablas)
    suc = "" if sid is None else " AND sucursal_id = ?"
    with get_db(eid) as conn:
        if desplazar_hoy:
            if sid is None:
                partes = conn.execute(
                    "WITH elegido AS ("
                    " SELECT COALESCE("
                    " (SELECT MAX(dia) FROM pos_base WHERE empresa_id = ? AND tabla = 'ventas' AND dia = ?),"
                    " (SELECT MAX(dia) FROM pos_base WHERE empresa_id = ? AND tabla = 'ventas' AND dia IS NOT NULL AND dia <> '')) AS dia)"
                    " SELECT p.tabla, p.sucursal_id, p.sucursal_nombre, p.columnas, p.filas,"
                    " p.cantidad, p.actualizado_en, p.parte, e.dia AS dia_elegido"
                    " FROM pos_base p, elegido e"
                    " WHERE p.empresa_id = ? AND (((p.tabla IN ('ventas', 'ventas_items', 'detalles_ventas', 'detalle_ventas')"
                    " AND (p.dia = e.dia OR p.dia IS NULL OR p.dia = ''))"
                    " OR p.tabla IN ('clientes', 'productos', 'configuracion')))"
                    " ORDER BY p.tabla, p.sucursal_id, p.parte",
                    (eid, desde, eid, eid),
                ).fetchall()
            else:
                partes = conn.execute(
                    "WITH elegido AS ("
                    " SELECT COALESCE("
                    " (SELECT MAX(dia) FROM pos_base WHERE empresa_id = ? AND tabla = 'ventas' AND sucursal_id = ? AND dia = ?),"
                    " (SELECT MAX(dia) FROM pos_base WHERE empresa_id = ? AND tabla = 'ventas' AND sucursal_id = ? AND dia IS NOT NULL AND dia <> '')) AS dia)"
                    " SELECT p.tabla, p.sucursal_id, p.sucursal_nombre, p.columnas, p.filas,"
                    " p.cantidad, p.actualizado_en, p.parte, e.dia AS dia_elegido"
                    " FROM pos_base p, elegido e"
                    " WHERE p.empresa_id = ? AND (((p.tabla IN ('ventas', 'ventas_items', 'detalles_ventas', 'detalle_ventas')"
                    " AND (p.dia = e.dia OR p.dia IS NULL OR p.dia = ''))"
                    " OR p.tabla IN ('clientes', 'productos', 'configuracion')))"
                    " AND p.sucursal_id = ?"
                    " ORDER BY p.tabla, p.sucursal_id, p.parte",
                    (eid, sid, desde, eid, sid, eid, sid),
                ).fetchall()
            elegido_dia = partes[0]["dia_elegido"] if partes else ""
            dia_real = str(elegido_dia or desde)
        else:
            dia_real = desde
            partes = conn.execute(
                "SELECT tabla, sucursal_id, sucursal_nombre, columnas, filas, cantidad, actualizado_en, parte "
                f"FROM pos_base WHERE empresa_id = ? AND tabla IN ({marcas}) AND ((dia >= ? AND dia <= ?) OR dia IS NULL OR dia = ''){suc} "
                "ORDER BY tabla, sucursal_id, parte",
                tuple([eid, *dia_tablas, desde, hasta, *(([sid]) if sid is not None else [])]),
            ).fetchall()
            partes += conn.execute(
                "SELECT tabla, sucursal_id, sucursal_nombre, columnas, filas, cantidad, actualizado_en, parte "
                f"FROM pos_base WHERE empresa_id = ? AND tabla IN ('clientes', 'productos', 'configuracion'){suc}",
                tuple([eid, *(([sid]) if sid is not None else [])]),
            ).fetchall()
    por_tabla: dict[str, list] = {}
    for parte in partes:
        por_tabla.setdefault(parte["tabla"], []).append(parte)
    ahora = time.monotonic()
    with _cache_lock:
        for tabla, grupo in por_tabla.items():
            columnas, filas = _armar_filas(grupo)
            if tabla in _TABLAS_DIA:
                corte_desde = dia_real if desplazar_hoy else desde
                corte_hasta = dia_real if desplazar_hoy else hasta
                filas = _recortar_dias(columnas, filas, corte_desde, corte_hasta)
            if sid is None and tabla in _TABLAS_DIA:
                filas = _sin_copias(tabla, columnas, filas)
            sello = _sello_partes(grupo)
            if tabla in _TABLAS_DIA:
                # El recorte del período no puede ocupar el lugar del libro entero.
                # Si hoy todavía no tiene ventas, el día elegido no se guarda bajo la fecha vacía.
                _cache_dia[(ambito, tabla, sid, corte_desde, corte_hasta)] = (ahora, columnas, filas)
            else:
                _cache[(ambito, tabla, sid)] = (ahora, sello, columnas, filas)
        for tabla in completas:
            if (ambito, tabla, sid) not in _cache:
                _cache[(ambito, tabla, sid)] = (ahora, (None, 0), [], [])
        for tabla in dia_tablas:
            if (ambito, tabla, sid, desde, hasta) not in _cache_dia:
                _cache_dia[(ambito, tabla, sid, desde, hasta)] = (ahora, [], [])
            if dia_real and (ambito, tabla, sid, dia_real, dia_real) not in _cache_dia:
                _cache_dia[(ambito, tabla, sid, dia_real, dia_real)] = (ahora, [], [])
    return dia_real


def ultimo_dia_ventas(sucursal_id: int | None = None, empresa_id: int | None = None) -> str:
    """El día más nuevo que ya está guardado, sin bajar los tickets."""
    eid = _empresa_activa(empresa_id)
    try:
        with get_db(eid) as conn:
            if sucursal_id is None:
                fila = conn.execute(
                    "SELECT MAX(dia) FROM pos_base WHERE empresa_id = ? AND tabla = 'ventas' AND dia IS NOT NULL AND dia <> ''",
                    (eid,),
                ).fetchone()
            else:
                fila = conn.execute(
                    "SELECT MAX(dia) FROM pos_base WHERE empresa_id = ? AND tabla = 'ventas' AND sucursal_id = ? AND dia IS NOT NULL AND dia <> ''",
                    (eid, int(sucursal_id)),
                ).fetchone()
    except Exception:
        return ""
    return str(fila[0] or "") if fila else ""


def hay_dia_ventas(dia: str, sucursal_id: int | str | None = None, empresa_id: int | None = None) -> bool:
    if not dia:
        return False
    if str(sucursal_id or "").strip().lower() == "web":
        return True
    eid = _empresa_activa(empresa_id)
    sid = _sid_int(sucursal_id)
    try:
        with get_db(eid) as conn:
            if sid is None:
                fila = conn.execute(
                    "SELECT 1 FROM pos_base WHERE empresa_id = ? AND tabla = 'ventas' AND dia = ? LIMIT 1",
                    (eid, dia),
                ).fetchone()
            else:
                fila = conn.execute(
                    "SELECT 1 FROM pos_base WHERE empresa_id = ? AND tabla = 'ventas' AND sucursal_id = ? AND dia = ? LIMIT 1",
                    (eid, sid, dia),
                ).fetchone()
    except Exception:
        return False
    return fila is not None


def _filas_del_rango(tabla: str, sucursal_id: int | str | None, desde: str, hasta: str, empresa_id: int | None = None) -> tuple[list[str], list[list]]:
    if str(sucursal_id or "").strip().lower() == "web":
        return [], []
    eid = _empresa_activa(empresa_id)
    sid = _sid_int(sucursal_id)
    ambito = _ambito_cache(eid)
    ahora = time.monotonic()
    clave = (ambito, tabla, sid, desde, hasta)
    with _cache_lock:
        hit = _cache_dia.get(clave)
        if hit and _vigente(hit[0], ahora, ambito):
            return hit[1], hit[2]
    with get_db(eid) as conn:
        if sid is None:
            partes = conn.execute(
                "SELECT sucursal_id, sucursal_nombre, columnas, filas, cantidad, actualizado_en "
                "FROM pos_base WHERE empresa_id = ? AND tabla = ? AND ((dia >= ? AND dia <= ?) OR dia IS NULL OR dia = '') "
                "ORDER BY sucursal_id, parte",
                (eid, tabla, desde, hasta),
            ).fetchall()
        else:
            partes = conn.execute(
                "SELECT sucursal_id, sucursal_nombre, columnas, filas, cantidad, actualizado_en "
                "FROM pos_base WHERE empresa_id = ? AND tabla = ? AND sucursal_id = ? AND ((dia >= ? AND dia <= ?) OR dia IS NULL OR dia = '') "
                "ORDER BY parte",
                (eid, tabla, sid, desde, hasta),
            ).fetchall()
    columnas, filas = _armar_filas(partes)
    filas = _recortar_dias(columnas, filas, desde, hasta)
    if sid is None:
        filas = _sin_copias(tabla, columnas, filas)
    with _cache_lock:
        _cache_dia[clave] = (ahora, columnas, filas)
    return columnas, filas


def _filas_sucursal(columnas: list, filas: list, sid: int) -> tuple[list, list]:
    """El libro de Todas ya está en memoria: de ahí sale una sucursal, sin devolver vacío."""
    idx = _columna(columnas, "sucursal_id")
    if idx is None:
        return columnas, filas
    salida = []
    for fila in filas:
        if idx >= len(fila):
            continue
        if _sucursal_id(fila[idx]) == sid:
            salida.append(fila)
    return columnas, salida


def hay_tabla(tabla: str, sucursal_id: int | str | None = None, empresa_id: int | None = None) -> bool:
    """La tabla existe en el libro, aunque el período pedido no tenga filas."""
    if not _TABLA.match(tabla or ""):
        return False
    if str(sucursal_id or "").strip().lower() == "web":
        return True
    eid = _empresa_activa(empresa_id)
    sid = _sid_int(sucursal_id)
    try:
        with get_db(eid) as conn:
            if sid is None:
                fila = conn.execute(
                    "SELECT 1 FROM pos_base WHERE empresa_id = ? AND tabla = ? LIMIT 1",
                    (eid, tabla),
                ).fetchone()
            else:
                fila = conn.execute(
                    "SELECT 1 FROM pos_base WHERE empresa_id = ? AND tabla = ? AND sucursal_id = ? LIMIT 1",
                    (eid, tabla, sid),
                ).fetchone()
    except Exception:
        return False
    return fila is not None


def filas_de(
    tabla: str,
    sucursal_id: int | str | None = None,
    desde: str | None = None,
    hasta: str | None = None,
    empresa_id: int | None = None,
) -> tuple[list[str], list[list]]:
    if not _TABLA.match(tabla or ""):
        return [], []
    if str(sucursal_id or "").strip().lower() == "web":
        if tabla in ("productos", "articulos"):
            return filas_de(tabla, None, desde=desde, hasta=hasta, empresa_id=empresa_id)
        return [], []
    eid = _empresa_activa(empresa_id)
    if desde and hasta and tabla in _TABLAS_DIA:
        return _filas_del_rango(tabla, sucursal_id, desde[:10], hasta[:10], empresa_id=eid)
    sid = _sid_int(sucursal_id)
    ambito = _ambito_cache(eid)
    ahora = time.monotonic()
    with _cache_lock:
        hit = _cache.get((ambito, tabla, sid))
        if hit and _vigente(hit[0], ahora, ambito):
            return hit[2], hit[3]
        base = _cache.get((ambito, tabla, None))
        if sid is not None and not hit and base and _vigente(base[0], ahora, ambito):
            return _filas_sucursal(base[2], base[3], sid)
    precargar_tablas((tabla,), sucursal_id=sid, empresa_id=eid)
    with _cache_lock:
        hit = _cache.get((ambito, tabla, sid))
        if hit:
            return hit[2], hit[3]
    return [], []


def precargar_tablas(
    tablas: tuple[str, ...] | list[str],
    sucursal_id: int | str | None = None,
    empresa_id: int | None = None,
) -> None:
    """Una lectura del libro alcanza para Todas y para cada sucursal.

    Si el sello no cambió, no se vuelven a bajar las filas.
    """
    pedidas = [t for t in tablas if _TABLA.match(t or "")]
    if not pedidas:
        return
    if str(sucursal_id or "").strip().lower() == "web":
        return
    eid = _empresa_activa(empresa_id)
    sid = _sid_int(sucursal_id)
    ambito = _ambito_cache(eid)
    ahora = time.monotonic()

    faltantes = [tabla for tabla in pedidas if not _libro_fresco(ambito, tabla, sid, ahora)]
    if not faltantes:
        return

    with get_db(eid) as conn:
        sellos = _sellos_tablas(conn, faltantes, eid=eid)
        bajar = [tabla for tabla in faltantes if not _tabla_vigente(ambito, tabla, sellos.get(tabla, {}), ahora)]
        partes = []
        if bajar:
            marcas = ", ".join("?" for _ in bajar)
            partes = conn.execute(
                f"SELECT tabla, sucursal_id, sucursal_nombre, columnas, filas, cantidad, actualizado_en "
                f"FROM pos_base WHERE empresa_id = ? AND tabla IN ({marcas}) ORDER BY tabla, sucursal_id, parte",
                (eid, *bajar),
            ).fetchall()

    if not bajar:
        return
    por_tabla: dict[str, list] = {}
    for parte in partes:
        por_tabla.setdefault(parte["tabla"], []).append(parte)
    for tabla in bajar:
        _publicar_tabla(ambito, tabla, por_tabla.get(tabla, []), ahora, sellos.get(tabla, {}))
