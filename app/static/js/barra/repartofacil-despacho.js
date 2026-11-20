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
            if (data && data.success && Array.isArray(data.pedidos)) {
                pedidosLista = data.pedidos;
                try {
                    localStorage.setItem('cf_rf_pedidos_cache', JSON.stringify(pedidosLista));
                } catch(e) {}
                renderizarCards();
                actualizarBadge();
            } else if (!silencioso) {
                // Mini-motor fallback: si hay cache local, renderizarlo para que el sistema siga vivo
                const cache = localStorage.getItem('cf_rf_pedidos_cache');
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
            // Mini-motor fallback resiliente
            const cache = localStorage.getItem('cf_rf_pedidos_cache');
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
            const esRechazado = estadoLower === 'rejected' || estadoLower === 'cancelled' || esTimeout;
            const esConfirmado = estadoLower === 'confirmed' || estadoLower === 'accepted';
            const esEmbalado = estadoLower === 'ready' || estadoLower === 'embalado';
            const esEntregado = estadoLower === 'delivered';
            const repartidorAsignado = p.repartidor_nombre || (p.repartidor_id ? 'Lucas Motomensajero' : null);

            let badgeEstadoHtml = '';
            if (esTimeout) {
                badgeEstadoHtml = `<span style="background:#fef3c7; color:#92400e; border:1px solid #fde68a; font-size:9.5px; font-weight:800; padding:2.5px 6px; border-radius:7px; white-space:nowrap;">⏰ TIMEOUT</span>`;
            } else if (esRechazado) {
                badgeEstadoHtml = `<span style="background:#fee2e2; color:#b91c1c; border:1px solid #fecaca; font-size:9.5px; font-weight:800; padding:2.5px 6px; border-radius:7px; white-space:nowrap;">❌ RECHAZADO</span>`;
            } else if (esEntregado) {
                badgeEstadoHtml = `<span style="background:#e2e8f0; color:#475569; font-size:9.5px; font-weight:800; padding:2.5px 6px; border-radius:7px; white-space:nowrap;">✅ ENTREGADO</span>`;
            } else if (esEmbalado) {
                badgeEstadoHtml = `<span style="background:#dcfce7; color:#166534; border:1px solid #bbf7d0; font-size:9.5px; font-weight:800; padding:2.5px 6px; border-radius:7px; white-space:nowrap;">📦 EMBALADO</span>`;
            } else if (repartidorAsignado) {
                badgeEstadoHtml = `<span style="background:#dbeafe; color:#1e40af; border:1px solid #bfdbfe; font-size:9.5px; font-weight:800; padding:2.5px 6px; border-radius:7px; white-space:nowrap;">🛵 ASIGNADO</span>`;
            } else if (esConfirmado) {
                badgeEstadoHtml = `<span style="background:#fef3c7; color:#b45309; border:1px solid #fde68a; font-size:9.5px; font-weight:800; padding:2.5px 6px; border-radius:7px; white-space:nowrap;">⏳ BUSCANDO CHOFER</span>`;
            } else {
                badgeEstadoHtml = `<span style="background:#ffedd5; color:#c2410c; border:1px solid #fed7aa; font-size:9.5px; font-weight:900; padding:2.5px 6px; border-radius:7px; white-space:nowrap; animation:pulse 2s infinite;">🔔 NUEVO</span>`;
            }

            const itemsArray = Array.isArray(p.items) ? p.items : [];
            const cantItems = itemsArray.reduce((acc, item) => acc + (Number(item.quantity || item.cantidad || 1)), 0);

            html += `
                <div class="card rf-order-card" data-order-id="${p.id}" style="background:#fff; border-radius:18px; border:1.5px solid ${esEmbalado ? '#86efac' : (esNuevoPendiente ? '#fdba74' : '#e2e8f0')}; box-shadow:0 4px 12px rgba(15,23,42,0.04); padding:12px; position:relative; transition:all 0.2s ease;">
                    
                    <!-- Fila Superior: ID, Ticket #, Hora y Badge de Estado (Responsive Mobile) -->
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; border-bottom:1px solid #f1f5f9; padding-bottom:8px; margin-bottom:10px;">
                        <div style="display:flex; align-items:center; flex-wrap:wrap; gap:6px;">
                            <span style="font-weight:900; font-size:13.5px; color:#0f172a; font-family:monospace; white-space:nowrap; letter-spacing:-0.2px;">#${p.id}</span>
                            ${p.ticket_id ? `
                                <button type="button" onclick="window.RepartoFacilDespacho.verTicket('${p.ticket_id}')" style="background:#eff6ff; color:#2563eb; border:1px solid #bfdbfe; border-radius:8px; font-size:10px; font-weight:800; padding:2px 6px; cursor:pointer; display:inline-flex; align-items:center; gap:2px; white-space:nowrap;">
                                    🧾 Ticket #${p.ticket_id} ↗
                                </button>
                            ` : ''}
                            <span style="color:#64748b; font-size:10.5px; font-weight:600; white-space:nowrap;">🕒 ${formatFecha(p.created_at)}</span>
                        </div>
                        <div style="flex-shrink:0;">${badgeEstadoHtml}</div>
                    </div>

                    <!-- Datos del Cliente y Entrega -->
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
                        <div style="min-width:0; flex:1; padding-right:10px;">
                            <h4 style="margin:0 0 3px; font-size:13.5px; font-weight:800; color:#0f172a; display:flex; align-items:center; gap:6px;">
                                <span>👤 ${p.cliente_nombre || 'Cliente Reparto Fácil'}</span>
                            </h4>
                            <div style="font-size:12px; color:#475569; font-weight:600; display:flex; align-items:center; gap:4px; margin-bottom:2px;">
                                <span>📍</span>
                                <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.direccion_entrega || 'Entrega a domicilio'}</span>
                            </div>
                            ${p.cliente_telefono ? `
                                <div style="font-size:11px; color:#64748b; display:flex; align-items:center; gap:6px; margin-top:2px;">
                                    <span>📞 ${p.cliente_telefono}</span>
                                    <a href="https://wa.me/${p.cliente_telefono.replace(/[^0-9]/g, '')}?text=Hola,%20nos%20comunicamos%20desde%20Cobro%20Fácil%20por%20tu%20pedido%20${p.id}" target="_blank" style="color:#10b981; font-weight:700; text-decoration:none;">(WhatsApp)</a>
                                </div>
                            ` : ''}
                        </div>

                        <!-- Monto Total -->
                        <div style="text-align:right; flex-shrink:0;">
                            <div style="font-size:10px; font-weight:800; text-transform:uppercase; color:#64748b;">A Cobrar</div>
                            <div style="font-size:15px; font-weight:900; color:#0f172a;">${formatMoney(p.total)}</div>
                            <div style="font-size:10px; font-weight:700; color:#10b981;">WEB</div>
                        </div>
                    </div>

                    <!-- Repartidor Asignado Info -->
                    <div style="background:#f8fafc; border-radius:12px; padding:7px 9px; margin-bottom:10px; display:flex; align-items:center; justify-content:space-between; font-size:11px;">
                        <div style="display:flex; align-items:center; gap:5px; color:#334155; font-weight:700; min-width:0; overflow:hidden;">
                            <span>🛵</span>
                            <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${repartidorAsignado ? `Chofer: <b style="color:#0f172a;">${repartidorAsignado}</b>` : (esConfirmado ? '<span style="color:#d97706;">Buscando chofer en la zona…</span>' : (esNuevoPendiente ? '<span style="color:#ea580c;">Esperando aceptación</span>' : '<span style="color:#94a3b8;">Sin chofer</span>'))}</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:5px; flex-shrink:0;">
                            ${repartidorAsignado && !esEntregado && !esRechazado ? `
                                <button type="button" onclick="window.RepartoFacilDespacho.liberarPorCustodio('${p.id}')" title="Reincorporar a la bandeja pública si el chofer no responde o se desconectó" style="background:#fff1f2; color:#be123c; border:1px solid #fecdd3; border-radius:7px; font-size:9.5px; font-weight:800; padding:2px 5px; cursor:pointer;">
                                    ⚠️ Reasignar
                                </button>
                            ` : ''}
                            <span style="color:#64748b; font-weight:600; font-size:10.5px;">${cantItems} ítems</span>
                        </div>
                    </div>

                    <!-- ACCIONES CONDICIONALES SEGÚN ESTADO: -->
                    ${esNuevoPendiente ? `
                        <!-- 1. DECISIÓN DE COBRO FÁCIL: ACEPTAR O RECHAZAR -->
                        <div style="background:#fff7ed; border:1px solid #ffedd5; border-radius:14px; padding:10px; margin-bottom:10px;">
                            <div style="font-size:11px; font-weight:800; color:#9a3412; margin-bottom:8px; text-transform:uppercase;">¿Aceptar pedido para despacho?</div>
                            <div style="display:flex; gap:8px;">
                                <button type="button" class="btn" onclick="window.RepartoFacilDespacho.rechazarPedido('${p.id}')" style="flex:1; background:#fee2e2; hover:background:#fecaca; color:#b91c1c; border:1px solid #fca5a5; border-radius:12px; font-size:11px; font-weight:800; padding:9px 6px; cursor:pointer;">
                                    ✕ Rechazar
                                </button>
                                <button type="button" class="btn" onclick="window.RepartoFacilDespacho.aceptarPedido('${p.id}')" style="flex:1.5; background:#10b981; hover:background:#059669; color:#ffffff; border:none; border-radius:12px; font-size:11.5px; font-weight:900; padding:9px 8px; cursor:pointer; box-shadow:0 3px 8px rgba(16,185,129,0.35);">
                                    ✓ Aceptar y Publicar
                                </button>
                            </div>
                        </div>
                    ` : ''}

                    <!-- BOTONES ESENCIALES: DETALLE, MENSAJERÍA Y EMBALADO (Adaptables a Mobile) -->
                    <div style="display:flex; gap:6px; margin-top:8px; width:100%; box-sizing:border-box;">
                        <!-- 1. Botón Detalle (Desplegable) -->
                        <button type="button" class="btn btn-ver-pedido" onclick="window.RepartoFacilDespacho.toggleDetalle('${p.id}')" style="flex:1; min-width:0; background:#f1f5f9; hover:background:#e2e8f0; color:#334155; border:1px solid #cbd5e1; border-radius:10px; font-size:11px; font-weight:700; padding:8px 4px !important; gap:3px !important; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; white-space:nowrap;">
                            <span>📋</span>
                            <span>Ver</span>
                        </button>

                        <!-- 2. Botón Mensajería Privada Tripartita -->
                        <button type="button" class="btn btn-chat-pedido" onclick="window.RepartoFacilDespacho.abrirChat('${p.id}', '${p.cliente_nombre || 'Cliente'}')" style="flex:1; min-width:0; background:#e0f2fe; hover:background:#bae6fd; color:#0369a1; border:1px solid #7dd3fc; border-radius:10px; font-size:11px; font-weight:700; padding:8px 4px !important; gap:3px !important; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; white-space:nowrap;">
                            <span>💬</span>
                            <span>Chat</span>
                        </button>

                        <!-- 3. Botón Embalado -->
                        <button type="button" class="btn btn-embalar-pedido" onclick="window.RepartoFacilDespacho.marcarEmbalado('${p.id}')" ${esRechazado ? 'disabled' : ''} style="flex:1.25; min-width:0; background:${esEmbalado ? '#10b981' : (esRechazado ? '#94a3b8' : '#047857')}; color:#ffffff; border:none; border-radius:10px; font-size:11px; font-weight:800; padding:8px 4px !important; gap:3px !important; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; box-shadow:0 2px 6px rgba(16,185,129,0.3); white-space:nowrap;">
                            <span>${esEmbalado ? '✓' : '📦'}</span>
                            <span>${esEmbalado ? 'Embalado' : 'Embalar'}</span>
                        </button>
                    </div>

                    <!-- DESGLOSE DE PRODUCTOS (OCULTO POR DEFECTO, SE ABRE AL CLICK) -->
                    <div id="detalle-pedido-${p.id}" style="display:none; margin-top:12px; padding-top:12px; border-top:1px dashed #cbd5e1; background:#f8fafc; border-radius:12px; padding:10px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <div style="font-size:11px; font-weight:800; text-transform:uppercase; color:#64748b;">Detalle de Cortes e Ítems:</div>
                            ${p.ticket_id ? `<button type="button" onclick="window.RepartoFacilDespacho.verTicket('${p.ticket_id}')" style="background:none; border:none; color:#2563eb; font-size:11px; font-weight:800; cursor:pointer;">Ver Ticket Digital #109${p.ticket_id.slice(-4)} ↗</button>` : ''}
                        </div>
                        <div style="display:flex; flex-direction:column; gap:4px;">
                            ${itemsArray.map(item => `
                                <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; color:#1e293b; padding:3px 0; border-bottom:1px solid #f1f5f9;">
                                    <div>
                                        <b style="color:#0f172a;">${item.name || item.nombre || 'Corte cárnico'}</b>
                                        <span style="color:#64748b; font-size:11px; margin-left:4px;">x ${item.quantity || item.cantidad || 1} ${item.unit || item.unidad || 'kg'}</span>
                                    </div>
                                    <div style="font-weight:700; font-family:monospace;">
                                        ${formatMoney((item.price || item.precio || 0) * (item.quantity || item.cantidad || 1))}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                        ${p.notas ? `
                            <div style="margin-top:8px; font-size:11px; color:#b45309; background:#fffbeb; padding:6px 8px; border-radius:8px; border:1px solid #fde68a;">
                                <b>Nota del cliente:</b> "${p.notas}"
                            </div>
                        ` : ''}
                    </div>

                </div>
            `;
        });

        contenedor.innerHTML = html;
    }

    // Toggle para ver los ítems del pedido ("al click se ve el pedido")
    function toggleDetalle(orderId) {
        const d = $('detalle-pedido-' + orderId);
        if (d) {
            d.style.display = d.style.display === 'none' ? 'block' : 'none';
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

    async function cargarMensajesChat(orderId) {
        const box = $('rfChatMessages');
        if (!box) return;

        try {
            const resp = await fetch(`/api/repartofacil/chat/${orderId}`);
            const data = await resp.json();

            if (data && data.success && Array.isArray(data.mensajes)) {
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
                                        <span>${m.author_name || 'Custodio del Sistema'} · ${m.timestamp_str || ''}</span>
                                    </div>
                                    <div style="color:#78350f; font-weight:600;">${m.content}</div>
                                </div>
                            </div>
                        `;
                    }

                    const esMio = m.author_role === 'store';
                    const esChofer = m.author_role === 'driver';
                    const emisor = esMio ? 'Frigorífico Maciel (Tú)' : (esChofer ? `Repartidor (${m.author_name || 'Lucas'})` : `Comprador (${m.author_name || 'Cliente'})`);

                    return `
                        <div style="align-self:${esMio ? 'flex-end' : 'flex-start'}; max-width:82%; display:flex; flex-direction:column; align-items:${esMio ? 'flex-end' : 'flex-start'};">
                            <span style="font-size:10px; color:#64748b; font-weight:700; margin-bottom:2px; padding:0 4px;">${emisor} · ${m.timestamp_str || ''}</span>
                            <div style="background:${esMio ? '#10b981' : (esChofer ? '#0f172a' : '#ffffff')}; color:${esMio || esChofer ? '#ffffff' : '#0f172a'}; padding:8px 12px; border-radius:14px; font-size:12.5px; border:1px solid ${esMio ? '#059669' : (esChofer ? '#1e293b' : '#cbd5e1')}; box-shadow:0 1px 3px rgba(0,0,0,0.05); word-break:break-word;">
                                ${m.content}
                            </div>
                        </div>
                    `;
                }).join('');

                box.scrollTop = box.scrollHeight;
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al cargar chat:', e);
        }
    }

    async function enviarMensajeChat(ev) {
        if (ev) ev.preventDefault();
        const input = $('rfChatInput');
        if (!input || !orderChatActivo) return;
        const texto = input.value.trim();
        if (!texto) return;

        input.value = '';

        try {
            await fetch(`/api/repartofacil/chat/${orderChatActivo}/mensaje`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: texto })
            });
            cargarMensajesChat(orderChatActivo);
        } catch (e) {
            console.error('[RepartoFacil] Error al enviar chat:', e);
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
