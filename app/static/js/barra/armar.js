/* La barra ya está en la plantilla. Acá solo se marca el módulo abierto. */
(function () {
    window.BarraPiramide = window.BarraModulos || [];

    const vista = new URLSearchParams(location.search).get('view') || 'reporte';
    const pwa = document.getElementById('bottomPwaBar');
    if (pwa) {
        pwa.querySelectorAll('.pwa-nav-btn').forEach((btn) => {
            const activo = btn.dataset.pwaView === vista;
            btn.classList.toggle('active', activo);
        });
    }
})();
