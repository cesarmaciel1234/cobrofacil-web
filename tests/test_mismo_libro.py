"""El día no esconde el mes. Reporte y Ventas suman el mismo libro."""
from app.services.pos_base import filas_de, guardar_parte, preparar_vista


def _libro(app):
    import app.services.pos_base as base
    import app.services.pos_jefe as jefe

    with app.app_context():
        with base._cache_lock:
            base._cache.clear()
            base._cache_dia.clear()
        with jefe._panel_lock:
            jefe._panel_cache.clear()
        guardar_parte(
            tabla="ventas",
            sucursal_id=1,
            sucursal_nombre="Maciel",
            columnas=["id", "fecha", "total", "estado", "metodo_pago"],
            filas=[
                [1, "2026-11-01 10:00:00", 100.0, "OK", "Efectivo"],
                [2, "2026-11-16 11:00:00", 50.0, "OK", "Efectivo"],
            ],
            parte=1,
            partes=1,
        )
        preparar_vista(1, "2026-11-16", "2026-11-16", desplazar_hoy=True)
        _, filas = filas_de("ventas", 1)
        assert len(filas) == 2
        rep = jefe.panel("reporte", sucursal_id=1, periodo="Mes")
        ven = jefe.panel(
            "ticket",
            sucursal_id=1,
            filtro={
                "alcance": "mes",
                "fecha": "2026-11-16",
                "metodo": "TODOS",
                "historico": False,
                "texto": "",
                "hora_desde": "00:00",
                "hora_hasta": "23:59",
                "caja": "",
            },
        )
    return rep, ven


def test_reporte_y_ventas_suman_el_mismo_mes(app):
    rep, ven = _libro(app)
    assert rep["vitrina"]["tickets"]["cant"] == 2
    assert rep["vitrina"]["tickets"]["total"] == 150
    assert ven["tickets_ok"] == 2
    assert ven["filtrado"] == 150
    assert ven["resumen"]["ventas"] == 150
    assert ven["resumen"]["tickets"] == 2
