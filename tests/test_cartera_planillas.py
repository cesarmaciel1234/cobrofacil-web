import pytest
from app.services.pos_jefe import panel

def test_panel_cargos():
    res = panel("cargos", periodo="Todas")
    assert res.get("ok") is True
    assert res.get("panel") == "cargos"
    assert "cargos" in res
    assert "resumen" in res
    assert res["resumen"].get("total_cargos", 0) >= 0

def test_panel_cobros():
    res = panel("cobros", periodo="Todas")
    assert res.get("ok") is True
    assert res.get("panel") == "cobros"
    assert "cobros" in res
    assert "resumen" in res
    assert res["resumen"].get("total_cobros", 0) >= 0

def test_panel_auditoria_cartera():
    res = panel("auditoria_cartera")
    assert res.get("ok") is True
    assert res.get("panel") == "auditoria_cartera"
    assert "auditoria" in res
    assert "resumen" in res
    assert res["resumen"].get("total_eventos", 0) >= 0

def test_panel_financiero():
    res = panel("financiero", periodo="Semana Actual")
    assert res.get("ok") is True
    assert res.get("panel") == "financiero"
    assert "kpis" in res
    assert "cerebro_jefe" in res
    assert "serie" in res
    assert len(res["cerebro_jefe"]) == 4
    assert len(res["serie"]) == 7
