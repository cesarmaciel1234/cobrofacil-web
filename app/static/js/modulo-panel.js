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

        const foot = $('sidebarFoot') || document.querySelector('.sidebar-foot');
        if (foot) {
            const esReporte = (activo === 'reporte');
            foot.style.display = esReporte ? 'flex' : 'none';
            foot.hidden = !esReporte;
        }

        const pantallas = deTipo(activo, 'pantalla');
        const bloques = piezas();
        const vistas = deTipo(activo, 'vista');
        const filtros = deTipo(activo, 'filtro');
        const vacio = !pantallas.length && !bloques.length && !vistas.length && !filtros.length;

        lista.innerHTML = vacio
            ? '<p class="herramientas-vacio">Esta pantalla ya muestra lo esencial. No hay herramientas aparte.</p>'
            : '';

        const marca = pantalla || (activo === 'cartera' && global.CarteraLibro && global.CarteraLibro.pantallaActual ? global.CarteraLibro.pantallaActual() : (activo === 'reporte' && global.ReporteJefe && global.ReporteJefe.pantallaActual ? global.ReporteJefe.pantallaActual() : ((pantallas[0] && pantallas[0].id) || '')));

        if (pantallas.length) {
            const lbl = document.createElement('div');
            lbl.className = 'nav-section-label';
            lbl.style.cssText = 'font-size:11px; font-weight:800; text-transform:uppercase; color:var(--text-tertiary, #64748b); padding:8px 12px 4px; letter-spacing:0.04em;';
            lbl.textContent = activo === 'cartera' ? 'Planillas y vistas' : (activo === 'reporte' ? 'Vistas de reporte' : 'Herramientas');
            lista.appendChild(lbl);
        }

        pantallas.forEach((accion) => {
            const id = accion.id || '';
            const isActive = (id === marca || (!id && !marca));
            const boton = document.createElement('button');
            boton.type = 'button';
            boton.className = 'nav-item herramienta-btn' + (isActive ? ' active' : '');
            if (accion.icono || accion.desc) {
                boton.style.cssText = 'min-height:48px; padding:8px 12px; margin-bottom:4px;';
                const icoHtml = accion.icono ? `<span style="font-size:18px; margin-right:10px; display:inline-flex; align-items:center; flex-shrink:0;">${accion.icono}</span>` : '';
                const descHtml = accion.desc ? `<div style="font-size:11px; color:var(--text-muted, #94a3b8); font-weight:500; margin-top:2px;">${accion.desc}</div>` : '';
                boton.innerHTML = `<div style="display:flex; align-items:center; width:100%; min-width:0;">
                    ${icoHtml}
                    <div style="flex:1; min-width:0; text-align:left;">
                        <div style="font-weight:700; font-size:13px; color:inherit; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${accion.titulo}</div>
                        ${descHtml}
                    </div>
                    ${isActive ? '<span style="display:inline-block; width:8px; height:8px; border-radius:999px; background:#3b82f6; margin-left:8px; flex-shrink:0;"></span>' : ''}
                </div>`;
            } else {
                boton.textContent = accion.titulo;
            }
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
