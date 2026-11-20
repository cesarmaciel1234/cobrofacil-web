/* Pedidos y Abastecimiento. Pantalla principal y Auditoría de Inventario continua. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'pedidos',
    nombre: 'Pedidos',
    icono: '📦',
    vista: 'pedidos',
    pantalla: 'Faltantes y reposición',
    herramientas: [
        { id: 'faltantes', titulo: 'Faltantes y reposición', tipo: 'pantalla', icono: '📦', desc: 'Sugerido de compra por quiebre de stock' },
        { id: 'auditoria', titulo: 'Auditoría de inventario', tipo: 'pantalla', icono: '📋', desc: 'Conteo físico táctil y escáner continuo' },
        { id: 'repartofacil', titulo: 'Reparto Fácil', tipo: 'pantalla', icono: '🛵', desc: 'Pedidos de clientes para preparar y embalar' },
        { id: 'whatsapp', titulo: 'Mensaje al frigorífico', tipo: 'bloque' }
    ]
});
