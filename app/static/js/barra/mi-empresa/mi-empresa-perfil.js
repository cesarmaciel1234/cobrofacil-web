/* =========================================================================
   PERFIL DE MARCA (EMPRESA) - Cobro Fácil
   Maneja exclusivamente datos generales de marca:
   Nombre comercial, Rubro general, Descripción y Logo.
   ========================================================================= */
(function (global) {
    const form = document.getElementById('empresaPerfilForm');
    const estado = document.getElementById('empresaPerfilEstado');
    const resumen = document.getElementById('empresaPerfilResumen');
    const editar = document.getElementById('empresaPerfilEditar');
    const lista = document.getElementById('empresaPerfilResenas');
    const valoracion = document.getElementById('empresaPerfilValoracion');

    const campos = ['nombre', 'rubro', 'descripcion', 'logo_url'];
    let version = 0;
    let guardando = false;
    let empresaActiva = null;
    let datosActuales = null;

    function pintar(datos, role) {
        datosActuales = datos;
        const perfil = datos.perfil || {};
        campos.forEach((campo) => {
            if (form && form.elements[campo]) {
                form.elements[campo].value = perfil[campo] ?? '';
            }
        });

        const nombreComercial = perfil.nombre || 'Empresa';
        const inicialEl = document.getElementById('empresaPerfilInicial');
        const nombreEl = document.getElementById('empresaPerfilNombre');
        if (inicialEl) inicialEl.textContent = (nombreComercial.trim()[0] || 'E').toUpperCase();
        if (nombreEl) nombreEl.textContent = nombreComercial;

        const rubroEl = document.getElementById('empresaPerfilRubro');
        if (rubroEl) rubroEl.textContent = perfil.rubro || 'Carnicería';

        const descEl = document.getElementById('empresaPerfilDescripcion');
        if (descEl) descEl.textContent = perfil.descripcion || 'Sin descripción comercial agregada.';

        const logoTxtEl = document.getElementById('empresaPerfilLogoTexto');
        if (logoTxtEl) {
            logoTxtEl.textContent = perfil.logo_url ? perfil.logo_url : 'Sin logo configurado (se muestra inicial)';
        }

        if (form && form.elements.rubro) {
            form.elements.rubro.value = perfil.rubro || 'Carnicería';
        }

        if (editar) editar.hidden = role !== 'admin';

        if (valoracion) {
            valoracion.textContent = datos.cantidad
                ? `${Number(datos.promedio).toFixed(1)} / 5 · ${datos.cantidad} reseña(s)`
                : 'Todavía no hay reseñas.';
        }

        if (lista) {
            lista.replaceChildren();
            (datos.resenas || []).forEach((resena) => {
                const tarjeta = document.createElement('p');
                tarjeta.textContent = `${resena.estrellas} / 5 · ${resena.comentario || 'Sin comentario'}`;
                lista.appendChild(tarjeta);
            });
        }
    }

    async function solicitar(opciones) {
        const respuesta = await global.CrmSafe.apiFetch('/api/repartofacil/mi-empresa', opciones);
        const datos = await respuesta.json();
        if (!respuesta.ok) throw new Error(datos.error || 'No se pudo consultar la ficha de marca.');
        return datos;
    }

    function sesionValida() {
        const usuario = global.CrmBus.emit('getSessionUser');
        return usuario && usuario.role === 'admin' && usuario.empresa_id === empresaActiva;
    }

    async function entrar(usuario) {
        const actual = ++version;
        empresaActiva = usuario.empresa_id;
        datosActuales = null;
        if (estado) estado.textContent = 'Cargando datos de marca…';
        if (form) form.hidden = true;
        if (resumen) resumen.hidden = true;
        if (lista) lista.replaceChildren();
        if (valoracion) valoracion.textContent = '';

        try {
            const datos = await solicitar();
            if (actual !== version) return;
            if (datos.empresa_id !== usuario.empresa_id) throw new Error('La sesión cambió. Volvé a iniciar sesión.');
            pintar(datos, usuario.role);
            if (resumen) resumen.hidden = false;
            if (estado) estado.textContent = usuario.role === 'admin' ? '' : 'Tu usuario puede consultar la marca, pero no editarla.';
        } catch (error) {
            if (actual === version && estado) estado.textContent = error.message || 'No se pudo cargar la marca.';
        }
    }

    function init() {
        if (editar) {
            editar.addEventListener('click', () => {
                if (!sesionValida() || guardando) {
                    if (estado) estado.textContent = 'La sesión cambió. Volvé a abrir la ficha.';
                    return;
                }
                if (estado) estado.textContent = '';
                if (resumen) resumen.hidden = true;
                if (form) form.hidden = false;
            });
        }

        document.querySelectorAll('[data-editar-campo]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                if (!sesionValida() || guardando) {
                    if (estado) estado.textContent = 'La sesión cambió. Volvé a abrir la ficha.';
                    return;
                }
                const campo = btn.getAttribute('data-editar-campo');
                if (estado) estado.textContent = '';
                if (resumen) resumen.hidden = true;
                if (form) form.hidden = false;
                if (campo && form && form.elements[campo]) {
                    form.elements[campo].focus();
                }
            });
        });

        const cancelarBtn = document.getElementById('empresaPerfilCancelar');
        if (cancelarBtn) {
            cancelarBtn.addEventListener('click', () => {
                if (guardando || !datosActuales) return;
                pintar(datosActuales, 'admin');
                if (form) form.hidden = true;
                if (resumen) resumen.hidden = false;
                if (estado) estado.textContent = '';
            });
        }

        if (form) {
            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                if (guardando) return;
                if (!sesionValida()) {
                    if (estado) estado.textContent = 'La sesión cambió. Volvé a abrir la ficha.';
                    return;
                }

                const datos = {};
                campos.forEach((campo) => {
                    if (form.elements[campo]) datos[campo] = form.elements[campo].value.trim();
                });
                datos.empresa_id = empresaActiva;
                guardando = true;
                const actual = version;
                Array.from(form.elements).forEach((elemento) => { elemento.disabled = true; });
                if (estado) estado.textContent = 'Guardando datos de marca…';

                try {
                    const resultado = await solicitar({
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(datos),
                    });
                    if (actual !== version) return;
                    pintar(resultado, 'admin');
                    form.hidden = true;
                    if (resumen) resumen.hidden = false;
                    if (estado) estado.textContent = '✓ Marca actualizada con éxito.';
                } catch (error) {
                    if (actual === version && estado) estado.textContent = error.message || 'No se pudo guardar la marca.';
                } finally {
                    Array.from(form.elements).forEach((elemento) => { elemento.disabled = false; });
                    guardando = false;
                }
            });
        }
    }

    global.MiEmpresaPerfil = { init, entrar, pintar, solicitar, sesionValida };
})(window);
