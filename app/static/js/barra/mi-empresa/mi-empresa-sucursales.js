/* =========================================================================
   SUCURSALES (UNIDAD OPERATIVA) - Cobro Fácil
   Maneja locales comerciales, dirección física con geocodificación
   automática Nominatim y mini-mapa Leaflet interactivo.
   ========================================================================= */
(function (global) {
    let sucursalesDisponibles = [];
    let mapa = null;
    let marcador = null;
    let sucursalBuscando = false;

    function textoSeguro(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = String(str);
        return d.innerHTML;
    }

    function getSucursalesDisponibles() {
        return sucursalesDisponibles;
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

            if (global.MiEmpresaColaboradores) {
                global.MiEmpresaColaboradores.poblarSelectSucursalesColaborador();
            }

            const esUnico = data.es_negocio_unico;
            if (subtitulo) {
                subtitulo.textContent = esUnico
                    ? '1 local activo · Negocio Único (Operación central)'
                    : `${sucursales.length} locales activos · Red Multi-sucursal`;
            }

            // Recopilar terminales para el módulo de terminales
            const terminales = [];
            sucursales.forEach((s) => {
                if (Array.isArray(s.terminales)) {
                    s.terminales.forEach((t) => terminales.push(t));
                }
            });
            const pendientes = Array.isArray(data.terminales_pendientes) ? data.terminales_pendientes : [];
            pendientes.forEach((p) => terminales.push(p));

            if (global.MiEmpresaTerminales) {
                global.MiEmpresaTerminales.setTerminalesDisponibles(terminales, sucursales);
            }

            if (sucursales.length === 0 && pendientes.length === 0) {
                listaCont.innerHTML = '<p style="color:#64748b; font-size:13px; padding:10px 0;">No hay sucursales registradas.</p>';
                return;
            }

            let html = '';

            // Renderizar sección de PCs pendientes si el módulo de terminales lo provee
            if (global.MiEmpresaTerminales) {
                html += global.MiEmpresaTerminales.renderPendientesHtml(pendientes);
            }

            sucursales.forEach((suc) => {
                const terms = suc.terminales || [];
                const badgeUnico = esUnico ? '<span style="background:#e0f2fe; color:#0369a1; font-size:10px; font-weight:800; padding:2px 8px; border-radius:12px; margin-left:6px;">⭐ LOCAL PRINCIPAL</span>' : '';
                const badgeCd = suc.es_centro_distribucion ? '<span style="background:#fef3c7; color:#92400e; font-size:10px; font-weight:800; padding:2px 8px; border-radius:12px; margin-left:6px;">📦 CENTRO DISTRIBUCIÓN</span>' : '';
                const coordsBadge = (suc.latitud && suc.longitud)
                    ? `<span style="background:#f0fdf4; color:#166534; font-size:10px; font-weight:700; padding:2px 6px; border-radius:6px; margin-left:6px;">📍 GPS: ${Number(suc.latitud).toFixed(4)}, ${Number(suc.longitud).toFixed(4)}</span>`
                    : '<span style="background:#fef2f2; color:#991b1b; font-size:10px; font-weight:700; padding:2px 6px; border-radius:6px; margin-left:6px;">⚠️ Sin coordenadas (se geocodificará)</span>';

                html += `
                <div class="sucursal-card" style="border:1.5px solid #e2e8f0; border-radius:14px; padding:12px 14px; background:#f8fafc; display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
                                <strong style="font-size:14px; color:#2D3277;">${textoSeguro(suc.nombre)}</strong>
                                ${suc.rubro ? `<span style="background:#fef9c3; color:#854d0e; font-size:10px; font-weight:800; padding:2px 6px; border-radius:6px;">🏷️ ${textoSeguro(suc.rubro)}</span>` : ''}
                                ${badgeUnico}
                                ${badgeCd}
                            </div>
                            <small style="display:block; color:#64748b; font-size:11px; margin-top:3px;">
                                📍 ${textoSeguro(suc.direccion || 'Sin dirección asignada')}
                                ${coordsBadge}
                            </small>
                            ${suc.horario ? `<small style="display:block; color:#64748b; font-size:11px;">⏰ ${textoSeguro(suc.horario)}</small>` : ''}
                            ${suc.whatsapp ? `<small style="display:block; color:#16a34a; font-size:11px; font-weight:700;">📱 WhatsApp Mostrador: ${textoSeguro(suc.whatsapp)}</small>` : ''}
                            ${suc.costo_envio ? `<small style="display:block; color:#0369a1; font-size:11px; font-weight:600;">🛵 Envío: $${Number(suc.costo_envio).toLocaleString('es-AR')}${suc.monto_minimo_envio_gratis ? ` · Gratis desde $${Number(suc.monto_minimo_envio_gratis).toLocaleString('es-AR')}` : ''}</small>` : ''}
                        </div>
                        <button type="button" class="btn-editar-sucursal" data-id="${suc.id}" style="background:#ffffff; border:1px solid #cbd5e1; border-radius:8px; padding:4px 8px; font-size:11px; font-weight:700; color:#475569; cursor:pointer;">
                            ✎ Editar Sucursal
                        </button>
                    </div>

                    ${global.MiEmpresaTerminales ? global.MiEmpresaTerminales.renderTerminalesSucursalHtml(terms) : ''}
                </div>`;
            });

            listaCont.innerHTML = html;

            listaCont.querySelectorAll('.btn-editar-sucursal').forEach((btn) => {
                btn.onclick = () => {
                    const sid = Number(btn.dataset.id);
                    const suc = sucursales.find((s) => s.id === sid);
                    if (suc) abrirModalSucursal(suc);
                };
            });

            if (global.MiEmpresaTerminales) {
                global.MiEmpresaTerminales.bindTerminalesEvents(listaCont);
            }
        } catch (e) {
            if (subtitulo) subtitulo.textContent = 'Error al cargar sucursales.';
        }
    }

    function actualizarPin(lat, lng, moverVista = true) {
        const inputLat = document.getElementById('sucursalFormLatitud');
        const inputLng = document.getElementById('sucursalFormLongitud');
        const coordsTxt = document.getElementById('sucursalCoordsTexto');
        const estadoMapa = document.getElementById('sucursalMapaEstado');

        if (inputLat) inputLat.value = lat;
        if (inputLng) inputLng.value = lng;
        if (coordsTxt) coordsTxt.textContent = `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
        if (estadoMapa) estadoMapa.textContent = '✓ Ubicación fijada';

        if (marcador) {
            marcador.setLatLng([lat, lng]);
        }
        if (mapa && moverVista) {
            mapa.setView([lat, lng], 16);
        }
    }

    function inicializarMiniMapa(lat, lng) {
        if (!global.L) return;
        const contenedor = document.getElementById('sucursalMapa');
        if (!contenedor) return;

        if (mapa) {
            mapa.remove();
            mapa = null;
            marcador = null;
        }

        const validLat = (lat != null && !isNaN(Number(lat))) ? Number(lat) : -34.4865;
        const validLng = (lng != null && !isNaN(Number(lng))) ? Number(lng) : -58.8335;

        mapa = global.L.map('sucursalMapa', {
            tap: false,
            zoomControl: true,
        }).setView([validLat, validLng], 15);

        global.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap',
        }).addTo(mapa);

        marcador = global.L.marker([validLat, validLng], {
            draggable: true,
            icon: global.L.divIcon({ className: 'perfil-empresa-pin', iconSize: [26, 26], iconAnchor: [13, 13] }),
        }).addTo(mapa);

        marcador.on('dragend', (e) => {
            const pos = e.target.getLatLng();
            actualizarPin(pos.lat, pos.lng, false);
        });

        mapa.on('click', (e) => {
            actualizarPin(e.latlng.lat, e.latlng.lng, false);
        });

        actualizarPin(validLat, validLng, false);

        setTimeout(() => mapa && mapa.invalidateSize(), 150);
        setTimeout(() => mapa && mapa.invalidateSize(), 400);
    }

    async function buscarDireccionEnMapa(texto) {
        if (!texto || sucursalBuscando) return;
        const estadoMapa = document.getElementById('sucursalMapaEstado');
        sucursalBuscando = true;
        if (estadoMapa) estadoMapa.textContent = 'Buscando en mapa…';

        try {
            const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ar&q=${encodeURIComponent(texto)}`;
            const res = await fetch(url);
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                const punto = data[0];
                actualizarPin(Number(punto.lat), Number(punto.lon), true);
                if (estadoMapa) estadoMapa.textContent = '✓ Dirección encontrada';
            } else {
                if (estadoMapa) estadoMapa.textContent = 'No se encontró. Ajustá el pin arrastrándolo.';
            }
        } catch (e) {
            if (estadoMapa) estadoMapa.textContent = 'Error de búsqueda. Arrastrá el pin manualmente.';
        } finally {
            sucursalBuscando = false;
        }
    }

    function abrirModalSucursal(suc = null) {
        const modal = document.getElementById('modalSucursal');
        const tit = document.getElementById('modalSucursalTitulo');
        if (!modal) return;

        document.getElementById('sucursalFormId').value = suc ? suc.id : '';
        document.getElementById('sucursalFormNombre').value = suc ? suc.nombre : '';
        document.getElementById('sucursalFormCodigo').value = suc ? (suc.codigo || '') : '';
        document.getElementById('sucursalFormRubro').value = suc ? (suc.rubro || 'Carnicería') : 'Carnicería';
        document.getElementById('sucursalFormWhatsapp').value = suc ? (suc.whatsapp || '') : '';
        document.getElementById('sucursalFormDireccion').value = suc ? (suc.direccion || '') : '';
        document.getElementById('sucursalFormHorario').value = suc ? (suc.horario || '') : '';
        document.getElementById('sucursalFormCostoEnvio').value = (suc && suc.costo_envio != null) ? suc.costo_envio : '';
        document.getElementById('sucursalFormMontoMinimoEnvioGratis').value = (suc && suc.monto_minimo_envio_gratis != null) ? suc.monto_minimo_envio_gratis : '';
        document.getElementById('sucursalFormEsCd').checked = suc ? !!suc.es_centro_distribucion : false;

        const buscadorInput = document.getElementById('sucursalBuscadorInput');
        if (buscadorInput) buscadorInput.value = suc ? (suc.direccion || '') : '';

        if (tit) tit.textContent = suc ? '✎ Editar Sucursal' : '+ Nueva Sucursal';
        modal.style.display = 'block';

        const latInit = suc ? suc.latitud : null;
        const lngInit = suc ? suc.longitud : null;
        inicializarMiniMapa(latInit, lngInit);
    }

    function cerrarModalSucursal() {
        const modal = document.getElementById('modalSucursal');
        if (modal) modal.style.display = 'none';
        if (mapa) {
            mapa.remove();
            mapa = null;
            marcador = null;
        }
    }

    function init() {
        document.getElementById('empresaBtnNuevaSucursal')?.addEventListener('click', () => abrirModalSucursal());
        document.getElementById('modalSucursalCerrar')?.addEventListener('click', cerrarModalSucursal);
        document.getElementById('modalSucursalCancelar')?.addEventListener('click', cerrarModalSucursal);

        const buscadorInput = document.getElementById('sucursalBuscadorInput');
        const buscadorBoton = document.getElementById('sucursalBuscadorBoton');
        if (buscadorBoton && buscadorInput) {
            buscadorBoton.addEventListener('click', () => buscarDireccionEnMapa(buscadorInput.value.trim()));
            buscadorInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    buscarDireccionEnMapa(buscadorInput.value.trim());
                }
            });
        }

        const direccionInput = document.getElementById('sucursalFormDireccion');
        if (direccionInput) {
            direccionInput.addEventListener('change', () => {
                const dir = direccionInput.value.trim();
                if (dir && (!marcador || !document.getElementById('sucursalFormLatitud')?.value)) {
                    if (buscadorInput) buscadorInput.value = dir;
                    buscarDireccionEnMapa(dir);
                }
            });
        }

        document.getElementById('sucursalGpsBoton')?.addEventListener('click', () => {
            if (!navigator.geolocation) {
                alert('Tu navegador no soporta geolocalización.');
                return;
            }
            const estadoMapa = document.getElementById('sucursalMapaEstado');
            if (estadoMapa) estadoMapa.textContent = 'Obteniendo GPS…';
            navigator.geolocation.getCurrentPosition(
                ({ coords }) => {
                    actualizarPin(coords.latitude, coords.longitude, true);
                },
                () => {
                    if (estadoMapa) estadoMapa.textContent = 'No se pudo obtener el GPS.';
                },
                { enableHighAccuracy: true, timeout: 10000 }
            );
        });

        document.getElementById('formSucursal')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = e.target;
            const idVal = f.elements['id'].value;
            const latVal = f.elements['latitud'].value;
            const lngVal = f.elements['longitud'].value;
            const costoEnvioVal = f.elements['costo_envio'].value;
            const minEnvioGratisVal = f.elements['monto_minimo_envio_gratis'].value;

            const datos = {
                id: idVal ? parseInt(idVal, 10) : null,
                nombre: f.elements['nombre'].value.trim(),
                codigo: f.elements['codigo'].value.trim(),
                rubro: f.elements['rubro'].value,
                whatsapp: f.elements['whatsapp'].value.trim(),
                direccion: f.elements['direccion'].value.trim(),
                horario: f.elements['horario'].value.trim(),
                costo_envio: costoEnvioVal !== '' ? parseFloat(costoEnvioVal) : null,
                monto_minimo_envio_gratis: minEnvioGratisVal !== '' ? parseFloat(minEnvioGratisVal) : null,
                latitud: (latVal !== '' && !isNaN(Number(latVal))) ? parseFloat(latVal) : null,
                longitud: (lngVal !== '' && !isNaN(Number(lngVal))) ? parseFloat(lngVal) : null,
                es_centro_distribucion: f.elements['es_centro_distribucion'].checked,
            };

            try {
                const res = await fetch('/api/sucursales', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(datos),
                });
                const data = await res.json();
                if (data.success) {
                    cerrarModalSucursal();
                    cargarSucursales();
                    if (global.cargarSucursalesSelector) {
                        global.cargarSucursalesSelector();
                    }
                } else {
                    alert(data.error || 'Error al guardar sucursal');
                }
            } catch (err) {
                alert('Error de red al guardar la sucursal');
            }
        });
    }

    global.MiEmpresaSucursales = {
        init,
        cargarSucursales,
        abrirModalSucursal,
        cerrarModalSucursal,
        getSucursalesDisponibles,
    };
})(window);
