/* ==============================================================================
   COBRO FÁCIL - AUDITORÍA DE INVENTARIO CONTINUA (MÓVIL & ESCRITORIO)
   Paridad exacta con Desktop (src/cerebro_global/auditoria/motor_auditoria.py).
   Ajuste SET inmediato, escáner de cámara con efecto láser, teclado táctil.
   ============================================================================== */

(function (global) {
    'use strict';

    let catalogo = [];
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
    let pantallaActiva = 'faltantes'; // 'faltantes' | 'auditoria'
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

    // -------------------------------------------------------------------------
    // CARGA DE DATOS DESDE LA API
    // -------------------------------------------------------------------------
    async function cargarCatalogoAuditoria(forzar = false) {
        const wrap = $('pedidosAuditoriaWrap');
        if (!wrap) return;

        try {
            const res = await fetch('/api/pos/inventario/auditoria');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (data.ok) {
                catalogo = data.productos || [];
                auditoriasHoy = data.auditorias_hoy || [];
                resumen = data.resumen || resumen;
                fuenteConexion = data.fuente || 'local';
                renderAuditoria();
            }
        } catch (err) {
            console.error('Error cargando catálogo de auditoría:', err);
            if (global.CrmBus) global.CrmBus.emit('toast', 'No se pudo cargar el inventario: ' + err.message, true);
        }
    }

    // -------------------------------------------------------------------------
    // CAMBIO DE PANTALLA (Faltantes vs Auditoría)
    // -------------------------------------------------------------------------
    function cambiarPantalla(id) {
        pantallaActiva = id || 'faltantes';
        const faltantesWrap = $('pedidosFaltantesWrap');
        const auditoriaWrap = $('pedidosAuditoriaWrap');

        if (pantallaActiva === 'auditoria') {
            if (faltantesWrap) faltantesWrap.style.display = 'none';
            if (auditoriaWrap) {
                auditoriaWrap.style.display = 'block';
                cargarCatalogoAuditoria();
            }
        } else {
            if (auditoriaWrap) auditoriaWrap.style.display = 'none';
            if (faltantesWrap) faltantesWrap.style.display = 'block';
        }

        if (global.ModuloPanel && global.ModuloPanel.pintar) {
            global.ModuloPanel.pintar();
        }
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
            if (filtroDepto && p.departamento !== filtroDepto) return false;

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

        // Obtener lista única de departamentos
        const deptosSet = new Set(catalogo.map((p) => p.departamento).filter(Boolean));
        const deptosList = Array.from(deptosSet).sort();

        const badgeConexion = fuenteConexion === 'mariadb_maestra'
            ? '<span class="audit-badge-online">⚡ Conexión Directa MariaDB (192.168.0.8)</span>'
            : '<span class="audit-badge-offline">📶 Servidor Nube / Caché Offline</span>';

        wrap.innerHTML = `
            <div class="auditoria-container">
                <!-- Barra de Estado y Acciones Rápidas -->
                <div class="auditoria-top-bar">
                    ${badgeConexion}
                    <div class="auditoria-top-actions">
                        <button type="button" class="btn-audit-sec" id="btnHistorialAuditoria" title="Ver historial de conteos">📋 Historial</button>
                        <button type="button" class="btn-audit-sec" id="btnExportarAuditoria" title="Descargar planilla Excel/CSV">📊 Exportar</button>
                    </div>
                </div>

                <!-- KPIs en Vivo (4 Cards táctiles) -->
                <div class="auditoria-kpi-grid">
                    <div class="audit-kpi-card ${filtroEstado === 'todos' ? 'active' : ''}" data-filtro="todos">
                        <span class="kpi-label">TOTAL SKU</span>
                        <b class="kpi-val">${resumen.total_sku}</b>
                        <span class="kpi-sub">artículos activos</span>
                    </div>
                    <div class="audit-kpi-card ${filtroEstado === 'auditados' ? 'active' : ''}" data-filtro="auditados">
                        <span class="kpi-label">AUDITADOS</span>
                        <b class="kpi-val kpi-green">${resumen.auditados} / ${resumen.total_sku}</b>
                        <span class="kpi-sub">${resumen.total_sku > 0 ? Math.round((resumen.auditados / resumen.total_sku) * 100) : 0}% contados</span>
                    </div>
                    <div class="audit-kpi-card ${filtroEstado === 'diferencia' ? 'active' : ''}" data-filtro="diferencia">
                        <span class="kpi-label">CON DIFERENCIA</span>
                        <b class="kpi-val ${resumen.con_diferencia > 0 ? 'kpi-red' : ''}">${resumen.con_diferencia}</b>
                        <span class="kpi-sub">${resumen.faltantes} falt. · ${resumen.sobrantes} sobr.</span>
                    </div>
                    <div class="audit-kpi-card ${filtroEstado === 'quiebre' ? 'active' : ''}" data-filtro="quiebre">
                        <span class="kpi-label">EN QUIEBRE</span>
                        <b class="kpi-val ${resumen.quiebre > 0 ? 'kpi-orange' : ''}">${resumen.quiebre}</b>
                        <span class="kpi-sub">stock en cero</span>
                    </div>
                </div>

                <!-- Buscador Móvil Mejorado con Ícono de Cámara para Escanear -->
                <div class="auditoria-search-wrap">
                    <div class="auditoria-input-box">
                        <input type="search" id="auditoriaSearchInput" class="auditoria-search-input" 
                               placeholder="Buscar corte, código o escanear..." 
                               value="${textoBusqueda}" autocomplete="off" autocapitalize="off">
                        ${textoBusqueda ? '<button type="button" id="btnAuditoriaLimpiar" class="btn-clear-search">✕</button>' : ''}
                    </div>
                    <button type="button" id="btnAuditoriaEscaner" class="btn-cam-scanner" aria-label="Escanear código con cámara">
                        <svg class="cam-ico" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                            <circle cx="12" cy="13" r="4"></circle>
                        </svg>
                        <span class="cam-btn-text">Escanear</span>
                    </button>
                </div>

                <!-- Chips de Filtrado Horizontal -->
                <div class="auditoria-chips-scroll">
                    <button type="button" class="chip-btn ${filtroEstado === 'todos' ? 'active' : ''}" data-f="todos">Todos (${resumen.total_sku})</button>
                    <button type="button" class="chip-btn ${filtroEstado === 'auditados' ? 'active' : ''}" data-f="auditados">Auditados (${resumen.auditados})</button>
                    <button type="button" class="chip-btn ${filtroEstado === 'pendientes' ? 'active' : ''}" data-f="pendientes">Pendientes (${resumen.pendientes})</button>
                    <button type="button" class="chip-btn ${filtroEstado === 'diferencia' ? 'active' : ''}" data-f="diferencia">Con diferencia (${resumen.con_diferencia})</button>
                    <button type="button" class="chip-btn ${filtroEstado === 'quiebre' ? 'active' : ''}" data-f="quiebre">Quiebre 0 (${resumen.quiebre})</button>
                </div>

                <!-- Filtro por Departamento / Rubro -->
                <div class="auditoria-deptos-scroll">
                    <button type="button" class="depto-chip ${!filtroDepto ? 'active' : ''}" data-depto="">Todos los rubros</button>
                    ${deptosList.map((d) => `<button type="button" class="depto-chip ${filtroDepto === d ? 'active' : ''}" data-depto="${d}">${d}</button>`).join('')}
                </div>

                <!-- Lista Táctil de Productos (Mobile Cards) -->
                <div class="auditoria-lista-cards">
                    ${filtrados.length === 0 ? `
                        <div class="audit-vacio">
                            <span class="vacio-ico">🔍</span>
                            <p>No se encontraron artículos con ese filtro.</p>
                            ${textoBusqueda || filtroEstado !== 'todos' || filtroDepto ? '<button type="button" class="btn-audit-sec" id="btnRestablecerFiltros">Restablecer filtros</button>' : ''}
                        </div>
                    ` : filtrados.map((p) => {
                        const esPesable = p.es_pesable || p.unidad === 'KG';
                        const unidadTxt = esPesable ? 'KG' : 'UN';
                        const decimales = esPesable ? 3 : 0;
                        const stockFmt = formatearNumero(p.stock, decimales);
                        
                        let badgeEstado = '';
                        if (p.auditado_hoy) {
                            const diff = p.diferencia || 0;
                            if (Math.abs(diff) < 0.001) {
                                badgeEstado = '<span class="status-pill exacto">✓ Exacto</span>';
                            } else if (diff < 0) {
                                badgeEstado = `<span class="status-pill faltante">Faltante ${formatearNumero(diff, decimales)} ${unidadTxt}</span>`;
                            } else {
                                badgeEstado = `<span class="status-pill sobrante">+${formatearNumero(diff, decimales)} ${unidadTxt} Sobrante</span>`;
                            }
                        } else if (p.stock <= 0.0001) {
                            badgeEstado = '<span class="status-pill quiebre">Quiebre (0)</span>';
                        } else {
                            badgeEstado = '<span class="status-pill pendiente">Pendiente</span>';
                        }

                        return `
                            <div class="audit-card ${p.auditado_hoy ? 'card-auditado' : ''}" data-pid="${p.id}">
                                <div class="audit-card-head">
                                    <div class="audit-card-title-wrap">
                                        <div class="audit-card-nombre">${p.nombre}</div>
                                        <div class="audit-card-meta">
                                            <span class="meta-depto">${p.departamento || 'GENERAL'}</span>
                                            ${p.codigo ? `<span class="meta-code">Cód: ${p.codigo}</span>` : `<span class="meta-code">ID: ${p.id}</span>`}
                                            <span class="meta-price">${formatearPlata(p.precio)}</span>
                                        </div>
                                    </div>
                                    <div class="audit-card-badge-wrap">
                                        ${badgeEstado}
                                    </div>
                                </div>

                                <div class="audit-card-body">
                                    <div class="stock-box">
                                        <span class="stock-lbl">Sistema</span>
                                        <b class="stock-val">${stockFmt} <small>${unidadTxt}</small></b>
                                    </div>
                                    <div class="stock-box ${p.auditado_hoy ? 'conteo-hecho' : 'conteo-pendiente'}">
                                        <span class="stock-lbl">Conteo Real</span>
                                        <b class="stock-val">${p.auditado_hoy ? formatearNumero(p.ultimo_conteo, decimales) : '—'} <small>${p.auditado_hoy ? unidadTxt : ''}</small></b>
                                    </div>
                                    <button type="button" class="btn-contar-card" data-contar="${p.id}">
                                        ${p.auditado_hoy ? '✎ Recalcular' : '⚡ Contar'}
                                    </button>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;

        // Event Listeners
        vincularEventosAuditoria();
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
                const btnLimpiar = $('btnAuditoriaLimpiar');
                if (btnLimpiar) btnLimpiar.style.display = textoBusqueda ? 'block' : 'none';
                renderAuditoria();
            });

            // Enter directo abre el primer resultado o conteo
            inputBuscar.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const code = (inputBuscar.value || '').trim();
                    if (!code) return;
                    const encontrado = buscarPorCodigoONombre(code);
                    if (encontrado) {
                        abrirDrawerConteo(encontrado);
                    }
                }
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

        // Botones de Contar en cada card
        document.querySelectorAll('[data-contar]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const pid = parseInt(btn.dataset.contar, 10);
                const prod = catalogo.find((p) => p.id === pid);
                if (prod) abrirDrawerConteo(prod);
            });
        });

        // Clic en la card completa también abre conteo
        document.querySelectorAll('.audit-card').forEach((card) => {
            card.addEventListener('click', () => {
                const pid = parseInt(card.dataset.pid, 10);
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
        let prod = catalogo.find((p) => String(p.codigo || '').toLowerCase() === q);
        if (prod) return prod;

        // 2. Coincidencia exacta de ID
        prod = catalogo.find((p) => String(p.id) === q);
        if (prod) return prod;

        // 3. Coincidencia exacta de nombre
        prod = catalogo.find((p) => (p.nombre || '').toLowerCase() === q);
        if (prod) return prod;

        // 4. Nombre que empiece con la búsqueda
        prod = catalogo.find((p) => (p.nombre || '').toLowerCase().startsWith(q));
        if (prod) return prod;

        // 5. Nombre que contenga la búsqueda
        return catalogo.find((p) => (p.nombre || '').toLowerCase().includes(q)) || null;
    }

    // -------------------------------------------------------------------------
    // ESCÁNER DE CÁMARA CON EFECTO LÁSER
    // -------------------------------------------------------------------------
    async function abrirEscanerCamara() {
        const modal = $('modalEscanerCamara');
        const video = $('videoEscaner');
        const prompt = $('scannerPrompt');
        if (!modal || !video) return;

        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        escaneando = true;

        if (prompt) prompt.textContent = 'Apuntá el código de barras o QR dentro del recuadro';

        // Inicializar BarcodeDetector si está disponible nativamente
        if ('BarcodeDetector' in window) {
            try {
                barcodeDetector = new window.BarcodeDetector({
                    formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'upc_a', 'upc_e']
                });
            } catch (e) {
                barcodeDetector = null;
            }
        }

        // Obtener cámaras y arrancar stream
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            camarasDisponibles = devices.filter((d) => d.kind === 'videoinput');
            const btnCamara = $('btnCambiarCamara');
            if (btnCamara) btnCamara.style.display = camarasDisponibles.length > 1 ? 'inline-block' : 'none';

            // Preferir cámara trasera
            const constraints = {
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            };

            videoStream = await navigator.mediaDevices.getUserMedia(constraints);
            video.srcObject = videoStream;
            await video.play();

            // Detectar soporte de linterna (torch)
            const track = videoStream.getVideoTracks()[0];
            trackLinterna = track;
            const capabilities = track.getCapabilities ? track.getCapabilities() : {};
            const btnLinterna = $('btnToggleLinterna');
            if (btnLinterna) {
                btnLinterna.style.display = capabilities.torch ? 'inline-block' : 'none';
                linternaEncendida = false;
                btnLinterna.textContent = '💡';
            }

            // Iniciar bucle de escaneo continuo
            bucleEscaneo();
        } catch (err) {
            console.error('Error accediendo a la cámara:', err);
            if (prompt) prompt.textContent = 'No se pudo acceder a la cámara. Verificá los permisos del navegador.';
            audioBeep(false);
            if (global.CrmBus) global.CrmBus.emit('toast', 'Permiso de cámara denegado o no disponible.', true);
        }
    }

    function cerrarEscanerCamara() {
        escaneando = false;
        if (animFrameId) cancelAnimationFrame(animFrameId);
        animFrameId = null;

        if (videoStream) {
            videoStream.getTracks().forEach((t) => t.stop());
            videoStream = null;
        }

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
        if (camarasDisponibles.length <= 1) return;
        camaraIndice = (camaraIndice + 1) % camarasDisponibles.length;
        const deviceId = camarasDisponibles[camaraIndice].deviceId;

        if (videoStream) {
            videoStream.getTracks().forEach((t) => t.stop());
        }

        try {
            const video = $('videoEscaner');
            videoStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: deviceId } },
                audio: false
            });
            video.srcObject = videoStream;
            await video.play();
            trackLinterna = videoStream.getVideoTracks()[0];
        } catch (err) {
            console.warn('Error cambiando lente de cámara:', err);
        }
    }

    async function bucleEscaneo() {
        if (!escaneando) return;
        const video = $('videoEscaner');
        if (video && video.readyState >= video.HAVE_CURRENT_DATA) {
            if (barcodeDetector) {
                try {
                    const barcodes = await barcodeDetector.detect(video);
                    if (barcodes && barcodes.length > 0) {
                        const codigoDetectado = barcodes[0].rawValue;
                        onCodigoDetectado(codigoDetectado);
                        return;
                    }
                } catch (_) {}
            }
        }
        animFrameId = requestAnimationFrame(bucleEscaneo);
    }

    function onCodigoDetectado(codigo) {
        if (!codigo) return;
        audioBeep(true);
        vibrar([60, 40, 80]);

        const target = $('scannerTarget');
        if (target) target.classList.add('scanned');

        const prompt = $('scannerPrompt');
        if (prompt) prompt.textContent = '✓ Código detectado: ' + codigo;

        // Buscar producto correspondiente
        setTimeout(() => {
            cerrarEscanerCamara();
            const prod = buscarPorCodigoONombre(codigo);
            if (prod) {
                abrirDrawerConteo(prod);
            } else {
                audioBeep(false);
                vibrar([150, 80, 150]);
                if (global.CrmBus) {
                    global.CrmBus.emit('toast', `Código "${codigo}" no encontrado en el inventario.`, true);
                }
                // Si no se encuentra, poner el código en el buscador para facilitar carga
                textoBusqueda = codigo;
                renderAuditoria();
            }
        }, 350);
    }

    // -------------------------------------------------------------------------
    // DRAWER / BOTTOM SHEET TÁCTIL DE CONTEO FÍSICO
    // -------------------------------------------------------------------------
    function abrirDrawerConteo(prod) {
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

        const numpadPunto = $('numpadPunto');
        if (numpadPunto) {
            numpadPunto.style.visibility = esPesable ? 'visible' : 'hidden';
        }

        // Generar botones de incremento rápido
        const quickBtnsWrap = $('drawerQuickBtns');
        if (quickBtnsWrap) {
            if (esPesable) {
                quickBtnsWrap.innerHTML = `
                    <button type="button" class="quick-btn" data-inc="0.5">+0,5 kg</button>
                    <button type="button" class="quick-btn" data-inc="1">+1 kg</button>
                    <button type="button" class="quick-btn" data-inc="2">+2 kg</button>
                    <button type="button" class="quick-btn" data-inc="5">+5 kg</button>
                    <button type="button" class="quick-btn" data-inc="10">+10 kg</button>
                    <button type="button" class="quick-btn btn-cero" data-set="0">Poner 0</button>
                `;
            } else {
                quickBtnsWrap.innerHTML = `
                    <button type="button" class="quick-btn" data-inc="1">+1 un</button>
                    <button type="button" class="quick-btn" data-inc="2">+2 un</button>
                    <button type="button" class="quick-btn" data-inc="5">+5 un</button>
                    <button type="button" class="quick-btn" data-inc="10">+10 un</button>
                    <button type="button" class="quick-btn" data-inc="20">+20 un</button>
                    <button type="button" class="quick-btn btn-cero" data-set="0">Poner 0</button>
                `;
            }

            quickBtnsWrap.querySelectorAll('[data-inc]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const inc = parseFloat(btn.dataset.inc) || 0;
                    let actual = parseFloat(bufferConteo) || 0;
                    actual = Math.max(0, actual + inc);
                    bufferConteo = esPesable ? String(Math.round(actual * 1000) / 1000) : String(Math.round(actual));
                    actualizarDisplayDrawer();
                });
            });

            quickBtnsWrap.querySelectorAll('[data-set]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    bufferConteo = btn.dataset.set;
                    actualizarDisplayDrawer();
                });
            });
        }

        actualizarDisplayDrawer();

        drawer.style.display = 'block';
        drawer.setAttribute('aria-hidden', 'false');
        setTimeout(() => drawer.classList.add('open'), 10);
    }

    function cerrarDrawerConteo() {
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
        const motivo = ($('selectMotivoAjuste') ? $('selectMotivoAjuste').value : 'Recuento físico rutinario') || 'Recuento físico';

        const btnConfirmar = $('btnConfirmarAjuste');
        if (btnConfirmar) {
            btnConfirmar.disabled = true;
            btnConfirmar.innerHTML = '<span>⏳ Guardando ajuste...</span>';
        }

        try {
            const res = await fetch('/api/pos/inventario/ajuste', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    producto_id: prod.id,
                    stock_fisico: conteoNum,
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

        // Soporte teclado físico para el drawer
        window.addEventListener('keydown', (e) => {
            if (!productoEnConteo) return;
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
        renderAuditoria,
        abrirDrawerConteo,
        abrirEscanerCamara,
        cerrarEscanerCamara,
        pantallaActual: () => pantallaActiva
    };

})(window);
