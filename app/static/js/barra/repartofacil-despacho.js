/* ==============================================================================
   REPARTO FÁCIL DESPACHO & EMBALADO (Cobro Fácil PRO)
   Flujo: Recepción -> Aceptar/Rechazar -> Asignar Repartidor -> Embalado -> Ticket Digital
   ============================================================================== */
(function (global) {
    'use strict';

    let pedidosLista = [];
    let timerPolling = null;
    let chatPollingTimer = null;
    let orderChatActivo = null;
    const pedidosExpandidos = new Set();

    function obtenerIniciales(nombre) {
        const limpio = String(nombre || 'Cliente').trim();
        const partes = limpio.split(/\s+/).filter(Boolean);
        if (partes.length >= 2) return (partes[0][0] + partes[1][0]).toUpperCase();
        return limpio.slice(0, 2).toUpperCase();
    }

    function getCacheKey() {
        const eid = (global.sessionUser && global.sessionUser.empresa_id) || localStorage.getItem('sync_empresa') || '0';
        return 'cf_rf_pedidos_cache_emp_' + eid;
    }

    function $(id) {
        return document.getElementById(id);
    }

    function formatMoney(val) {
        const num = Number(val) || 0;
        return '$' + num.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    function formatMoneyDecimal(val) {
        const num = Number(val) || 0;
        return '$' + num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatFecha(fechaStr) {
        if (!fechaStr) return '';
        try {
            const d = new Date(fechaStr);
            return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            return '';
        }
    }

    // Iniciar el módulo cuando se entra a la pantalla
    function iniciar() {
        const wrap = $('pedidosRepartoFacilWrap');
        if (!wrap) return;
        cargarPedidos();
        
        // Polling cada 6 segundos para pedidos y estados en vivo
        if (timerPolling) clearInterval(timerPolling);
        timerPolling = setInterval(() => {
            const wrapVisible = $('pedidosRepartoFacilWrap');
            if (wrapVisible && wrapVisible.style.display !== 'none') {
                cargarPedidos(true); // background silent
            } else {
                clearInterval(timerPolling);
                timerPolling = null;
            }
        }, 6000);
    }

    // Detener polling
    function detener() {
        if (timerPolling) {
            clearInterval(timerPolling);
            timerPolling = null;
        }
        cerrarChatModal();
        cerrarTicketModal();
    }

    // Cargar lista de pedidos desde la API
    async function cargarPedidos(silencioso = false) {
        const contenedor = $('repartoFacilCardsContenedor');
        if (!contenedor) return;

        if (!silencioso && pedidosLista.length === 0) {
            contenedor.innerHTML = `
                <div style="text-align:center; padding:32px 16px; color:#64748b;">
                    <div class="loader-ring" style="margin:0 auto 12px; width:28px; height:28px; border:3px solid #cbd5e1; border-top-color:#10b981; border-radius:50%; animation:spin 0.8s linear infinite;"></div>
                    <div style="font-weight:700; font-size:13px;">Conectando con Reparto Fácil Cloud…</div>
                </div>
            `;
        }

        try {
            const resp = await fetch('/api/repartofacil/pedidos');
            const data = await resp.json();
            if (resp.status === 401 || resp.status === 403) {
                pedidosLista = [];
                actualizarBadge();
                contenedor.textContent = data.error || 'Inici\u00e1 sesi\u00f3n para consultar los pedidos.';
                return;
            }
            if (data && data.success && Array.isArray(data.pedidos)) {
                pedidosLista = data.pedidos;
                try {
                    localStorage.setItem(getCacheKey(), JSON.stringify(pedidosLista));
                } catch(e) {}
                renderizarCards();
                actualizarBadge();
            } else if (!silencioso) {
                const cache = localStorage.getItem(getCacheKey());
                if (cache) {
                    try {
                        pedidosLista = JSON.parse(cache);
                        renderizarCards();
                        actualizarBadge();
                        return;
                    } catch(e) {}
                }
                contenedor.innerHTML = `<div style="text-align:center; padding:24px; color:#ef4444; font-weight:700;">No se pudieron cargar los pedidos. Reintentá en unos segundos.</div>`;
            }
        } catch (err) {
            console.error('[RepartoFacil] Error al cargar pedidos:', err);
            const cache = localStorage.getItem(getCacheKey());
            if (cache) {
                try {
                    pedidosLista = JSON.parse(cache);
                    renderizarCards();
                    actualizarBadge();
                    return;
                } catch(e) {}
            }
            if (!silencioso) {
                contenedor.innerHTML = `<div style="text-align:center; padding:24px; color:#ef4444; font-weight:700;">Error de conexión con el servidor.</div>`;
            }
        }
    }

    // Actualiza el badge en la barra superior
    function actualizarBadge() {
        const badge = $('repartoFacilCountBadge');
        if (!badge) return;
        const activos = pedidosLista.filter(p => p.estado !== 'delivered' && p.estado !== 'cancelled' && p.estado !== 'rejected');
        badge.textContent = activos.length;
        badge.style.display = activos.length > 0 ? 'inline-block' : 'none';
    }

    // Renderizar tarjetas de clientes
    function renderizarCards() {
        const contenedor = $('repartoFacilCardsContenedor');
        if (!contenedor) return;

        if (pedidosLista.length === 0) {
            contenedor.innerHTML = `
                <div style="text-align:center; padding:48px 20px; background:#fff; border-radius:20px; border:1px dashed #cbd5e1; margin-top:8px;">
                    <span style="font-size:36px; display:block; margin-bottom:8px;">🛵</span>
                    <h4 style="margin:0 0 6px; font-size:15px; font-weight:800; color:#1e293b;">No hay pedidos activos de Reparto Fácil</h4>
                    <p style="margin:0; font-size:12px; color:#64748b; max-width:300px; margin:0 auto;">
                        Los pedidos que los clientes realicen desde la tienda online aparecerán automáticamente aquí listos para aceptar, embalar y despachar.
                    </p>
                </div>
            `;
            return;
        }

        let html = '';
        pedidosLista.forEach((p) => {
            const estadoLower = (p.estado || 'pending').toLowerCase();
            const esNuevoPendiente = estadoLower === 'pending' || estadoLower === 'pending_store';
            const esTimeout = estadoLower === 'cancelled_timeout';
            const esCanceladoCliente = estadoLower === 'cancelled' || estadoLower === 'cancelled_by_client';
            const esRechazadoComercio = estadoLower === 'rejected';
            const esRechazado = esRechazadoComercio || esCanceladoCliente || esTimeout;
            const esConfirmado = estadoLower === 'confirmed' || estadoLower === 'accepted';
            const esEmbalado = estadoLower === 'ready' || estadoLower === 'embalado';
            const esEntregado = estadoLower === 'delivered';
            const repartidorAsignado = p.repartidor_nombre || (p.repartidor_id ? 'Lucas Motomensajero' : null);

            let badgeEstadoHtml = '';
            if (esCanceladoCliente) {
                badgeEstadoHtml = `<span style="background:#dc2626; color:#ffffff; border:1px solid #b91c1c; font-size:9.5px; font-weight:800; padding:2.5px 7px; border-radius:7px; white-space:nowrap;">✕ CANCELADO POR CLIENTE</span>`;
            } else if (esRechazadoComercio) {
                badgeEstadoHtml = `<span style="background:#dc2626; color:#ffffff; border:1px solid #b91c1c; font-size:9.5px; font-weight:800; padding:2.5px 7px; border-radius:7px; white-space:nowrap;">✕ RECHAZADO</span>`;
            } else if (esTimeout) {
                badgeEstadoHtml = `<span style="background:#dc2626; color:#ffffff; border:1px solid #b91c1c; font-size:9.5px; font-weight:800; padding:2.5px 7px; border-radius:7px; white-space:nowrap;">⏰ CANCELADO (1H)</span>`;
            } else if (esEntregado) {
                badgeEstadoHtml = `<span style="background:#2563eb; color:#ffffff; border:1px solid #1d4ed8; font-size:9.5px; font-weight:800; padding:2.5px 7px; border-radius:7px; white-space:nowrap;">✓ ENTREGADO</span>`;
            } else if (esEmbalado) {
                badgeEstadoHtml = `<span style="background:#dcfce7; color:#166534; border:1px solid #bbf7d0; font-size:9.5px; font-weight:800; padding:2.5px 6px; border-radius:7px; white-space:nowrap;">📦 EMBALADO</span>`;
            } else if (repartidorAsignado) {
                badgeEstadoHtml = `<span style="background:#d1fae5; color:#065f46; border:1px solid #6ee7b7; font-size:9.5px; font-weight:800; padding:2.5px 6px; border-radius:7px; white-space:nowrap;">🛵 EN CAMINO</span>`;
            } else if (esConfirmado) {
                badgeEstadoHtml = `<span style="background:#fef3c7; color:#b45309; border:1px solid #fde68a; font-size:9.5px; font-weight:800; padding:2.5px 6px; border-radius:7px; white-space:nowrap;">⏳ BUSCANDO CHOFER</span>`;
            } else {
                badgeEstadoHtml = `<span style="background:#ffedd5; color:#c2410c; border:1px solid #fed7aa; font-size:9.5px; font-weight:900; padding:2.5px 6px; border-radius:7px; white-space:nowrap; animation:pulse 2s infinite;">🔔 NUEVO</span>`;
            }

            const itemsArray = Array.isArray(p.items) ? p.items : [];
            const cantItems = itemsArray.reduce((acc, item) => acc + (Number(item.quantity || item.cantidad || 1)), 0);
            const abierto = pedidosExpandidos.has(p.id) || esNuevoPendiente;
            const iniciales = obtenerIniciales(p.cliente_nombre);

            // Tema cromático por estado:
            // - Cancelado / Rechazado -> ROJO
            // - Entregado -> AZUL / CELESTE
            // - Nuevo / Pendiente -> NARANJA / ÁMBAR
            // - Embalado / En curso -> VERDE ESMERALDA
            let cardBg = '#ffffff';
            let cardBorder = '#4ade80';
            let avatarBg = '#ecfdf5';
            let avatarBorder = '#6ee7b7';
            let avatarColor = '#065f46';
            let dotColor = '#10b981';
            let pillBg = '#ecfdf5';
            let pillColor = '#047857';
            let pillBorder = '#a7f3d0';
            let checkIcon = '<span style="color:#10b981; font-weight:800;">✓✓</span>';
            let totalColor = '#0f172a';

            if (esRechazado) {
                cardBg = '#fef2f2';
                cardBorder = '#f87171';
                avatarBg = '#fee2e2';
                avatarBorder = '#fca5a5';
                avatarColor = '#b91c1c';
                dotColor = '#dc2626';
                pillBg = '#fee2e2';
                pillColor = '#b91c1c';
                pillBorder = '#fca5a5';
                checkIcon = '<span style="color:#dc2626; font-weight:900;">✕</span>';
                totalColor = '#b91c1c';
            } else if (esEntregado) {
                cardBg = '#f0f7ff';
                cardBorder = '#93c5fd';
                avatarBg = '#dbeafe';
                avatarBorder = '#60a5fa';
                avatarColor = '#1e40af';
                dotColor = '#2563eb';
                pillBg = '#dbeafe';
                pillColor = '#1d4ed8';
                pillBorder = '#93c5fd';
                checkIcon = '<span style="color:#2563eb; font-weight:800;">✓✓</span>';
                totalColor = '#1e3a8a';
            } else if (esNuevoPendiente || esConfirmado) {
                cardBg = esNuevoPendiente ? '#fffbeb' : '#ffffff';
                cardBorder = '#fb923c';
                avatarBg = '#ffedd5';
                avatarBorder = '#fdba74';
                avatarColor = '#9a3412';
                dotColor = '#f97316';
                pillBg = '#ffedd5';
                pillColor = '#c2410c';
                pillBorder = '#fed7aa';
            }

            const resumenLinea = esRechazado
                ? `<span style="color:#b91c1c; font-weight:700;">${esCanceladoCliente ? 'Cancelado por el cliente' : (esRechazadoComercio ? 'Rechazado por el comercio' : 'Cancelado por tiempo de espera')} · ${cantItems} ítems</span>`
                : (repartidorAsignado
                    ? `Chofer: ${repartidorAsignado} · ${cantItems} ítems`
                    : (esNuevoPendiente ? `🔔 Tocar para aceptar o rechazar · ${cantItems} ítems` : `${cantItems} ítems · Pago Web`));

            html += `
                <div class="card rf-order-card" data-order-id="${p.id}" style="background:${cardBg}; border-radius:16px; border:1.5px solid ${cardBorder}; box-shadow:0 2px 8px rgba(15,23,42,0.04); padding:10px 12px; position:relative; transition:all 0.18s ease;">
                    
                    <!-- FILA COMPACTA (ESTILO MENSAJERÍA: AL CLICK SE ABRE PARA VER MÁS DETALLES) -->
                    <div onclick="window.RepartoFacilDespacho.toggleDetalle('${p.id}')" style="display:flex; align-items:center; gap:10px; cursor:pointer; user-select:none;">
                        <!-- Avatar Circular con Iniciales y Punto de Estado -->
                        <div style="position:relative; width:40px; height:40px; border-radius:999px; background:${avatarBg}; border:1.5px solid ${avatarBorder}; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:13px; color:${avatarColor}; flex-shrink:0;">
                            <span>${iniciales}</span>
                            <span style="position:absolute; bottom:-1px; right:-1px; width:11px; height:11px; border-radius:999px; background:${dotColor}; border:2px solid #fff;"></span>
                        </div>

                        <!-- Centro: Cliente + #RF + Dirección + Resumen -->
                        <div style="flex:1; min-width:0;">
                            <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:2px;">
                                <div style="display:flex; align-items:center; gap:6px; min-width:0; flex-wrap:wrap;">
                                    <span style="font-weight:800; font-size:13.5px; color:${esRechazado ? '#991b1b' : '#0f172a'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.cliente_nombre || 'Cliente'}</span>
                                    <span style="background:${pillBg}; color:${pillColor}; border:1px solid ${pillBorder}; font-family:monospace; font-size:10.5px; font-weight:800; padding:1px 6px; border-radius:999px; white-space:nowrap;">#${p.id}</span>
                                    ${badgeEstadoHtml}
                                </div>
                                <span style="color:#64748b; font-size:10.5px; font-weight:700; white-space:nowrap; flex-shrink:0;">${formatFecha(p.created_at)}</span>
                            </div>

                            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                                <div style="font-size:11.5px; color:#475569; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                    📍 ${p.direccion_entrega || 'Entrega a domicilio'}
                                </div>
                                <div style="font-size:13px; font-weight:900; color:${totalColor}; ${esRechazado ? 'text-decoration:line-through;' : ''} white-space:nowrap; flex-shrink:0;">
                                    ${formatMoney(p.total)}
                                </div>
                            </div>

                            <div style="font-size:11px; color:#64748b; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px;">
                                ${checkIcon} ${resumenLinea}
                            </div>
                        </div>

                        <!-- Flecha indicadora de desplegable -->
                        <div id="chevron-pedido-${p.id}" style="color:#94a3b8; font-size:16px; font-weight:800; flex-shrink:0; transition:transform 0.2s ease; transform:${abierto ? 'rotate(90deg)' : 'rotate(0deg)'};">
                            ›
                        </div>
                    </div>

                    <!-- PANEL EXPANDIBLE AL CLICK: DETALLES, TICKET Y ACCIONES -->
                    <div id="detalle-pedido-${p.id}" style="display:${abierto ? 'block' : 'none'}; margin-top:10px; padding-top:10px; border-top:1px solid #f1f5f9;">
                        
                        <!-- Barra de Ticket, Teléfono y Reasignación -->
                        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
                            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:6px;">
                                ${p.ticket_id ? `
                                    <button type="button" onclick="window.RepartoFacilDespacho.verTicket('${p.ticket_id}')" style="background:#eff6ff; color:#2563eb; border:1px solid #bfdbfe; border-radius:8px; font-size:10.5px; font-weight:800; padding:3px 8px; cursor:pointer; display:inline-flex; align-items:center; gap:3px; white-space:nowrap;">
                                        🧾 Ticket #${p.ticket_id} ↗
                                    </button>
                                ` : ''}
                                ${p.cliente_telefono ? `
                                    <span style="font-size:11px; color:#64748b; font-weight:600;">📞 ${p.cliente_telefono}</span>
                                    <a href="https://wa.me/${p.cliente_telefono.replace(/[^0-9]/g, '')}?text=Hola,%20nos%20comunicamos%20desde%20Cobro%20Fácil%20por%20tu%20pedido%20${p.id}" target="_blank" style="font-size:11px; color:#10b981; font-weight:800; text-decoration:none;">(WhatsApp)</a>
                                ` : ''}
                            </div>
                            ${repartidorAsignado && !esEntregado && !esRechazado ? `
                                <button type="button" onclick="window.RepartoFacilDespacho.liberarPorCustodio('${p.id}')" style="background:#fff1f2; color:#be123c; border:1px solid #fecdd3; border-radius:7px; font-size:10px; font-weight:800; padding:2px 6px; cursor:pointer;">
                                    ⚠️ Reasignar chofer
                                </button>
                            ` : ''}
                        </div>

                        <!-- Lista de Cortes e Ítems del Pedido -->
                        <div style="background:#f8fafc; border-radius:10px; padding:8px 10px; margin-bottom:8px; display:flex; flex-direction:column; gap:4px;">
                            ${itemsArray.map(item => `
                                <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; color:#1e293b;">
                                    <div>
                                        <b style="color:#0f172a;">${item.name || item.nombre || 'Artículo'}</b>
                                        <span style="color:#64748b; font-size:11px; margin-left:4px;">x ${item.quantity || item.cantidad || 1} ${item.unit || item.unidad || 'un'}</span>
                                    </div>
                                    <div style="font-weight:700; font-family:monospace;">
                                        ${formatMoney((item.price || item.precio || 0) * (item.quantity || item.cantidad || 1))}
                                    </div>
                                </div>
                            `).join('')}
                            ${p.notas ? `
                                <div style="margin-top:4px; font-size:11px; color:#b45309; background:#fffbeb; padding:5px 8px; border-radius:7px; border:1px solid #fde68a;">
                                    <b>Nota:</b> "${p.notas}"
                                </div>
                            ` : ''}
                        </div>

                        ${esNuevoPendiente ? `
                            <!-- DECISIÓN DE COBRO FÁCIL: ACEPTAR O RECHAZAR -->
                            <div style="background:#fff7ed; border:1px solid #ffedd5; border-radius:12px; padding:9px; margin-bottom:8px;">
                                <div style="font-size:10.5px; font-weight:800; color:#9a3412; margin-bottom:6px; text-transform:uppercase;">¿Aceptar pedido para despacho?</div>
                                <div style="display:flex; gap:8px;">
                                    <button type="button" class="btn" onclick="window.RepartoFacilDespacho.rechazarPedido('${p.id}')" style="flex:1; background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; border-radius:10px; font-size:11px; font-weight:800; padding:8px 6px !important; cursor:pointer;">
                                        ✕ Rechazar
                                    </button>
                                    <button type="button" class="btn" onclick="window.RepartoFacilDespacho.aceptarPedido('${p.id}')" style="flex:1.5; background:#10b981; color:#ffffff; border:none; border-radius:10px; font-size:11.5px; font-weight:900; padding:8px 8px !important; cursor:pointer; box-shadow:0 3px 8px rgba(16,185,129,0.35);">
                                        ✓ Aceptar y Publicar
                                    </button>
                                </div>
                            </div>
                        ` : ''}

                        <!-- BOTONES DE ACCIÓN: CERRAR DETALLE, CHAT Y EMBALADO -->
                        <div style="display:flex; gap:6px; width:100%; box-sizing:border-box;">
                            <button type="button" class="btn btn-ver-pedido" onclick="window.RepartoFacilDespacho.toggleDetalle('${p.id}')" style="flex:1; min-width:0; background:#f1f5f9; color:#334155; border:1px solid #cbd5e1; border-radius:10px; font-size:11px; font-weight:700; padding:8px 4px !important; gap:3px !important; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; white-space:nowrap;">
                                <span>📋</span>
                                <span>Ocultar</span>
                            </button>

                            <button type="button" class="btn btn-chat-pedido" onclick="window.RepartoFacilDespacho.abrirChat('${p.id}', '${p.cliente_nombre || 'Cliente'}')" style="flex:1; min-width:0; background:#e0f2fe; color:#0369a1; border:1px solid #7dd3fc; border-radius:10px; font-size:11px; font-weight:700; padding:8px 4px !important; gap:3px !important; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; white-space:nowrap;">
                                <span>💬</span>
                                <span>Chat</span>
                            </button>

                            <button type="button" class="btn btn-embalar-pedido" onclick="window.RepartoFacilDespacho.marcarEmbalado('${p.id}')" ${esRechazado ? 'disabled' : ''} style="flex:1.25; min-width:0; background:${esEmbalado ? '#10b981' : (esRechazado ? '#94a3b8' : '#047857')}; color:#ffffff; border:none; border-radius:10px; font-size:11px; font-weight:800; padding:8px 4px !important; gap:3px !important; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; box-shadow:0 2px 6px rgba(16,185,129,0.3); white-space:nowrap;">
                                <span>${esEmbalado ? '✓' : '📦'}</span>
                                <span>${esEmbalado ? 'Embalado' : 'Embalar'}</span>
                            </button>
                        </div>
                    </div>

                </div>
            `;
        });

        contenedor.innerHTML = html;
    }

    // Toggle para desplegar/ocultar detalles al click en la fila compacta
    function toggleDetalle(orderId) {
        const d = $('detalle-pedido-' + orderId);
        const chev = $('chevron-pedido-' + orderId);
        if (!d) return;
        const visible = d.style.display !== 'none';
        if (visible) {
            d.style.display = 'none';
            pedidosExpandidos.delete(orderId);
            if (chev) chev.style.transform = 'rotate(0deg)';
        } else {
            d.style.display = 'block';
            pedidosExpandidos.add(orderId);
            if (chev) chev.style.transform = 'rotate(90deg)';
        }
    }

    // Acción: ACEPTAR PEDIDO (Cobro Fácil emite Ticket y publica a repartidores)
    async function aceptarPedido(orderId) {
        try {
            mostrarToast(`⏳ Aceptando pedido #${orderId} y emitiendo Ticket…`);
            const resp = await fetch(`/api/repartofacil/pedidos/${orderId}/aceptar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await resp.json();
            if (data && data.success) {
                mostrarToast(`✅ Pedido #${orderId} aceptado con Ticket #${data.ticket_id}. Publicado a repartidores en zona.`);
                cargarPedidos(true);
            } else {
                alert('No se pudo aceptar el pedido: ' + (data.error || 'Error'));
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al aceptar pedido:', e);
            alert('Error de conexión al aceptar pedido.');
        }
    }

    // Acción: RECHAZAR PEDIDO
    async function rechazarPedido(orderId) {
        const conf = confirm(`¿Rechazar el pedido #${orderId}? Se notificará al comprador.`);
        if (!conf) return;

        try {
            const resp = await fetch(`/api/repartofacil/pedidos/${orderId}/rechazar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ motivo: 'Falta de stock en sucursal' })
            });
            const data = await resp.json();
            if (data && data.success) {
                mostrarToast(`Pedido #${orderId} rechazado.`);
                cargarPedidos(true);
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al rechazar pedido:', e);
        }
    }

    // Acción de marcar EMBALADO
    async function marcarEmbalado(orderId) {
        const order = pedidosLista.find(p => p.id === orderId);
        const card = document.querySelector(`.rf-order-card[data-order-id="${orderId}"]`);
        const btn = card ? card.querySelector('.btn-embalar-pedido') : null;

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<span>⏳</span><span>Embalando…</span>`;
        }

        try {
            const resp = await fetch(`/api/repartofacil/pedidos/${orderId}/embalar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await resp.json();

            if (data && data.success) {
                mostrarToast(`✅ Pedido #${orderId} embalado. Mensaje enviado al repartidor: "Pedido listo y embalado" 📦`);

                if (order) {
                    order.estado = 'ready';
                }
                renderizarCards();
            } else {
                alert('No se pudo marcar como embalado: ' + (data.error || 'Error'));
                if (btn) btn.disabled = false;
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al embalar:', e);
            alert('Error al conectar con el servidor.');
            if (btn) btn.disabled = false;
        }
    }

    // Modal de Ticket Digital Idéntico a Cobro Fácil (Captura del Usuario)
    async function verTicket(targetId) {
        let modal = $('rfTicketModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'rfTicketModal';
            modal.style.cssText = `
                position:fixed; inset:0; z-index:999999; background:rgba(15,23,42,0.6);
                display:flex; align-items:flex-end; sm:align-items:center; justify-content:center;
                backdrop-filter:blur(3px);
            `;
            modal.innerHTML = `
                <div class="rf-ticket-container" style="background:#fff; width:100%; max-width:400px; border-radius:24px 24px 0 0; sm:border-radius:24px; box-shadow:0 -10px 40px rgba(0,0,0,0.3); padding:20px 24px; max-height:90vh; overflow-y:auto; border:1px solid #e2e8f0; font-family:'Inter', sans-serif;">
                    
                    <div style="width:36px; height:4px; background:#cbd5e1; border-radius:999px; margin:0 auto 16px;"></div>

                    <h2 id="rfTicketNumero" style="margin:0 0 16px; font-size:22px; font-weight:800; color:#0f172a;">Ticket #------</h2>

                    <div style="display:flex; flex-direction:column; gap:10px; font-size:14px; margin-bottom:16px;">
                        <div style="display:flex; justify-content:space-between; color:#64748b;">
                            <span>Cuándo</span>
                            <b id="rfTicketFecha" style="color:#0f172a; font-weight:700;">2026-11-20 09:54:56</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; color:#64748b;">
                            <span>Pago</span>
                            <b id="rfTicketPago" style="color:#0f172a; font-weight:700;">Web</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; color:#64748b;">
                            <span>Cajero</span>
                            <span id="rfTicketCajero" style="color:#64748b;">—</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; color:#64748b;">
                            <span>Caja</span>
                            <span id="rfTicketCaja" style="color:#64748b;">—</span>
                        </div>
                    </div>

                    <!-- Lista de Cortes e Ítems -->
                    <div id="rfTicketItems" style="border-top:1px solid #f1f5f9; border-bottom:1px solid #f1f5f9; padding:12px 0; margin-bottom:16px; display:flex; flex-direction:column; gap:8px;">
                        <!-- Items inyectados -->
                    </div>

                    <!-- Total -->
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; font-size:16px;">
                        <span style="color:#64748b; font-weight:600;">Total</span>
                        <b id="rfTicketTotal" style="font-size:18px; font-weight:900; color:#0f172a;">$0,00</b>
                    </div>

                    <button type="button" onclick="window.RepartoFacilDespacho.cerrarTicketModal()" style="width:100%; background:#0f172a; color:#fff; border:none; border-radius:14px; padding:12px; font-size:14px; font-weight:800; cursor:pointer;">
                        Cerrar
                    </button>

                </div>
            `;
            document.body.appendChild(modal);
        } else {
            modal.style.display = 'flex';
        }

        try {
            const resp = await fetch(`/api/repartofacil/ticket/${targetId}`);
            const t = await resp.json();

            if (t && t.encontrado) {
                $('rfTicketNumero').textContent = `Ticket #${t.ticket_numero || t.id}`;
                $('rfTicketFecha').textContent = t.fecha || '2026-11-20 09:54:56';
                $('rfTicketPago').textContent = 'Web';
                $('rfTicketCajero').textContent = t.cajero || '—';
                $('rfTicketCaja').textContent = t.caja || '—';
                $('rfTicketTotal').textContent = formatMoneyDecimal(t.total);

                const itemsBox = $('rfTicketItems');
                itemsBox.innerHTML = (t.items || []).map(i => {
                    const cant = i.quantity || i.cantidad || 1;
                    const nombre = i.name || i.nombre || 'Corte cárnico';
                    const sub = (i.price || i.precio || 0) * cant;
                    return `
                        <div style="display:flex; justify-content:space-between; font-size:13.5px; color:#0f172a;">
                            <span>${nombre} · ${cant}</span>
                            <b style="font-weight:700;">${formatMoneyDecimal(sub)}</b>
                        </div>
                    `;
                }).join('') || '<div style="color:#94a3b8; font-size:12px;">Detalle de cortes registrado</div>';
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al cargar ticket:', e);
        }
    }

    function cerrarTicketModal() {
        const modal = $('rfTicketModal');
        if (modal) modal.style.display = 'none';
    }

    // Modal de Mensajería Tripartita en Vivo (Queda abierto como lazo permanente de venta)
    function abrirChat(orderId, clienteNombre) {
        orderChatActivo = orderId;
        const order = pedidosLista.find(p => p.id === orderId);
        let modal = $('rfChatModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'rfChatModal';
            modal.style.cssText = `
                position:fixed; inset:0; z-index:99999; background:rgba(15,23,42,0.7);
                display:flex; align-items:center; justify-content:center; padding:16px;
                backdrop-filter:blur(4px);
            `;
            modal.innerHTML = `
                <div style="background:#fff; width:100%; max-width:440px; border-radius:24px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.5); display:flex; flex-direction:column; max-height:85vh; overflow:hidden; border:1px solid #e2e8f0;">
                    
                    <!-- Header Chat con Ticket Digital Integrado -->
                    <div style="background:#0f172a; color:#fff; padding:14px 18px; display:flex; justify-content:space-between; align-items:center;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <div style="width:36px; height:36px; border-radius:12px; background:#10b981; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:14px;">
                                💬
                            </div>
                            <div>
                                <h4 id="rfChatTitle" style="margin:0; font-size:13px; font-weight:800; color:#fff;">Canal de Pedido</h4>
                                <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
                                    <small id="rfChatSub" style="color:#94a3b8; font-size:10px; font-weight:600;">Lazo Comercial Permanente</small>
                                    <button type="button" id="rfChatTicketBtn" style="display:none; background:#2563eb; color:#fff; border:none; border-radius:6px; font-size:9.5px; font-weight:800; padding:1px 6px; cursor:pointer;">
                                        🧾 Ticket
                                    </button>
                                </div>
                            </div>
                        </div>
                        <button type="button" onclick="window.RepartoFacilDespacho.cerrarChatModal()" style="background:transparent; border:none; color:#cbd5e1; font-size:22px; cursor:pointer; line-height:1;">
                            ✕
                        </button>
                    </div>

                    <!-- Mensajes Cuerpo -->
                    <div id="rfChatMessages" style="flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; background:#f8fafc; min-height:260px;">
                        <div style="text-align:center; color:#64748b; font-size:12px; padding:20px;">Cargando mensajes del pedido…</div>
                    </div>

                    <!-- Input Footer -->
                    <form onsubmit="window.RepartoFacilDespacho.enviarMensajeChat(event)" style="padding:12px; background:#fff; border-top:1px solid #e2e8f0; display:flex; gap:8px;">
                        <input id="rfChatInput" type="text" placeholder="Escribir al comprador o chofer…" style="flex:1; border:1px solid #cbd5e1; border-radius:12px; padding:10px 14px; font-size:13px; outline:none;" autocomplete="off" />
                        <button type="submit" style="background:#10b981; color:#fff; border:none; border-radius:12px; padding:0 18px; font-weight:800; font-size:13px; cursor:pointer;">
                            Enviar
                        </button>
                    </form>

                </div>
            `;
            document.body.appendChild(modal);
        } else {
            modal.style.display = 'flex';
        }

        $('rfChatTitle').textContent = `Chat Pedido #${orderId}`;
        $('rfChatSub').textContent = `Cliente: ${clienteNombre} · Blindado a orden #${orderId}`;
        
        const ticketBtn = $('rfChatTicketBtn');
        if (order && order.ticket_id) {
            ticketBtn.style.display = 'inline-block';
            ticketBtn.textContent = `🧾 Ticket #${order.ticket_id}`;
            ticketBtn.onclick = () => verTicket(order.ticket_id);
        } else {
            ticketBtn.style.display = 'none';
        }

        cargarMensajesChat(orderId);

        if (chatPollingTimer) clearInterval(chatPollingTimer);
        chatPollingTimer = setInterval(() => {
            if (orderChatActivo) cargarMensajesChat(orderChatActivo);
        }, 3000);
    }

    function cerrarChatModal() {
        orderChatActivo = null;
        if (chatPollingTimer) {
            clearInterval(chatPollingTimer);
            chatPollingTimer = null;
        }
        const modal = $('rfChatModal');
        if (modal) modal.style.display = 'none';
    }

    function escaparTextoChat(valor) {
        return String(valor == null ? '' : valor)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async function cargarMensajesChat(orderId) {
        const box = $('rfChatMessages');
        if (!box) return;

        try {
            const resp = await fetch(`/api/repartofacil/chat/${encodeURIComponent(orderId)}`);
            const data = await resp.json();
            if (orderChatActivo !== orderId) return;
            if (!resp.ok || !data.success || !Array.isArray(data.mensajes)) {
                throw new Error(data.error || 'No se pudo cargar la conversación.');
            }

            {
                if (data.mensajes.length === 0) {
                    box.innerHTML = `
                        <div style="text-align:center; padding:24px; color:#64748b; font-size:12px;">
                            Sin mensajes todavía. Cuando el pedido sea aceptado o embalado, los avisos se registrarán acá en vivo.
                        </div>
                    `;
                    return;
                }

                box.innerHTML = data.mensajes.map(m => {
                    const esSistema = m.author_role === 'system';
                    if (esSistema) {
                        return `
                            <div style="align-self:center; width:100%; margin:6px 0;">
                                <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:10px 12px; font-size:12px; text-align:center; box-shadow:0 1px 3px rgba(0,0,0,0.04);">
                                    <div style="font-size:10px; font-weight:800; color:#b45309; text-transform:uppercase; margin-bottom:3px; display:flex; align-items:center; justify-content:center; gap:4px;">
                                        <span>🛡️</span>
                                        <span>${escaparTextoChat(m.author_name || 'Custodio del Sistema')} · ${escaparTextoChat(m.timestamp_str || '')}</span>
                                    </div>
                                    <div style="color:#78350f; font-weight:600;">${escaparTextoChat(m.content)}</div>
                                </div>
                            </div>
                        `;
                    }

                    const esMio = m.author_role === 'store';
                    const esChofer = m.author_role === 'driver';
                    const emisor = esMio ? 'Comercio (Tú)' : (esChofer ? `Repartidor (${m.author_name || 'Repartidor'})` : `Comprador (${m.author_name || 'Cliente'})`);

                    return `
                        <div style="align-self:${esMio ? 'flex-end' : 'flex-start'}; max-width:82%; display:flex; flex-direction:column; align-items:${esMio ? 'flex-end' : 'flex-start'};">
                            <span style="font-size:10px; color:#64748b; font-weight:700; margin-bottom:2px; padding:0 4px;">${escaparTextoChat(emisor)} · ${escaparTextoChat(m.timestamp_str || '')}</span>
                            <div style="background:${esMio ? '#10b981' : (esChofer ? '#0f172a' : '#ffffff')}; color:${esMio || esChofer ? '#ffffff' : '#0f172a'}; padding:8px 12px; border-radius:14px; font-size:12.5px; border:1px solid ${esMio ? '#059669' : (esChofer ? '#1e293b' : '#cbd5e1')}; box-shadow:0 1px 3px rgba(0,0,0,0.05); word-break:break-word;">
                                ${escaparTextoChat(m.content)}
                            </div>
                        </div>
                    `;
                }).join('');

                box.scrollTop = box.scrollHeight;
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al cargar chat:', e);
            if (orderChatActivo === orderId) {
                box.textContent = e.message || 'No se pudo cargar la conversación.';
            }
        }
    }

    async function enviarMensajeChat(ev) {
        if (ev) ev.preventDefault();
        const input = $('rfChatInput');
        if (!input || !orderChatActivo) return;
        const texto = input.value.trim();
        if (!texto) return;

        const orderId = orderChatActivo;

        try {
            const resp = await fetch(`/api/repartofacil/chat/${encodeURIComponent(orderId)}/mensaje`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: texto })
            });
            const data = await resp.json();
            if (!resp.ok || !data.success) {
                throw new Error(data.error || 'No se pudo enviar el mensaje.');
            }
            if (orderChatActivo === orderId) {
                if (input.value.trim() === texto) input.value = '';
                cargarMensajesChat(orderId);
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al enviar chat:', e);
            mostrarToast(escaparTextoChat(e.message || 'No se pudo enviar el mensaje.'));
        }
    }

    // Feedback Toast Flotante
    function mostrarToast(mensaje) {
        let toast = $('rfToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'rfToast';
            toast.style.cssText = `
                position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
                background:#0f172a; color:#fff; padding:12px 20px; border-radius:16px;
                font-size:13px; font-weight:800; z-index:999999; box-shadow:0 10px 25px rgba(0,0,0,0.4);
                border:1px solid #10b981; display:flex; align-items:center; gap:8px; transition:opacity 0.3s ease;
            `;
            document.body.appendChild(toast);
        }
        toast.innerHTML = mensaje;
        toast.style.opacity = '1';
        toast.style.display = 'flex';
        setTimeout(() => {
            if (toast) {
                toast.style.opacity = '0';
                setTimeout(() => { toast.style.display = 'none'; }, 300);
            }
        }, 4000);
    }

    // Acción Custodio: Reincorporar pedido a bandeja por desconexión / falta de respuesta del chofer
    async function liberarPorCustodio(orderId) {
        if (!confirm(`¿Deseas desvincular al repartidor del pedido #${orderId} y devolverlo a la bandeja pública por desconexión o inactividad?`)) {
            return;
        }
        try {
            const resp = await fetch(`/api/repartofacil/pedidos/${orderId}/custodio/liberar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ motivo: 'inactividad y falta de respuesta del chofer' })
            });
            const data = await resp.json();
            if (data.success) {
                mostrarToast(`Pedido #${orderId} devuelto a la bandeja disponible`);
                cargarPedidos();
                if (orderChatActivo === orderId) {
                    cargarMensajesChat(orderId);
                }
            } else {
                alert(data.error || 'No se pudo liberar el pedido');
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al liberar:', e);
        }
    }

    // API pública del módulo
    global.RepartoFacilDespacho = {
        iniciar,
        detener,
        cargarPedidos,
        toggleDetalle,
        aceptarPedido,
        rechazarPedido,
        marcarEmbalado,
        liberarPorCustodio,
        verTicket,
        cerrarTicketModal,
        abrirChat,
        cerrarChatModal,
        enviarMensajeChat
    };

})(window);
