/* Caja. Primera pantalla: los medios de pago del día. Arqueo, movimientos y balance en el menú. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'caja',
    nombre: 'Caja',
    icono: '💰',
    vista: 'contabilidad',
    pantalla: 'Medios de pago',
    herramientas: [
        { id: 'arqueo', titulo: 'Arqueo por medio de pago', tipo: 'bloque' },
        { id: 'movimientos', titulo: 'Cobros y gastos del día', tipo: 'bloque' },
        { id: 'balance', titulo: 'Balance corporativo', tipo: 'vista', vista: 'dashboard' }
    ]
});
