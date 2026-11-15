/* Ventas. Primera pantalla: el historial de tickets del día. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'cobros',
    nombre: 'Ventas',
    icono: '🧺',
    vista: 'ticket',
    pantalla: 'Historial del día',
    herramientas: [
        { id: 'historial', titulo: 'Historial del día', tipo: 'pantalla' },
        { id: 'desglose', titulo: 'Desglose de artículos', tipo: 'pantalla' }
    ]
});
