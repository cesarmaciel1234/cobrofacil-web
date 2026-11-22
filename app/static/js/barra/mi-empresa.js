/* Ficha pública y reseñas verificadas de la empresa de la sesión. */
(function (global) {
    global.BarraModulos = global.BarraModulos || [];
    global.BarraModulos.push({ id: 'mi-empresa', nombre: 'Mi empresa', vista: 'mi-empresa', herramientas: [] });
    const form = document.getElementById('empresaPerfilForm');
    const estado = document.getElementById('empresaPerfilEstado');
    const lista = document.getElementById('empresaPerfilResenas');
    const valoracion = document.getElementById('empresaPerfilValoracion');
    let version = 0;
    let guardando = false;
    let empresaActiva = null;
    const campos = ['nombre', 'descripcion', 'direccion', 'latitud', 'longitud', 'whatsapp', 'horario'];

    function pintar(datos, role) {
        campos.forEach((campo) => { form.elements[campo].value = datos.perfil[campo] ?? ''; });
        Array.from(form.elements).forEach((elemento) => { elemento.disabled = role !== 'admin'; });
        valoracion.textContent = datos.cantidad
            ? `${Number(datos.promedio).toFixed(1)} / 5 · ${datos.cantidad} reseña(s)`
            : 'Todavía no hay reseñas.';
        lista.replaceChildren();
        datos.resenas.forEach((resena) => {
            const tarjeta = document.createElement('p');
            tarjeta.textContent = `${resena.estrellas} / 5 · ${resena.comentario || 'Sin comentario'}`;
            lista.appendChild(tarjeta);
        });
    }

    async function solicitar(opciones) {
        const respuesta = await global.CrmSafe.apiFetch('/api/repartofacil/mi-empresa', opciones);
        const datos = await respuesta.json();
        if (!respuesta.ok) throw new Error(datos.error || 'No se pudo consultar la ficha.');
        return datos;
    }

    async function entrar(usuario) {
        const actual = ++version;
        empresaActiva = usuario.empresa_id;
        estado.textContent = 'Cargando ficha…';
        form.hidden = true;
        lista.replaceChildren();
        valoracion.textContent = '';
        try {
            const datos = await solicitar();
            if (actual !== version) return;
            if (datos.empresa_id !== usuario.empresa_id) throw new Error('La sesión cambió. Volvé a iniciar sesión.');
            pintar(datos, usuario.role);
            form.hidden = false;
            estado.textContent = usuario.role === 'admin' ? '' : 'Tu usuario puede consultar la ficha, pero no editarla.';
        } catch (error) {
            if (actual === version) estado.textContent = error.message || 'No se pudo cargar la ficha.';
        }
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (guardando) return;
        const usuario = global.CrmBus.emit('getSessionUser');
        if (!usuario || usuario.role !== 'admin' || usuario.empresa_id !== empresaActiva) {
            estado.textContent = 'La sesión cambió. Volvé a abrir la ficha.';
            return;
        }
        const datos = {};
        campos.forEach((campo) => { datos[campo] = form.elements[campo].value; });
        datos.empresa_id = empresaActiva;
        guardando = true;
        const actual = version;
        estado.textContent = 'Guardando…';
        try {
            const resultado = await solicitar({
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos),
            });
            if (actual !== version) return;
            pintar(resultado, usuario.role);
            estado.textContent = 'Ficha guardada. Reparto Fácil la actualizará al consultar el catálogo.';
            if (datos.direccion && resultado.perfil.latitud == null) {
                estado.textContent += ' Revisá las coordenadas para mostrar el comercio por distancia.';
            }
        } catch (error) {
            if (actual === version) estado.textContent = error.message || 'No se pudo guardar la ficha.';
        } finally {
            guardando = false;
        }
    });
    global.MiEmpresa = { entrar };
})(window);
