/* Cartera. Página propia. El menú filtra el libro. La ficha abre el perfil y el ticket. */
window.BarraModulos = window.BarraModulos || [];
window.BarraModulos.push({
    id: 'cartera',
    nombre: 'Cartera',
    icono: '👥',
    vista: 'cartera',
    href: '/cartera',
    pantalla: 'Tarjetas de clientes',
    herramientas: [
        { id: 'sucursal', titulo: 'Sucursal', tipo: 'filtro' },
        { id: 'deuda', titulo: 'Con deuda, riesgo, al día, express, 30+, 60+, 90+', tipo: 'filtro' },
        { id: 'perfil', titulo: 'Perfil del cliente', tipo: 'ficha' },
        { id: 'historial', titulo: 'Historial', tipo: 'ficha' },
        { id: 'ticket', titulo: 'Ticket de la venta', tipo: 'ficha' }
    ]
});
