/* Caja. Primera pantalla: el arqueo del día. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'caja',
    nombre: 'Caja',
    icono: '💰',
    vista: 'contabilidad',
    pantalla: 'Arqueo por medio de pago',
    herramientas: [
        { id: 'arqueo', titulo: 'Arqueo por medio de pago', tipo: 'pantalla' },
        { id: 'digital', titulo: 'Pago digital', tipo: 'pantalla' },
        { id: 'historial', titulo: 'Historial de ventas', tipo: 'pantalla' },
        { id: 'desglose', titulo: 'Desglose de artículos', tipo: 'pantalla' }
    ]
});
