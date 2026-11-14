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

    function accionesDe(vista) {
        const mod = piramide().find((item) => item.vista === vista);
        return ((mod && mod.herramientas) || []).filter((item) => item.tipo === 'vista');
    }

    let activo = 'reporte';
    let elegida = '';

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

    function pintar() {
        guardarDetalle();
        const titulo = $('herramientasTitulo');
        const lista = $('herramientasLista');
        const detalle = $('herramientasDetalle');
        if (!lista) return;
        if (titulo) titulo.textContent = 'Herramientas · ' + (nombres()[activo] || 'Módulo');

        const listaAcciones = accionesDe(activo);
        const bloques = piezas();
        const vacio = !listaAcciones.length && !bloques.length;

        lista.innerHTML = vacio
            ? '<p class="herramientas-vacio">Esta pantalla ya muestra lo esencial. No hay herramientas aparte.</p>'
            : '';

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

        listaAcciones.forEach((accion) => {
            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'nav-item herramienta-btn';
            boton.textContent = accion.titulo;
            boton.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (global.CrmBus) global.CrmBus.emit('switchView', accion.vista);
            });
            lista.appendChild(boton);
        });

        if (detalle) {
            detalle.hidden = true;
            detalle.replaceChildren();
            const nodo = bloques.find((item) => item.dataset.herramienta === elegida);
            if (nodo) {
                nodo.hidden = false;
                detalle.hidden = false;
                detalle.appendChild(nodo);
            }
        }
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
        activo = modulo || 'reporte';
        elegida = '';
        pintar();
    }

    global.ModuloPanel = { recoger, usar, pintar };
})(window);
