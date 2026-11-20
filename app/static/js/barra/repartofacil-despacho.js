/* ==============================================================================
   REPARTO FÁCIL DESPACHO & EMBALADO (Cobro Fácil PRO)
   Recepción de pedidos de clientes, detalle de cortes, chat y aviso de embalado
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
        
        // Polling cada 8 segundos para nuevos pedidos
        if (timerPolling) clearInterval(timerPolling);
        timerPolling = setInterval(() => {
            const wrapVisible = $('pedidosRepartoFacilWrap');
            if (wrapVisible && wrapVisible.style.display !== 'none') {
                cargarPedidos(true); // background silent
            } else {
                clearInterval(timerPolling);
                timerPolling = null;
            }
        }, 8000);
    }

    // Detener polling
    function detener() {
        if (timerPolling) {
            clearInterval(timerPolling);
            timerPolling = null;
        }
        cerrarChatModal();
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
                renderizarCards();
                actualizarBadge();
            } else if (!silencioso) {
                contenedor.innerHTML = `<div style="text-align:center; padding:24px; color:#ef4444; font-weight:700;">No se pudieron cargar los pedidos. Reintentá en unos segundos.</div>`;
            }
        } catch (err) {
            console.error('[RepartoFacil] Error al cargar pedidos:', err);
            if (!silencioso) {
                contenedor.innerHTML = `<div style="text-align:center; padding:24px; color:#ef4444; font-weight:700;">Error de conexión con el servidor.</div>`;
            }
        }
    }

    // Actualiza el badge en la barra superior
    function actualizarBadge() {
        const badge = $('repartoFacilCountBadge');
        if (!badge) return;
        const activos = pedidosLista.filter(p => p.estado !== 'delivered' && p.estado !== 'cancelled');
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
                        Los pedidos que los clientes realicen desde la tienda online aparecerán automáticamente aquí listos para preparar y embalar.
                    </p>
                </div>
            `;
            return;
        }

        let html = '';
        pedidosLista.forEach((p, idx) => {
            const estadoLower = (p.estado || 'pending').toLowerCase();
            const esEmbalado = estadoLower === 'ready' || estadoLower === 'embalado';
            const esEntregado = estadoLower === 'delivered';
            const repartidorAsignado = p.repartidor_nombre || (p.repartidor_id ? 'Lucas Motomensajero' : null);

            let badgeEstadoHtml = '';
            if (esEntregado) {
                badgeEstadoHtml = `<span style="background:#e2e8f0; color:#475569; font-size:10px; font-weight:800; padding:3px 8px; border-radius:8px;">✅ ENTREGADO</span>`;
            } else if (esEmbalado) {
                badgeEstadoHtml = `<span style="background:#dcfce7; color:#166534; border:1px solid #bbf7d0; font-size:10px; font-weight:800; padding:3px 8px; border-radius:8px;">📦 EMBALADO / LISTO</span>`;
            } else if (repartidorAsignado) {
                badgeEstadoHtml = `<span style="background:#dbeafe; color:#1e40af; border:1px solid #bfdbfe; font-size:10px; font-weight:800; padding:3px 8px; border-radius:8px;">🛵 ASIGNADO A CHOFER</span>`;
            } else {
                badgeEstadoHtml = `<span style="background:#fef3c7; color:#92400e; border:1px solid #fde68a; font-size:10px; font-weight:800; padding:3px 8px; border-radius:8px;">⏳ NUEVO PEDIDO</span>`;
            }

            const itemsArray = Array.isArray(p.items) ? p.items : [];
            const cantItems = itemsArray.reduce((acc, item) => acc + (Number(item.quantity || item.cantidad || 1)), 0);

            html += `
                <div class="card rf-order-card" data-order-id="${p.id}" style="background:#fff; border-radius:18px; border:1.5px solid ${esEmbalado ? '#86efac' : '#e2e8f0'}; box-shadow:0 4px 12px rgba(15,23,42,0.04); padding:14px; position:relative; transition:all 0.2s ease;">
                    
                    <!-- Fila Superior: ID, Hora y Badge de Estado -->
                    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #f1f5f9; padding-bottom:8px; margin-bottom:10px;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-weight:900; font-size:14px; color:#0f172a; font-family:monospace;">#${p.id}</span>
                            <span style="color:#64748b; font-size:11px; font-weight:600;">🕒 ${formatFecha(p.created_at)}</span>
                        </div>
                        <div>${badgeEstadoHtml}</div>
                    </div>

                    <!-- Datos del Cliente y Entrega -->
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
                        <div style="min-width:0; flex:1; padding-right:10px;">
                            <h4 style="margin:0 0 3px; font-size:14px; font-weight:800; color:#0f172a; display:flex; align-items:center; gap:6px;">
                                <span>👤 ${p.cliente_nombre || 'Cliente Reparto Fácil'}</span>
                            </h4>
                            <div style="font-size:12px; color:#475569; font-weight:600; display:flex; align-items:center; gap:4px; margin-bottom:2px;">
                                <span>📍</span>
                                <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.direccion_entrega || 'Entrega a domicilio'}</span>
                            </div>
                            ${p.cliente_telefono ? `
                                <div style="font-size:11px; color:#64748b; display:flex; align-items:center; gap:6px; margin-top:2px;">
                                    <span>📞 ${p.cliente_telefono}</span>
                                    <a href="https://wa.me/${p.cliente_telefono.replace(/[^0-9]/g, '')}?text=Hola,%20nos%20comunicamos%20desde%20Frigorífico%20Maciel%20por%20tu%20pedido%20${p.id}" target="_blank" style="color:#10b981; font-weight:700; text-decoration:none;">(WhatsApp)</a>
                                </div>
                            ` : ''}
                        </div>

                        <!-- Monto Total -->
                        <div style="text-align:right; flex-shrink:0;">
                            <div style="font-size:10px; font-weight:800; text-transform:uppercase; color:#64748b;">A Cobrar</div>
                            <div style="font-size:16px; font-weight:900; color:#0f172a;">${formatMoney(p.total)}</div>
                            <div style="font-size:10px; font-weight:700; color:#10b981;">${(p.metodo_pago || 'efectivo').toUpperCase()}</div>
                        </div>
                    </div>

                    <!-- Repartidor Asignado Info -->
                    <div style="background:#f8fafc; border-radius:12px; padding:8px 10px; margin-bottom:10px; display:flex; align-items:center; justify-content:space-between; font-size:11px;">
                        <div style="display:flex; align-items:center; gap:6px; color:#334155; font-weight:700;">
                            <span>🛵</span>
                            <span>${repartidorAsignado ? `Repartidor: <b style="color:#0f172a;">${repartidorAsignado}</b>` : '<span style="color:#94a3b8;">Esperando repartidor en camino…</span>'}</span>
                        </div>
                        <span style="color:#64748b; font-weight:600;">${cantItems} cortes cárnicos</span>
                    </div>

                    <!-- BOTONES ESENCIALES: DETALLE (AL CLICK SE VE EL PEDIDO), MENSAJERÍA Y EMBALADO -->
                    <div style="display:grid; grid-template-columns: 1fr 1fr 1.3fr; gap:6px; margin-top:8px;">
                        <!-- 1. Botón Detalle (Desplegable) -->
                        <button type="button" class="btn btn-ver-pedido" onclick="window.RepartoFacilDespacho.toggleDetalle('${p.id}')" style="background:#f1f5f9; hover:background:#e2e8f0; color:#334155; border:1px solid #cbd5e1; border-radius:12px; font-size:11px; font-weight:700; padding:8px 4px; display:flex; align-items:center; justify-content:center; gap:4px; cursor:pointer;">
                            <span>📋</span>
                            <span>Ver Pedido</span>
                        </button>

                        <!-- 2. Botón Mensajería Privada Tripartita -->
                        <button type="button" class="btn btn-chat-pedido" onclick="window.RepartoFacilDespacho.abrirChat('${p.id}', '${p.cliente_nombre || 'Cliente'}')" style="background:#e0f2fe; hover:background:#bae6fd; color:#0369a1; border:1px solid #7dd3fc; border-radius:12px; font-size:11px; font-weight:700; padding:8px 4px; display:flex; align-items:center; justify-content:center; gap:4px; cursor:pointer;">
                            <span>💬</span>
                            <span>Mensajería</span>
                        </button>

                        <!-- 3. Botón Embalado -->
                        <button type="button" class="btn btn-embalar-pedido" onclick="window.RepartoFacilDespacho.marcarEmbalado('${p.id}')" style="background:${esEmbalado ? '#10b981' : '#047857'}; color:#ffffff; border:none; border-radius:12px; font-size:11px; font-weight:800; padding:8px 4px; display:flex; align-items:center; justify-content:center; gap:4px; cursor:pointer; box-shadow:0 2px 6px rgba(16,185,129,0.3);">
                            <span>${esEmbalado ? '✓' : '📦'}</span>
                            <span>${esEmbalado ? 'Embalado' : 'Embalar'}</span>
                        </button>
                    </div>

                    <!-- DESGLOSE DE PRODUCTOS (OCULTO POR DEFECTO, SE ABRE AL CLICK) -->
                    <div id="detalle-pedido-${p.id}" style="display:none; margin-top:12px; padding-top:12px; border-top:1px dashed #cbd5e1; background:#f8fafc; border-radius:12px; padding:10px;">
                        <div style="font-size:11px; font-weight:800; text-transform:uppercase; color:#64748b; margin-bottom:6px;">Detalle de Cortes e Ítems:</div>
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
                // Notificación visual flotante
                mostrarToast(`✅ Pedido #${orderId} embalado. Mensaje enviado al repartidor: "Pedido listo y embalado" 📦`);

                // Actualizar estado local
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

    // Modal de Mensajería Tripartita en Vivo
    function abrirChat(orderId, clienteNombre) {
        orderChatActivo = orderId;
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
                    
                    <!-- Header Chat -->
                    <div style="background:#0f172a; color:#fff; padding:14px 18px; display:flex; justify-content:space-between; align-items:center;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <div style="width:36px; height:36px; border-radius:12px; background:#10b981; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:14px;">
                                💬
                            </div>
                            <div>
                                <h4 id="rfChatTitle" style="margin:0; font-size:13px; font-weight:800; color:#fff;">Canal de Pedido</h4>
                                <small id="rfChatSub" style="color:#94a3b8; font-size:10px; font-weight:600;">Repartidor · Cliente · Frigorífico Maciel</small>
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
                        <input id="rfChatInput" type="text" placeholder="Escribir al repartidor y cliente…" style="flex:1; border:1px solid #cbd5e1; border-radius:12px; padding:10px 14px; font-size:13px; outline:none;" autocomplete="off" />
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
        $('rfChatSub').textContent = `Cliente: ${clienteNombre} · Canal Tripartito`;
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
                            Sin mensajes todavía. Cuando el pedido esté embalado, el aviso se publicará acá automáticamente.
                        </div>
                    `;
                    return;
                }

                box.innerHTML = data.mensajes.map(m => {
                    const esMio = m.author_role === 'store';
                    const esChofer = m.author_role === 'driver';
                    const emisor = esMio ? 'Frigorífico Maciel (Tú)' : (esChofer ? `Repartidor (${m.author_name || 'Lucas'})` : `Cliente (${m.author_name || 'Comprador'})`);

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

    // API pública del módulo
    global.RepartoFacilDespacho = {
        iniciar,
        detener,
        cargarPedidos,
        toggleDetalle,
        marcarEmbalado,
        abrirChat,
        cerrarChatModal,
        enviarMensajeChat
    };

})(window);
