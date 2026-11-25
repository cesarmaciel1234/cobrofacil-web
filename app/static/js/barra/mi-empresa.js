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
    const buscadorInput = document.getElementById('empresaPerfilBuscadorInput');
    const buscadorBoton = document.getElementById('empresaPerfilBuscadorBoton');
    const sugerenciasContenedor = document.getElementById('empresaPerfilSugerencias');
    const centrarPinBoton = document.getElementById('empresaPerfilCentrarPin');
    const confirmarMapa = document.getElementById('empresaPerfilConfirmarMapa');
    const inputCalle = document.getElementById('empresaPerfilCalle');
    const inputAltura = document.getElementById('empresaPerfilAltura');
    const inputPiso = document.getElementById('empresaPerfilPiso');
    const inputLocalidad = document.getElementById('empresaPerfilLocalidad');
    const inputMapaAltura = document.getElementById('empresaPerfilMapaAltura');
    const campos = ['nombre', 'descripcion', 'direccion', 'latitud', 'longitud', 'whatsapp', 'horario', 'rubro'];
    let version = 0;
    let guardando = false;
    let empresaActiva = null;
    let datosActuales = null;
    let mapa = null;
    let marcador = null;
    let ubicacionConfirmada = false;
    let ubicacionRevision = 0;

    function desglosarDireccion(dirTexto) {
        if (!dirTexto) return { calle: '', altura: '', piso: '', localidad: '' };
        const partes = dirTexto.split(',').map(s => s.trim());
        const primeraParte = partes[0] || '';
        const match = primeraParte.match(/^(.*?)(?:\s+(\d+[\w\s/-]*))?$/);
        const calle = match && match[1] ? match[1].trim() : primeraParte;
        const altura = match && match[2] ? match[2].trim() : '';
        const localidad = partes.slice(1).join(', ').trim();
        return { calle, altura, piso: '', localidad };
    }

    function sincronizarCamposDesdeDireccion(dirTexto) {
        const { calle, altura, piso, localidad } = desglosarDireccion(dirTexto);
        if (inputCalle) inputCalle.value = calle;
        if (inputAltura) inputAltura.value = altura;
        if (inputMapaAltura) inputMapaAltura.value = altura;
        if (inputPiso) inputPiso.value = piso;
        if (inputLocalidad) inputLocalidad.value = localidad;
    }

    function reconstruirDireccion() {
        const calle = (inputCalle?.value || '').trim();
        const altura = (inputAltura?.value || inputMapaAltura?.value || '').trim();
        const piso = (inputPiso?.value || '').trim();
        const loc = (inputLocalidad?.value || '').trim();
        
        let dir = '';
        if (calle) {
            dir = calle + (altura ? ' ' + altura : '');
            if (piso) dir += ', ' + piso;
            if (loc) dir += ', ' + loc;
        } else if (altura || loc) {
            dir = [altura, loc].filter(Boolean).join(', ');
        }
        if (dir) {
            form.elements.direccion.value = dir;
            if (buscadorInput) buscadorInput.value = dir;
            actualizarUbicacion();
        }
        return dir;
    }

    if (inputMapaAltura) {
        inputMapaAltura.addEventListener('input', () => {
            if (inputAltura) inputAltura.value = inputMapaAltura.value;
            reconstruirDireccion();
        });
    }
    if (inputAltura) {
        inputAltura.addEventListener('input', () => {
            if (inputMapaAltura) inputMapaAltura.value = inputAltura.value;
            reconstruirDireccion();
        });
    }
    [inputCalle, inputPiso, inputLocalidad].forEach(inp => {
        if (inp) inp.addEventListener('input', () => reconstruirDireccion());
    });

    function cerrarMapa() {
        panelMapa.hidden = true;
        if (mapa) mapa.remove();
        mapa = null;
        marcador = null;
        estadoMapa.textContent = '';
    }

    function actualizarUbicacion() {
        const tieneCoords = form.elements.latitud.value && form.elements.longitud.value;
        const dir = form.elements.direccion.value.trim();
        ubicacion.textContent = tieneCoords
            ? (dir ? '✓ Ubicación GPS precisa vinculada: ' + dir : '✓ Ubicación seleccionada en el mapa.')
            : '⚠️ Todavía no seleccionaste una ubicación en el mapa (necesaria para mostrar la distancia a los clientes).';
        ubicacion.style.color = tieneCoords ? '#15803d' : '#b45309';
        ubicacion.style.fontWeight = '700';
    }

    function pintar(datos, role) {
        datosActuales = datos;
        const perfil = datos.perfil;
        campos.forEach((campo) => { form.elements[campo].value = perfil[campo] ?? ''; });
        document.getElementById('empresaPerfilInicial').textContent = (perfil.nombre.trim()[0] || 'E').toUpperCase();
        document.getElementById('empresaPerfilNombre').textContent = perfil.nombre;
        ['direccion', 'rubro', 'whatsapp', 'horario', 'descripcion'].forEach((campo) => {
            const id = 'empresaPerfil' + campo[0].toUpperCase() + campo.slice(1);
            const el = document.getElementById(id);
            if (el) el.textContent = perfil[campo] || (campo === 'rubro' ? 'Carnicería' : 'Sin agregar');
        });
        if (form.elements.rubro) {
            form.elements.rubro.value = perfil.rubro || 'Carnicería';
        }
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
        ubicacionConfirmada = Boolean(perfil.latitud && perfil.longitud);
        sincronizarCamposDesdeDireccion(perfil.direccion || '');
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
            cargarSucursales();
            cargarColaboradores();
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

    document.querySelectorAll('[data-editar-campo]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            if (!sesionValida() || guardando) {
                estado.textContent = 'La sesión cambió. Volvé a abrir la ficha.';
                return;
            }
            const campo = btn.getAttribute('data-editar-campo');
            estado.textContent = '';
            resumen.hidden = true;
            form.hidden = false;
            if (campo === 'direccion') {
                document.getElementById('empresaPerfilAbrirMapa').click();
                if (inputMapaAltura && !inputMapaAltura.value) {
                    inputMapaAltura.focus();
                } else if (buscadorInput) {
                    buscadorInput.focus();
                }
            } else if (campo === 'nombre') {
                if (form.elements.nombre) form.elements.nombre.focus();
            } else if (campo === 'rubro') {
                if (form.elements.rubro) form.elements.rubro.focus();
            } else if (campo === 'whatsapp') {
                if (form.elements.whatsapp) form.elements.whatsapp.focus();
            } else if (campo === 'horario') {
                if (form.elements.horario) form.elements.horario.focus();
            } else if (campo === 'descripcion') {
                if (form.elements.descripcion) form.elements.descripcion.focus();
            }
        });
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
        if (buscadorInput) buscadorInput.value = form.elements.direccion.value;
        actualizarUbicacion();
    });

    async function resolverDireccionInversa(lat, lng, rev) {
        try {
            // 1. Intentar por backend local (sin problemas de CSP ni CORS)
            let data = null;
            try {
                const localRes = await fetch(`/api/repartofacil/geo/reverse?lat=${lat}&lng=${lng}`);
                if (localRes.ok) data = await localRes.json();
            } catch (e) {
                data = null;
            }

            // 2. Fallback directo a Nominatim si hiciera falta
            if (!data || !data.address) {
                const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
                const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
                if (res.ok) data = await res.json();
            }

            if (rev !== ubicacionRevision || !data || !data.address) return;
            
            const addr = data.address;
            const road = addr.road || addr.pedestrian || addr.street || '';
            const existingHouse = (inputMapaAltura ? inputMapaAltura.value.trim() : '') || (inputAltura ? inputAltura.value.trim() : '');
            const house = addr.house_number || existingHouse;
            const suburb = addr.suburb || addr.neighbourhood || addr.city_district || '';
            const city = addr.city || addr.town || addr.village || '';
            const locality = [suburb, city].filter(Boolean).join(', ');

            if (inputCalle && road) inputCalle.value = road;
            if (house) {
                if (inputAltura) inputAltura.value = house;
                if (inputMapaAltura) inputMapaAltura.value = house;
            }
            if (inputLocalidad && locality) inputLocalidad.value = locality;
            
            const finalAddr = reconstruirDireccion() || [road + (house ? ' ' + house : ''), locality].filter(Boolean).join(', ') || (data.display_name ? data.display_name.split(',').slice(0, 3).join(', ') : '');
            if (finalAddr) {
                form.elements.direccion.value = finalAddr;
                if (buscadorInput) buscadorInput.value = finalAddr;
                estadoMapa.textContent = `📍 ${finalAddr} (Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)})`;
                actualizarUbicacion();
            }
        } catch (e) {
            console.warn('No se pudo resolver la dirección inversa:', e);
        }
    }

    function seleccionar(lat, lng, resolverInversa = false) {
        if (!sesionValida() || form.hidden || guardando) return;
        const rev = ++ubicacionRevision;
        form.elements.latitud.value = String(lat);
        form.elements.longitud.value = String(lng);
        ubicacionConfirmada = true;
        
        if (marcador) {
            marcador.setLatLng([lat, lng]);
        } else if (mapa && global.L) {
            marcador = global.L.marker([lat, lng], {
                draggable: true,
                icon: global.L.divIcon({ className: 'perfil-empresa-pin', iconSize: [26, 26], iconAnchor: [13, 13] }),
            }).addTo(mapa);

            marcador.on('dragend', (e) => {
                const pos = e.target.getLatLng();
                seleccionar(pos.lat, pos.lng, true);
            });
        }
        
        estadoMapa.textContent = `Punto fijado: Lat ${lat.toFixed(5)}, Lng ${lng.toFixed(5)}`;
        actualizarUbicacion();
        
        if (resolverInversa) {
            resolverDireccionInversa(lat, lng, rev);
        }
    }

    function cerrarSugerencias() {
        if (sugerenciasContenedor) {
            sugerenciasContenedor.hidden = true;
            sugerenciasContenedor.replaceChildren();
        }
    }

    async function buscarDireccionEnMapa(texto) {
        const query = (texto || '').trim();
        if (!query) {
            estadoMapa.textContent = 'Escribí una calle o localidad para buscar.';
            return;
        }
        cerrarSugerencias();
        estadoMapa.textContent = `Buscando "${query}"...`;
        try {
            let results = null;

            // 1. Intentar por backend local (sin bloqueo de CSP)
            try {
                const localRes = await fetch(`/api/repartofacil/geo/search?q=${encodeURIComponent(query)}`);
                if (localRes.ok) results = await localRes.json();
            } catch (e) {
                results = null;
            }

            // 2. Fallback a Nominatim directo
            if (!results || results.length === 0) {
                let queryArg = query;
                if (!/argentina|buenos aires|caba|santa fe|cordoba|rosario|hurlingham/i.test(query)) {
                    queryArg = `${query}, Buenos Aires, Argentina`;
                } else if (!/argentina/i.test(query)) {
                    queryArg = `${query}, Argentina`;
                }
                const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(queryArg)}&limit=5&countrycodes=ar&addressdetails=1`;
                const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
                if (res.ok) results = await res.json();
            }
            
            // Si no encontró con el filtro estricto, probamos con el texto original sin agregados
            if ((!results || results.length === 0) && queryArg !== query) {
                const fallbackUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&countrycodes=ar&addressdetails=1`;
                const fallbackRes = await fetch(fallbackUrl, { headers: { 'Accept-Language': 'es' } });
                if (fallbackRes.ok) results = await fallbackRes.json();
            }

            if (!results || results.length === 0) {
                estadoMapa.textContent = `No encontramos "${query}". Probá tocar el mapa o arrastrar el pin amarillo.`;
                return;
            }

            // Mostrar sugerencias si hay múltiples resultados
            if (sugerenciasContenedor && results.length > 1) {
                sugerenciasContenedor.replaceChildren();
                results.slice(0, 4).forEach((item) => {
                    const btn = document.createElement('div');
                    btn.className = 'perfil-empresa-sugerencia-item';
                    const label = item.display_name.split(',').slice(0, 3).join(', ');
                    btn.textContent = `📍 ${label}`;
                    btn.addEventListener('click', () => {
                        const sLat = parseFloat(item.lat);
                        const sLng = parseFloat(item.lon);
                        if (mapa) mapa.setView([sLat, sLng], 17);
                        seleccionar(sLat, sLng, false);
                        form.elements.direccion.value = label;
                        if (buscadorInput) buscadorInput.value = label;
                        estadoMapa.textContent = `✓ Ubicación elegida: ${label}`;
                        cerrarSugerencias();
                    });
                    sugerenciasContenedor.appendChild(btn);
                });
                sugerenciasContenedor.hidden = false;
            }

            // Aplicar el primer resultado inmediatamente
            const item = results[0];
            const lat = parseFloat(item.lat);
            const lng = parseFloat(item.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            
            if (mapa) {
                mapa.setView([lat, lng], 17);
                seleccionar(lat, lng, false);
            }
            const displayName = item.display_name ? item.display_name.split(',').slice(0, 3).join(', ') : query;
            form.elements.direccion.value = displayName;
            if (buscadorInput) buscadorInput.value = displayName;
            estadoMapa.textContent = `✓ Ubicación encontrada: ${displayName}`;
            actualizarUbicacion();
        } catch (err) {
            estadoMapa.textContent = 'No se pudo buscar la dirección. Podés arrastrar el pin amarillo o tocar el mapa.';
        }
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
        cerrarSugerencias();
        
        const dirPrevia = form.elements.direccion.value.trim();
        if (buscadorInput) buscadorInput.value = dirPrevia;

        const latVal = form.elements.latitud.value;
        const lngVal = form.elements.longitud.value;
        const tieneUbicacion = latVal !== '' && lngVal !== '' && !Number.isNaN(Number(latVal));
        const lat = tieneUbicacion ? Number(latVal) : -34.5954;
        const lng = tieneUbicacion ? Number(lngVal) : -58.6275;

        if (mapa) {
            mapa.invalidateSize();
            if (tieneUbicacion) {
                mapa.setView([lat, lng], 17);
                if (marcador) marcador.setLatLng([lat, lng]);
            }
            return;
        }

        // tap: false es CRUCIAL en Leaflet para que los toques en Android/iOS funcionen siempre
        mapa = global.L.map('empresaPerfilMapa', {
            tap: false,
            zoomControl: true,
        }).setView([lat, lng], tieneUbicacion ? 17 : 14);

        const tiles = global.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(mapa);
        
        tiles.on('tileerror', () => { estadoMapa.textContent = 'No se pudo cargar el mapa. Revisá tu conexión.'; });
        
        // Al tocar el mapa, mover y actualizar
        mapa.on('click', (event) => seleccionar(event.latlng.lat, event.latlng.lng, true));

        // Crear marcador arrastrable
        marcador = global.L.marker([lat, lng], {
            draggable: true,
            icon: global.L.divIcon({ className: 'perfil-empresa-pin', iconSize: [26, 26], iconAnchor: [13, 13] }),
        }).addTo(mapa);

        marcador.on('dragend', (e) => {
            const pos = e.target.getLatLng();
            seleccionar(pos.lat, pos.lng, true);
        });

        if (tieneUbicacion) {
            estadoMapa.textContent = `Ubicación actual fijada: ${dirPrevia || 'en el mapa'}`;
        } else if (dirPrevia) {
            buscarDireccionEnMapa(dirPrevia);
        } else {
            estadoMapa.textContent = 'Arrastrá el pin amarillo o tocá el mapa para ubicar tu local.';
        }

        setTimeout(() => mapa && mapa.invalidateSize(), 100);
        setTimeout(() => mapa && mapa.invalidateSize(), 300);
    });

    if (buscadorBoton) {
        buscadorBoton.addEventListener('click', () => {
            if (buscadorInput) buscarDireccionEnMapa(buscadorInput.value);
        });
    }

    if (buscadorInput) {
        buscadorInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                buscarDireccionEnMapa(buscadorInput.value);
            }
        });
    }

    if (centrarPinBoton) {
        centrarPinBoton.addEventListener('click', () => {
            if (!mapa) return;
            const center = mapa.getCenter();
            seleccionar(center.lat, center.lng, true);
        });
    }

    if (confirmarMapa) {
        confirmarMapa.addEventListener('click', () => {
            if (!form.elements.latitud.value || !form.elements.longitud.value) {
                estadoMapa.textContent = 'Primero tocá el mapa o buscá tu dirección para fijar el punto.';
                return;
            }
            ubicacionConfirmada = true;
            actualizarUbicacion();
            cerrarMapa();
        });
    }

    document.getElementById('empresaPerfilCerrarMapa').addEventListener('click', cerrarMapa);
    
    document.getElementById('empresaPerfilGps').addEventListener('click', () => {
        if (!navigator.geolocation) {
            estadoMapa.textContent = 'Tu navegador no permite usar la ubicación.';
            return;
        }
        const actual = version;
        const mapaSolicitado = mapa;
        const revision = ++ubicacionRevision;
        estadoMapa.textContent = 'Detectando ubicación precisa por GPS…';
        navigator.geolocation.getCurrentPosition(({ coords }) => {
            if (actual !== version || revision !== ubicacionRevision || !mapa || mapa !== mapaSolicitado || !sesionValida() || form.hidden) return;
            seleccionar(coords.latitude, coords.longitude, true);
            mapa.setView([coords.latitude, coords.longitude], 17);
        }, () => {
            if (actual === version && revision === ubicacionRevision && mapa === mapaSolicitado && mapa) {
                estadoMapa.textContent = 'No se pudo obtener el GPS del dispositivo. Podés buscar tu calle arriba o arrastrar el pin.';
            }
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
    // =========================================================================
    // 🏢 GESTIÓN PIRAMIDAL DE SUCURSALES Y TERMINALES / CAJAS (TPV)
    // =========================================================================
    let sucursalesDisponibles = [];
    let terminalesDisponibles = [];

    function textoSeguro(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = String(str);
        return d.innerHTML;
    }

    async function cargarSucursales() {
        const subtitulo = document.getElementById('empresaSucursalesSubtitulo');
        const listaCont = document.getElementById('empresaListaSucursales');
        if (!listaCont) return;

        try {
            if (subtitulo) subtitulo.textContent = 'Consultando locales y cajas...';
            const res = await fetch('/api/sucursales');
            const data = await res.json();
            if (!data.success || !Array.isArray(data.sucursales)) {
                if (subtitulo) subtitulo.textContent = 'No se pudo cargar la lista.';
                return;
            }
            const sucursales = data.sucursales;
            sucursalesDisponibles = sucursales;
            poblarSelectSucursalesColaborador();
            const esUnico = data.es_negocio_unico;
            if (subtitulo) {
                subtitulo.textContent = esUnico
                    ? '1 local activo · Negocio Único (Cero fricción en catálogo)'
                    : `${sucursales.length} locales activos · Red Multi-sucursal`;
            }

            // Recopilar todas las terminales para consulta rápida
            terminalesDisponibles = [];
            sucursales.forEach(s => {
                if (Array.isArray(s.terminales)) {
                    s.terminales.forEach(t => terminalesDisponibles.push(t));
                }
            });
            const pendientes = Array.isArray(data.terminales_pendientes) ? data.terminales_pendientes : [];
            pendientes.forEach(p => terminalesDisponibles.push(p));

            if (sucursales.length === 0 && pendientes.length === 0) {
                listaCont.innerHTML = '<p style="color:#64748b; font-size:13px; padding:10px 0;">No hay sucursales registradas.</p>';
                return;
            }

            let html = '';

            // 💻 Sección: PCs Pendientes / Sin Asignar
            html += `
            <div class="sucursal-card" style="border:1.5px solid ${pendientes.length > 0 ? '#fde68a' : '#e2e8f0'}; border-radius:14px; padding:12px 14px; background:${pendientes.length > 0 ? '#fffbeb' : '#ffffff'}; margin-bottom:12px;">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <strong style="font-size:13px; color:${pendientes.length > 0 ? '#b45309' : '#1e293b'};">
                            💻 PCs Pendientes / Sin Asignar
                        </strong>
                        <span style="background:${pendientes.length > 0 ? '#fef08a' : '#f1f5f9'}; color:${pendientes.length > 0 ? '#854d0e' : '#64748b'}; font-size:10px; font-weight:800; padding:2px 8px; border-radius:12px;">
                            ${pendientes.length}
                        </span>
                    </div>
                </div>
                <p style="margin:0 0 ${pendientes.length > 0 ? '8px' : '0'} 0; font-size:11px; color:${pendientes.length > 0 ? '#92400e' : '#64748b'};">
                    ${pendientes.length > 0
                        ? 'Equipos TPV que enviaron saludo por primera vez y están esperando asignación de sucursal para comenzar a sincronizar tickets y stock.'
                        : '✓ No hay PCs esperando asignación. Cualquier equipo nuevo que inicie enviará su saludo y aparecerá aquí automáticamente.'}
                </p>
                ${pendientes.length > 0 ? `
                <div style="display:flex; flex-direction:column; gap:8px;">
                    ${pendientes.map(pt => `
                        <div style="display:flex; flex-direction:column; gap:8px; background:#ffffff; border:1px solid #fef08a; border-radius:10px; padding:10px 12px; font-size:11px;">
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <div style="display:flex; align-items:center; justify-content:space-between;">
                                    <div style="display:flex; align-items:center; gap:6px;">
                                        <span style="font-size:14px;">🖥️</span>
                                        <strong style="color:#1e293b; font-size:12px;">${textoSeguro(pt.nombre || 'PC Nueva')}</strong>
                                    </div>
                                    <span style="background:#fef9c3; color:#a16207; font-size:9px; font-weight:800; padding:2px 6px; border-radius:4px;">PENDIENTE</span>
                                </div>
                                <div style="display:flex; flex-direction:column; gap:2px; color:#64748b; font-size:10px;">
                                    <span>ID: <code style="background:#f1f5f9; padding:1px 4px; border-radius:4px; word-break:break-all;">${textoSeguro(pt.identificador_pc)}</code></span>
                                    ${pt.ultimo_sync ? `<span>Último saludo: ${textoSeguro(pt.ultimo_sync.replace('GMT', '').trim())}</span>` : ''}
                                </div>
                            </div>
                            <button type="button" class="btn-asignar-terminal" data-tid="${pt.id}" style="width:100%; background:#FFE600; border:none; border-radius:8px; padding:8px 12px; font-size:11px; font-weight:800; color:#2D3277; cursor:pointer; text-align:center; box-shadow:0 1px 3px rgba(0,0,0,0.08);">
                                + Asignar a Sucursal
                            </button>
                        </div>
                    `).join('')}
                </div>` : ''}
            </div>`;

            sucursales.forEach((suc) => {
                const terms = suc.terminales || [];
                const badgeUnico = esUnico ? '<span style="background:#e0f2fe; color:#0369a1; font-size:10px; font-weight:800; padding:2px 8px; border-radius:12px; margin-left:6px;">⭐ LOCAL ÚNICO</span>' : '';
                const badgeCd = suc.es_centro_distribucion ? '<span style="background:#fef3c7; color:#92400e; font-size:10px; font-weight:800; padding:2px 8px; border-radius:12px; margin-left:6px;">📦 CENTRO DISTRIBUCIÓN</span>' : '';

                html += `
                <div class="sucursal-card" style="border:1.5px solid #e2e8f0; border-radius:14px; padding:12px 14px; background:#f8fafc; display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
                                <strong style="font-size:14px; color:#2D3277;">${textoSeguro(suc.nombre)}</strong>
                                ${badgeUnico}
                                ${badgeCd}
                            </div>
                            <small style="display:block; color:#64748b; font-size:11px; margin-top:3px;">
                                📍 ${textoSeguro(suc.direccion || 'Sin dirección asignada')}
                            </small>
                            ${suc.horario ? `<small style="display:block; color:#64748b; font-size:11px;">⏰ ${textoSeguro(suc.horario)}</small>` : ''}
                            ${suc.whatsapp ? `<small style="display:block; color:#16a34a; font-size:11px; font-weight:700;">📱 WhatsApp: ${textoSeguro(suc.whatsapp)}</small>` : ''}
                        </div>
                        <button type="button" class="btn-editar-sucursal" data-id="${suc.id}" style="background:#ffffff; border:1px solid #cbd5e1; border-radius:8px; padding:4px 8px; font-size:11px; font-weight:700; color:#475569; cursor:pointer;">
                            ✎ Editar
                        </button>
                    </div>

                    <!-- Terminales / Cajas conectadas a esta sucursal -->
                    <div style="border-top:1px dashed #cbd5e1; padding-top:8px; margin-top:2px;">
                        <span style="font-size:10px; font-weight:800; text-transform:uppercase; color:#94a3b8; letter-spacing:0.5px;">
                            Cajas / PCs Conectadas (${terms.length})
                        </span>
                        <div style="margin-top:4px; display:flex; flex-direction:column; gap:4px;">
                            ${terms.length === 0 ? '<span style="font-size:11px; color:#94a3b8; font-style:italic;">⚠️ Sin cajas TPV vinculadas aún</span>' : ''}
                            ${terms.map(t => {
                                let statusBadge = '<span style="display:inline-flex; align-items:center; gap:4px; color:#16a34a; font-weight:700; font-size:10px;"><span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#16a34a;"></span>En vivo</span>';
                                if (t.activo === 0) {
                                    statusBadge = '<span style="display:inline-flex; align-items:center; gap:4px; color:#d97706; font-weight:700; font-size:10px;"><span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#d97706;"></span>Pausada</span>';
                                } else if (t.activo === -1) {
                                    statusBadge = '<span style="display:inline-flex; align-items:center; gap:4px; color:#dc2626; font-weight:700; font-size:10px;"><span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#dc2626;"></span>Bloqueada</span>';
                                }
                                return `
                                <div style="display:flex; align-items:center; justify-content:space-between; background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:5px 10px; font-size:11px;">
                                    <div style="display:flex; align-items:center; gap:6px;">
                                        <span style="font-size:13px;">💻</span>
                                        <strong style="color:#1e293b;">${textoSeguro(t.nombre)}</strong>
                                        <code style="background:#f1f5f9; padding:1px 4px; border-radius:4px; font-size:10px; color:#64748b;" title="${textoSeguro(t.identificador_pc)}">${textoSeguro(t.identificador_pc.length > 18 ? t.identificador_pc.substring(0, 16) + '...' : t.identificador_pc)}</code>
                                    </div>
                                    <div style="display:flex; align-items:center; gap:8px;">
                                        ${statusBadge}
                                        <button type="button" class="btn-editar-terminal" data-tid="${t.id}" title="Mover a otra sucursal o editar" style="background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px; padding:2px 8px; font-size:10px; font-weight:700; color:#334155; cursor:pointer;">
                                            ✎ Mover / Editar
                                        </button>
                                    </div>
                                </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                </div>`;
            });

            listaCont.innerHTML = html;

            listaCont.querySelectorAll('.btn-editar-sucursal').forEach(btn => {
                btn.onclick = () => {
                    const sid = Number(btn.dataset.id);
                    const suc = sucursales.find(s => s.id === sid);
                    if (suc) abrirModalSucursal(suc);
                };
            });

            listaCont.querySelectorAll('.btn-editar-terminal, .btn-asignar-terminal').forEach(btn => {
                btn.onclick = () => {
                    const tid = Number(btn.dataset.tid);
                    const term = terminalesDisponibles.find(t => t.id === tid);
                    if (term) abrirModalTerminal(term);
                };
            });
        } catch (e) {
            if (subtitulo) subtitulo.textContent = 'Error al cargar sucursales.';
        }
    }

    function abrirModalSucursal(suc = null) {
        const modal = document.getElementById('modalSucursal');
        const tit = document.getElementById('modalSucursalTitulo');
        if (!modal) return;
        document.getElementById('sucursalFormId').value = suc ? suc.id : '';
        document.getElementById('sucursalFormNombre').value = suc ? suc.nombre : '';
        document.getElementById('sucursalFormCodigo').value = suc ? (suc.codigo || '') : '';
        document.getElementById('sucursalFormWhatsapp').value = suc ? (suc.whatsapp || '') : '';
        document.getElementById('sucursalFormDireccion').value = suc ? (suc.direccion || '') : '';
        document.getElementById('sucursalFormHorario').value = suc ? (suc.horario || '') : '';
        document.getElementById('sucursalFormEsCd').checked = suc ? !!suc.es_centro_distribucion : false;
        if (tit) tit.textContent = suc ? '✎ Editar Sucursal' : '+ Nueva Sucursal';
        modal.style.display = 'block';
    }

    function cerrarModalSucursal() {
        const modal = document.getElementById('modalSucursal');
        if (modal) modal.style.display = 'none';
    }

    function abrirModalTerminal(term) {
        const modal = document.getElementById('modalTerminal');
        const tit = document.getElementById('modalTerminalTitulo');
        if (!modal) return;
        document.getElementById('terminalFormId').value = term.id;
        document.getElementById('terminalFormIdentificador').textContent = term.identificador_pc || '-';
        document.getElementById('terminalFormUltimoSync').textContent = term.ultimo_sync ? term.ultimo_sync.replace('T', ' ').substring(0, 19) : 'Sin contacto';
        document.getElementById('terminalFormNombre').value = term.nombre || '';

        // Título dinámico
        if (tit) {
            tit.textContent = (!term.sucursal_id || term.sucursal_id === 0) ? '📥 Asignar PC a Sucursal' : '💻 Administrar Caja TPV';
        }

        // Poblar select de sucursales
        const selectSuc = document.getElementById('terminalFormSucursal');
        if (selectSuc) {
            selectSuc.innerHTML = sucursalesDisponibles.map(s => `
                <option value="${s.id}" ${s.id === term.sucursal_id ? 'selected' : ''}>${textoSeguro(s.nombre)}</option>
            `).join('');
        }

        const selectActivo = document.getElementById('terminalFormActivo');
        if (selectActivo) {
            if (!term.sucursal_id || term.sucursal_id === 0) {
                selectActivo.value = '1'; // Al asignar por primera vez, sugerir habilitada
            } else {
                selectActivo.value = term.activo != null ? String(term.activo) : '1';
            }
        }

        modal.style.display = 'block';
    }

    function cerrarModalTerminal() {
        const modal = document.getElementById('modalTerminal');
        if (modal) modal.style.display = 'none';
    }

    document.getElementById('empresaBtnNuevaSucursal')?.addEventListener('click', () => abrirModalSucursal());
    document.getElementById('modalSucursalCerrar')?.addEventListener('click', cerrarModalSucursal);
    document.getElementById('modalSucursalCancelar')?.addEventListener('click', cerrarModalSucursal);

    document.getElementById('modalTerminalCerrar')?.addEventListener('click', cerrarModalTerminal);
    document.getElementById('modalTerminalCancelar')?.addEventListener('click', cerrarModalTerminal);

    document.getElementById('formTerminal')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const tid = f.elements['id'].value;
        const nombre = f.elements['nombre'].value.trim();
        const sucursal_id = f.elements['sucursal_id'].value;
        const activo = f.elements['activo'].value;

        if (!tid) return;

        try {
            const res = await fetch(`/api/terminales/${tid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nombre: nombre,
                    sucursal_id: sucursal_id ? parseInt(sucursal_id, 10) : null,
                    activo: parseInt(activo, 10)
                })
            });
            const data = await res.json();
            if (data.success) {
                cerrarModalTerminal();
                cargarSucursales();
            } else {
                alert(data.error || 'Error al actualizar la caja');
            }
        } catch (err) {
            alert('Error de red al actualizar la caja');
        }
    });

    document.getElementById('modalTerminalEliminar')?.addEventListener('click', async () => {
        const tid = document.getElementById('terminalFormId')?.value;
        if (!tid) return;
        if (!confirm('¿Estás seguro de desvincular esta caja TPV? Dejará de pertenecer a la empresa hasta que vuelva a sincronizar.')) {
            return;
        }

        try {
            const res = await fetch(`/api/terminales/${tid}`, {
                method: 'DELETE'
            });
            const data = await res.json();
            if (data.success) {
                cerrarModalTerminal();
                cargarSucursales();
            } else {
                alert(data.error || 'Error al desvincular la caja');
            }
        } catch (err) {
            alert('Error de red al desvincular la caja');
        }
    });

    document.getElementById('formSucursal')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const idVal = f.elements['id'].value;
        const datos = {
            id: idVal ? parseInt(idVal, 10) : null,
            nombre: f.elements['nombre'].value.trim(),
            codigo: f.elements['codigo'].value.trim(),
            whatsapp: f.elements['whatsapp'].value.trim(),
            direccion: f.elements['direccion'].value.trim(),
            horario: f.elements['horario'].value.trim(),
            es_centro_distribucion: f.elements['es_centro_distribucion'].checked
        };
        try {
            const res = await fetch('/api/sucursales', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(datos)
            });
            const data = await res.json();
            if (data.success) {
                cerrarModalSucursal();
                cargarSucursales();
                if (window.cargarSucursalesSelector) {
                    window.cargarSucursalesSelector();
                }
            } else {
                alert(data.error || 'Error al guardar sucursal');
            }
        } catch (err) {
            alert('Error de red al guardar la sucursal');
        }
    });

    let colaboradoresLista = [];

    async function cargarColaboradores() {
        const subtitulo = document.getElementById('empresaColaboradoresSubtitulo');
        const listaCont = document.getElementById('empresaListaColaboradores');
        if (!listaCont) return;

        try {
            if (subtitulo) subtitulo.textContent = 'Consultando equipo...';
            const res = await fetch('/api/usuarios');
            if (!res.ok) {
                if (subtitulo) subtitulo.textContent = 'Solo administradores pueden gestionar colaboradores.';
                return;
            }
            colaboradoresLista = await res.json();
            if (!Array.isArray(colaboradoresLista)) {
                if (subtitulo) subtitulo.textContent = 'No se pudo cargar la lista.';
                return;
            }
            if (subtitulo) {
                const conCandado = colaboradoresLista.filter(u => u.sucursal_id != null).length;
                subtitulo.textContent = `${colaboradoresLista.length} miembros · ${conCandado} con sucursal exclusiva`;
            }

            if (colaboradoresLista.length === 0) {
                listaCont.innerHTML = '<p style="color:#64748b; font-size:13px; padding:10px 0;">No hay colaboradores registrados.</p>';
                return;
            }

            let html = '';
            colaboradoresLista.forEach((u) => {
                const esGlobal = !u.sucursal_id;
                const badgeColor = esGlobal ? '#2D3277' : '#0369a1';
                const badgeBg = esGlobal ? '#f1f5f9' : '#e0f2fe';
                const badgeTexto = esGlobal ? '👑 Toda la Red (Gerente Comercial)' : `🏪 ${textoSeguro(u.sucursal_nombre || 'Sucursal ' + u.sucursal_id)}`;
                const rolTexto = u.role === 'admin' ? 'Administrador' : (u.role === 'visor' ? 'Visor' : 'Operador / Cajero');
                const letra = (u.nombre || u.username || 'U')[0].toUpperCase();

                html += `
                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:12px 14px; display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <div style="width:36px; height:36px; border-radius:50%; background:${esGlobal ? '#2D3277' : '#0284c7'}; color:#ffffff; font-weight:800; font-size:14px; display:flex; align-items:center; justify-content:center;">
                                ${letra}
                            </div>
                            <div>
                                <strong style="font-size:14px; color:#1e293b; display:block;">${textoSeguro(u.nombre || u.username)}</strong>
                                <small style="font-size:11px; color:#64748b;">@${textoSeguro(u.username)} · ${rolTexto}</small>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <button type="button" class="btn btn-ghost btn-sm btn-editar-colaborador" data-id="${u.id}" style="padding:4px 8px; font-size:12px; font-weight:700; color:#2D3277;">
                                ✎ Editar
                            </button>
                            <button type="button" class="btn btn-ghost btn-sm btn-toggle-colaborador" data-id="${u.id}" data-activo="${u.activo ? '0' : '1'}" style="padding:4px 8px; font-size:11px; color:${u.activo ? '#dc2626' : '#16a34a'};">
                                ${u.activo ? 'Desactivar' : 'Activar'}
                            </button>
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                        <span style="font-size:11px; font-weight:800; padding:3px 10px; border-radius:20px; background:${badgeBg}; color:${badgeColor}; border:1px solid ${badgeColor}33;">
                            ${badgeTexto}
                        </span>
                        <span style="font-size:10px; font-weight:700; color:${u.activo ? '#16a34a' : '#94a3b8'};">
                            ● ${u.activo ? 'Activo' : 'Inactivo'}
                        </span>
                    </div>
                </div>`;
            });

            listaCont.innerHTML = html;

            listaCont.querySelectorAll('.btn-editar-colaborador').forEach(btn => {
                btn.onclick = () => {
                    const uid = Number(btn.dataset.id);
                    const user = colaboradoresLista.find(u => u.id === uid);
                    if (user) abrirModalColaborador(user);
                };
            });

            listaCont.querySelectorAll('.btn-toggle-colaborador').forEach(btn => {
                btn.onclick = async () => {
                    const uid = Number(btn.dataset.id);
                    const nuevoActivo = btn.dataset.activo === '1';
                    try {
                        const res = await fetch(`/api/usuarios/${uid}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ activo: nuevoActivo })
                        });
                        if (res.ok) {
                            cargarColaboradores();
                        } else {
                            const d = await res.json();
                            alert(d.error || 'Error al actualizar colaborador');
                        }
                    } catch (e) {
                        alert('Error de conexión');
                    }
                };
            });
        } catch (e) {
            if (subtitulo) subtitulo.textContent = 'Error al consultar colaboradores.';
        }
    }

    function poblarSelectSucursalesColaborador(sucursalSeleccionada = null) {
        const sel = document.getElementById('colaboradorFormSucursal');
        if (!sel) return;
        let opts = '<option value="">👑 Toda la Red (Gerente Comercial - Acceso Global)</option>';
        sucursalesDisponibles.forEach(s => {
            const isSel = sucursalSeleccionada != null && String(s.id) === String(sucursalSeleccionada);
            opts += `<option value="${s.id}" ${isSel ? 'selected' : ''}>🏪 ${textoSeguro(s.nombre || 'Sucursal ' + s.id)}</option>`;
        });
        sel.innerHTML = opts;
    }

    function abrirModalColaborador(user = null) {
        const modal = document.getElementById('modalColaborador');
        const tit = document.getElementById('modalColaboradorTitulo');
        const passGrupo = document.getElementById('colaboradorPasswordGrupo');
        const passInput = document.getElementById('colaboradorFormPassword');
        if (!modal) return;

        poblarSelectSucursalesColaborador(user ? user.sucursal_id : null);

        document.getElementById('colaboradorFormId').value = user ? user.id : '';
        document.getElementById('colaboradorFormNombre').value = user ? (user.nombre || '') : '';
        document.getElementById('colaboradorFormUsername').value = user ? user.username : '';
        document.getElementById('colaboradorFormUsername').disabled = !!user;
        document.getElementById('colaboradorFormRole').value = user ? user.role : 'operador';
        document.getElementById('colaboradorFormSucursal').value = (user && user.sucursal_id != null) ? String(user.sucursal_id) : '';

        if (user) {
            if (passGrupo) passGrupo.style.display = 'none';
            if (passInput) passInput.required = false;
            if (tit) tit.textContent = '✎ Editar Colaborador';
        } else {
            if (passGrupo) passGrupo.style.display = '';
            if (passInput) {
                passInput.value = '';
                passInput.required = true;
            }
            if (tit) tit.textContent = '+ Nuevo Colaborador';
        }
        modal.style.display = 'block';
    }

    function cerrarModalColaborador() {
        const modal = document.getElementById('modalColaborador');
        if (modal) modal.style.display = 'none';
    }

    document.getElementById('empresaBtnNuevoColaborador')?.addEventListener('click', () => abrirModalColaborador());
    document.getElementById('modalColaboradorCerrar')?.addEventListener('click', cerrarModalColaborador);
    document.getElementById('modalColaboradorCancelar')?.addEventListener('click', cerrarModalColaborador);

    document.getElementById('formColaborador')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const idVal = f.elements['id'].value;
        const sidVal = f.elements['sucursal_id'].value;
        const sucursalId = sidVal ? parseInt(sidVal, 10) : null;
        
        if (idVal) {
            // Actualizar colaborador existente
            const datos = {
                nombre: f.elements['nombre'].value.trim(),
                role: f.elements['role'].value,
                sucursal_id: sucursalId
            };
            try {
                const res = await fetch(`/api/usuarios/${idVal}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(datos)
                });
                const data = await res.json();
                if (res.ok) {
                    cerrarModalColaborador();
                    cargarColaboradores();
                } else {
                    alert(data.error || 'Error al actualizar colaborador');
                }
            } catch (err) {
                alert('Error de red al actualizar colaborador');
            }
        } else {
            // Crear nuevo colaborador
            const datos = {
                nombre: f.elements['nombre'].value.trim(),
                username: f.elements['username'].value.trim(),
                password: f.elements['password'].value,
                role: f.elements['role'].value,
                sucursal_id: sucursalId
            };
            try {
                const res = await fetch('/api/usuarios', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(datos)
                });
                const data = await res.json();
                if (res.ok) {
                    cerrarModalColaborador();
                    cargarColaboradores();
                } else {
                    alert(data.error || 'Error al crear colaborador');
                }
            } catch (err) {
                alert('Error de red al crear colaborador');
            }
        }
    });

    global.MiEmpresa = { entrar, cargarSucursales, cargarColaboradores };
})(window);
