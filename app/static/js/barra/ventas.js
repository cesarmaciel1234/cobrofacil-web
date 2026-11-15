/* Ventas. Primera pantalla: la vitrina. Las herramientas viven en el menú. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'ventas',
    nombre: 'Reporte',
    icono: '👑',
    vista: 'reporte',
    pantalla: 'Vitrina del período',
    herramientas: [
        { id: 'alertas', titulo: 'Alertas del día', tipo: 'bloque' },
        { id: 'ranking', titulo: 'Ranking de cortes', tipo: 'bloque' },
        { id: 'sucursales', titulo: 'Rendimiento por sucursal', tipo: 'bloque' }
    ]
});
