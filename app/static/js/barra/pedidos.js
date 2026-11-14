/* Pedidos. Primera pantalla: la lista de faltantes. El mensaje queda en el menú. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'pedidos',
    nombre: 'Pedidos',
    icono: '📦',
    vista: 'pedidos',
    pantalla: 'Faltantes y stock a pedir',
    herramientas: [
        { id: 'whatsapp', titulo: 'Mensaje al frigorífico', tipo: 'bloque' }
    ]
});
