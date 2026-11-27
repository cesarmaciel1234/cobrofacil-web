"""
Módulo de Caja y Contabilidad Diaria (Backend).
Exporta la lógica de cálculo y armado del panel de caja multi-sucursal.
"""

from app.services.caja.service_caja import (
    obtener_contabilidad_caja,
    armar_panel_caja,
    etiqueta_caja,
)

__all__ = [
    "obtener_contabilidad_caja",
    "armar_panel_caja",
    "etiqueta_caja",
]
