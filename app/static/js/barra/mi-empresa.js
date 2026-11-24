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
    global.MiEmpresa = { entrar };
})(window);
