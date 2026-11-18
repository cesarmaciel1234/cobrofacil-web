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
        return sign + '$' + Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function repararTexto(str) {
        if (!str || typeof str !== 'string') return str || '';
        if (/[\u00C0-\u00FF]/.test(str)) {
            try {
                return decodeURIComponent(escape(str));
            } catch (_) {}
        }
        return str;
    }

    function esc(value) {
        return String(repararTexto(value ?? '')).replace(/[&<>"']/g, (ch) => ({
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
            boton.setAttribute('aria-label', activo ? 'Volver a clientes' : 'Opciones del módulo');
            boton.title = activo ? 'Volver a clientes' : 'Opciones del módulo';
        }
        const perfil = nodo('btnPerfil');
        if (perfil) perfil.hidden = true;
        actualizarBotonFiltro();
    }

    function actualizarBotonFiltro() {
        const refresh = nodo('btnRefresh');
        if (refresh && vistaActiva()) {
            refresh.hidden = false;
            refresh.classList.add('es-filtro');
            refresh.classList.toggle('filtrando', filtroActivo());
            refresh.setAttribute('aria-label', 'Filtrar cartera');
            refresh.title = 'Filtrar cartera';
        }
    }

    function filtroActivo() {
        if (pantallaActual === 'cargos') {
            return (periodoCargos && periodoCargos !== 'Mes') || (estadoCargos && estadoCargos !== 'todos') || !!textoCargos;
        }
        if (pantallaActual === 'cobros') {
            return (periodoCobros && periodoCobros !== 'Mes') || (medioCobros && medioCobros !== 'todos') || !!textoCobros;
        }
        if (pantallaActual === 'auditoria') {
            return (accionAuditoria && accionAuditoria !== 'todas') || !!textoAuditoria;
        }
        return currentFilter !== 'all' || !!(nodo('searchInput')?.value?.trim());
    }

    function actualizarPeriodoChip(id, texto) {
        const el = nodo(id);
        if (el && texto) el.textContent = texto;
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
        const cargos = nodo('carteraCargos');
        const cobros = nodo('carteraCobros');
        const auditoria = nodo('carteraAuditoria');
        if (lista) lista.hidden = false;
        if (ficha) {
            ficha.hidden = true;
            ficha.innerHTML = '';
        }
        if (cargos) cargos.hidden = true;
        if (cobros) cobros.hidden = true;
        if (auditoria) auditoria.hidden = true;
        fichaAbierta = '';
        pantallaActual = 'clientes';
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
            if (dato && Array.isArray(dato.movimientos) && dato.movimientos.length) {
                librosVistos.set(clave, dato);
                pintarMovimientos(dato);
                return;
            }
        } catch (error) {
            if (error && error.name === 'AbortError') return;
        }
        if (window.Espejo && Espejo.historialCliente) {
            const localHist = Espejo.historialCliente(client.pos_id, client.dni);
            if (localHist && Array.isArray(localHist.movimientos) && localHist.movimientos.length) {
                if (fichaAbierta !== String(id)) return;
                librosVistos.set(clave, localHist);
                pintarMovimientos(localHist);
                return;
            }
        }
        if (fichaAbierta === String(id)) {
            pintarMovimientos({ movimientos: [] });
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
        const deuda = cliente.deuda != null ? cliente.deuda : (cliente.saldo_actual != null ? cliente.saldo_actual : (cliente.deuda_pos != null ? cliente.deuda_pos : 0));
        const limite = cliente.limite != null ? cliente.limite : (cliente.limite_credito != null ? cliente.limite_credito : (cliente.techo_deuda != null ? cliente.techo_deuda : 0));
        const dni = cliente.dni != null ? cliente.dni : (cliente.dni_cuit != null ? cliente.dni_cuit : (cliente.cuit || ''));
        const tipo = cliente.tipo || cliente.tipo_cliente || 'Minorista';
        const numDeuda = Number(deuda) || 0;
        const numLimite = Number(limite) || 0;
        const numDias = cliente.dias != null && cliente.dias !== '' ? Number(cliente.dias) : null;
        return aplicarPerfilLocal({
            id: cliente.id,
            pos_id: cliente.pos_id || cliente.id,
            nombre: cliente.nombre || '',
            nombres: cliente.nombres || [cliente.nombre || ''],
            sucursales: cliente.sucursales || (cliente.sucursal_nombre ? [cliente.sucursal_nombre] : []),
            cuit: dni,
            dni: dni,
            telefono: cliente.telefono || '',
            tipo_cliente: tipo,
            tipo: tipo,
            deuda: numDeuda,
            deuda_pos: numDeuda,
            saldo_actual: numDeuda,
            techo_deuda: numLimite,
            limite_credito: numLimite,
            dias: numDias,
            mantenimiento: cliente.mantenimiento != null ? Number(cliente.mantenimiento) : 0,
            mantenimiento_origen: cliente.mantenimiento_origen || '',
            tarifa: cliente.tarifa || '',
            en_riesgo: !!(cliente.en_riesgo || (numLimite > 0 && numDeuda >= numLimite) || (numDias !== null && numDias > 30)),
            estado: cliente.estado || (numDeuda > 0 ? 'Con saldo' : 'Al día'),
            sucursal_nombre: cliente.sucursal_nombre || '',
            direccion: cliente.direccion || ''
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
                    if (!navigator.onLine) return;
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
            if (response.status === 401) {
                window.location.href = '/login';
                return;
            }
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

    let pantallaActual = 'clientes';
    let periodoCargos = 'Mes';
    let estadoCargos = 'todos';
    let textoCargos = '';
    let timerCargos = null;

    let periodoCobros = 'Mes';
    let medioCobros = 'todos';
    let textoCobros = '';
    let timerCobros = null;

    let accionAuditoria = 'todas';
    let textoAuditoria = '';
    let timerAuditoria = null;

    function cambiarPantalla(id) {
        pantallaActual = id || 'clientes';
        const lista = nodo('carteraLista');
        const ficha = nodo('ficha');
        const cargos = nodo('carteraCargos');
        const cobros = nodo('carteraCobros');
        const auditoria = nodo('carteraAuditoria');

        if (pantallaActual === 'clientes') {
            mostrarLista();
            return;
        }

        if (lista) lista.hidden = true;
        if (ficha) { ficha.hidden = true; ficha.innerHTML = ''; }
        if (cargos) cargos.hidden = (pantallaActual !== 'cargos');
        if (cobros) cobros.hidden = (pantallaActual !== 'cobros');
        if (auditoria) auditoria.hidden = (pantallaActual !== 'auditoria');

        marcarAtras(false);
        actualizarBotonFiltro();
        if (pantallaActual === 'cargos') {
            ponerMarca('Historial de cargos');
            cargarCargos();
        } else if (pantallaActual === 'cobros') {
            ponerMarca('Historial de cobros');
            cargarCobros();
        } else if (pantallaActual === 'auditoria') {
            ponerMarca('Auditoría de cartera');
            cargarAuditoria();
        }
    }

    async function cargarCargos() {
        const cuerpo = nodo('cuerpoCargos');
        const pie = nodo('pieCargos');
        actualizarBotonFiltro();
        let chipTexto = periodoCargos;
        if (estadoCargos && estadoCargos !== 'todos') chipTexto += ` · ${estadoCargos}`;
        if (textoCargos) chipTexto += ` · "${textoCargos}"`;
        actualizarPeriodoChip('chipCarteraCargos', chipTexto);
        if (cuerpo) cuerpo.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:24px; color:var(--text-muted);">Cargando planilla de cargos…</td></tr>';
        try {
            let url = `${API_BASE}/pos/jefe?panel=cargos&periodo=${encodeURIComponent(periodoCargos)}`;
            if (estadoCargos && estadoCargos !== 'todos') url += `&estado=${encodeURIComponent(estadoCargos)}`;
            if (textoCargos) url += `&q=${encodeURIComponent(textoCargos)}`;
            if (sucursalId) url += `&sucursal_id=${encodeURIComponent(sucursalId)}`;
            const res = await fetch(url);
            if (res.status === 401) {
                window.location.href = '/login';
                return;
            }
            if (!res.ok) throw new Error('cargos');
            const data = await res.json();
            renderCargos(data.cargos || [], data.resumen || {});
        } catch (e) {
            if (cuerpo) cuerpo.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:24px; color:#ef4444;">No se pudo cargar la planilla de cargos.</td></tr>';
        }
    }

    function renderCargos(filas, resumen) {
        const cuerpo = nodo('cuerpoCargos');
        const pie = nodo('pieCargos');
        if (!cuerpo) return;
        if (!filas.length) {
            cuerpo.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:28px; color:var(--text-muted);">No se encontraron cargos para este filtro.</td></tr>';
            if (pie) pie.innerHTML = '<span>0 cargos</span>';
            return;
        }

        cuerpo.innerHTML = filas.map(f => {
            const inactivo = f.estado_clave === 'borrado' || f.estado_clave === 'cancelado';
            const estiloFila = inactivo ? 'opacity:0.6; text-decoration:line-through;' : '';
            const colorMonto = inactivo ? 'var(--text-muted)' : '#dc2626';
            const colorEstado = f.estado_clave === 'vivo' ? 'background:rgba(220,38,38,0.15); color:#f87171;' : (f.estado_clave === 'borrado' ? 'background:rgba(217,119,6,0.15); color:#fbbf24;' : 'background:rgba(100,116,139,0.2); color:#94a3b8;');
            const ticketHtml = f.venta_id ? `<span style="color:#3b82f6; font-weight:700;">#${esc(f.venta_id)}</span>` : esc(f.ticket);

            return `<tr style="${estiloFila}">
                <td style="white-space:nowrap; font-size:12px; color:var(--text-muted);">${esc(f.fecha)}</td>
                <td style="white-space:nowrap;">${ticketHtml}</td>
                <td style="font-weight:700;">${esc(f.nombre)}</td>
                <td style="font-size:12px; color:var(--text-muted);">${esc(f.dni || '—')}</td>
                <td style="text-align:right; font-weight:800; color:${colorMonto}; white-space:nowrap;">${formatPos(f.monto)}</td>
                <td style="font-size:12px;">${esc(f.origen)}</td>
                <td><span style="display:inline-block; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:800; text-transform:uppercase; ${colorEstado}">${esc(f.estado)}</span></td>
                <td style="text-align:right; font-size:13px; font-weight:600; white-space:nowrap;">${formatPos(f.saldo)}</td>
                <td style="font-size:12px; color:var(--text-muted); max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(f.descripcion)}">${esc(f.descripcion)}</td>
            </tr>`;
        }).join('');

        if (pie) {
            let partes = [`${filas.length} cargos · Vivos: ${formatPos(resumen.total_vivos || 0)}`];
            if (resumen.total_borrados) partes.push(`Borrados: ${formatPos(resumen.total_borrados)}`);
            if (resumen.total_cancelados) partes.push(`Cancelados: ${formatPos(resumen.total_cancelados)}`);
            pie.innerHTML = `<span>${partes.join(' &nbsp;·&nbsp; ')}</span>`;
        }
    }

    async function cargarCobros() {
        const cuerpo = nodo('cuerpoCobros');
        const pie = nodo('pieCobros');
        actualizarBotonFiltro();
        let chipTexto = periodoCobros;
        if (medioCobros && medioCobros !== 'todos') chipTexto += ` · ${medioCobros}`;
        if (textoCobros) chipTexto += ` · "${textoCobros}"`;
        actualizarPeriodoChip('chipCarteraCobros', chipTexto);
        if (cuerpo) cuerpo.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:24px; color:var(--text-muted);">Cargando planilla de cobros…</td></tr>';
        try {
            let url = `${API_BASE}/pos/jefe?panel=cobros&periodo=${encodeURIComponent(periodoCobros)}`;
            if (medioCobros && medioCobros !== 'todos') url += `&medio=${encodeURIComponent(medioCobros)}`;
            if (textoCobros) url += `&q=${encodeURIComponent(textoCobros)}`;
            if (sucursalId) url += `&sucursal_id=${encodeURIComponent(sucursalId)}`;
            const res = await fetch(url);
            if (res.status === 401) {
                window.location.href = '/login';
                return;
            }
            if (!res.ok) throw new Error('cobros');
            const data = await res.json();
            renderCobros(data.cobros || [], data.resumen || {});
        } catch (e) {
            if (cuerpo) cuerpo.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:24px; color:#ef4444;">No se pudo cargar la planilla de cobros.</td></tr>';
        }
    }

    function renderCobros(filas, resumen) {
        const cuerpo = nodo('cuerpoCobros');
        const pie = nodo('pieCobros');
        if (!cuerpo) return;
        if (!filas.length) {
            cuerpo.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:28px; color:var(--text-muted);">No se encontraron cobros para este filtro.</td></tr>';
            if (pie) pie.innerHTML = '<span>0 cobros</span>';
            return;
        }

        cuerpo.innerHTML = filas.map(f => {
            const colorMedio = f.digital ? 'background:rgba(59,130,246,0.15); color:#60a5fa;' : 'background:rgba(16,185,129,0.15); color:#34d399;';

            return `<tr>
                <td style="white-space:nowrap; font-size:12px; color:var(--text-muted);">${esc(f.fecha)}</td>
                <td style="white-space:nowrap; font-weight:800; color:#3b82f6;">${esc(f.ticket_cobro)}</td>
                <td style="font-weight:700;">${esc(f.nombre)}</td>
                <td style="font-size:12px; color:var(--text-muted);">${esc(f.dni || '—')}</td>
                <td style="text-align:right; font-weight:800; color:#059669; white-space:nowrap;">${formatPos(f.monto)}</td>
                <td><span style="display:inline-block; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:800; text-transform:uppercase; ${colorMedio}">${esc(f.medio)}</span></td>
                <td style="font-size:12px; color:var(--text-muted);">${esc(f.detalle)}</td>
                <td style="font-size:12px;">${esc(f.perfil)}</td>
                <td style="font-size:12px; color:var(--text-muted);">${esc(f.quien)}</td>
                <td style="text-align:right; font-size:13px; font-weight:600; white-space:nowrap;">${formatPos(f.saldo)}</td>
            </tr>`;
        }).join('');

        if (pie) {
            let partes = [`${filas.length} cobros · Total cobrado: ${formatPos(resumen.monto_cobrado || 0)}`];
            if (resumen.desglose_medios) {
                const subMedios = Object.entries(resumen.desglose_medios).map(([k, v]) => `${k}: ${formatPos(v)}`);
                if (subMedios.length) partes.push(`(${subMedios.join(', ')})`);
            }
            pie.innerHTML = `<span>${partes.join(' &nbsp;·&nbsp; ')}</span>`;
        }
    }

    async function cargarAuditoria() {
        const cuerpo = nodo('cuerpoAuditoria');
        const barra = nodo('barraCuadreCartera');
        const pie = nodo('pieAuditoria');
        actualizarBotonFiltro();
        let chipTexto = (accionAuditoria || 'todas').toUpperCase();
        if (textoAuditoria) chipTexto += ` · "${textoAuditoria}"`;
        actualizarPeriodoChip('chipCarteraAuditoria', chipTexto);
        if (cuerpo) cuerpo.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:24px; color:var(--text-muted);">Cargando auditoría de clientes…</td></tr>';
        try {
            let url = `${API_BASE}/pos/jefe?panel=auditoria_cartera`;
            if (accionAuditoria && accionAuditoria !== 'todas') url += `&accion=${encodeURIComponent(accionAuditoria)}`;
            if (textoAuditoria) url += `&q=${encodeURIComponent(textoAuditoria)}`;
            if (sucursalId) url += `&sucursal_id=${encodeURIComponent(sucursalId)}`;
            const res = await fetch(url);
            if (res.status === 401) {
                window.location.href = '/login';
                return;
            }
            if (!res.ok) throw new Error('auditoria');
            const data = await res.json();
            renderAuditoria(data.auditoria || [], data.resumen || {});
        } catch (e) {
            if (cuerpo) cuerpo.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:24px; color:#ef4444;">No se pudo cargar la auditoría.</td></tr>';
        }
    }

    function renderAuditoria(filas, resumen) {
        const cuerpo = nodo('cuerpoAuditoria');
        const barra = nodo('barraCuadreCartera');
        const pie = nodo('pieAuditoria');
        if (!cuerpo) return;

        if (barra) {
            const cuadreOk = resumen.cuadre_ok;
            const diffTxt = resumen.cuadre_diferencia != null ? formatPos(Math.abs(resumen.cuadre_diferencia)) : '$0';
            barra.innerHTML = `
                <div>
                    <span style="font-size:11px; text-transform:uppercase; color:var(--text-muted); font-weight:700;">Deuda Activa Clientes</span>
                    <div style="font-size:1.15rem; font-weight:900; color:#3b82f6;">${formatPos(resumen.total_deuda_clientes || 0)}</div>
                </div>
                <div>
                    <span style="font-size:11px; text-transform:uppercase; color:var(--text-muted); font-weight:700;">Cargos Vivos</span>
                    <div style="font-size:1.15rem; font-weight:900; color:#dc2626;">${formatPos(resumen.cargos_vivos || 0)}</div>
                </div>
                <div>
                    <span style="font-size:11px; text-transform:uppercase; color:var(--text-muted); font-weight:700;">Abonos / Pagos</span>
                    <div style="font-size:1.15rem; font-weight:900; color:#059669;">${formatPos(resumen.abonos_totales || 0)}</div>
                </div>
                <div>
                    <span style="font-size:11px; text-transform:uppercase; color:var(--text-muted); font-weight:700;">Control Integridad</span>
                    <div style="font-size:0.95rem; font-weight:800; color:${cuadreOk ? '#10b981' : '#f59e0b'};">
                        ${cuadreOk ? '✅ Cuadre de saldos 100% íntegro' : 'ℹ Diferencia histórica: ' + diffTxt}
                    </div>
                </div>
            `;
        }

        if (!filas.length) {
            cuerpo.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:28px; color:var(--text-muted);">No se encontraron eventos de auditoría para este filtro.</td></tr>';
            if (pie) pie.innerHTML = '<span>0 eventos</span>';
            return;
        }

        const TONO = {
            'Alta': 'background:rgba(4,120,87,0.18); color:#34d399;',
            'Cargo': 'background:rgba(185,28,28,0.18); color:#f87171;',
            'Abono': 'background:rgba(29,78,216,0.18); color:#60a5fa;',
            'Borrado': 'background:rgba(71,85,105,0.25); color:#94a3b8;',
            'Anulación': 'background:rgba(71,85,105,0.25); color:#94a3b8;',
            'Unido': 'background:rgba(180,83,9,0.2); color:#fbbf24;',
            'Límite': 'background:rgba(2,132,199,0.18); color:#38bdf8;',
            'Edición': 'background:rgba(2,132,199,0.18); color:#38bdf8;',
            'Suspendido': 'background:rgba(153,27,27,0.2); color:#fca5a5;',
        };

        cuerpo.innerHTML = filas.map(f => {
            const estiloBadge = TONO[f.accion] || 'background:rgba(255,255,255,0.1); color:#cbd5e1;';
            return `<tr>
                <td style="white-space:nowrap; font-size:12px; color:var(--text-muted);">${esc(f.fecha)}</td>
                <td><span style="display:inline-block; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:800; text-transform:uppercase; ${estiloBadge}">${esc(f.accion)}</span></td>
                <td style="font-weight:700;">${esc(f.cliente)}</td>
                <td style="font-size:12px; color:#3b82f6; font-weight:700;">${esc(f.referencia)}</td>
                <td style="font-size:12px;">${esc(f.medio)}</td>
                <td style="font-size:12px; color:var(--text-muted);">${esc(f.id_pago)}</td>
                <td style="font-size:12px;">${esc(f.usuario)}</td>
                <td style="font-size:12px; color:var(--text-muted);">${esc(f.pc)}${f.caja ? ' (caja ' + esc(f.caja) + ')' : ''}</td>
                <td style="font-size:12px; color:var(--text-muted); white-space:nowrap;">${esc(f.llegada)}</td>
                <td style="font-size:12px; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(f.detalle)}">${esc(f.detalle)}</td>
            </tr>`;
        }).join('');

        if (pie) {
            pie.innerHTML = `<span>${filas.length} eventos registrados</span>`;
        }
    }

    nodo('searchInput')?.addEventListener('input', () => filterClients());
    caja?.querySelector('.resumen')?.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button || !button.dataset.filter) return;
        setFilter(button.dataset.filter === currentFilter ? 'all' : button.dataset.filter);
    });
    nodo('cards')?.addEventListener('click', (event) => {
        const card = event.target.closest('.debt-card');
        if (!card) return;
        const marca = '#c=' + encodeURIComponent(card.dataset.id);
        pintarFicha(card.dataset.id);
        if (location.hash !== marca) location.hash = marca;
    });
    nodo('ficha')?.addEventListener('click', (event) => {
        const mov = event.target.closest('[data-mov]');
        if (mov) abrirMovimiento(Number(mov.dataset.mov));
    });
    nodo('sheetHost')?.addEventListener('click', (event) => {
        const ticket = event.target.closest('[data-ticket]');
        if (ticket) {
            verTicket(ticket.dataset.ticket);
            return;
        }
        if (event.target.closest('[data-guardar]')) guardarPerfilAbierto();
        else if (event.target.closest('[data-close]')) cerrarMovimiento();
    });
    nodo('btnPerfil')?.addEventListener('click', () => abrirPerfil());

    // Listeners para Cargos
    nodo('carteraCargos')?.querySelectorAll('[data-periodo-cargos]').forEach(btn => {
        btn.addEventListener('click', () => {
            nodo('carteraCargos').querySelectorAll('[data-periodo-cargos]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            periodoCargos = btn.dataset.periodoCargos || 'Mes';
            cargarCargos();
        });
    });
    nodo('filtroEstadoCargos')?.addEventListener('change', (ev) => {
        estadoCargos = ev.target.value;
        cargarCargos();
    });
    nodo('buscarCargos')?.addEventListener('input', (ev) => {
        clearTimeout(timerCargos);
        timerCargos = setTimeout(() => {
            textoCargos = ev.target.value.trim();
            cargarCargos();
        }, 220);
    });
    nodo('btnVolverCarteraCargos')?.addEventListener('click', () => cambiarPantalla('clientes'));

    // Listeners para Cobros
    nodo('carteraCobros')?.querySelectorAll('[data-periodo-cobros]').forEach(btn => {
        btn.addEventListener('click', () => {
            nodo('carteraCobros').querySelectorAll('[data-periodo-cobros]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            periodoCobros = btn.dataset.periodoCobros || 'Mes';
            cargarCobros();
        });
    });
    nodo('filtroMedioCobros')?.addEventListener('change', (ev) => {
        medioCobros = ev.target.value;
        cargarCobros();
    });
    nodo('buscarCobros')?.addEventListener('input', (ev) => {
        clearTimeout(timerCobros);
        timerCobros = setTimeout(() => {
            textoCobros = ev.target.value.trim();
            cargarCobros();
        }, 220);
    });
    nodo('btnVolverCarteraCobros')?.addEventListener('click', () => cambiarPantalla('clientes'));

    // Listeners para Auditoría
    nodo('carteraAuditoria')?.querySelectorAll('[data-accion-auditoria]').forEach(btn => {
        btn.addEventListener('click', () => {
            nodo('carteraAuditoria').querySelectorAll('[data-accion-auditoria]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            accionAuditoria = btn.dataset.accionAuditoria || 'todas';
            cargarAuditoria();
        });
    });
    nodo('buscarAuditoria')?.addEventListener('input', (ev) => {
        clearTimeout(timerAuditoria);
        timerAuditoria = setTimeout(() => {
            textoAuditoria = ev.target.value.trim();
            cargarAuditoria();
        }, 220);
    });
    nodo('btnVolverCarteraAuditoria')?.addEventListener('click', () => cambiarPantalla('clientes'));

    // Click en la tarjeta de COBROS del resumen superior
    nodo('goCobros')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        cambiarPantalla('cobros');
    });

    window.addEventListener('hashchange', () => {
        if (!vistaActiva()) return;
        const abierto = clienteDelHash();
        if (abierto) pintarFicha(abierto);
        else mostrarLista();
    });

    nodo('chipCarteraCargos')?.addEventListener('click', () => abrirFiltro());
    nodo('chipCarteraCobros')?.addEventListener('click', () => abrirFiltro());
    nodo('chipCarteraAuditoria')?.addEventListener('click', () => abrirFiltro());

    function abrirFiltro() {
        document.getElementById('ticketSheet')?.remove();
        document.getElementById('carteraSheet')?.remove();

        const fondo = document.createElement('div');
        fondo.id = 'carteraSheet';
        fondo.className = 'pedido-sheet-back';

        let contenidoHtml = '';

        if (pantallaActual === 'cargos') {
            const estados = [
                { id: 'todos', label: 'Estado: Todos' },
                { id: 'vivo', label: 'Solo Vivos' },
                { id: 'borrado', label: 'Borrados' },
                { id: 'cancelado', label: 'Cancelados' }
            ];
            const periodos = ['Mes', 'Hoy', 'Semana', 'Todas'];
            contenidoHtml = `
                <div class="pedido-sheet filtro-venta" role="dialog" aria-label="Filtro de cargos">
                    <div class="filtro-cabeza">
                        <strong class="pedido-sheet-titulo">Filtro</strong>
                        <button type="button" class="filtro-cerrar" data-cerrar aria-label="Cerrar">×</button>
                    </div>
                    <label>Buscar cliente, DNI, ticket o descripción
                        <input id="filtroCarteraQ" type="search" value="${esc(textoCargos)}" placeholder="1024, asado o cliente">
                    </label>
                    <div class="filtro-periodos" role="group" aria-label="Período">
                        ${periodos.map(p => `<button type="button" class="filtro-periodo${p === periodoCargos ? ' active' : ''}" data-periodo="${p}">${p}</button>`).join('')}
                    </div>
                    <label>Estado
                        <select id="filtroCarteraEstado">
                            ${estados.map(e => `<option value="${e.id}"${e.id === estadoCargos ? ' selected' : ''}>${e.label}</option>`).join('')}
                        </select>
                    </label>
                    <button type="button" class="pedido-cerrar" data-aplicar>Aplicar</button>
                </div>
            `;
        } else if (pantallaActual === 'cobros') {
            const medios = [
                { id: 'todos', label: 'Medio: Todos' },
                { id: 'efectivo', label: 'Efectivo' },
                { id: 'transferencia', label: 'Transferencia' },
                { id: 'tarjeta', label: 'Tarjeta' },
                { id: 'qr', label: 'QR' },
                { id: 'mixto', label: 'Mixto' }
            ];
            const periodos = ['Mes', 'Hoy', 'Semana', 'Todas'];
            contenidoHtml = `
                <div class="pedido-sheet filtro-venta" role="dialog" aria-label="Filtro de cobros">
                    <div class="filtro-cabeza">
                        <strong class="pedido-sheet-titulo">Filtro</strong>
                        <button type="button" class="filtro-cerrar" data-cerrar aria-label="Cerrar">×</button>
                    </div>
                    <label>Buscar cliente, DNI, COB- o id de pago
                        <input id="filtroCarteraQ" type="search" value="${esc(textoCobros)}" placeholder="COB-12, María o MP">
                    </label>
                    <div class="filtro-periodos" role="group" aria-label="Período">
                        ${periodos.map(p => `<button type="button" class="filtro-periodo${p === periodoCobros ? ' active' : ''}" data-periodo="${p}">${p}</button>`).join('')}
                    </div>
                    <label>Medio de pago
                        <select id="filtroCarteraMedio">
                            ${medios.map(m => `<option value="${m.id}"${m.id === medioCobros ? ' selected' : ''}>${m.label}</option>`).join('')}
                        </select>
                    </label>
                    <button type="button" class="pedido-cerrar" data-aplicar>Aplicar</button>
                </div>
            `;
        } else if (pantallaActual === 'auditoria') {
            const acciones = [
                { id: 'todas', label: 'Todas' },
                { id: 'cargos', label: 'Cargos' },
                { id: 'abonos', label: 'Abonos' },
                { id: 'borrados', label: 'Borrados' },
                { id: 'ficha', label: 'Ficha' }
            ];
            contenidoHtml = `
                <div class="pedido-sheet filtro-venta" role="dialog" aria-label="Filtro de auditoría">
                    <div class="filtro-cabeza">
                        <strong class="pedido-sheet-titulo">Filtro</strong>
                        <button type="button" class="filtro-cerrar" data-cerrar aria-label="Cerrar">×</button>
                    </div>
                    <label>Buscar cliente, COB-, PC, usuario o detalle
                        <input id="filtroCarteraQ" type="search" value="${esc(textoAuditoria)}" placeholder="Caja1, admin o cliente">
                    </label>
                    <div class="filtro-periodos" role="group" aria-label="Acción">
                        ${acciones.map(a => `<button type="button" class="filtro-periodo${a.id === accionAuditoria ? ' active' : ''}" data-accion="${a.id}">${a.label}</button>`).join('')}
                    </div>
                    <button type="button" class="pedido-cerrar" data-aplicar style="margin-top:16px;">Aplicar</button>
                </div>
            `;
        } else {
            const busqActual = (nodo('searchInput')?.value || '').trim();
            const filtros = [
                { id: 'all', label: 'Todos' },
                { id: 'saldo', label: 'Con saldo' },
                { id: 'aldia', label: 'Al día' },
                { id: 'reciente', label: 'Recientes' },
                { id: 'criticos', label: 'En riesgo' },
                { id: 'quietos', label: 'Sin mov.' }
            ];
            contenidoHtml = `
                <div class="pedido-sheet filtro-venta" role="dialog" aria-label="Filtro de clientes">
                    <div class="filtro-cabeza">
                        <strong class="pedido-sheet-titulo">Filtro</strong>
                        <button type="button" class="filtro-cerrar" data-cerrar aria-label="Cerrar">×</button>
                    </div>
                    <label>Buscar cliente por nombre o DNI
                        <input id="filtroCarteraQ" type="search" value="${esc(busqActual)}" placeholder="Ej: Perez o 34888999">
                    </label>
                    <label style="margin-top:14px;">Estado de cuenta</label>
                    <div class="filtro-periodos" role="group" aria-label="Filtro rápido" style="flex-wrap:wrap;">
                        ${filtros.map(f => `<button type="button" class="filtro-periodo${f.id === currentFilter ? ' active' : ''}" data-filtro-cliente="${f.id}" style="flex:1 1 30%;">${f.label}</button>`).join('')}
                    </div>
                    <button type="button" class="pedido-cerrar" data-aplicar style="margin-top:16px;">Aplicar</button>
                </div>
            `;
        }

        fondo.innerHTML = contenidoHtml;

        fondo.addEventListener('click', (ev) => {
            if (ev.target === fondo || ev.target.closest('[data-cerrar]')) {
                fondo.remove();
                return;
            }

            const btnP = ev.target.closest('[data-periodo]');
            if (btnP) {
                fondo.querySelectorAll('[data-periodo]').forEach(b => b.classList.toggle('active', b === btnP));
                return;
            }

            const btnA = ev.target.closest('[data-accion]');
            if (btnA) {
                fondo.querySelectorAll('[data-accion]').forEach(b => b.classList.toggle('active', b === btnA));
                return;
            }

            const btnC = ev.target.closest('[data-filtro-cliente]');
            if (btnC) {
                fondo.querySelectorAll('[data-filtro-cliente]').forEach(b => b.classList.toggle('active', b === btnC));
                return;
            }

            if (ev.target.closest('[data-aplicar]')) {
                const q = (fondo.querySelector('#filtroCarteraQ')?.value || '').trim();
                if (pantallaActual === 'cargos') {
                    textoCargos = q;
                    periodoCargos = fondo.querySelector('[data-periodo].active')?.dataset.periodo || 'Mes';
                    estadoCargos = fondo.querySelector('#filtroCarteraEstado')?.value || 'todos';
                    if (nodo('buscarCargos')) nodo('buscarCargos').value = q;
                    if (nodo('filtroEstadoCargos')) nodo('filtroEstadoCargos').value = estadoCargos;
                    nodo('carteraCargos')?.querySelectorAll('[data-periodo-cargos]').forEach(b => {
                        b.classList.toggle('active', b.dataset.periodoCargos === periodoCargos);
                    });
                    fondo.remove();
                    cargarCargos();
                } else if (pantallaActual === 'cobros') {
                    textoCobros = q;
                    periodoCobros = fondo.querySelector('[data-periodo].active')?.dataset.periodo || 'Mes';
                    medioCobros = fondo.querySelector('#filtroCarteraMedio')?.value || 'todos';
                    if (nodo('buscarCobros')) nodo('buscarCobros').value = q;
                    if (nodo('filtroMedioCobros')) nodo('filtroMedioCobros').value = medioCobros;
                    nodo('carteraCobros')?.querySelectorAll('[data-periodo-cobros]').forEach(b => {
                        b.classList.toggle('active', b.dataset.periodoCobros === periodoCobros);
                    });
                    fondo.remove();
                    cargarCobros();
                } else if (pantallaActual === 'auditoria') {
                    textoAuditoria = q;
                    accionAuditoria = fondo.querySelector('[data-accion].active')?.dataset.accion || 'todas';
                    if (nodo('buscarAuditoria')) nodo('buscarAuditoria').value = q;
                    nodo('carteraAuditoria')?.querySelectorAll('[data-accion-auditoria]').forEach(b => {
                        b.classList.toggle('active', b.dataset.accionAuditoria === accionAuditoria);
                    });
                    fondo.remove();
                    cargarAuditoria();
                } else {
                    const fActivo = fondo.querySelector('[data-filtro-cliente].active')?.dataset.filtroCliente || 'all';
                    const inputSearch = nodo('searchInput');
                    if (inputSearch) inputSearch.value = q;
                    fondo.remove();
                    setFilter(fActivo);
                }
                actualizarBotonFiltro();
            }
        });

        document.body.appendChild(fondo);
    }

    window.CarteraLibro = {
        pantallaActual() { return pantallaActual; },
        cambiarPantalla(id) { cambiarPantalla(id); },
        filtroActual() { return currentFilter; },
        filtrar(filtro) { setFilter(filtro || 'all'); },
        abrirFiltro() { abrirFiltro(); },
        filtroActivo() { return filtroActivo(); },
        actualizar() {
            try {
                fetch('/api/pos/sync/solicitar?sucursal_id=' + (sucursalId || '1'), { method: 'POST' }).catch(() => {});
            } catch (_) {}
            return loadClients();
        },
        recibir(dato) { if (dato) aplicarLibro(dato); },
        sucursal(id) {
            sucursalId = (id == null || id === '') ? '' : String(id);
            try {
                const previo = localStorage.getItem(claveCacheCartera());
                if (previo) aplicarLibro(JSON.parse(previo));
            } catch (_) {}
            if (pantallaActual === 'cargos') return cargarCargos();
            if (pantallaActual === 'cobros') return cargarCobros();
            if (pantallaActual === 'auditoria') return cargarAuditoria();
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
            if (pantallaActual !== 'clientes') {
                cambiarPantalla('clientes');
                return true;
            }
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
