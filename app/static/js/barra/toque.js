/* La barra solo cambia el módulo visible. Los datos entran en el turno siguiente. */
(function () {
    const bar = document.getElementById('bottomPwaBar');
    if (!bar) return;

    let marco = 0;
    let pedido = '';

    function vistaActual() {
        const btn = bar.querySelector('.pwa-nav-btn.active');
        return (btn && btn.dataset.pwaView) || '';
    }

    function pintar(nombre) {
        const botones = bar.querySelectorAll('.pwa-nav-btn');
        for (let i = 0; i < botones.length; i++) {
            const on = botones[i].dataset.pwaView === nombre;
            botones[i].classList.toggle('active', on);
        }
        const id = 'view-' + nombre;
        const views = document.querySelectorAll('.view');
        for (let i = 0; i < views.length; i++) {
            views[i].classList.toggle('active', views[i].id === id);
        }
    }

    function cargar(nombre) {
        window.__barraPedido = nombre;
        pedido = nombre;
        if (marco) return;
        marco = 1;
        setTimeout(function () {
            marco = 0;
            if (window.CrmBus && window.CrmBus.get('switchView')) {
                window.CrmBus.emit('switchView', pedido);
            }
        }, 0);
    }

    bar.addEventListener('click', function (ev) {
        const btn = ev.target.closest('.pwa-nav-btn');
        if (!btn || !bar.contains(btn)) return;
        const nombre = btn.dataset.pwaView;
        if (!nombre) return;
        if (nombre === vistaActual()) {
            if (nombre === 'reporte' && window.CrmBus && window.CrmBus.get('switchView')) {
                window.CrmBus.emit('switchView', 'reporte');
            }
            return;
        }
        pintar(nombre);
        cargar(nombre);
    });
})();
