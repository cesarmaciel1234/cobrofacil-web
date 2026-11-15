/* Panel de herramientas de cada módulo. La lista sale de js/barra/. No pide datos. */
(function (global) {
    const ALIAS = { ticket: 'Tickets', dashboard: 'Balance' };

    function piramide() {
        return global.BarraPiramide || [];
    }

    function nombres() {
        const mapa = Object.assign({}, ALIAS);
        piramide().forEach((mod) => { mapa[mod.vista] = mod.nombre; });
        return mapa;
    }

    function deTipo(vista, tipo) {
        const mod = piramide().find((item) => item.vista === vista);
        return ((mod && mod.herramientas) || []).filter((item) => item.tipo === tipo);
    }

    let activo = 'reporte';
    let elegida = '';
    let pantalla = '';

    function $(id) {
        return document.getElementById(id);
    }

    function bolsa() {
        return $('bolsaHerramientas');
    }

    function piezas() {
        return [...document.querySelectorAll('[data-modulo="' + activo + '"]')];
    }

    function guardarDetalle() {
        const detalle = $('herramientasDetalle');
        const caja = bolsa();
        if (!detalle || !caja) return;
        [...detalle.children].forEach((nodo) => {
            nodo.hidden = true;
            caja.appendChild(nodo);
        });
        detalle.hidden = true;
    }

    function cerrarMenu() {
        const sidebar = $('sidebar');
        const backdrop = $('sidebarBackdrop');
        if (sidebar) sidebar.classList.remove('open');
        if (backdrop) {
            backdrop.classList.remove('active');
            backdrop.setAttribute('aria-hidden', 'true');
        }
        document.body.classList.remove('sidebar-open');
    }

    function vistaActiva() {
        return $('view-' + activo);
    }

    function slotActivo() {
        const vista = vistaActiva();
        if (!vista) return null;
        return vista.querySelector('.card-body') || vista.querySelector('[id$="Cuerpo"]') || vista;
    }

    function soltar() {
        const vista = vistaActiva();
        const caja = bolsa();
        if (!vista || !caja) return;
        vista.querySelectorAll('[data-herramienta]').forEach((nodo) => {
            nodo.hidden = true;
            caja.appendChild(nodo);
        });
        vista.querySelectorAll('[data-oculto-herramienta]').forEach((nodo) => {
            nodo.hidden = false;
            nodo.removeAttribute('data-oculto-herramienta');
        });
    }

    function mostrar(id) {
        soltar();
        if (!id) return;
        const nodo = document.querySelector('[data-modulo="' + activo + '"][data-herramienta="' + id + '"]');
        const slot = slotActivo();
        if (!nodo || !slot) return;
        [...slot.children].forEach((hijo) => {
            hijo.hidden = true;
            hijo.setAttribute('data-oculto-herramienta', '1');
        });
        nodo.hidden = false;
        slot.appendChild(nodo);
    }

    function pintar() {
        guardarDetalle();
        const titulo = $('herramientasTitulo');
        const lista = $('herramientasLista');
        const detalle = $('herramientasDetalle');
        if (detalle) {
            detalle.hidden = true;
            detalle.replaceChildren();
        }
        if (!lista) return;
        if (titulo) titulo.textContent = 'Herramientas · ' + (nombres()[activo] || 'Módulo');

        const pantallas = deTipo(activo, 'pantalla');
        const bloques = piezas();
        const vistas = deTipo(activo, 'vista');
        const filtros = deTipo(activo, 'filtro');
        const vacio = !pantallas.length && !bloques.length && !vistas.length && !filtros.length;

        lista.innerHTML = vacio
            ? '<p class="herramientas-vacio">Esta pantalla ya muestra lo esencial. No hay herramientas aparte.</p>'
            : '';

        const marca = pantalla || ((pantallas[0] && pantallas[0].id) || '');
        pantallas.forEach((accion) => {
            const id = accion.id || '';
            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'nav-item herramienta-btn' + ((id === marca || (!id && !marca)) ? ' active' : '');
            boton.textContent = accion.titulo;
            boton.addEventListener('click', (ev) => {
                ev.stopPropagation();
                pantalla = id;
                elegida = '';
                pintar();
                cerrarMenu();
                if (global.CrmBus) global.CrmBus.emit('pantallaModulo', activo, id);
            });
            lista.appendChild(boton);
        });

        bloques.forEach((nodo) => {
            const id = nodo.dataset.herramienta;
            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'nav-item herramienta-btn' + (elegida === id ? ' active' : '');
            boton.textContent = nodo.dataset.titulo || id;
            boton.addEventListener('click', (ev) => {
                ev.stopPropagation();
                elegir(id);
            });
            lista.appendChild(boton);
        });

        const filtroActual = global.CarteraLibro && global.CarteraLibro.filtroActual
            ? global.CarteraLibro.filtroActual()
            : '';
        filtros.forEach((accion) => {
            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'nav-item herramienta-btn' + (filtroActual === accion.filtro ? ' active' : '');
            boton.dataset.filtro = accion.filtro;
            boton.textContent = accion.titulo;
            boton.addEventListener('click', (ev) => {
                ev.stopPropagation();
                cerrarMenu();
                if (global.CarteraLibro) global.CarteraLibro.filtrar(accion.filtro);
                lista.querySelectorAll('[data-filtro]').forEach((item) => {
                    item.classList.toggle('active', item.dataset.filtro === accion.filtro);
                });
            });
            lista.appendChild(boton);
        });

        vistas.forEach((accion) => {
            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'nav-item herramienta-btn';
            boton.textContent = accion.titulo;
            boton.addEventListener('click', (ev) => {
                ev.stopPropagation();
                cerrarMenu();
                if (global.CrmBus) global.CrmBus.emit('switchView', accion.vista);
            });
            lista.appendChild(boton);
        });

        if (elegida) mostrar(elegida);
        else soltar();
    }

    function elegir(id) {
        const detalle = $('herramientasDetalle');
        if (elegida && elegida !== id && detalle) {
            const actual = detalle.querySelector('[data-herramienta="' + elegida + '"]');
            if (actual && bolsa()) {
                actual.hidden = true;
                bolsa().appendChild(actual);
            }
        }
        elegida = elegida === id ? '' : id;
        pintar();
        cerrarMenu();
    }

    function recoger(modulo) {
        const caja = bolsa();
        const vista = $('view-' + modulo);
        if (!caja || !vista) return;
        document.querySelectorAll('[data-modulo="' + modulo + '"]').forEach((nodo) => nodo.remove());
        vista.querySelectorAll('[data-herramienta]').forEach((nodo) => {
            nodo.dataset.modulo = modulo;
            nodo.hidden = true;
            caja.appendChild(nodo);
        });
        if (activo === modulo) pintar();
    }

    function usar(modulo) {
        soltar();
        activo = modulo || 'reporte';
        elegida = '';
        pantalla = '';
        pintar();
    }

    global.ModuloPanel = { recoger, usar, pintar };
})(window);
