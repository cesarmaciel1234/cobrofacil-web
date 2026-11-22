/* Ficha pública y reseñas verificadas de la empresa de la sesión. */
(function (global) {
    global.BarraModulos = global.BarraModulos || [];
    global.BarraModulos.push({ id: 'mi-empresa', nombre: 'Perfil', vista: 'mi-empresa', herramientas: [] });
    const form = document.getElementById('empresaPerfilForm');
    const estado = document.getElementById('empresaPerfilEstado');
    const resumen = document.getElementById('empresaPerfilResumen');
    const editar = document.getElementById('empresaPerfilEditar');
    const lista = document.getElementById('empresaPerfilResenas');
    const valoracion = document.getElementById('empresaPerfilValoracion');
    const panelMapa = document.getElementById('empresaPerfilMapaPanel');
    const estadoMapa = document.getElementById('empresaPerfilMapaEstado');
    const ubicacion = document.getElementById('empresaPerfilUbicacion');
    const campos = ['nombre', 'descripcion', 'direccion', 'latitud', 'longitud', 'whatsapp', 'horario'];
    let version = 0;
    let guardando = false;
    let empresaActiva = null;
    let datosActuales = null;
    let mapa = null;
    let marcador = null;
    let ubicacionConfirmada = false;
    let ubicacionRevision = 0;

    function cerrarMapa() {
        panelMapa.hidden = true;
        if (mapa) mapa.remove();
        mapa = null;
        marcador = null;
        estadoMapa.textContent = '';
    }

    function actualizarUbicacion() {
        ubicacion.textContent = form.elements.latitud.value && form.elements.longitud.value
            ? 'Ubicación seleccionada en el mapa.'
            : 'Todavía no seleccionaste una ubicación.';
    }

    function pintar(datos, role) {
        datosActuales = datos;
        const perfil = datos.perfil;
        campos.forEach((campo) => { form.elements[campo].value = perfil[campo] ?? ''; });
        document.getElementById('empresaPerfilInicial').textContent = (perfil.nombre.trim()[0] || 'E').toUpperCase();
        document.getElementById('empresaPerfilNombre').textContent = perfil.nombre;
        ['direccion', 'whatsapp', 'horario', 'descripcion'].forEach((campo) => {
            const id = 'empresaPerfil' + campo[0].toUpperCase() + campo.slice(1);
            document.getElementById(id).textContent = perfil[campo] || 'Sin agregar';
        });
        editar.hidden = role !== 'admin';
        valoracion.textContent = datos.cantidad
            ? `${Number(datos.promedio).toFixed(1)} / 5 · ${datos.cantidad} reseña(s)`
            : 'Todavía no hay reseñas.';
        lista.replaceChildren();
        datos.resenas.forEach((resena) => {
            const tarjeta = document.createElement('p');
            tarjeta.textContent = `${resena.estrellas} / 5 · ${resena.comentario || 'Sin comentario'}`;
            lista.appendChild(tarjeta);
        });
        ubicacionConfirmada = false;
        actualizarUbicacion();
    }

    async function solicitar(opciones) {
        const respuesta = await global.CrmSafe.apiFetch('/api/repartofacil/mi-empresa', opciones);
        const datos = await respuesta.json();
        if (!respuesta.ok) throw new Error(datos.error || 'No se pudo consultar la ficha.');
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
        cerrarMapa();
        estado.textContent = 'Cargando ficha…';
        form.hidden = true;
        resumen.hidden = true;
        lista.replaceChildren();
        valoracion.textContent = '';
        try {
            const datos = await solicitar();
            if (actual !== version) return;
            if (datos.empresa_id !== usuario.empresa_id) throw new Error('La sesión cambió. Volvé a iniciar sesión.');
            pintar(datos, usuario.role);
            resumen.hidden = false;
            estado.textContent = usuario.role === 'admin' ? '' : 'Tu usuario puede consultar la ficha, pero no editarla.';
        } catch (error) {
            if (actual === version) estado.textContent = error.message || 'No se pudo cargar la ficha.';
        }
    }

    editar.addEventListener('click', () => {
        if (!sesionValida() || guardando) {
            estado.textContent = 'La sesión cambió. Volvé a abrir la ficha.';
            return;
        }
        estado.textContent = '';
        resumen.hidden = true;
        form.hidden = false;
    });
    document.getElementById('empresaPerfilCancelar').addEventListener('click', () => {
        if (guardando || !datosActuales) return;
        cerrarMapa();
        pintar(datosActuales, 'admin');
        form.hidden = true;
        resumen.hidden = false;
        estado.textContent = '';
    });
    form.elements.direccion.addEventListener('input', () => {
        ubicacionRevision++;
        form.elements.latitud.value = '';
        form.elements.longitud.value = '';
        ubicacionConfirmada = false;
        if (marcador) {
            marcador.remove();
            marcador = null;
        }
        actualizarUbicacion();
    });

    function seleccionar(lat, lng) {
        if (!sesionValida() || form.hidden || guardando) return;
        ubicacionRevision++;
        form.elements.latitud.value = String(lat);
        form.elements.longitud.value = String(lng);
        ubicacionConfirmada = true;
        if (marcador) marcador.setLatLng([lat, lng]);
        else marcador = global.L.marker([lat, lng], {
            icon: global.L.divIcon({ className: 'perfil-empresa-pin', iconSize: [18, 18], iconAnchor: [9, 9] }),
        }).addTo(mapa);
        estadoMapa.textContent = 'Ubicación elegida. Guardá la ficha para aplicarla.';
        actualizarUbicacion();
    }

    document.getElementById('empresaPerfilAbrirMapa').addEventListener('click', () => {
        if (!sesionValida() || guardando) {
            estado.textContent = 'La sesión cambió. Volvé a abrir la ficha.';
            return;
        }
        if (!global.L) {
            estado.textContent = 'No se pudo cargar el mapa. Comprobá tu conexión e intentá nuevamente.';
            return;
        }
        panelMapa.hidden = false;
        if (mapa) { mapa.invalidateSize(); return; }
        const lat = Number(form.elements.latitud.value);
        const lng = Number(form.elements.longitud.value);
        const tieneUbicacion = form.elements.latitud.value !== '' && form.elements.longitud.value !== '';
        mapa = global.L.map('empresaPerfilMapa').setView(tieneUbicacion ? [lat, lng] : [-32.9468, -60.6393], tieneUbicacion ? 16 : 12);
        const tiles = global.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(mapa);
        tiles.on('tileerror', () => { estadoMapa.textContent = 'No se pudo cargar el mapa. Revisá tu conexión.'; });
        mapa.on('click', (event) => seleccionar(event.latlng.lat, event.latlng.lng));
        if (tieneUbicacion) {
            marcador = global.L.marker([lat, lng], {
                icon: global.L.divIcon({ className: 'perfil-empresa-pin', iconSize: [18, 18], iconAnchor: [9, 9] }),
            }).addTo(mapa);
        } else {
            estadoMapa.textContent = 'Mové el mapa o usá tu ubicación para encontrar el comercio.';
        }
        mapa.invalidateSize();
    });
    document.getElementById('empresaPerfilCerrarMapa').addEventListener('click', cerrarMapa);
    document.getElementById('empresaPerfilGps').addEventListener('click', () => {
        if (!navigator.geolocation) {
            estadoMapa.textContent = 'Tu navegador no permite usar la ubicación.';
            return;
        }
        const actual = version;
        const mapaSolicitado = mapa;
        const revision = ++ubicacionRevision;
        estadoMapa.textContent = 'Buscando tu ubicación…';
        navigator.geolocation.getCurrentPosition(({ coords }) => {
            if (actual !== version || revision !== ubicacionRevision || !mapa || mapa !== mapaSolicitado || !sesionValida() || form.hidden) return;
            seleccionar(coords.latitude, coords.longitude);
            mapa.setView([coords.latitude, coords.longitude], 16);
        }, () => {
            if (actual === version && revision === ubicacionRevision && mapa === mapaSolicitado && mapa) estadoMapa.textContent = 'No pudimos obtener tu ubicación. Podés elegirla en el mapa.';
        }, { enableHighAccuracy: true, timeout: 12000 });
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (guardando) return;
        if (!sesionValida()) {
            estado.textContent = 'La sesión cambió. Volvé a abrir la ficha.';
            return;
        }
        const datos = {};
        campos.forEach((campo) => { datos[campo] = form.elements[campo].value; });
        datos.empresa_id = empresaActiva;
        datos.ubicacion_confirmada = ubicacionConfirmada;
        guardando = true;
        const actual = version;
        Array.from(form.elements).forEach((elemento) => { elemento.disabled = true; });
        estado.textContent = 'Guardando…';
        try {
            const resultado = await solicitar({
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos),
            });
            if (actual !== version) return;
            cerrarMapa();
            pintar(resultado, 'admin');
            form.hidden = true;
            resumen.hidden = false;
            estado.textContent = 'Ficha guardada. Reparto Fácil la actualizará al consultar el catálogo.';
            if (datos.direccion && resultado.perfil.latitud == null) {
                estado.textContent += ' Elegí la ubicación en el mapa para mostrar la distancia.';
            }
        } catch (error) {
            if (actual === version) estado.textContent = error.message || 'No se pudo guardar la ficha.';
        } finally {
            Array.from(form.elements).forEach((elemento) => { elemento.disabled = false; });
            guardando = false;
        }
    });
    global.MiEmpresa = { entrar };
})(window);
