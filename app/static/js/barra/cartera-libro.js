/* Libro de cartera dentro de la plantilla. No navega a otra página. */
(function () {
    const caja = document.getElementById('view-cartera');
    if (!caja) return;

    const API_BASE = '/api';
    function claveCacheCartera() { return 'crm-cartera-app:' + (sucursalId || 'todas'); }
    const PERFILES_LOCAL = 'crm-perfiles-local';
    let allClients = [];
    let currentFilter = 'all';
    let cobrosMes = 0;
    let libro = {};
    let sucursalId = '';
    let libroAbierto = [];
    let marcaEmpresa = (document.getElementById('empresaNombre') || {}).textContent || '';
    const librosVistos = new Map();
    let historialCtl = null;
    let fichaAbierta = '';

    function nodo(id) { return document.getElementById(id); }
    function texto(id, valor) {
        const n = nodo(id);
        if (n) n.textContent = valor;
    }

    function formatMoney(amount) {
        return new Intl.NumberFormat('es-AR', {
            style: 'currency', currency: 'ARS', maximumFractionDigits: 0
        }).format(Number(amount) || 0);
    }

    function formatCompact(amount) {
        const n = Number(amount) || 0;
        const sign = n < 0 ? '-' : '';
        const abs = Math.abs(n);
        if (abs >= 1000000) {
            const millions = (abs / 1000000).toFixed(1).replace('.', ',');
            return sign + '$' + millions + 'M';
        }
        return sign + formatMoney(abs);
    }

    function formatPos(amount) {
        const n = Number(amount) || 0;
        const sign = n < 0 ? '-' : '';
        return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    function deudaVisible(client) {
        if (client.deuda_pos != null && client.deuda_pos !== '') return Number(client.deuda_pos) || 0;
        const saldo = Number(client.saldo_actual);
        return Number.isFinite(saldo) ? saldo : 0;
    }

    function diasDe(client) {
        if (client.dias != null && client.dias !== '') return Number(client.dias);
        return null;
    }

    function esExpress(client) {
        const tipo = String(client.tipo_cliente || '').toLowerCase();
        return tipo.includes('express') || tipo.includes('expres');
    }

    function enRiesgo(client) {
        return !!client.en_riesgo;
    }

    function interesCuenta(client) {
        const monto = Number(client.mantenimiento) || 0;
        return { monto, real: client.mantenimiento_origen === 'libro' };
    }

    function ponerMarca(valor) {
        const marca = nodo('empresaNombre');
        if (marca) marca.textContent = valor;
    }

    function clienteDelHash() {
        const marca = location.hash.match(/^#c=([^&]+)/);
        return marca ? decodeURIComponent(marca[1]) : '';
    }

    function vistaActiva() {
        return caja.classList.contains('active');
    }

    function cfrPorDia(tarifa) {
        const n = parseFloat(String(tarifa || '').replace('%', '').replace(',', '.'));
        if (!Number.isFinite(n)) return esc(tarifa || '—');
        const hoy = new Date();
        const dias = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
        const diario = n / dias;
        return diario.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
    }

    function fechaCorta(valor) {
        const partes = String(valor || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
        if (!partes) return valor || '—';
        return partes[3] + '/' + partes[2] + (partes[4] ? ' ' + partes[4] + ':' + partes[5] : '');
    }

    function marcarAtras(activo) {
        const boton = nodo('menuToggle');
        if (boton) {
            boton.classList.toggle('es-atras', activo);
            boton.setAttribute('aria-label', activo ? 'Volver' : 'Opciones del módulo');
            boton.title = activo ? 'Volver' : 'Opciones del módulo';
        }
        const perfil = nodo('btnPerfil');
        const refresh = nodo('btnRefresh');
        if (perfil) perfil.hidden = !activo;
        if (refresh) refresh.hidden = !!activo;
    }

    function cromo() {
        const ficha = nodo('ficha');
        if (!fichaAbierta || !ficha || ficha.hidden || !vistaActiva()) return false;
        const client = allClients.find(item => String(item.id) === fichaAbierta);
        if (client) ponerMarca(client.nombre);
        marcarAtras(true);
        return true;
    }

    function mostrarLista() {
        const lista = nodo('carteraLista');
        const ficha = nodo('ficha');
        if (lista) lista.hidden = false;
        if (ficha) {
            ficha.hidden = true;
            ficha.innerHTML = '';
        }
        fichaAbierta = '';
        libroAbierto = [];
        cerrarMovimiento();
        ponerMarca(marcaEmpresa);
        marcarAtras(false);
    }

    function tarjetaMovimiento(fila, indice) {
        const clase = fila.es_cobro ? 'cobro' : (fila.es_venta ? 'venta' : '');
        const extra = fila.detalle && fila.detalle !== '—' ? fila.detalle : (fila.ticket && fila.ticket !== '—' ? fila.ticket : '');
        return `<button type="button" class="mov ${clase}" data-mov="${indice}">
            <div>
                <strong>${esc(fila.etiqueta)}</strong>
                <span>${esc(fechaCorta(fila.fecha))}${extra ? ' · ' + esc(extra) : ''}</span>
            </div>
            <div class="mov-num">
                <b>${formatPos(fila.monto)}</b>
                <span>saldo ${formatPos(fila.saldo)}</span>
            </div>
        </button>`;
    }

    function pintarFichaBase(client, cuerpo) {
        const ficha = nodo('ficha');
        const lista = nodo('carteraLista');
        const saldo = deudaVisible(client);
        const interes = interesCuenta(client);
        const total = saldo + interes.monto;
        const interesTxt = interes.real ? formatCompact(interes.monto) : ('est. ' + formatCompact(interes.monto));
        if (lista) lista.hidden = true;
        if (ficha) ficha.hidden = false;
        ponerMarca(client.nombre);
        marcarAtras(true);
        const alias = (client.nombres || []).filter((nombre) => nombre && nombre !== client.nombre);
        const lugares = (client.sucursales || []).filter(Boolean);
        const notaNombres = alias.length
            ? `<p class="ficha-nota">También figura como ${alias.map(esc).join(', ')}</p>`
            : '';
        const notaLugar = lugares.length > 1
            ? `<p class="ficha-nota">Figura en ${lugares.map(esc).join(' y ')}</p>`
            : '';
        if (ficha) {
            ficha.innerHTML = `
                ${notaNombres}
                ${notaLugar}
                <div class="ficha-numeros">
                    <div><span>CAPITAL</span><strong>${formatCompact(saldo)}</strong></div>
                    <div><span>INTERÉS</span><strong>${interesTxt}</strong></div>
                    <div><span>CFR DÍA</span><strong>${cfrPorDia(client.tarifa)}</strong></div>
                </div>
                <div class="ficha-total"><span>TOTAL A PAGAR</span><strong>${formatCompact(total)}</strong></div>
                <div id="fichaCuerpo">${cuerpo}</div>`;
        }
        window.scrollTo(0, 0);
    }

    function pintarMovimientos(dato) {
        const cuerpo = nodo('fichaCuerpo');
        if (!cuerpo) return;
        libroAbierto = dato.movimientos || [];
        const nota = dato.resumen ? `<p class="ficha-nota">${esc(dato.resumen)}</p>` : '';
        if (!libroAbierto.length) {
            cuerpo.innerHTML = nota + '<p class="ficha-nota">El libro de esta cuenta todavía no llegó a la nube.</p>';
            return;
        }
        cuerpo.innerHTML = nota + `<div class="movs">${libroAbierto.map(tarjetaMovimiento).join('')}</div>`;
    }

    async function pintarFicha(id) {
        const client = allClients.find(item => String(item.id) === String(id));
        if (!client) return;
        const misma = fichaAbierta === String(id) && nodo('ficha') && !nodo('ficha').hidden;
        fichaAbierta = String(id);
        ponerMarca(client.nombre);
        marcarAtras(true);
        if (!misma) pintarFichaBase(client, '<p class="ficha-nota">Cargando el libro…</p>');
        if (client.pos_id == null) {
            const cuerpo = nodo('fichaCuerpo');
            if (cuerpo) cuerpo.innerHTML = '<p class="ficha-nota">Esta cuenta todavía no tiene el libro de Cobro Fácil.</p>';
            return;
        }
        const clave = String(client.pos_id);
        const visto = librosVistos.get(clave);
        if (visto) {
            pintarMovimientos(visto);
            return;
        }
        if (historialCtl) historialCtl.abort();
        const ctl = new AbortController();
        historialCtl = ctl;
        try {
            const respuesta = await fetch(`${API_BASE}/pos/historial?pos_id=${encodeURIComponent(client.pos_id)}&deuda=${encodeURIComponent(deudaVisible(client))}`, { signal: ctl.signal });
            const dato = await respuesta.json();
            if (fichaAbierta !== String(id)) return;
            librosVistos.set(clave, dato);
            pintarMovimientos(dato);
        } catch (error) {
            if (error && error.name === 'AbortError') return;
            const cuerpo = nodo('fichaCuerpo');
            if (cuerpo && fichaAbierta === String(id)) cuerpo.innerHTML = '<p class="ficha-nota">No se pudo leer el historial.</p>';
        }
    }

    function abrirMovimiento(indice) {
        const fila = libroAbierto[indice];
        if (!fila) return;
        const dias = fila.dias == null ? '—' : `${fila.dias} días`;
        const mant = fila.es_interes ? 'Asentado' : (fila.mantenimiento == null ? '—' : formatPos(fila.mantenimiento));
        const numero = String(fila.ticket || '').match(/#(\d+)/);
        const ticket = numero
            ? `<button type="button" class="fact" data-ticket="${esc(numero[1])}"><span>Ticket</span><strong>#${esc(numero[1])}</strong></button>`
            : `<div class="fact"><span>Ticket</span><strong>${esc(fila.ticket)}</strong></div>`;
        const host = nodo('sheetHost');
        host.hidden = false;
        host.innerHTML = `
            <div class="sheet-back" data-close="1"></div>
            <section class="sheet" role="dialog" aria-modal="true" aria-label="Movimiento">
                <h3>${esc(fila.etiqueta)}</h3>
                <p>${esc(fila.fecha)}</p>
                <div class="facts">
                    <div class="fact"><span>Monto</span><strong>${formatPos(fila.monto)}</strong></div>
                    <div class="fact"><span>Saldo</span><strong>${formatPos(fila.saldo)}</strong></div>
                    ${ticket}
                    <div class="fact"><span>Días</span><strong>${esc(dias)}</strong></div>
                    <div class="fact"><span>Mantenimiento</span><strong>${mant}</strong></div>
                    <div class="fact"><span>Detalle</span><strong>${esc(fila.detalle)}</strong></div>
                </div>
                <button class="sheet-close" type="button" data-close="1">Cerrar</button>
            </section>`;
    }

    async function verTicket(id) {
        const sheet = document.querySelector('#sheetHost .sheet');
        if (!sheet) return;
        sheet.innerHTML = `<h3>Ticket #${esc(id)}</h3><p>Buscando en el libro…</p>`;
        try {
            const dato = await fetch(`${API_BASE}/pos/ticket?id=${encodeURIComponent(id)}`).then(r => r.json());
            if (!dato.encontrado) {
                sheet.innerHTML = `<h3>Ticket #${esc(id)}</h3><p>Ese ticket todavía no está en la nube.</p><button class="sheet-close" type="button" data-close="1">Cerrar</button>`;
                return;
            }
            const lineas = (dato.items || []).map(item => `
                <div class="fact"><span>${esc(item.nombre)}</span><strong>${esc(item.cantidad)} x ${formatPos(item.precio)} · ${formatPos(item.subtotal)}</strong></div>
            `).join('');
            sheet.innerHTML = `
                <h3>Ticket #${esc(dato.id)}</h3>
                <p>${esc(dato.fecha)} · ${esc(dato.pago)}${dato.estado ? ' · ' + esc(dato.estado) : ''}</p>
                <div class="facts">${lineas || '<p>El ticket está, sin el detalle de los cortes.</p>'}</div>
                <p class="perfil-aviso">Total ${formatPos(dato.total)}</p>
                <button class="sheet-close" type="button" data-close="1">Cerrar</button>`;
        } catch (_) {
            sheet.innerHTML = `<h3>Ticket #${esc(id)}</h3><p>No se pudo leer el ticket.</p><button class="sheet-close" type="button" data-close="1">Cerrar</button>`;
        }
    }

    function cerrarMovimiento() {
        const host = nodo('sheetHost');
        if (!host) return;
        host.hidden = true;
        host.innerHTML = '';
    }

    function abrirPerfil() {
        const id = fichaAbierta || clienteDelHash();
        const client = allClients.find(item => String(item.id) === String(id));
        const host = nodo('sheetHost');
        host.hidden = false;
        if (!client) {
            host.innerHTML = `
                <div class="sheet-back" data-close="1"></div>
                <section class="sheet" role="dialog" aria-modal="true" aria-label="Perfil">
                    <h3>Perfil</h3>
                    <p>Abrí un cliente para editar su ficha.</p>
                    <button class="sheet-close" type="button" data-close="1">Cerrar</button>
                </section>`;
            return;
        }
        host.innerHTML = `
            <div class="sheet-back" data-close="1"></div>
            <section class="sheet" role="dialog" aria-modal="true" aria-label="Perfil">
                <h3>Perfil</h3>
                <p class="perfil-aviso">Queda en este teléfono. La base se actualiza más adelante.</p>
                <label class="perfil-campo"><span>NOMBRE</span><input id="perfilNombre" value="${esc(client.nombre || '')}" autocomplete="name"></label>
                <label class="perfil-campo"><span>DNI</span><input id="perfilDni" value="${esc(client.cuit || '')}" inputmode="numeric" autocomplete="off"></label>
                <label class="perfil-campo"><span>TELÉFONO</span><input id="perfilTelefono" value="${esc(client.telefono || '')}" inputmode="tel" autocomplete="tel"></label>
                <label class="perfil-campo"><span>DIRECCIÓN</span><input id="perfilDireccion" value="${esc(client.direccion || '')}" autocomplete="street-address"></label>
                <button class="sheet-close" type="button" data-guardar="1">Guardar en el teléfono</button>
            </section>`;
        host.dataset.perfilId = String(client.id);
    }

    function leerPerfiles() {
        try { return JSON.parse(localStorage.getItem(PERFILES_LOCAL)) || {}; }
        catch (e) { return {}; }
    }

    function aplicarPerfilLocal(client) {
        const local = leerPerfiles()[String(client.id)];
        if (!local) return client;
        if (local.nombre) client.nombre = local.nombre;
        if ('dni' in local) client.cuit = local.dni || '';
        if ('telefono' in local) client.telefono = local.telefono || '';
        if ('direccion' in local) client.direccion = local.direccion || '';
        return client;
    }

    function guardarPerfilLocal(perfil) {
        const todos = leerPerfiles();
        todos[String(perfil.id)] = {
            id: perfil.id,
            pos_id: perfil.pos_id,
            nombre: perfil.nombre,
            dni: perfil.dni,
            telefono: perfil.telefono,
            direccion: perfil.direccion,
            origen: 'local',
            actualizado: new Date().toISOString()
        };
        localStorage.setItem(PERFILES_LOCAL, JSON.stringify(todos));
    }

    function guardarPerfilAbierto() {
        const id = nodo('sheetHost').dataset.perfilId;
        const client = allClients.find(item => String(item.id) === String(id));
        if (!client) return;
        const perfil = {
            id: client.id,
            pos_id: client.pos_id,
            nombre: nodo('perfilNombre').value.trim(),
            dni: nodo('perfilDni').value.trim(),
            telefono: nodo('perfilTelefono').value.trim(),
            direccion: nodo('perfilDireccion').value.trim()
        };
        guardarPerfilLocal(perfil);
        if (perfil.nombre) client.nombre = perfil.nombre;
        client.cuit = perfil.dni;
        client.telefono = perfil.telefono;
        client.direccion = perfil.direccion;
        if (fichaAbierta === String(client.id)) ponerMarca(client.nombre);
        filterClients();
        cerrarMovimiento();
    }

    function desdeLibro(cliente) {
        return aplicarPerfilLocal({
            id: cliente.id,
            pos_id: cliente.id,
            nombre: cliente.nombre,
            nombres: cliente.nombres || [],
            sucursales: cliente.sucursales || [],
            cuit: cliente.dni,
            telefono: cliente.telefono,
            tipo_cliente: cliente.tipo,
            deuda_pos: cliente.deuda,
            techo_deuda: cliente.limite,
            dias: cliente.dias,
            mantenimiento: cliente.mantenimiento,
            mantenimiento_origen: cliente.mantenimiento_origen,
            tarifa: cliente.tarifa,
            en_riesgo: cliente.en_riesgo,
            estado: cliente.estado,
            sucursal_nombre: cliente.sucursal_nombre || '',
            direccion: ''
        });
    }

    function setFilter(filter) {
        currentFilter = filter;
        caja.querySelectorAll('.resumen button').forEach(item => {
            item.classList.toggle('on', item.dataset.filter === filter);
        });
        filterClients();
    }

    function filterClients() {
        const searchQuery = (nodo('searchInput').value || '').toLowerCase();
        const filtered = allClients.filter(client => {
            const matchesSearch = !searchQuery ||
                (client.nombre && client.nombre.toLowerCase().includes(searchQuery)) ||
                (client.cuit && String(client.cuit).toLowerCase().includes(searchQuery));
            const saldo = deudaVisible(client);
            const days = diasDe(client);
            let matchesCategory = true;
            switch (currentFilter) {
                case 'saldo': matchesCategory = saldo > 0; break;
                case 'al_dia': matchesCategory = saldo <= 0; break;
                case 'expres': matchesCategory = esExpress(client); break;
                case 'criticos': matchesCategory = enRiesgo(client); break;
                case '30+': matchesCategory = days !== null && days >= 30; break;
                case '60+': matchesCategory = days !== null && days >= 60; break;
                case '90+': matchesCategory = days !== null && days >= 90; break;
            }
            return matchesSearch && matchesCategory;
        });
        filtered.sort((a, b) => deudaVisible(b) - deudaVisible(a));
        renderCards(filtered);
    }

    function renderCards(clients) {
        const box = nodo('cards');
        const emptyState = nodo('emptyState');
        if (!clients.length) {
            box.innerHTML = '';
            emptyState.hidden = false;
            emptyState.textContent = 'No hay clientes en este filtro.';
            return;
        }
        emptyState.hidden = true;
        box.innerHTML = clients.map(client => {
            const saldo = deudaVisible(client);
            const interes = interesCuenta(client);
            const total = saldo + interes.monto;
            const tipo = esExpress(client) ? 'EXPRESS' : String(client.tipo_cliente || '').replaceAll('_', ' ').toUpperCase();
            const pill = tipo && tipo !== 'REGULAR' ? `<span class="pill">${esc(tipo)}</span>` : '';
            const interesTxt = interes.real ? formatCompact(interes.monto) : ('est. ' + formatCompact(interes.monto));
            const late = client.dias == null
                ? '<span class="late">Sin días<br>en el libro</span>'
                : (Number(client.dias) > 0
                    ? `<span class="late">${esc(client.dias)} días<br>retraso</span>`
                    : '<span class="late ok">Al día</span>');
            const lugares = (client.sucursales || []).filter(Boolean);
            const lugar = lugares.length > 1 ? lugares.join(' · ') : '';
            const pie = [client.cuit ? 'DNI ' + client.cuit : '', lugar, client.telefono || ''].filter(Boolean).join(' · ') || 'Ver historial';
            return `
                <article class="debt-card" data-id="${esc(client.id)}">
                    <div class="card-top">
                        <div class="who">
                            <div class="avatar" aria-hidden="true">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e2e8f0" stroke-width="1.8"><path d="M20 21a8 8 0 10-16 0"/><circle cx="12" cy="7" r="4"/></svg>
                            </div>
                            <div>
                                <h2>${esc(client.nombre)}</h2>
                                ${pill}
                            </div>
                        </div>
                        ${late}
                    </div>
                    <div class="metrics">
                        <div><span>CAPITAL</span><strong>${formatCompact(saldo)}</strong></div>
                        <div><span>INTERÉS</span><strong>${interesTxt}</strong></div>
                        <div><span>CFR</span><strong>${esc(client.tarifa || '—')}</strong></div>
                    </div>
                    <div class="card-foot">
                        <div>
                            <span class="amount-label">TOTAL A PAGAR</span>
                            <span class="amount ${saldo > 0 ? 'hot' : 'cool'}">${formatCompact(total)}</span>
                        </div>
                        <div class="foot-note">${esc(pie)}</div>
                    </div>
                </article>`;
        }).join('');
    }

    function updateMetrics() {
        const base = allClients;
        const conDeuda = base.filter(c => deudaVisible(c) > 0);
        const riesgo = base.filter(enRiesgo);
        const deuda = conDeuda.reduce((sum, c) => sum + deudaVisible(c), 0);
        const deudaRiesgo = riesgo.reduce((sum, c) => sum + Math.max(deudaVisible(c), 0), 0);
        texto('barDeuda', formatMoney(libro.cartera_en_calle != null ? libro.cartera_en_calle : deuda));
        texto('barDeudaSub', `${libro.cuentas_activas != null ? libro.cuentas_activas : conDeuda.length} activas`);
        texto('barRiesgo', formatMoney(libro.cartera_en_riesgo != null ? libro.cartera_en_riesgo : deudaRiesgo));
        texto('barRiesgoSub', `${libro.cuentas_en_riesgo != null ? libro.cuentas_en_riesgo : riesgo.length} cuentas`);
        texto('barCobros', formatMoney(libro.cobros_del_mes != null ? libro.cobros_del_mes : cobrosMes));
    }

    function aplicarLibro(dato) {
        const cartera = (dato && dato.cartera) || {};
        libro = cartera;
        cobrosMes = Number(cartera.cobros_del_mes) || 0;
        allClients = (cartera.clientes || cartera.top_deudores || []).map(desdeLibro);
        updateMetrics();
        filterClients();
        const abierto = clienteDelHash();
        if (abierto && vistaActiva()) pintarFicha(abierto);
    }

    async function loadClients() {
        librosVistos.clear();
        const vacio = nodo('emptyState');
        if (!allClients.length && vacio) {
            vacio.hidden = false;
            vacio.textContent = 'Cargando el libro…';
        }
        try {
            // 1. Consulta al Espejo local primero (0ms de latencia, cero conflicto en la nube)
            if (window.Espejo && Espejo.cartera) {
                const carteraEspejo = Espejo.cartera(sucursalId);
                if (carteraEspejo && carteraEspejo.cartera && carteraEspejo.cartera.clientes && carteraEspejo.cartera.clientes.length) {
                    aplicarLibro(carteraEspejo);
                    if (window.EspejoEngine && EspejoEngine.syncDelta) {
                        void EspejoEngine.syncDelta();
                    }
                    return;
                }
            }

            const consulta = sucursalId ? ('sucursal_id=' + encodeURIComponent(sucursalId)) : '';
            if (window.Nodo) {
                const previo = Nodo.tomar('cartera', consulta);
                if (previo) aplicarLibro(previo);
                const dato = await Nodo.encargar('cartera', consulta);
                if (dato) {
                    try { localStorage.setItem(claveCacheCartera(), JSON.stringify(dato)); } catch (e) {}
                    aplicarLibro(dato);
                }
                return;
            }
            let url = `${API_BASE}/pos/jefe?panel=admin`;
            if (sucursalId) url += '&sucursal_id=' + encodeURIComponent(sucursalId);
            const response = await fetch(url);
            if (!response.ok) throw new Error('libro');
            const dato = await response.json();
            try { localStorage.setItem(claveCacheCartera(), JSON.stringify(dato)); } catch (e) {}
            aplicarLibro(dato);
        } catch (e) {
            if (!allClients.length && vacio) {
                vacio.hidden = false;
                vacio.textContent = 'El libro no llegó. Tocá actualizar.';
            }
        }
    }

    nodo('searchInput').addEventListener('input', () => filterClients());
    caja.querySelector('.resumen').addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button || !button.dataset.filter) return;
        setFilter(button.dataset.filter === currentFilter ? 'all' : button.dataset.filter);
    });
    nodo('cards').addEventListener('click', (event) => {
        const card = event.target.closest('.debt-card');
        if (!card) return;
        const marca = '#c=' + encodeURIComponent(card.dataset.id);
        pintarFicha(card.dataset.id);
        if (location.hash !== marca) location.hash = marca;
    });
    nodo('ficha').addEventListener('click', (event) => {
        const mov = event.target.closest('[data-mov]');
        if (mov) abrirMovimiento(Number(mov.dataset.mov));
    });
    nodo('sheetHost').addEventListener('click', (event) => {
        const ticket = event.target.closest('[data-ticket]');
        if (ticket) {
            verTicket(ticket.dataset.ticket);
            return;
        }
        if (event.target.closest('[data-guardar]')) guardarPerfilAbierto();
        else if (event.target.closest('[data-close]')) cerrarMovimiento();
    });
    nodo('btnPerfil').addEventListener('click', () => abrirPerfil());
    window.addEventListener('hashchange', () => {
        if (!vistaActiva()) return;
        const abierto = clienteDelHash();
        if (abierto) pintarFicha(abierto);
        else mostrarLista();
    });

    window.CarteraLibro = {
        filtroActual() { return currentFilter; },
        filtrar(filtro) { setFilter(filtro || 'all'); },
        actualizar() { return loadClients(); },
        recibir(dato) { if (dato) aplicarLibro(dato); },
        sucursal(id) {
            sucursalId = (id == null || id === '') ? '' : String(id);
            try {
                const previo = localStorage.getItem(claveCacheCartera());
                if (previo) aplicarLibro(JSON.parse(previo));
            } catch (_) {}
            return loadClients();
        },
        entrar(id) {
            sucursalId = (id == null || id === '') ? '' : String(id);
            const abierto = clienteDelHash();
            if (abierto) pintarFicha(abierto);
            else mostrarLista();
            return loadClients();
        },
        cromo,
        salir() {
            marcarAtras(false);
            if (window.actualizarNombreEmpresaTopbar) window.actualizarNombreEmpresaTopbar();
            else ponerMarca(marcaEmpresa);
            cerrarMovimiento();
        },
        atras() {
            const ficha = nodo('ficha');
            if (!vistaActiva() || !ficha || ficha.hidden) return false;
            if (location.hash) history.replaceState(null, '', location.pathname + location.search);
            mostrarLista();
            return true;
        }
    };

    try {
        const idIni = localStorage.getItem('crm_active_sucursal_id') || '';
        sucursalId = idIni;
        const previo = localStorage.getItem(claveCacheCartera()) || sessionStorage.getItem(claveCacheCartera());
        if (previo) aplicarLibro(JSON.parse(previo));
    } catch (e) {}

    if (window.Espejo && Espejo.alActualizar) {
        Espejo.alActualizar(() => {
            if (vistaActiva && vistaActiva()) {
                const carteraEspejo = Espejo.cartera(sucursalId);
                if (carteraEspejo && carteraEspejo.cartera && carteraEspejo.cartera.clientes) {
                    aplicarLibro(carteraEspejo);
                }
            }
        });
    }
})();
