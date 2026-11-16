"""Cambiar de sucursal no vuelve a bajar el libro si el sello no cambió."""
from app.services.pos_base import filas_de, guardar_parte


def _ventas(sid, filas):
    guardar_parte(
        tabla="ventas",
        sucursal_id=sid,
        sucursal_nombre=f"PC {sid}",
        columnas=["id", "fecha", "total"],
        filas=filas,
        parte=1,
        partes=1,
    )


def test_una_lectura_alcanza_para_las_dos_sucursales(client, monkeypatch):
    import app.services.pos_base as base

    with base._cache_lock:
        base._cache.clear()
    _ventas(1, [[1, "2026-11-15 10:00:00", 10.0]])
    _ventas(2, [[2, "2026-11-15 11:00:00", 20.0]])

    publicadas = {"n": 0}
    real_publicar = base._publicar_tabla

    def publicar(*args, **kwargs):
        publicadas["n"] += 1
        return real_publicar(*args, **kwargs)

    monkeypatch.setattr(base, "_publicar_tabla", publicar)

    _, una = filas_de("ventas", 1)
    assert [fila[0] for fila in una] == [1]
    assert publicadas["n"] == 1

    _, otra = filas_de("ventas", 2)
    _, todas = filas_de("ventas")
    assert [fila[0] for fila in otra] == [2]
    assert sorted(fila[0] for fila in todas) == [1, 2]
    assert publicadas["n"] == 1

    with base._cache_lock:
        for clave, valor in list(base._cache.items()):
            base._cache[clave] = (0.0, valor[1], valor[2], valor[3])

    _, otra_vez = filas_de("ventas", 2)
    assert [fila[0] for fila in otra_vez] == [2]
    assert publicadas["n"] == 1


def test_el_panel_no_se_recalcula_si_el_libro_no_cambio(client, monkeypatch):
    import app.services.pos_jefe as jefe

    with jefe._panel_lock:
        jefe._panel_cache.clear()
    _ventas(1, [[1, "2026-11-15 10:00:00", 10.0]])
    llamadas = {"n": 0}
    real = jefe._armar_panel

    def envolver(*args, **kwargs):
        llamadas["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(jefe, "_armar_panel", envolver)
    primero = jefe.panel("pedidos", sucursal_id=1)
    segundo = jefe.panel("pedidos", sucursal_id=1)
    assert primero["sucursal_id"] == 1
    assert segundo["panel"] == primero["panel"]
    assert llamadas["n"] == 1

    otro = jefe.panel("pedidos", sucursal_id=2)
    assert otro["sucursal_id"] == 2
    assert llamadas["n"] == 2
