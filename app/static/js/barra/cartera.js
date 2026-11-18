/* Cartera. Misma plantilla que el resto. Las herramientas cambian la pantalla activa. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'cartera',
    nombre: 'Cartera',
    icono: '👥',
    vista: 'cartera',
    pantalla: 'Tarjetas de clientes',
    herramientas: [
        { id: 'clientes', titulo: 'Tarjetas de clientes', tipo: 'pantalla', icono: '👥', desc: 'Fichas y saldos activos' },
        { id: 'cargos', titulo: 'Historial de cargos', tipo: 'pantalla', icono: '📑', desc: 'Ventas y cargos a cuenta' },
        { id: 'cobros', titulo: 'Historial de cobros', tipo: 'pantalla', icono: '💵', desc: 'Recibos y acreditaciones' },
        { id: 'auditoria', titulo: 'Auditoría de cartera', tipo: 'pantalla', icono: '🛡️', desc: 'Control de cuadre y eventos' }
    ]
});
