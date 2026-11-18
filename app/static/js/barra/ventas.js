/* Ventas / Reporte. Las herramientas viven en el menú lateral. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'ventas',
    nombre: 'Reporte',
    icono: '👑',
    vista: 'reporte',
    pantalla: 'Vitrina de ventas',
    herramientas: [
        { id: 'vitrina', titulo: 'Vitrina de ventas', tipo: 'pantalla', icono: '👑', desc: '12 KPIs y pulso del día' },
        { id: 'financiero', titulo: 'Reporte financiero', tipo: 'pantalla', icono: '📉', desc: 'Cerebro Jefe, curvas y ganancias' },
        { id: 'alertas', titulo: 'Alertas del día', tipo: 'bloque' },
        { id: 'ranking', titulo: 'Ranking de cortes', tipo: 'bloque' },
        { id: 'sucursales', titulo: 'Rendimiento por sucursal', tipo: 'bloque' }
    ]
});
