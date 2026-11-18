/* Cartera. Misma plantilla que el resto. El menú filtra el libro. */
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
        { id: 'auditoria', titulo: 'Auditoría de cartera', tipo: 'pantalla', icono: '🛡️', desc: 'Control de cuadre y eventos' },
        { id: 'all', titulo: 'Todos', tipo: 'filtro', filtro: 'all' },
        { id: 'saldo', titulo: 'Con deuda', tipo: 'filtro', filtro: 'saldo' },
        { id: 'criticos', titulo: 'En riesgo', tipo: 'filtro', filtro: 'criticos' },
        { id: 'al_dia', titulo: 'Al día', tipo: 'filtro', filtro: 'al_dia' },
        { id: 'expres', titulo: 'Express', tipo: 'filtro', filtro: 'expres' },
        { id: '30', titulo: '30+ días', tipo: 'filtro', filtro: '30+' },
        { id: '60', titulo: '60+ días', tipo: 'filtro', filtro: '60+' },
        { id: '90', titulo: '90+ días', tipo: 'filtro', filtro: '90+' }
    ]
});
