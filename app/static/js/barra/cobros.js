/* Cobros. Primera pantalla: el aviso del módulo. La auditoría está en el menú. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'cobros',
    nombre: 'Cobros',
    icono: '💳',
    vista: 'digitales',
    pantalla: 'Cobros digitales del día',
    herramientas: [
        { id: 'auditoria', titulo: 'Libro de auditoría', tipo: 'bloque' }
    ]
});
