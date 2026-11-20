/* Pedidos Reparto Fácil como pantalla principal directa, y Auditoría / Faltantes como herramientas. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'pedidos',
    nombre: 'Pedidos',
    icono: '📦',
    vista: 'pedidos',
    pantalla: 'Pedidos Reparto Fácil',
    herramientas: [
        { id: 'repartofacil', titulo: 'Pedidos Reparto Fácil', tipo: 'pantalla', icono: '🛵', desc: 'Recepción en vivo de pedidos de clientes y embalado' },
        { id: 'faltantes', titulo: 'Faltantes y reposición', tipo: 'pantalla', icono: '📦', desc: 'Sugerido de compra por quiebre de stock' },
        { id: 'auditoria', titulo: 'Auditoría de inventario', tipo: 'pantalla', icono: '📋', desc: 'Conteo físico táctil y escáner continuo' },
        { id: 'whatsapp', titulo: 'Mensaje al frigorífico', tipo: 'bloque' }
    ]
});
