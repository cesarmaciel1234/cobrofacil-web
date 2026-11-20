/* ==============================================================================
   COBRO FÁCIL - AUDITORÍA DE INVENTARIO CONTINUA (MÓVIL & ESCRITORIO)
   Paridad exacta con Desktop (src/cerebro_global/auditoria/motor_auditoria.py).
   Ajuste SET inmediato, escáner de cámara con efecto láser, teclado táctil.
   ============================================================================== */

(function (global) {
    'use strict';

    let catalogo = [];
    let departamentosTpv = [];
    let auditoriasHoy = [];
    let resumen = {
        total_sku: 0,
        auditados: 0,
        pendientes: 0,
        con_diferencia: 0,
        faltantes: 0,
        sobrantes: 0,
        quiebre: 0
    };
    let fuenteConexion = 'local';
    let pantallaActiva = 'repartofacil'; // 'repartofacil' (principal) | 'faltantes' | 'auditoria'
    let filtroEstado = 'todos'; // 'todos' | 'auditados' | 'pendientes' | 'diferencia' | 'quiebre'
    let filtroDepto = '';
    let textoBusqueda = '';

    // Estado del conteo activo
    let productoEnConteo = null;
    let bufferConteo = '0';

    // Estado de la cámara
    let videoStream = null;
    let barcodeDetector = null;
    let escaneando = false;
    let animFrameId = null;
    let trackLinterna = null;
    let linternaEncendida = false;
    let camarasDisponibles = [];
    let camaraIndice = 0;
    let modoFacingActual = 'environment';
    let zxingReader = null;
    let escaneoEnProgreso = false;
    let wakeLock = null;

    async function solicitarWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => { wakeLock = null; });
            } catch (_) {}
        }
    }

    function liberarWakeLock() {
        if (wakeLock) {
            wakeLock.release().catch(() => {});
            wakeLock = null;
        }
    }

    function $(id) {
        return document.getElementById(id);
    }

    function audioBeep(exito = true) {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            if (exito) {
                osc.type = 'sine';
                osc.frequency.setValueAtTime(1760, ctx.currentTime);
                gain.gain.setValueAtTime(0.28, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);
                osc.start();
                osc.stop(ctx.currentTime + 0.12);
            } else {
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(320, ctx.currentTime);
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.22);
                osc.start();
                osc.stop(ctx.currentTime + 0.22);
            }
        } catch (_) {}
    }

    function vibrar(patron = [50, 40, 50]) {
        if (navigator.vibrate) {
            try { navigator.vibrate(patron); } catch (_) {}
        }
    }

    function formatearNumero(val, decimales = 3) {
        const num = parseFloat(val) || 0;
        return num.toLocaleString('es-AR', {
            minimumFractionDigits: decimales,
            maximumFractionDigits: decimales
        });
    }

    function formatearPlata(val) {
        const num = parseFloat(val) || 0;
        return '$ ' + num.toLocaleString('es-AR', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    let callbackCodigoEscaneado = null;

    function iconoDepto(d) {
        const u = String(d || '').toUpperCase();
        if (u.includes('CARNE') || u.includes('VACUN')) return '🥩';
        if (u.includes('AVE') || u.includes('POLLO')) return '🍗';
        if (u.includes('CERDO')) return '🥓';
        if (u.includes('ACHURA')) return '🔥';
        if (u.includes('EMBUTID') || u.includes('FIAMBR')) return '🌭';
        if (u.includes('PREPARAD') || u.includes('MILANES')) return '🍲';
        if (u.includes('HUEVO')) return '🥚';
        if (u.includes('ALMACEN') || u.includes('CONDIMENT')) return '🛒';
        if (u.includes('VERDU')) return '🥬';
        if (u.includes('CONGELAD')) return '❄️';
        if (u.includes('GRASA')) return '🧈';
        if (u.includes('BEBIDA')) return '🥤';
        return '📦';
    }

    function obtenerDepartamentosLista() {
        const mapa = new Map();
        (departamentosTpv || []).forEach((d) => {
            const nom = String(d.nombre || d || '').trim().toUpperCase();
            if (nom) mapa.set(nom, 0);
        });
        (catalogo || []).forEach((p) => {
            const nom = String(p.departamento || p.categoria || 'GENERAL').trim().toUpperCase();
            mapa.set(nom, (mapa.get(nom) || 0) + 1);
        });
        return Array.from(mapa.entries())
            .map(([nombre, cantidad]) => ({ nombre, cantidad }))
            .sort((a, b) => (b.cantidad - a.cantidad) || a.nombre.localeCompare(b.nombre));
    }

    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // CARGA DE DATOS DESDE LA API
    // -------------------------------------------------------------------------
    function renderSkeletonAuditoria(wrap) {
        if (!wrap) return;
        wrap.innerHTML = `
            <div class="auditoria-mobile-container" style="padding: 48px 16px; text-align: center;">
                <div style="display:inline-block; width:38px; height:38px; border:3px solid #e2e8f0; border-top-color:#3b82f6; border-radius:50%; animation:auditoriaSpin 0.8s linear infinite; margin-bottom:14px;"></div>
                <p style="font-weight:700; color:#1e293b; margin:0 0 6px; font-size:16px;">Cargando inventario para auditar…</p>
                <span style="font-size:13px; color:#64748b;">Obteniendo stock y artículos de la sucursal</span>
            </div>
        `;
    }

    async function cargarCatalogoAuditoria(forzar = false) {
        const wrap = $('pedidosAuditoriaWrap');
        if (!wrap) return;

        try {
            const sid = global.activeSucursalId;
            const url = '/api/pos/inventario/auditoria' + (sid !== undefined && sid !== null ? ('?sucursal_id=' + encodeURIComponent(sid)) : '');
            const res = await fetch(url);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (data.ok) {
                catalogo = data.productos || [];
                departamentosTpv = data.departamentos || [];
                auditoriasHoy = data.auditorias_hoy || [];
                resumen = data.resumen || resumen;
                fuenteConexion = data.fuente || 'local';
                renderAuditoria();
            } else {
                throw new Error(data.error || 'Respuesta no exitosa');
            }
        } catch (err) {
            console.error('Error cargando catálogo de auditoría:', err);
            if (global.CrmBus) global.CrmBus.emit('toast', 'No se pudo cargar el inventario: ' + err.message, true);
            if (!catalogo || catalogo.length === 0) {
                wrap.innerHTML = `
                    <div class="auditoria-mobile-container" style="padding: 48px 16px; text-align: center;">
                        <div style="font-size:36px; margin-bottom:10px;">📦</div>
                        <p style="font-weight:700; color:#ef4444; margin:0 0 6px; font-size:16px;">No se pudo conectar al inventario</p>
                        <p style="font-size:13px; color:#64748b; margin-bottom:18px;">${err.message || 'Error de red o servidor no disponible'}</p>
                        <button type="button" class="btn btn-primary" id="btnReintentarAuditoria" style="padding:10px 24px; border-radius:10px; font-weight:700; cursor:pointer;">Reintentar</button>
                    </div>
                `;
                const btnRe = wrap.querySelector('#btnReintentarAuditoria');
                if (btnRe) {
                    btnRe.addEventListener('click', () => {
                        renderSkeletonAuditoria(wrap);
                        cargarCatalogoAuditoria(true);
                    });
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // CAMBIO DE PANTALLA (Faltantes vs Auditoría)
    // -------------------------------------------------------------------------
    function cambiarPantalla(id) {
        pantallaActiva = id || 'repartofacil';
        const faltantesWrap = $('pedidosFaltantesWrap');
        const auditoriaWrap = $('pedidosAuditoriaWrap');
        const repartofacilWrap = $('pedidosRepartoFacilWrap');

        if (pantallaActiva === 'repartofacil') {
            if (faltantesWrap) faltantesWrap.style.display = 'none';
            if (auditoriaWrap) auditoriaWrap.style.display = 'none';
            if (repartofacilWrap) {
                repartofacilWrap.style.display = 'block';
                if (global.RepartoFacilDespacho && global.RepartoFacilDespacho.iniciar) {
                    global.RepartoFacilDespacho.iniciar();
                }
            }
        } else if (pantallaActiva === 'auditoria') {
            if (repartofacilWrap) repartofacilWrap.style.display = 'none';
            if (faltantesWrap) faltantesWrap.style.display = 'none';
            if (auditoriaWrap) {
                auditoriaWrap.style.display = 'block';
                if (catalogo && catalogo.length > 0) {
                    renderAuditoria();
                } else {
                    renderSkeletonAuditoria(auditoriaWrap);
                }
                cargarCatalogoAuditoria();
            }
            actualizarIconoFiltroHeader();
        } else {
            if (repartofacilWrap) repartofacilWrap.style.display = 'none';
            if (auditoriaWrap) auditoriaWrap.style.display = 'none';
            if (faltantesWrap) faltantesWrap.style.display = 'block';
            const refresh = $('btnRefresh');
            if (refresh) refresh.classList.toggle('filtrando', !!global.filtroProveedorPedido);
        }

        if (global.ModuloPanel && global.ModuloPanel.pintar) {
            global.ModuloPanel.pintar();
        }
    }

    // -------------------------------------------------------------------------
    // FILTRO POR DEPARTAMENTO DEL TPV VÍA BOTÓN DEL HEADER (EMBUDO)
    // -------------------------------------------------------------------------
    function etiquetaFiltro() {
        if (filtroDepto) return `${iconoDepto(filtroDepto)} ${filtroDepto}`;
        if (filtroEstado === 'quiebre') return '⚡ Sin stock / Quiebre';
        return 'Todos';
    }

    function actualizarIconoFiltroHeader() {
        const refresh = $('btnRefresh');
        if (refresh && pantallaActiva === 'auditoria') {
            refresh.classList.toggle('filtrando', !!(filtroDepto || filtroEstado !== 'todos'));
        }
    }

    function abrirFiltroAuditoria() {
        const existente = $('auditoriaFiltroSheet');
        if (existente) existente.remove();

        const deptos = obtenerDepartamentosLista();
        const totalArt = catalogo.length;
        const quiebreCant = catalogo.filter((p) => (p.stock || 0) <= 0.0001).length;

        const sheet = document.createElement('div');
        sheet.id = 'auditoriaFiltroSheet';
        sheet.className = 'pedido-sheet-back';
        sheet.innerHTML = `
            <div class="pedido-sheet" role="dialog" aria-label="Departamentos de Inventario" style="max-height:84vh; display:flex; flex-direction:column;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                    <strong class="pedido-sheet-titulo" style="margin:0; font-size:17px; font-weight:800;">Departamentos · Inventario</strong>
                    <span style="font-size:12px; font-weight:700; color:#64748b; background:#f1f5f9; padding:3px 8px; border-radius:6px;">${totalArt} artículos</span>
                </div>
                <div style="display:flex; flex-direction:column; gap:6px; overflow-y:auto; padding-right:2px;">
                    <button type="button" class="pedido-opcion ${!filtroDepto && filtroEstado === 'todos' ? 'active' : ''}" data-select-depto="" data-select-estado="todos" style="display:flex; justify-content:space-between; align-items:center; padding:11px 14px; text-align:left;">
                        <span style="font-weight:800; font-size:14px; color:inherit; display:flex; align-items:center; gap:8px;">
                            <span>📋</span>
                            <span>Todos los departamentos</span>
                        </span>
                        <b style="font-size:13px; font-weight:800;">${totalArt}</b>
                    </button>

                    ${deptos.map((d) => `
                        <button type="button" class="pedido-opcion ${filtroDepto === d.nombre ? 'active' : ''}" data-select-depto="${escHtml(d.nombre)}" data-select-estado="todos" style="display:flex; justify-content:space-between; align-items:center; padding:11px 14px; text-align:left;">
                            <span style="font-weight:700; font-size:14px; color:inherit; display:flex; align-items:center; gap:8px;">
                                <span>${iconoDepto(d.nombre)}</span>
                                <span>${escHtml(d.nombre)}</span>
                            </span>
                            <b style="font-size:13px; font-weight:800; color:#2563eb;">${d.cantidad}</b>
                        </button>
                    `).join('')}

                    <button type="button" class="pedido-opcion ${!filtroDepto && filtroEstado === 'quiebre' ? 'active' : ''}" data-select-depto="" data-select-estado="quiebre" style="display:flex; justify-content:space-between; align-items:center; padding:11px 14px; text-align:left; border-top:1px dashed #e2e8f0; margin-top:4px;">
                        <span style="font-weight:700; font-size:13.5px; color:#b91c1c; display:flex; align-items:center; gap:8px;">
                            <span>⚡</span>
                            <span>Sin stock / Quiebre (0 o negativo)</span>
                        </span>
                        <b style="font-size:13px; font-weight:800; color:#dc2626;">${quiebreCant}</b>
                    </button>
                </div>
                <div style="display:flex; gap:10px; margin-top:12px; padding-top:10px; border-top:1px solid #f1f5f9;">
                    <button type="button" id="btnSheetNuevoArt" style="flex:1.2; padding:10px; border:1px solid #bfdbfe; border-radius:10px; background:#eff6ff; font-size:12.5px; font-weight:800; color:#1d4ed8; cursor:pointer;">+ Nuevo Artículo</button>
                    <button type="button" id="btnSheetHistorial" style="flex:1; padding:10px; border:1px solid #e2e8f0; border-radius:10px; background:#f8fafc; font-size:12.5px; font-weight:700; color:#334155; cursor:pointer;">📋 Historial</button>
                    <button type="button" id="btnSheetExportar" style="flex:1; padding:10px; border:1px solid #e2e8f0; border-radius:10px; background:#f8fafc; font-size:12.5px; font-weight:700; color:#334155; cursor:pointer;">📥 Excel</button>
                </div>
                <button type="button" class="pedido-cerrar" data-cerrar style="margin-top:10px;">Listo</button>
            </div>
        `;

        sheet.addEventListener('click', (ev) => {
            const btnOpt = ev.target.closest('[data-select-depto]');
            if (btnOpt) {
                filtroDepto = btnOpt.dataset.selectDepto || '';
                filtroEstado = btnOpt.dataset.selectEstado || 'todos';
                sheet.remove();
                actualizarIconoFiltroHeader();
                renderAuditoria();
                return;
            }
            if (ev.target.closest('#btnSheetNuevoArt')) {
                sheet.remove();
                abrirModalCrearProducto(textoBusqueda.trim());
                return;
            }
            if (ev.target.closest('#btnSheetHistorial')) {
                sheet.remove();
                abrirModalHistorial();
                return;
            }
            if (ev.target.closest('#btnSheetExportar')) {
                sheet.remove();
                exportarPlanillaCSV();
                return;
            }
            if (ev.target === sheet || ev.target.closest('[data-cerrar]')) {
                sheet.remove();
            }
        });

        document.body.appendChild(sheet);
    }

    // -------------------------------------------------------------------------
    // RENDERIZADO PRINCIPAL DE LA VISTA
    // -------------------------------------------------------------------------
    function renderAuditoria() {
        const wrap = $('pedidosAuditoriaWrap');
        if (!wrap) return;

        // Filtrar productos
        const texto = textoBusqueda.trim().toLowerCase();
        const filtrados = catalogo.filter((p) => {
            // Filtro de estado
            if (filtroEstado === 'auditados' && !p.auditado_hoy) return false;
            if (filtroEstado === 'pendientes' && p.auditado_hoy) return false;
            if (filtroEstado === 'diferencia' && (!p.auditado_hoy || Math.abs(p.diferencia || 0) < 0.001)) return false;
            if (filtroEstado === 'quiebre' && p.stock > 0.0001) return false;

            // Filtro de depto
            if (filtroDepto && String(p.departamento || '').toUpperCase() !== filtroDepto.toUpperCase()) return false;

            // Filtro de texto
            if (texto) {
                const matchNombre = (p.nombre || '').toLowerCase().includes(texto);
                const matchCodigo = String(p.codigo || '').toLowerCase().includes(texto);
                const matchId = String(p.id || '').includes(texto);
                const matchDepto = (p.departamento || '').toLowerCase().includes(texto);
                if (!matchNombre && !matchCodigo && !matchId && !matchDepto) return false;
            }
            return true;
        });

        const deptosBarra = obtenerDepartamentosLista();

        const filas = filtrados.length
            ? filtrados.map((p) => {
                const esPesable = p.es_pesable || p.unidad === 'KG';
                const unidadTxt = esPesable ? 'kg' : 'un';
                const decimales = esPesable ? 3 : 0;
                const stockVal = p.auditado_hoy && p.ultimo_conteo !== null ? p.ultimo_conteo : p.stock;
                const stockFmt = formatearNumero(stockVal, decimales);
                const precioFmt = formatearPlata(p.precio || 0);
                const deptoNom = (p.departamento || 'GENERAL').toUpperCase();
                const stockColor = stockVal <= 0 ? '#ef4444' : '#0f172a';

                const subHtml = `
                    <span class="pedido-meta" style="display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-top:2px;">
                        <span style="background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; font-size:11.5px; font-weight:900; padding:1px 7px; border-radius:6px;">
                            ${precioFmt} / ${unidadTxt}
                        </span>
                        <span style="font-size:12px; color:#475569;">
                            Stock: <b class="pedido-stock" style="color:${stockColor};">${stockFmt} ${unidadTxt}</b>
                        </span>
                        ${p.codigo ? `<span style="font-size:10.5px; color:#94a3b8; font-family:monospace;">#${escHtml(p.codigo)}</span>` : ''}
                    </span>
                `;

                const btnHtml = `<button type="button" class="pedido-mas" data-contar="${p.id}" title="Cargar stock o editar precio" aria-label="Editar inventario">+</button>`;

                return `<div class="pedido-fila" data-pid="${p.id}">
                    <button type="button" class="pedido-cuerpo" data-contar="${p.id}">
                        <span class="pedido-nombre" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                            <span>${escHtml(p.nombre)}</span>
                            <span style="background:#f1f5f9; color:#475569; border:1px solid #e2e8f0; font-size:9.5px; font-weight:800; padding:1px 6px; border-radius:999px; text-transform:uppercase;">
                                ${iconoDepto(deptoNom)} ${escHtml(deptoNom)}
                            </span>
                        </span>
                        ${subHtml}
                    </button>
                    ${btnHtml}
                </div>`;
            }).join('')
            : (texto
                ? `<div class="pedido-vacio" style="padding:22px 16px; text-align:center;">
                        <div style="color:#64748b; font-size:13.5px; margin-bottom:12px;">No hay <b style="color:#0f172a;">“${escHtml(textoBusqueda.trim())}”</b> en el inventario.</div>
                        <button type="button" id="btnCrearDesdeVacio" style="background:#2563eb; color:#fff; border:none; border-radius:12px; font-size:14px; font-weight:800; padding:11px 18px; cursor:pointer; box-shadow:0 4px 12px rgba(37,99,235,0.3);">
                            + Crear artículo
                        </button>
                   </div>`
                : `<p class="pedido-vacio" style="padding: 24px; text-align: center; color: #94a3b8;">No hay artículos en este departamento.</p>`);

        const sinResultados = !!texto && filtrados.length === 0;
        const inputPrevio = $('auditoriaSearchInput');
        const teniaFoco = document.activeElement === inputPrevio;
        const cursorPos = teniaFoco && inputPrevio ? inputPrevio.selectionStart : null;

        wrap.innerHTML = `
            <div class="auditoria-mobile-container" style="padding: 10px 12px 60px;">
                <!-- Buscador Móvil en Blanco con Ícono de Cámara para Escanear -->
                <div class="auditoria-search-wrap" style="margin-bottom: 8px;">
                    <div class="auditoria-input-box">
                        <input type="search" id="auditoriaSearchInput" class="auditoria-search-input" 
                               placeholder="Buscar artículo, código o escanear..." 
                               value="${escHtml(textoBusqueda)}" autocomplete="off" autocapitalize="off">
                        ${sinResultados
                            ? '<button type="button" id="btnAuditoriaCrear" class="btn-clear-search" title="Crear artículo" aria-label="Crear artículo" style="color:#fff; background:#2563eb; border-radius:999px; width:28px; height:28px; font-size:20px; font-weight:800; line-height:28px; padding:0;">+</button>'
                            : (textoBusqueda ? '<button type="button" id="btnAuditoriaLimpiar" class="btn-clear-search">✕</button>' : '')}
                    </div>
                    <button type="button" id="btnAuditoriaEscaner" class="btn-cam-scanner" aria-label="Escanear código con cámara">
                        <svg class="cam-ico" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                            <circle cx="12" cy="13" r="4"></circle>
                        </svg>
                        <span class="cam-btn-text">Escanear</span>
                    </button>
                </div>

                <!-- Barra de Departamentos del TPV -->
                <div style="display:flex; align-items:center; gap:6px; overflow-x:auto; padding-bottom:8px; margin-bottom:8px; scrollbar-width:none;">
                    <button type="button" class="depto-chip" data-depto="" style="flex-shrink:0; padding:6px 12px; border-radius:999px; font-size:11.5px; font-weight:800; cursor:pointer; border:1px solid ${!filtroDepto && filtroEstado === 'todos' ? '#2563eb' : '#cbd5e1'}; background:${!filtroDepto && filtroEstado === 'todos' ? '#2563eb' : '#fff'}; color:${!filtroDepto && filtroEstado === 'todos' ? '#fff' : '#334155'};">
                        🔥 Todos (${catalogo.length})
                    </button>
                    ${deptosBarra.map((d) => {
                        const act = filtroDepto === d.nombre;
                        return `<button type="button" class="depto-chip" data-depto="${escHtml(d.nombre)}" style="flex-shrink:0; padding:6px 12px; border-radius:999px; font-size:11.5px; font-weight:800; cursor:pointer; border:1px solid ${act ? '#2563eb' : '#cbd5e1'}; background:${act ? '#2563eb' : '#fff'}; color:${act ? '#fff' : '#334155'};">
                            ${iconoDepto(d.nombre)} ${escHtml(d.nombre)} (${d.cantidad})
                        </button>`;
                    }).join('')}
                </div>

                ${(filtroDepto || filtroEstado !== 'todos') ? `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding:0 2px;">
                    <span style="font-size:12.5px; font-weight:700; color:#2563eb; background:#eff6ff; padding:3px 10px; border-radius:999px; border:1px solid #bfdbfe; display:inline-flex; align-items:center; gap:6px;">
                        <span>Departamento: ${etiquetaFiltro()} (${filtrados.length})</span>
                        <button type="button" id="btnQuitarFiltroAuditoria" style="background:none; border:none; color:#2563eb; font-size:13px; font-weight:800; cursor:pointer; padding:0 2px; line-height:1;" aria-label="Quitar filtro">✕</button>
                    </span>
                    <button type="button" id="btnAbrirFiltroDesdeBarra" style="background:none; border:none; color:#64748b; font-size:12px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:4px;">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 5h16l-6 7v6l-4 2v-8L4 5z"/></svg>
                        Departamentos
                    </button>
                </div>` : ''}

                <!-- Lista Simple e Idéntica a Pedidos (pedido-lista y pedido-fila) -->
                <div class="pedido-lista">
                    ${filas}
                </div>
            </div>
        `;

        actualizarIconoFiltroHeader();

        // Event Listeners
        vincularEventosAuditoria();

        if (teniaFoco) {
            const nuevoInput = $('auditoriaSearchInput');
            if (nuevoInput) {
                nuevoInput.focus();
                if (cursorPos !== null) {
                    try { nuevoInput.setSelectionRange(cursorPos, cursorPos); } catch (_) {}
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // EVENTOS DE LA PANTALLA DE AUDITORÍA
    // -------------------------------------------------------------------------
    function vincularEventosAuditoria() {
        // Buscador
        const inputBuscar = $('auditoriaSearchInput');
        if (inputBuscar) {
            inputBuscar.addEventListener('input', (e) => {
                textoBusqueda = e.target.value;
                renderAuditoria();
            });

            // Enter directo abre el primer resultado o el alta si no existe
            inputBuscar.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const code = (inputBuscar.value || '').trim();
                    if (!code) return;
                    const encontrado = buscarPorCodigoONombre(code);
                    if (encontrado) {
                        abrirDrawerConteo(encontrado);
                    } else {
                        abrirModalCrearProducto(code);
                    }
                }
            });
        }

        const btnCrear = $('btnAuditoriaCrear');
        if (btnCrear) {
            btnCrear.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                abrirModalCrearProducto(textoBusqueda.trim());
            });
        }

        const btnCrearVacio = $('btnCrearDesdeVacio');
        if (btnCrearVacio) {
            btnCrearVacio.addEventListener('click', (e) => {
                e.preventDefault();
                abrirModalCrearProducto(textoBusqueda.trim());
            });
        }

        const btnLimpiar = $('btnAuditoriaLimpiar');
        if (btnLimpiar) {
            btnLimpiar.addEventListener('click', () => {
                textoBusqueda = '';
                renderAuditoria();
                if ($('auditoriaSearchInput')) $('auditoriaSearchInput').focus();
            });
        }

        // Botón de Cámara Escáner
        const btnEscaner = $('btnAuditoriaEscaner');
        if (btnEscaner) {
            btnEscaner.addEventListener('click', (e) => {
                e.preventDefault();
                abrirEscanerCamara();
            });
        }

        // Filtro rápido activo en barra
        const btnQuitar = $('btnQuitarFiltroAuditoria');
        if (btnQuitar) {
            btnQuitar.addEventListener('click', (e) => {
                e.stopPropagation();
                filtroDepto = '';
                filtroEstado = 'todos';
                actualizarIconoFiltroHeader();
                renderAuditoria();
            });
        }

        // Chips de departamento
        document.querySelectorAll('.depto-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                filtroDepto = btn.dataset.depto || '';
                filtroEstado = 'todos';
                actualizarIconoFiltroHeader();
                renderAuditoria();
            });
        });

        const btnAbrirBarra = $('btnAbrirFiltroDesdeBarra');
        if (btnAbrirBarra) {
            btnAbrirBarra.addEventListener('click', (e) => {
                e.stopPropagation();
                abrirFiltroAuditoria();
            });
        }

        // KPIs clicables
        document.querySelectorAll('.audit-kpi-card').forEach((card) => {
            card.addEventListener('click', () => {
                filtroEstado = card.dataset.filtro || 'todos';
                renderAuditoria();
            });
        });

        // Chips de estado
        document.querySelectorAll('.chip-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                filtroEstado = btn.dataset.f || 'todos';
                renderAuditoria();
            });
        });

        // Chips de departamento
        document.querySelectorAll('.depto-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                filtroDepto = btn.dataset.depto || '';
                renderAuditoria();
            });
        });

        // Botones de Contar en cada fila
        document.querySelectorAll('[data-contar]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const pid = parseInt(btn.dataset.contar, 10);
                const prod = catalogo.find((p) => p.id === pid);
                if (prod) abrirDrawerConteo(prod);
            });
        });

        // Clic en la fila completa también abre conteo
        document.querySelectorAll('.pedido-fila').forEach((fila) => {
            fila.addEventListener('click', () => {
                const pid = parseInt(fila.dataset.pid, 10);
                const prod = catalogo.find((p) => p.id === pid);
                if (prod) abrirDrawerConteo(prod);
            });
        });

        // Restablecer filtros
        const btnReset = $('btnRestablecerFiltros');
        if (btnReset) {
            btnReset.addEventListener('click', () => {
                filtroEstado = 'todos';
                filtroDepto = '';
                textoBusqueda = '';
                renderAuditoria();
            });
        }

        // Historial
        const btnHistorial = $('btnHistorialAuditoria');
        if (btnHistorial) {
            btnHistorial.addEventListener('click', () => abrirModalHistorial());
        }

        // Exportar CSV
        const btnExportar = $('btnExportarAuditoria');
        if (btnExportar) {
            btnExportar.addEventListener('click', () => exportarPlanillaCSV());
        }
    }

    // -------------------------------------------------------------------------
    // BÚSQUEDA INTELIGENTE POR CÓDIGO, BARCODE O NOMBRE
    // -------------------------------------------------------------------------
    function buscarPorCodigoONombre(query) {
        if (!query) return null;
        const q = String(query).trim().toLowerCase();

        // 1. Coincidencia exacta de código
        let prod = catalogo.find((p) => String(p.codigo || '').trim().toLowerCase() === q);
        if (prod) return prod;

        // 2. Coincidencia exacta de ID
        prod = catalogo.find((p) => String(p.id) === q);
        if (prod) return prod;

        // 3. Comparación numérica (para barcodes con ceros a la izquierda ej. 00010 vs 10)
        const qNum = parseInt(q, 10);
        if (!isNaN(qNum) && qNum > 0) {
            prod = catalogo.find((p) => {
                const codNum = parseInt(p.codigo, 10);
                return (!isNaN(codNum) && codNum === qNum) || p.id === qNum;
            });
            if (prod) return prod;
        }

        // 4. Códigos de balanza EAN-13 (prefijo 2, código en dígitos 2 a 6)
        if (q.length === 13 && q.startsWith('2')) {
            const codBalanza = q.substring(2, 7);
            const numBalanza = parseInt(codBalanza, 10);
            prod = catalogo.find((p) => {
                const c = String(p.codigo || '').trim();
                return c === codBalanza || (parseInt(c, 10) === numBalanza) || p.id === numBalanza;
            });
            if (prod) return prod;
        }

        // 5. Coincidencia exacta de nombre
        prod = catalogo.find((p) => (p.nombre || '').toLowerCase() === q);
        if (prod) return prod;

        // 6. Nombre que empiece con la búsqueda
        prod = catalogo.find((p) => (p.nombre || '').toLowerCase().startsWith(q));
        if (prod) return prod;

        // 7. Nombre que contenga la búsqueda
        return catalogo.find((p) => (p.nombre || '').toLowerCase().includes(q)) || null;
    }

    // -------------------------------------------------------------------------
    // ESCÁNER DE CÁMARA BIDIRECCIONAL CON DECODIFICACIÓN ESPEJO (FRONTAL & TRASERA)
    // -------------------------------------------------------------------------
    function decodificarCanvasZXing(canvas) {
        if (!window.ZXing) return null;
        try {
            if (!zxingReader) {
                const hints = new Map();
                const formats = [
                    window.ZXing.BarcodeFormat.EAN_13,
                    window.ZXing.BarcodeFormat.EAN_8,
                    window.ZXing.BarcodeFormat.CODE_128,
                    window.ZXing.BarcodeFormat.CODE_39,
                    window.ZXing.BarcodeFormat.UPC_A,
                    window.ZXing.BarcodeFormat.UPC_E,
                    window.ZXing.BarcodeFormat.ITF,
                    window.ZXing.BarcodeFormat.QR_CODE
                ];
                hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
                hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);
                zxingReader = new window.ZXing.MultiFormatReader();
                zxingReader.setHints(hints);
            }
            const lum = new window.ZXing.HTMLCanvasElementLuminanceSource(canvas);
            const bitmap = new window.ZXing.BinaryBitmap(new window.ZXing.HybridBinarizer(lum));
            const res = zxingReader.decode(bitmap);
            return res ? res.getText() : null;
        } catch (_) {
            return null;
        }
    }

    async function decodificarFrame(video, canvas, ctx) {
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 480;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }

        // --- PASE 1: ORIENTACIÓN NORMAL ---
        if (barcodeDetector) {
            try {
                const barcodes = await barcodeDetector.detect(video);
                if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                    return barcodes[0].rawValue;
                }
            } catch (_) {}
        }

        // Renderizar frame normal en canvas para ZXing / BarcodeDetector canvas
        ctx.save();
        ctx.drawImage(video, 0, 0, w, h);
        ctx.restore();

        if (barcodeDetector) {
            try {
                const barcodes = await barcodeDetector.detect(canvas);
                if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                    return barcodes[0].rawValue;
                }
            } catch (_) {}
        }

        if (window.ZXing) {
            const zxCode = decodificarCanvasZXing(canvas);
            if (zxCode) return zxCode;
        }

        // --- PASE 2: ORIENTACIÓN ESPEJO / HORIZONTALMENTE INVERTIDA ---
        // Crucial para cámaras frontales que entregan el video espejado o al revés
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, w, h);
        ctx.restore();

        if (barcodeDetector) {
            try {
                const barcodesEspejo = await barcodeDetector.detect(canvas);
                if (barcodesEspejo && barcodesEspejo.length > 0 && barcodesEspejo[0].rawValue) {
                    return barcodesEspejo[0].rawValue;
                }
            } catch (_) {}
        }

        if (window.ZXing) {
            const zxCodeEspejo = decodificarCanvasZXing(canvas);
            if (zxCodeEspejo) return zxCodeEspejo;
        }

        return null;
    }

    function actualizarEstadoCamara() {
        if (!videoStream) return;
        const track = videoStream.getVideoTracks()[0];
        if (!track) return;

        const settings = track.getSettings ? track.getSettings() : {};
        const label = (track.label || '').toLowerCase();
        const isFront = settings.facingMode === 'user' ||
                        label.includes('front') ||
                        label.includes('delantera') ||
                        label.includes('selfie') ||
                        label.includes('user') ||
                        modoFacingActual === 'user';

        const video = $('videoEscaner');
        const badge = $('badgeModoCamara');
        const prompt = $('scannerPrompt');

        if (isFront) {
            if (video) video.style.transform = 'scaleX(-1)';
            if (badge) {
                badge.textContent = '📷 Frontal (Auto-espejo ON)';
                badge.className = 'escaner-badge badge-frontal';
            }
            if (prompt) prompt.textContent = '📷 Cámara Frontal activa · Lectura espejo dual habilitada';
        } else {
            if (video) video.style.transform = 'none';
            if (badge) {
                badge.textContent = '📷 Trasera';
                badge.className = 'escaner-badge badge-trasera';
            }
            if (prompt) prompt.textContent = '📷 Apuntá el código de barras o QR dentro del recuadro';
        }

        // Soporte de linterna si existe
        const capabilities = track.getCapabilities ? track.getCapabilities() : {};
        const btnLinterna = $('btnToggleLinterna');
        if (btnLinterna) {
            btnLinterna.style.display = capabilities.torch ? 'inline-block' : 'none';
            btnLinterna.textContent = linternaEncendida ? '🔦' : '💡';
        }
    }

    async function autoEncenderLinterna() {
        if (!trackLinterna) return;
        const capabilities = trackLinterna.getCapabilities ? trackLinterna.getCapabilities() : {};
        if (capabilities.torch) {
            try {
                await trackLinterna.applyConstraints({
                    advanced: [{ torch: true }]
                });
                linternaEncendida = true;
            } catch (err) {
                console.warn('No se pudo encender flash automáticamente:', err);
                linternaEncendida = false;
            }
        } else {
            linternaEncendida = false;
        }
        const btnLinterna = $('btnToggleLinterna');
        if (btnLinterna) {
            btnLinterna.style.display = capabilities.torch ? 'inline-block' : 'none';
            btnLinterna.textContent = linternaEncendida ? '🔦' : '💡';
        }
    }

    async function abrirEscanerCamara() {
        solicitarWakeLock();
        const modal = $('modalEscanerCamara');
        const video = $('videoEscaner');
        const prompt = $('scannerPrompt');
        if (!modal || !video) return;

        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        escaneando = true;

        if (prompt) prompt.textContent = 'Iniciando escáner de alta precisión...';

        // Inicializar BarcodeDetector si está disponible nativamente
        if ('BarcodeDetector' in window) {
            try {
                barcodeDetector = new window.BarcodeDetector({
                    formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'upc_a', 'upc_e', 'itf']
                });
            } catch (e) {
                barcodeDetector = null;
            }
        }

        // Obtener cámaras y arrancar stream
        try {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                camarasDisponibles = devices.filter((d) => d.kind === 'videoinput');
            } catch (_) {
                camarasDisponibles = [];
            }

            const btnCamara = $('btnCambiarCamara');
            if (btnCamara) btnCamara.style.display = 'inline-block';

            // Intentar primero con la cámara preferida actual
            const constraints = {
                video: {
                    facingMode: modoFacingActual ? { ideal: modoFacingActual } : { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            };

            videoStream = await navigator.mediaDevices.getUserMedia(constraints);
            video.srcObject = videoStream;
            await video.play();

            trackLinterna = videoStream.getVideoTracks()[0];
            actualizarEstadoCamara();
            await autoEncenderLinterna();

            // Iniciar bucle de escaneo continuo
            bucleEscaneo();
        } catch (err) {
            console.error('Error accediendo a la cámara:', err);
            // Reintento genérico sin restricciones
            try {
                videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                video.srcObject = videoStream;
                await video.play();
                trackLinterna = videoStream.getVideoTracks()[0];
                actualizarEstadoCamara();
                await autoEncenderLinterna();
                bucleEscaneo();
            } catch (err2) {
                console.error('Fallo definitivo acceso cámara:', err2);
                if (prompt) prompt.textContent = 'No se pudo acceder a la cámara. Verificá los permisos del navegador.';
                audioBeep(false);
                if (global.CrmBus) global.CrmBus.emit('toast', 'Permiso de cámara denegado o no disponible.', true);
            }
        }
    }

    function cerrarEscanerCamara() {
        liberarWakeLock();
        escaneando = false;
        linternaEncendida = false;
        if (animFrameId) cancelAnimationFrame(animFrameId);
        animFrameId = null;

        if (videoStream) {
            videoStream.getTracks().forEach((t) => t.stop());
            videoStream = null;
        }
        trackLinterna = null;

        const modal = $('modalEscanerCamara');
        if (modal) {
            modal.style.display = 'none';
            modal.setAttribute('aria-hidden', 'true');
        }

        const target = $('scannerTarget');
        if (target) target.classList.remove('scanned');
    }

    async function toggleLinterna() {
        if (!trackLinterna) return;
        try {
            linternaEncendida = !linternaEncendida;
            await trackLinterna.applyConstraints({
                advanced: [{ torch: linternaEncendida }]
            });
            const btn = $('btnToggleLinterna');
            if (btn) btn.textContent = linternaEncendida ? '🔦' : '💡';
        } catch (err) {
            console.warn('No se pudo activar linterna:', err);
        }
    }

    async function cambiarCamara() {
        modoFacingActual = (modoFacingActual === 'environment') ? 'user' : 'environment';

        if (videoStream) {
            videoStream.getTracks().forEach((t) => t.stop());
            videoStream = null;
        }

        const video = $('videoEscaner');
        if (!video) return;

        try {
            if (camarasDisponibles.length > 1) {
                camaraIndice = (camaraIndice + 1) % camarasDisponibles.length;
                const dev = camarasDisponibles[camaraIndice];
                videoStream = await navigator.mediaDevices.getUserMedia({
                    video: { deviceId: { exact: dev.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
                    audio: false
                });
            } else {
                videoStream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: modoFacingActual }, width: { ideal: 1280 }, height: { ideal: 720 } },
                    audio: false
                });
            }
            video.srcObject = videoStream;
            await video.play();
            trackLinterna = videoStream.getVideoTracks()[0];
            actualizarEstadoCamara();
            await autoEncenderLinterna();
        } catch (err) {
            console.warn('Error cambiando lente de cámara, usando fallback:', err);
            try {
                videoStream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: modoFacingActual },
                    audio: false
                });
                video.srcObject = videoStream;
                await video.play();
                trackLinterna = videoStream.getVideoTracks()[0];
                actualizarEstadoCamara();
                await autoEncenderLinterna();
            } catch (err2) {
                console.error('Fallo cambiar cámara:', err2);
            }
        }
    }

    async function bucleEscaneo() {
        if (!escaneando) return;
        const video = $('videoEscaner');
        const canvas = $('canvasEscaner');

        if (video && video.readyState >= video.HAVE_CURRENT_DATA && canvas && !escaneoEnProgreso) {
            escaneoEnProgreso = true;
            try {
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                const codigoDetectado = await decodificarFrame(video, canvas, ctx);
                if (codigoDetectado) {
                    onCodigoDetectado(codigoDetectado);
                    escaneoEnProgreso = false;
                    return;
                }
            } catch (err) {
                console.warn('Error decodificando frame:', err);
            } finally {
                escaneoEnProgreso = false;
            }
        }

        if (escaneando) {
            animFrameId = requestAnimationFrame(bucleEscaneo);
        }
    }

    function onCodigoDetectado(codigo) {
        if (!codigo) return;
        audioBeep(true);
        vibrar([60, 40, 80]);

        const target = $('scannerTarget');
        if (target) target.classList.add('scanned');

        const prompt = $('scannerPrompt');
        if (prompt) prompt.textContent = '✓ Código detectado: ' + codigo;

        setTimeout(() => {
            cerrarEscanerCamara();
            if (typeof callbackCodigoEscaneado === 'function') {
                const cb = callbackCodigoEscaneado;
                callbackCodigoEscaneado = null;
                cb(String(codigo).trim());
                return;
            }
            const prod = buscarPorCodigoONombre(codigo);
            if (prod) {
                abrirDrawerConteo(prod);
            } else {
                audioBeep(false);
                vibrar([150, 80, 150]);
                textoBusqueda = codigo;
                renderAuditoria();
                abrirModalCrearProducto(codigo);
            }
        }, 350);
    }

    // -------------------------------------------------------------------------
    // ALTA RÁPIDA DE ARTÍCULO CON NOMBRE + CÓDIGO DE BARRAS FUNCIONAL
    // -------------------------------------------------------------------------
    function abrirModalCrearProducto(semilla = '') {
        $('modalCrearProductoInv')?.remove();
        const texto = String(semilla || '').trim();
        const esCodigoNumerico = /^\d{4,}$/.test(texto);
        const nombreInicial = esCodigoNumerico ? '' : texto;
        const codigoInicial = esCodigoNumerico ? texto : '';
        const deptosOpciones = obtenerDepartamentosLista();
        const deptoDefault = filtroDepto || (deptosOpciones[0]?.nombre) || 'GENERAL';

        const fondo = document.createElement('div');
        fondo.id = 'modalCrearProductoInv';
        fondo.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,0.6); z-index:9500; display:flex; align-items:flex-end; justify-content:center; padding:0;';
        fondo.innerHTML = `
            <div style="background:#fff; width:100%; max-width:460px; border-radius:22px 22px 0 0; padding:20px 18px 26px; box-shadow:0 -10px 30px rgba(15,23,42,0.2); animation:slideUpSheet 0.2s ease-out;">
                <div style="width:38px; height:4px; background:#cbd5e1; border-radius:99px; margin:0 auto 12px;"></div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                    <h3 style="margin:0; font-size:17px; font-weight:800; color:#0f172a;">+ Nuevo artículo en Inventario</h3>
                    <button type="button" id="btnCerrarCrearProd" style="background:#f1f5f9; border:none; width:30px; height:30px; border-radius:99px; font-size:15px; font-weight:800; color:#475569; cursor:pointer;">✕</button>
                </div>

                <form id="formCrearProductoInv" style="display:flex; flex-direction:column; gap:12px;">
                    <div>
                        <label style="display:block; font-size:11.5px; font-weight:800; color:#475569; text-transform:uppercase; margin-bottom:4px;">Nombre del artículo *</label>
                        <input type="text" id="nuevoProdNombre" required placeholder="Ej: Coca Cola 2.25L" value="${escHtml(nombreInicial)}"
                               style="width:100%; box-sizing:border-box; padding:11px 12px; border:1.5px solid #cbd5e1; border-radius:12px; font-size:14.5px; font-weight:700; color:#0f172a;">
                    </div>

                    <div style="display:grid; grid-template-columns:1.3fr 1fr; gap:8px;">
                        <div>
                            <label style="display:block; font-size:11.5px; font-weight:800; color:#475569; text-transform:uppercase; margin-bottom:4px;">Código de barras</label>
                            <div style="display:flex; gap:6px;">
                                <input type="text" id="nuevoProdCodigo" placeholder="Código..." value="${escHtml(codigoInicial)}"
                                       style="flex:1; min-width:0; box-sizing:border-box; padding:11px 10px; border:1.5px solid #cbd5e1; border-radius:12px; font-size:13.5px; font-weight:700; font-family:monospace; color:#0f172a;">
                                <button type="button" id="btnEscanearParaNuevo" title="Escanear código" style="background:#2563eb; color:#fff; border:none; border-radius:12px; padding:0 11px; font-size:13px; font-weight:800; cursor:pointer; white-space:nowrap;">
                                    📷
                                </button>
                            </div>
                        </div>
                        <div>
                            <label style="display:block; font-size:11.5px; font-weight:800; color:#475569; text-transform:uppercase; margin-bottom:4px;">Departamento TPV</label>
                            <select id="nuevoProdDepto" style="width:100%; box-sizing:border-box; padding:11px 8px; border:1.5px solid #cbd5e1; border-radius:12px; font-size:13px; font-weight:800; color:#0f172a; background:#fff;">
                                ${deptosOpciones.map((d) => `<option value="${escHtml(d.nombre)}" ${d.nombre === deptoDefault ? 'selected' : ''}>${iconoDepto(d.nombre)} ${escHtml(d.nombre)}</option>`).join('')}
                                ${!deptosOpciones.some((d) => d.nombre === 'GENERAL') ? '<option value="GENERAL">📦 GENERAL</option>' : ''}
                            </select>
                        </div>
                    </div>

                    <div style="display:grid; grid-template-columns:1fr 1fr 96px; gap:8px;">
                        <div>
                            <label style="display:block; font-size:11.5px; font-weight:800; color:#475569; text-transform:uppercase; margin-bottom:4px;">Precio ($)</label>
                            <input type="number" id="nuevoProdPrecio" step="0.01" min="0" placeholder="0" value=""
                                   style="width:100%; box-sizing:border-box; padding:11px 10px; border:1.5px solid #cbd5e1; border-radius:12px; font-size:14px; font-weight:700; color:#0f172a;">
                        </div>
                        <div>
                            <label style="display:block; font-size:11.5px; font-weight:800; color:#475569; text-transform:uppercase; margin-bottom:4px;">Stock inicial</label>
                            <input type="number" id="nuevoProdStock" step="0.001" placeholder="0" value="0"
                                   style="width:100%; box-sizing:border-box; padding:11px 10px; border:1.5px solid #cbd5e1; border-radius:12px; font-size:14px; font-weight:700; color:#0f172a;">
                        </div>
                        <div>
                            <label style="display:block; font-size:11.5px; font-weight:800; color:#475569; text-transform:uppercase; margin-bottom:4px;">Unidad</label>
                            <select id="nuevoProdUnidad" style="width:100%; box-sizing:border-box; padding:11px 8px; border:1.5px solid #cbd5e1; border-radius:12px; font-size:13.5px; font-weight:800; color:#0f172a; background:#fff;">
                                <option value="UN">UN</option>
                                <option value="KG">KG</option>
                            </select>
                        </div>
                    </div>

                    <div id="nuevoProdError" style="display:none; color:#dc2626; background:#fef2f2; border:1px solid #fecaca; padding:8px 10px; border-radius:10px; font-size:12.5px; font-weight:700;"></div>

                    <div style="display:flex; gap:8px; margin-top:4px;">
                        <button type="button" id="btnCancelarCrearProd" style="flex:1; padding:12px; border-radius:12px; border:1px solid #cbd5e1; background:#f8fafc; color:#475569; font-size:13.5px; font-weight:800; cursor:pointer;">Cancelar</button>
                        <button type="submit" id="btnGuardarCrearProd" style="flex:1.6; padding:12px; border-radius:12px; border:none; background:#10b981; color:#fff; font-size:14px; font-weight:900; cursor:pointer; box-shadow:0 4px 12px rgba(16,185,129,0.3);">✓ Guardar en Catálogo</button>
                    </div>
                </form>
            </div>
        `;
        document.body.appendChild(fondo);

        const cerrar = () => {
            callbackCodigoEscaneado = null;
            fondo.remove();
        };
        fondo.addEventListener('click', (e) => { if (e.target === fondo) cerrar(); });
        fondo.querySelector('#btnCerrarCrearProd')?.addEventListener('click', cerrar);
        fondo.querySelector('#btnCancelarCrearProd')?.addEventListener('click', cerrar);

        const inputNom = fondo.querySelector('#nuevoProdNombre');
        const inputCod = fondo.querySelector('#nuevoProdCodigo');
        setTimeout(() => {
            if (nombreInicial && inputCod) inputCod.focus();
            else if (inputNom) inputNom.focus();
        }, 40);

        fondo.querySelector('#btnEscanearParaNuevo')?.addEventListener('click', (e) => {
            e.preventDefault();
            callbackCodigoEscaneado = (codDetectado) => {
                if (inputCod) inputCod.value = codDetectado;
                if (inputNom && !inputNom.value.trim()) inputNom.focus();
            };
            abrirEscanerCamara();
        });

        fondo.querySelector('#formCrearProductoInv')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const errBox = fondo.querySelector('#nuevoProdError');
            const btnSave = fondo.querySelector('#btnGuardarCrearProd');
            const nombre = (inputNom?.value || '').trim();
            const codigo = (inputCod?.value || '').trim();
            const precio = parseFloat(fondo.querySelector('#nuevoProdPrecio')?.value || '0') || 0;
            const stock = parseFloat(fondo.querySelector('#nuevoProdStock')?.value || '0') || 0;
            const unidad = fondo.querySelector('#nuevoProdUnidad')?.value || 'UN';
            const departamento = fondo.querySelector('#nuevoProdDepto')?.value || 'GENERAL';

            if (!nombre) {
                if (errBox) { errBox.textContent = 'Ingresá el nombre del artículo.'; errBox.style.display = 'block'; }
                return;
            }
            if (btnSave) { btnSave.disabled = true; btnSave.textContent = 'Guardando…'; }
            try {
                const res = await fetch('/api/pos/inventario/producto', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        nombre,
                        codigo,
                        precio,
                        stock,
                        unidad,
                        departamento,
                        sucursal_id: global.activeSucursalId
                    })
                });
                const data = await res.json();
                if (!res.ok || !data.ok) {
                    throw new Error(data.error || 'No se pudo crear el artículo');
                }
                if (data.producto) {
                    catalogo.unshift(data.producto);
                    resumen.total_sku = catalogo.length;
                    textoBusqueda = data.producto.nombre;
                }
                cerrar();
                renderAuditoria();
                if (global.CrmBus) global.CrmBus.emit('toast', `✓ "${nombre}" creado con código ${data.producto?.codigo || codigo}`);
            } catch (err) {
                if (errBox) { errBox.textContent = err.message; errBox.style.display = 'block'; }
                if (btnSave) { btnSave.disabled = false; btnSave.textContent = '✓ Guardar en Catálogo'; }
            }
        });
    }

    // -------------------------------------------------------------------------
    // DRAWER / BOTTOM SHEET TÁCTIL DE CONTEO FÍSICO
    // -------------------------------------------------------------------------
    function abrirDrawerConteo(prod) {
        solicitarWakeLock();
        productoEnConteo = prod;
        const esPesable = prod.es_pesable || prod.unidad === 'KG';
        const unidadTxt = esPesable ? 'KG' : 'UN';

        // Buffer inicial: si ya fue auditado hoy, usar el último conteo; sino el stock del sistema
        bufferConteo = prod.auditado_hoy && prod.ultimo_conteo !== null
            ? String(prod.ultimo_conteo)
            : (prod.stock > 0 ? String(prod.stock) : '0');

        const drawer = $('drawerConteoTactil');
        if (!drawer) return;

        $('drawerDepto').textContent = prod.departamento || 'GENERAL';
        $('drawerNombre').textContent = prod.nombre;
        $('drawerCodigo').textContent = `${prod.codigo ? 'Cód: ' + prod.codigo : 'ID: ' + prod.id} · ${formatearPlata(prod.precio)}`;
        $('drawerStockSistema').textContent = `${formatearNumero(prod.stock, esPesable ? 3 : 0)} ${unidadTxt}`;
        $('drawerDisplayUnidad').textContent = unidadTxt;

        // Inyectar controles de Precio ($) y Departamento TPV dentro del drawer de inventario
        let boxPrecioDepto = $('drawerPrecioDeptoBox');
        if (!boxPrecioDepto) {
            boxPrecioDepto = document.createElement('div');
            boxPrecioDepto.id = 'drawerPrecioDeptoBox';
            boxPrecioDepto.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:8px 0 10px; padding:8px 10px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px;';
            const displayWrap = $('drawerDisplayConteo')?.closest('.conteo-display-box') || $('drawerDiffBox');
            if (displayWrap && displayWrap.parentNode) {
                displayWrap.parentNode.insertBefore(boxPrecioDepto, displayWrap);
            }
        }
        const deptosOpts = obtenerDepartamentosLista();
        const deptoActual = String(prod.departamento || 'GENERAL').toUpperCase();
        boxPrecioDepto.innerHTML = `
            <div>
                <label style="display:block; font-size:10px; font-weight:800; color:#64748b; text-transform:uppercase; margin-bottom:2px;">Precio Venta ($)</label>
                <input type="number" id="drawerInputPrecio" step="0.01" min="0" value="${prod.precio || 0}"
                       style="width:100%; box-sizing:border-box; padding:7px 8px; border:1.5px solid #cbd5e1; border-radius:8px; font-size:13.5px; font-weight:800; color:#0f172a; background:#fff;">
            </div>
            <div>
                <label style="display:block; font-size:10px; font-weight:800; color:#64748b; text-transform:uppercase; margin-bottom:2px;">Departamento TPV</label>
                <select id="drawerSelectDepto" style="width:100%; box-sizing:border-box; padding:7px 6px; border:1.5px solid #cbd5e1; border-radius:8px; font-size:12.5px; font-weight:800; color:#0f172a; background:#fff;">
                    ${deptosOpts.map((d) => `<option value="${escHtml(d.nombre)}" ${d.nombre === deptoActual ? 'selected' : ''}>${iconoDepto(d.nombre)} ${escHtml(d.nombre)}</option>`).join('')}
                    ${!deptosOpts.some((d) => d.nombre === deptoActual) ? `<option value="${escHtml(deptoActual)}" selected>${iconoDepto(deptoActual)} ${escHtml(deptoActual)}</option>` : ''}
                </select>
            </div>
        `;

        const numpadPunto = $('numpadPunto');
        if (numpadPunto) {
            numpadPunto.style.visibility = esPesable ? 'visible' : 'hidden';
        }

        actualizarDisplayDrawer();

        drawer.style.display = 'block';
        drawer.setAttribute('aria-hidden', 'false');
        setTimeout(() => drawer.classList.add('open'), 10);
    }

    function cerrarDrawerConteo() {
        liberarWakeLock();
        const drawer = $('drawerConteoTactil');
        if (!drawer) return;
        drawer.classList.remove('open');
        setTimeout(() => {
            drawer.style.display = 'none';
            drawer.setAttribute('aria-hidden', 'true');
            productoEnConteo = null;
        }, 250);
    }

    function actualizarDisplayDrawer() {
        if (!productoEnConteo) return;
        const esPesable = productoEnConteo.es_pesable || productoEnConteo.unidad === 'KG';
        const unidadTxt = esPesable ? 'KG' : 'UN';

        let displayTxt = bufferConteo.replace('.', ',');
        if (!displayTxt) displayTxt = '0';
        $('drawerDisplayConteo').textContent = displayTxt;

        const conteoNum = parseFloat(bufferConteo.replace(',', '.')) || 0;
        const sistNum = productoEnConteo.stock || 0;
        const diff = conteoNum - sistNum;

        const diffBox = $('drawerDiffBox');
        const diffVal = $('drawerDiferencia');

        if (diffBox && diffVal) {
            diffBox.className = 'info-diferencia';
            if (Math.abs(diff) < 0.001) {
                diffBox.classList.add('exacto');
                diffVal.textContent = `0,000 ${unidadTxt} (EXACTO)`;
            } else if (diff < 0) {
                diffBox.classList.add('faltante');
                diffVal.textContent = `${formatearNumero(diff, esPesable ? 3 : 0)} ${unidadTxt} (FALTANTE)`;
            } else {
                diffBox.classList.add('sobrante');
                diffVal.textContent = `+${formatearNumero(diff, esPesable ? 3 : 0)} ${unidadTxt} (SOBRANTE)`;
            }
        }
    }

    // Manejo de teclas táctiles del numpad
    function onNumpadKey(key) {
        if (!productoEnConteo) return;
        vibrar([12]);
        const esPesable = productoEnConteo.es_pesable || productoEnConteo.unidad === 'KG';

        if (key === 'C') {
            bufferConteo = '0';
        } else if (key === 'BACK') {
            bufferConteo = bufferConteo.length > 1 ? bufferConteo.slice(0, -1) : '0';
        } else if (key === '.' || key === ',') {
            if (esPesable && !bufferConteo.includes('.')) {
                bufferConteo += '.';
            }
        } else if (/^[0-9]$/.test(key)) {
            if (bufferConteo === '0') {
                bufferConteo = key;
            } else {
                // Limitar a 3 decimales
                if (bufferConteo.includes('.')) {
                    const dec = bufferConteo.split('.')[1] || '';
                    if (dec.length < 3) bufferConteo += key;
                } else {
                    bufferConteo += key;
                }
            }
        }
        actualizarDisplayDrawer();
    }

    // -------------------------------------------------------------------------
    // CONFIRMAR AJUSTE INMEDIATO (POST /api/pos/inventario/ajuste)
    // -------------------------------------------------------------------------
    async function confirmarAjusteInmediato() {
        if (!productoEnConteo) return;
        const prod = productoEnConteo;
        const conteoNum = parseFloat(bufferConteo.replace(',', '.')) || 0;
        const nuevoPrecioInput = $('drawerInputPrecio');
        const nuevoDeptoSelect = $('drawerSelectDepto');
        const precioEditado = nuevoPrecioInput ? parseFloat(nuevoPrecioInput.value || '0') : prod.precio;
        const deptoEditado = nuevoDeptoSelect ? nuevoDeptoSelect.value : prod.departamento;
        const motivo = ($('selectMotivoAjuste') ? $('selectMotivoAjuste').value : 'Actualización de inventario') || 'Actualización de inventario';

        const btnConfirmar = $('btnConfirmarAjuste');
        if (btnConfirmar) {
            btnConfirmar.disabled = true;
            btnConfirmar.innerHTML = '<span>⏳ Guardando en inventario...</span>';
        }

        try {
            const res = await fetch('/api/pos/inventario/ajuste', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    producto_id: prod.id,
                    stock_fisico: conteoNum,
                    precio: !isNaN(precioEditado) ? precioEditado : prod.precio,
                    departamento: deptoEditado,
                    responsable: 'Admin',
                    motivo: motivo
                })
            });

            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error || 'Fallo al guardar ajuste');
            }

            // Éxito: feedback háptico y sonoro
            audioBeep(true);
            vibrar([50, 60, 50]);

            // Actualizar el producto en memoria
            prod.stock = conteoNum;
            if (!isNaN(precioEditado)) prod.precio = precioEditado;
            if (deptoEditado) prod.departamento = deptoEditado;
            prod.auditado_hoy = true;
            prod.ultimo_conteo = conteoNum;
            prod.diferencia = data.diferencia || 0;

            // Recalcular resumen
            let auditados = 0;
            let conDiff = 0;
            let faltantes = 0;
            let sobrantes = 0;
            let quiebre = 0;

            catalogo.forEach((p) => {
                if (p.auditado_hoy) {
                    auditados++;
                    if (Math.abs(p.diferencia || 0) > 0.001) {
                        conDiff++;
                        if (p.diferencia < 0) faltantes++;
                        else sobrantes++;
                    }
                }
                if (p.stock <= 0.0001) quiebre++;
            });

            resumen.auditados = auditados;
            resumen.pendientes = catalogo.length - auditados;
            resumen.con_diferencia = conDiff;
            resumen.faltantes = faltantes;
            resumen.sobrantes = sobrantes;
            resumen.quiebre = quiebre;

            cerrarDrawerConteo();
            renderAuditoria();

            if (global.CrmBus) {
                global.CrmBus.emit('toast', `✓ Stock de ${prod.nombre} ajustado a ${conteoNum}`);
            }
        } catch (err) {
            console.error('Error aplicando ajuste:', err);
            audioBeep(false);
            vibrar([200, 100, 200]);
            if (global.CrmBus) {
                global.CrmBus.emit('toast', 'Error al guardar ajuste: ' + err.message, true);
            }
        } finally {
            if (btnConfirmar) {
                btnConfirmar.disabled = false;
                btnConfirmar.innerHTML = '<span class="btn-ico">✓</span><span class="btn-txt">CONFIRMAR AJUSTE INMEDIATO</span>';
            }
        }
    }

    // -------------------------------------------------------------------------
    // MODAL DE HISTORIAL DE AUDITORÍAS
    // -------------------------------------------------------------------------
    async function abrirModalHistorial() {
        let modal = $('modalHistorialAuditoria');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modalHistorialAuditoria';
            modal.className = 'modal-historial-wrap';
            document.body.appendChild(modal);
        }

        modal.innerHTML = `
            <div class="modal-historial-dialog">
                <div class="modal-historial-header">
                    <h3>📋 Historial de Ajustes de Stock</h3>
                    <button type="button" class="btn-cerrar-historial" id="btnCerrarHistorial">✕</button>
                </div>
                <div class="modal-historial-body" id="historialBody">
                    <p style="padding:20px; text-align:center; color:#94a3b8;">Cargando historial...</p>
                </div>
            </div>
        `;

        modal.style.display = 'flex';
        $('btnCerrarHistorial').addEventListener('click', () => {
            modal.style.display = 'none';
        });

        try {
            const res = await fetch('/api/pos/inventario/historial?limite=60');
            const data = await res.json();
            const list = data.historial || [];

            const body = $('historialBody');
            if (!body) return;

            if (list.length === 0) {
                body.innerHTML = '<p style="padding:30px; text-align:center; color:#94a3b8;">No hay registros de auditoría aún.</p>';
                return;
            }

            body.innerHTML = `
                <div class="historial-lista">
                    ${list.map((h) => {
                        const diff = h.diferencia || 0;
                        let diffBadge = '';
                        if (Math.abs(diff) < 0.001) diffBadge = '<span class="hist-diff exacto">0,000 (Exacto)</span>';
                        else if (diff < 0) diffBadge = `<span class="hist-diff faltante">${diff.toFixed(3)} (Faltante)</span>`;
                        else diffBadge = `<span class="hist-diff sobrante">+${diff.toFixed(3)} (Sobrante)</span>`;

                        return `
                            <div class="hist-item">
                                <div class="hist-head">
                                    <b class="hist-prod">${h.nombre_producto}</b>
                                    <span class="hist-fecha">${h.fecha}</span>
                                </div>
                                <div class="hist-vals">
                                    <span>Sist: <b>${h.stock_sistema.toFixed(3)}</b></span>
                                    <span>Real: <b>${h.stock_fisico.toFixed(3)}</b></span>
                                    ${diffBadge}
                                </div>
                                <div class="hist-meta">
                                    <small>Resp: <b>${h.responsable || 'Admin'}</b> · Motivo: ${h.motivo || 'Recuento'}</small>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        } catch (err) {
            console.error('Error cargando historial:', err);
            const body = $('historialBody');
            if (body) body.innerHTML = '<p style="color:#ef4444; padding:20px;">Error al cargar historial.</p>';
        }
    }

    // -------------------------------------------------------------------------
    // EXPORTACIÓN A PLANILLA EXCEL / CSV CON BOM UTF-8
    // -------------------------------------------------------------------------
    function exportarPlanillaCSV() {
        if (!catalogo || catalogo.length === 0) {
            if (global.CrmBus) global.CrmBus.emit('toast', 'No hay artículos para exportar.', true);
            return;
        }

        const fechaStr = new Date().toISOString().slice(0, 10);
        let csv = '\uFEFF'; // BOM UTF-8 para Excel
        csv += 'ID;Código;Producto;Departamento;Unidad;Stock Sistema;Conteo Real;Diferencia;Estado;Precio;Costo\r\n';

        catalogo.forEach((p) => {
            const esPesable = p.es_pesable || p.unidad === 'KG';
            const unidadTxt = esPesable ? 'KG' : 'UN';
            const sist = p.stock || 0;
            const conteo = p.auditado_hoy && p.ultimo_conteo !== null ? p.ultimo_conteo : '';
            const diff = p.auditado_hoy && p.diferencia !== null ? p.diferencia : '';
            let estado = 'PENDIENTE';
            if (p.auditado_hoy) {
                if (Math.abs(diff) < 0.001) estado = 'EXACTO';
                else if (diff < 0) estado = 'FALTANTE';
                else estado = 'SOBRANTE';
            } else if (sist <= 0) {
                estado = 'QUIEBRE';
            }

            const fila = [
                p.id,
                `"${p.codigo || ''}"`,
                `"${p.nombre || ''}"`,
                `"${p.departamento || ''}"`,
                unidadTxt,
                String(sist).replace('.', ','),
                conteo !== '' ? String(conteo).replace('.', ',') : '',
                diff !== '' ? String(diff).replace('.', ',') : '',
                estado,
                String(p.precio || 0).replace('.', ','),
                String(p.costo || 0).replace('.', ',')
            ];
            csv += fila.join(';') + '\r\n';
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Auditoria_Inventario_${fechaStr}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        if (global.CrmBus) global.CrmBus.emit('toast', 'Planilla descargada con éxito');
    }

    // -------------------------------------------------------------------------
    // VINCULACIÓN INICIAL DEL MODAL DE CÁMARA Y DRAWER
    // -------------------------------------------------------------------------
    function initEventosEstaticos() {
        // Escáner Cámara
        const btnCerrarEscaner = $('btnCerrarEscaner');
        if (btnCerrarEscaner) btnCerrarEscaner.addEventListener('click', cerrarEscanerCamara);

        const btnToggleLinterna = $('btnToggleLinterna');
        if (btnToggleLinterna) btnToggleLinterna.addEventListener('click', toggleLinterna);

        const btnCambiarCamara = $('btnCambiarCamara');
        if (btnCambiarCamara) btnCambiarCamara.addEventListener('click', cambiarCamara);

        // Drawer Conteo
        const btnCerrarDrawer = $('btnCerrarDrawer');
        if (btnCerrarDrawer) btnCerrarDrawer.addEventListener('click', cerrarDrawerConteo);

        const backdropConteo = $('backdropConteo');
        if (backdropConteo) backdropConteo.addEventListener('click', cerrarDrawerConteo);

        const btnConfirmar = $('btnConfirmarAjuste');
        if (btnConfirmar) btnConfirmar.addEventListener('click', confirmarAjusteInmediato);

        // Numpad clicks
        document.querySelectorAll('.numpad-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.key;
                onNumpadKey(key);
            });
        });

        // Soporte teclado físico para el drawer (ignorar si escribe en el input de precio)
        window.addEventListener('keydown', (e) => {
            if (!productoEnConteo) return;
            if (document.activeElement && (document.activeElement.id === 'drawerInputPrecio' || document.activeElement.id === 'drawerSelectDepto')) {
                return;
            }
            if (e.key === 'Escape') {
                cerrarDrawerConteo();
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmarAjusteInmediato();
                return;
            }
            if (e.key === 'Backspace') {
                e.preventDefault();
                onNumpadKey('BACK');
                return;
            }
            if (e.key === '.' || e.key === ',') {
                onNumpadKey('.');
                return;
            }
            if (/^[0-9]$/.test(e.key)) {
                onNumpadKey(e.key);
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initEventosEstaticos);
    } else {
        initEventosEstaticos();
    }

    global.AuditoriaInventario = {
        cambiarPantalla,
        cargarCatalogoAuditoria,
        recargar: () => cargarCatalogoAuditoria(true),
        renderAuditoria,
        abrirDrawerConteo,
        abrirEscanerCamara,
        cerrarEscanerCamara,
        abrirFiltro: abrirFiltroAuditoria,
        filtroActivo: () => !!(filtroDepto || filtroEstado !== 'todos'),
        pantallaActual: () => pantallaActiva
    };

})(window);
