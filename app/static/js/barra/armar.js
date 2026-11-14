/* Arma la barra de abajo con los cinco módulos. No pide datos. */
(function () {
    const mods = window.BarraModulos || [];
    window.BarraPiramide = mods;

    function texto(valor) {
        return String(valor || '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    const pwa = document.getElementById('bottomPwaBar');
    if (pwa) {
        const vista = new URLSearchParams(location.search).get('view') || 'reporte';
        pwa.innerHTML = mods.map((mod) => {
            if (mod.href) {
                return `<a href="${texto(mod.href)}" class="pwa-nav-btn" aria-label="${texto(mod.nombre)}"><span class="pwa-icon">${mod.icono}</span><span class="pwa-text">${texto(mod.nombre)}</span></a>`;
            }
            const activo = mod.vista === vista ? ' active' : '';
            return `<button type="button" class="pwa-nav-btn${activo}" data-pwa-view="${texto(mod.vista)}" aria-label="${texto(mod.nombre)}"><span class="pwa-icon">${mod.icono}</span><span class="pwa-text">${texto(mod.nombre)}</span></button>`;
        }).join('');
    }

    const cartera = document.querySelector('nav.modulos');
    if (cartera) {
        cartera.innerHTML = mods.map((mod) => {
            const href = mod.href || ('/?view=' + mod.vista);
            const activo = mod.id === 'cartera' ? ' class="active" aria-current="page"' : '';
            return `<a href="${texto(href)}"${activo}><span aria-hidden="true">${mod.icono}</span>${texto(mod.nombre)}</a>`;
        }).join('');
    }
})();
