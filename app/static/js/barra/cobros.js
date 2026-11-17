/* Ventas. Primera pantalla: el historial de tickets del día. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'cobros',
    nombre: 'Ventas',
    icono: '🧺',
    vista: 'ticket',
    pantalla: 'Historial',
    herramientas: [
        { id: 'historial', titulo: 'Historial', tipo: 'pantalla' },
        { id: 'desglose', titulo: 'Desglose de artículos', tipo: 'pantalla' }
    ]
});
