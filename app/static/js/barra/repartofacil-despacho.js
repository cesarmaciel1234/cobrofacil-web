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
    let tabPedidos = 'activos'; // 'activos' | 'nuevos' | 'retira' | 'delivery' | 'historial'
    let pedidoModal = null; // ID del pedido con modal comanda abierto
    let busquedaHistorial = '';
    let ultimoCountActivos = 0;
    let audioContext = null;
    let ultimoOrderIdNotificado = new Set();

    // Sonido de notificación urgente para nuevos pedidos
    function reproducirSonidoUrgente() {
        try {
            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            // Tono ascendente tipo "ding-dong" para nuevo pedido
            oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // A5
            oscillator.frequency.setValueAtTime(1108, audioContext.currentTime + 0.1); // C#6
            oscillator.frequency.setValueAtTime(1318, audioContext.currentTime + 0.2); // E6

            gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.4);

            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.4);
        } catch (e) {
            console.error('[RepartoFacil] Error al reproducir sonido:', e);
        }
    }

    // Vibración para notificación táctil
    function vibrarUrgente() {
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
            try {
                // Patrón: vibración larga, pausa corta, vibración corta
                navigator.vibrate([300, 100, 150]);
            } catch (e) {
                console.error('[RepartoFacil] Error al vibrar:', e);
            }
        }
    }

    // Notificación completa de nuevo pedido
    function notificarNuevoPedido(orderId) {
        if (ultimoOrderIdNotificado.has(orderId)) {
            return; // Ya notificado
        }
        ultimoOrderIdNotificado.add(orderId);

        reproducirSonidoUrgente();
        vibrarUrgente();

        // Limpiar notificaciones viejas (máximo 100 en memoria)
        if (ultimoOrderIdNotificado.size > 100) {
            const primero = ultimoOrderIdNotificado.values().next().value;
            ultimoOrderIdNotificado.delete(primero);
        }
    }

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

    function formatearIdCorto(id) {
        if (!id) return '';
        const clean = String(id).trim().replace(/^#?RF-?/i, '');
        if (clean.length > 5) {
            return ('RF-' + clean.slice(0, 5)).toUpperCase();
        }
        return ('RF-' + clean).toUpperCase();
    }

    function limpiarDireccion(dir) {
        if (!dir) return 'Domicilio';
        let str = String(dir).trim();
        // Evitar duplicar barrio/localidad consecutivos separados por coma (ej: "Monterrey, Monterrey" -> "Monterrey")
        str = str.replace(/([^,]+)(,\s*\1)+/gi, '$1');
        return str;
    }

    function capitalizarNombre(str) {
        if (!str) return '';
        return String(str).toLowerCase().replace(/(?:^|\s)\S/g, function(a) { return a.toUpperCase(); });
    }

    // Sistema de alerta sonora (Chime Web Audio API)
    let sonidoHabilitado = localStorage.getItem('cf_rf_sound_enabled') !== '0';
    let prevPendientesCount = -1;
    let prevUnreadChatTotal = -1;

    function reproducirAlertaSonora() {
        if (!sonidoHabilitado) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();
            if (ctx.state === 'suspended') {
                ctx.resume();
            }
            const now = ctx.currentTime;
            
            // Tono 1 (Ding)
            const osc1 = ctx.createOscillator();
            const gain1 = ctx.createGain();
            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(587.33, now); // D5
            osc1.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5
            gain1.gain.setValueAtTime(0.28, now);
            gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
            osc1.connect(gain1);
            gain1.connect(ctx.destination);
            osc1.start(now);
            osc1.stop(now + 0.35);

            // Tono 2 (Dong armónico)
            const osc2 = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.type = 'triangle';
            osc2.frequency.setValueAtTime(880, now + 0.14); // A5
            osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.28); // D6
            gain2.gain.setValueAtTime(0.22, now + 0.14);
            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.start(now + 0.14);
            osc2.stop(now + 0.65);
        } catch (e) {
            console.warn('[RepartoFacil] No se pudo reproducir alerta sonora:', e);
        }
    }

    // Iconos SVG limpios (evitan cuadros vacíos o caracteres rotos en Android / Windows)
    const SVG_ICONOS = {
        cruz: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
        ticket: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>`,
        chat: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><path d="m3 21 1.9-5.7a8.5 8.5 0 1 1 3.8 3.8z"/></svg>`,
        print: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>`,
        check: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><polyline points="20 6 9 17 4 12"/></svg>`,
        refresh: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`,
        bell: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`,
        bellOff: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
        box: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`,
        store: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/></svg>`,
        bike: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>`,
        sync: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; display:inline-block;"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>`
    };

    function toggleSonido() {
        sonidoHabilitado = !sonidoHabilitado;
        localStorage.setItem('cf_rf_sound_enabled', sonidoHabilitado ? '1' : '0');
        actualizarBotonSonido();
        if (sonidoHabilitado) {
            reproducirAlertaSonora();
            mostrarToast('Timbre activado para nuevos pedidos y mensajes');
        } else {
            mostrarToast('Timbre silenciado');
        }
    }

    function actualizarBotonSonido() {
        const btn = $('btnToggleSonidoReparto');
        const icono = $('iconoSonidoReparto');
        const lbl = $('lblSonidoReparto');
        if (!btn) return;
        if (sonidoHabilitado) {
            if (icono) icono.innerHTML = SVG_ICONOS.bell;
            if (lbl) lbl.textContent = 'ON';
            btn.style.background = '#ffffff';
            btn.style.borderColor = '#fde047';
            btn.style.color = '#2D3277';
            btn.title = 'Timbre activado (clic para silenciar)';
        } else {
            if (icono) icono.innerHTML = SVG_ICONOS.bellOff;
            if (lbl) lbl.textContent = 'OFF';
            btn.style.background = '#f1f5f9';
            btn.style.borderColor = '#cbd5e1';
            btn.style.color = '#94a3b8';
            btn.title = 'Timbre silenciado (clic para activar)';
        }
    }

    function obtenerPruebaDeVida(driverLastPing) {
        if (!driverLastPing) {
            return { estado: 'esperando', label: 'Conectando señal GPS...', color: '#64748b', bg: '#f1f5f9' };
        }
        const diffSec = Math.max(0, Math.floor((Date.now() - new Date(driverLastPing).getTime()) / 1000));
        if (diffSec < 60) {
            return { estado: 'activo', label: `🟢 Prueba de vida: En línea (GPS hace ${diffSec}s)`, color: '#065f46', bg: '#ecfdf5' };
        } else if (diffSec < 300) {
            const min = Math.floor(diffSec / 60);
            return { estado: 'reciente', label: `🟡 Chofer en tránsito (Señal hace ${min}m)`, color: '#92400e', bg: '#fffbeb' };
        } else {
            const min = Math.floor(diffSec / 60);
            return { estado: 'alerta', label: `🔴 Sin señal hace ${min}m (Alerta Custodio)`, color: '#991b1b', bg: '#fef2f2' };
        }
    }

    // Iniciar el módulo cuando se entra a la pantalla
    function iniciar() {
        const wrap = $('pedidosRepartoFacilWrap');
        if (!wrap) return;
        cargarPedidos();
        cargarMetricasOmnicanal();
        
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
                    <div class="loader-ring" style="margin:0 auto 12px; width:28px; height:28px; border:3px solid #fef08a; border-top-color:#FFE600; border-radius:50%; animation:spin 0.8s linear infinite;"></div>
                    <div style="font-weight:900; font-size:13px; color:#2D3277;">Conectando con Reparto Fácil Cloud…</div>
                </div>
            `;
        }

        try {
            const resp = await fetch('/api/repartofacil/pedidos');
            const data = await resp.json();
            if (resp.status === 401 || resp.status === 403) {
                pedidosLista = [];
                actualizarBadge();
                contenedor.textContent = data.error || 'Iniciá sesión para consultar los pedidos.';
                return;
            }
            if (data && data.success && Array.isArray(data.pedidos)) {
                // Detectar nuevos pedidos (pendientes/confirmados que no estaban antes)
                const nuevosIds = new Set(pedidosLista.map(p => p.id));
                const nuevosPedidos = data.pedidos.filter(p =>
                    !nuevosIds.has(p.id) &&
                    (p.estado === 'pending' || p.estado === 'pending_store')
                );

                // Notificar nuevos pedidos
                nuevosPedidos.forEach(p => {
                    if (!silencioso) {
                        notificarNuevoPedido(p.id);
                    }
                });

                pedidosLista = data.pedidos;
                try {
                    localStorage.setItem(getCacheKey(), JSON.stringify(pedidosLista));
                } catch(e) {}
                renderizarCards();
                actualizarBadge();
                cargarMetricasOmnicanal();
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

    // Actualiza badges numéricos en vivo, título de pestaña y alerta sonora
    function actualizarBadge() {
        const badge = $('repartoFacilCountBadge');
        const pwaBadge = $('pwaNavPedidosBadge');

        const nuevosPendientes = pedidosLista.filter(p => {
            const st = String(p.estado || '').toLowerCase();
            return st === 'pending' || st === 'pending_store';
        }).length;

        const unreadChatsTotal = pedidosLista.reduce((acc, p) => acc + (Number(p.unread_chat_count) || 0), 0);
        const totalPendientesAlerta = nuevosPendientes + unreadChatsTotal;

        // Sonar alerta si entraron pedidos nuevos o llegaron mensajes sin leer
        if (prevPendientesCount >= 0 && (nuevosPendientes > prevPendientesCount || unreadChatsTotal > prevUnreadChatTotal)) {
            reproducirAlertaSonora();
        }
        prevPendientesCount = nuevosPendientes;
        prevUnreadChatTotal = unreadChatsTotal;

        // Badge en el encabezado de Pedidos Reparto Fácil
        if (badge) {
            if (totalPendientesAlerta > 0) {
                let textoBadge = nuevosPendientes > 0 ? `${nuevosPendientes} NUEVO${nuevosPendientes === 1 ? '' : 'S'}` : '';
                if (unreadChatsTotal > 0) {
                    textoBadge += (textoBadge ? ' · ' : '') + `💬 ${unreadChatsTotal}`;
                }
                badge.textContent = textoBadge || String(totalPendientesAlerta);
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        }

        // Badge rojo en la barra de navegación inferior (ícono Pedidos)
        if (pwaBadge) {
            if (totalPendientesAlerta > 0) {
                pwaBadge.textContent = totalPendientesAlerta > 99 ? '99+' : String(totalPendientesAlerta);
                pwaBadge.style.display = 'inline-block';
            } else {
                pwaBadge.style.display = 'none';
            }
        }

        // Título dinámico de la pestaña del navegador
        if (nuevosPendientes > 0 && unreadChatsTotal > 0) {
            document.title = `(${totalPendientesAlerta}) ${nuevosPendientes} pedidos / ${unreadChatsTotal} mensajes · Cobro Fácil`;
        } else if (nuevosPendientes > 0) {
            document.title = `(${nuevosPendientes}) Nuevo pedido · Cobro Fácil`;
        } else if (unreadChatsTotal > 0) {
            document.title = `(${unreadChatsTotal}) Mensaje nuevo · Cobro Fácil`;
        } else {
            document.title = 'Cobro Fácil';
        }

        actualizarBotonSonido();
    }

    // Funciones de control de Pestañas
    function setTab(nuevaTab) {
        tabPedidos = String(nuevaTab || 'activos').toLowerCase();
        renderizarCards();
    }

    function setBusquedaHistorial(texto) {
        busquedaHistorial = String(texto || '').trim();
        renderizarCards();
    }

    // Funciones de control de Modal de Comanda
    function abrirModal(orderId) {
        pedidoModal = String(orderId);
        renderizarComandaModal();
    }

    function cerrarModal() {
        pedidoModal = null;
        const modal = $('rfComandaModal');
        if (modal) modal.style.display = 'none';
    }

    // Imprimir comanda en ticket térmico estándar (80mm/58mm)
    function imprimirComanda(orderId) {
        const p = pedidosLista.find(item => String(item.id) === String(orderId));
        if (!p) return;
        const itemsArray = Array.isArray(p.items) ? p.items : [];
        const tipoEntregaNormalizado = String(p.tipo_entrega || '').toLowerCase();
        const esRetiro = tipoEntregaNormalizado === 'pickup' || tipoEntregaNormalizado === 'takeaway' || tipoEntregaNormalizado === 'retiro' || tipoEntregaNormalizado === 'tienda' || tipoEntregaNormalizado === 'mostrador';

        const subtotalCalculado = itemsArray.reduce((acc, it) => acc + (Number(it.price || it.precio || 0) * Number(it.quantity || it.cantidad || 1)), 0);
        const subtotalProd = Number(p.subtotal) > 0 ? Number(p.subtotal) : (subtotalCalculado || (Number(p.total || 0) - Number(p.costo_envio || 0)));

        const w = window.open('', '_blank', 'width=380,height=600');
        if (!w) {
            alert('Por favor habilitá las ventanas emergentes del navegador para imprimir la comanda.');
            return;
        }

        const htmlTicket = `
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="utf-8">
                <title>Ticket #${escaparTextoChat(p.ticket_id || formatearIdCorto(p.id))}</title>
                <style>
                    body { font-family: monospace; font-size: 13px; line-height: 1.35; margin: 10px; color: #000; }
                    .center { text-align: center; }
                    .bold { font-weight: bold; }
                    .line { border-top: 1px dashed #000; margin: 8px 0; }
                    .row { display: flex; justify-content: space-between; margin: 3px 0; }
                </style>
            </head>
            <body onload="window.print()">
                <div class="center bold" style="font-size:16px;">REPARTO FÁCIL</div>
                <div class="center">${escaparTextoChat(p.sucursal_origen || 'Sucursal Maciel')}</div>
                <div class="center">Ticket #${escaparTextoChat(p.ticket_id || formatearIdCorto(p.id))}</div>
                <div class="center">${formatFecha(p.created_at)}</div>
                <div class="line"></div>
                <div><b>Cliente:</b> ${escaparTextoChat(p.cliente_nombre || 'Cliente')}</div>
                ${p.cliente_telefono ? `<div><b>Teléfono:</b> ${escaparTextoChat(p.cliente_telefono)}</div>` : ''}
                <div><b>Modalidad:</b> ${esRetiro ? 'RETIRO EN LOCAL / MOSTRADOR' : 'DELIVERY A DOMICILIO'}</div>
                ${!esRetiro && p.direccion_entrega ? `<div><b>Domicilio:</b> ${escaparTextoChat(limpiarDireccion(p.direccion_entrega))}</div>` : ''}
                <div class="line"></div>
                <div class="bold">PRODUCTOS:</div>
                ${itemsArray.map(it => {
                    const cant = Number(it.quantity || it.cantidad || 1);
                    const precio = Number(it.price || it.precio || 0);
                    return `
                        <div class="row">
                            <span>${cant} x ${escaparTextoChat(capitalizarNombre(it.name || it.nombre))}</span>
                            <span>$${formatMoneyNum(precio * cant)}</span>
                        </div>
                    `;
                }).join('')}
                <div class="line"></div>
                <div class="row"><span>Subtotal:</span><span>$${formatMoneyNum(subtotalProd)}</span></div>
                ${Number(p.costo_envio) > 0 ? `<div class="row"><span>Envío:</span><span>$${formatMoneyNum(p.costo_envio)}</span></div>` : ''}
                <div class="row bold" style="font-size:15px; margin-top:4px;"><span>TOTAL:</span><span>$${formatMoneyNum(p.total)}</span></div>
                <div class="line"></div>
                <div class="center"><b>Pago:</b> ${escaparTextoChat(p.metodo_pago || 'Efectivo')}</div>
                ${p.notas ? `<div style="margin-top:6px;"><b>Nota:</b> "${escaparTextoChat(p.notas)}"</div>` : ''}
            </body>
            </html>
        `;
        w.document.write(htmlTicket);
        w.document.close();
    }

    // Renderizar barra de pestañas (Activos, Nuevos, Retira, Delivery, Historial)
    function renderizarTabs(countActivos, countNuevos, countRetira, countDelivery, countHistorial) {
        let host = $('repartoFacilFiltrosTabs');
        if (!host) {
            const banner = $('repartoFacilOmnicanalBanner');
            if (banner && banner.parentNode) {
                host = document.createElement('div');
                host.id = 'repartoFacilFiltrosTabs';
                host.style.marginBottom = '12px';
                banner.parentNode.insertBefore(host, $('repartoFacilCardsContenedor'));
            }
        }
        if (!host) return;

        const tabs = [
            { id: 'activos', label: 'Activos', count: countActivos },
            { id: 'nuevos', label: 'Nuevos', count: countNuevos, alert: countNuevos > 0 },
            { id: 'retira', label: 'Retira', count: countRetira },
            { id: 'delivery', label: 'Delivery', count: countDelivery },
            { id: 'historial', label: 'Historial', count: countHistorial },
        ];

        host.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px; overflow-x:auto; padding-bottom:6px; -webkit-overflow-scrolling:touch;">
                ${tabs.map(t => {
                    const isActive = tabPedidos === t.id;
                    const bg = isActive ? '#2D3277' : '#ffffff';
                    const color = isActive ? '#ffffff' : '#334155';
                    const border = isActive ? '#2D3277' : '#cbd5e1';
                    const badgeBg = isActive ? '#FFE600' : (t.alert ? '#ef4444' : '#f1f5f9');
                    const badgeColor = isActive ? '#2D3277' : (t.alert ? '#ffffff' : '#475569');
                    return `
                        <button type="button" onclick="window.RepartoFacilDespacho.setTab('${t.id}')"
                            style="background:${bg}; color:${color}; border:1.5px solid ${border}; border-radius:999px; padding:6px 12px; font-size:12px; font-weight:800; cursor:pointer; display:inline-flex; align-items:center; gap:5px; white-space:nowrap; flex-shrink:0; box-shadow:${isActive ? '0 2px 6px rgba(45,50,119,0.25)' : 'none'}; transition:all 0.15s ease;">
                            <span>${t.label}</span>
                            <span style="background:${badgeBg}; color:${badgeColor}; font-size:10px; font-weight:900; padding:1px 6px; border-radius:999px;">
                                ${t.count}
                            </span>
                        </button>
                    `;
                }).join('')}
            </div>
            ${tabPedidos === 'historial' ? `
                <div style="margin-top:8px;">
                    <input type="search" placeholder="Buscar por #RF o cliente en historial..."
                        value="${escaparTextoChat(busquedaHistorial)}"
                        oninput="window.RepartoFacilDespacho.setBusquedaHistorial(this.value)"
                        style="width:100%; box-sizing:border-box; background:#ffffff; border:1.5px solid #cbd5e1; border-radius:12px; padding:8px 12px; font-size:12.5px; color:#1e293b; outline:none;" />
                </div>
            ` : ''}
        `;
    }

    // Funciones auxiliares de filtrado estricto
    function esPedidoFinalizado(p) {
        const st = String((p && p.estado) || 'pending').toLowerCase();
        return st === 'delivered' || st === 'rejected' || st === 'cancelled' || st === 'cancelled_by_client' || st === 'cancelled_timeout';
    }

    function esPedidoActivo(p) {
        return !esPedidoFinalizado(p);
    }

    function esModalidadRetiro(p) {
        const tipo = String((p && p.tipo_entrega) || '').toLowerCase();
        return tipo === 'pickup' || tipo === 'takeaway' || tipo === 'retiro' || tipo === 'tienda' || tipo === 'mostrador';
    }

    function esPedidoNuevo(p) {
        const st = String((p && p.estado) || 'pending').toLowerCase();
        return st === 'pending' || st === 'pending_store';
    }

    // Renderizar tarjetas de clientes (COMPACTAS 1-2 LÍNEAS, SIN ACORDEÓN INLINE)
    function renderizarCards() {
        const contenedor = $('repartoFacilCardsContenedor');
        if (!contenedor) return;

        if (!Array.isArray(pedidosLista)) pedidosLista = [];

        // 1. Calcular conteos para todas las pestañas
        let countActivos = 0;
        let countNuevos = 0;
        let countRetira = 0;
        let countDelivery = 0;
        let countHistorial = 0;

        pedidosLista.forEach((p) => {
            if (esPedidoNuevo(p)) countNuevos++;
            if (esPedidoActivo(p)) {
                countActivos++;
                if (esModalidadRetiro(p)) countRetira++;
                else countDelivery++;
            } else if (esPedidoFinalizado(p)) {
                countHistorial++;
            }
        });

        // 2. Renderizar barra de pestañas
        renderizarTabs(countActivos, countNuevos, countRetira, countDelivery, countHistorial);

        // 3. Filtrar lista ANTES de renderizar
        let pedidosFiltrados = [];
        if (tabPedidos === 'activos') {
            pedidosFiltrados = pedidosLista.filter(p => esPedidoActivo(p));
        } else if (tabPedidos === 'nuevos') {
            pedidosFiltrados = pedidosLista.filter(p => esPedidoNuevo(p));
        } else if (tabPedidos === 'retira') {
            pedidosFiltrados = pedidosLista.filter(p => esPedidoActivo(p) && esModalidadRetiro(p));
        } else if (tabPedidos === 'delivery') {
            pedidosFiltrados = pedidosLista.filter(p => esPedidoActivo(p) && !esModalidadRetiro(p));
        } else if (tabPedidos === 'historial') {
            pedidosFiltrados = pedidosLista.filter(p => {
                if (!esPedidoFinalizado(p)) return false;
                if (busquedaHistorial) {
                    const q = busquedaHistorial.toLowerCase();
                    const pool = `${p.id || ''} ${p.cliente_nombre || ''} ${p.ticket_id || ''}`.toLowerCase();
                    return pool.includes(q);
                }
                return true;
            });
        }

        if (pedidosFiltrados.length === 0) {
            let msgTitulo = 'No hay pedidos en esta pestaña';
            let msgSub = 'Los pedidos entrarán en vivo automáticamente aquí.';
            if (tabPedidos === 'nuevos') {
                msgTitulo = 'No hay pedidos nuevos pendientes';
                msgSub = 'Cuando un cliente haga una orden web, sonará la alerta y aparecerá aquí.';
            } else if (tabPedidos === 'historial') {
                msgTitulo = 'Historial vacío';
                msgSub = busquedaHistorial ? 'No se encontraron pedidos con ese criterio de búsqueda.' : 'Los pedidos entregados y cancelados se archivarán acá.';
            } else if (tabPedidos === 'retira') {
                msgTitulo = 'Sin pedidos para retiro en mostrador';
                msgSub = 'Las compras donde el comprador retira en local aparecerán acá.';
            } else if (tabPedidos === 'delivery') {
                msgTitulo = 'Sin pedidos con envío delivery';
                msgSub = 'Las compras con entrega a domicilio por chofer aparecerán acá.';
            }

            contenedor.innerHTML = `
                <div style="text-align:center; padding:36px 20px; background:#fff; border-radius:18px; border:1px dashed #cbd5e1; margin-top:4px;">
                    <div style="margin-bottom:8px; display:flex; justify-content:center; color:#94a3b8;">${SVG_ICONOS.box}</div>
                    <h4 style="margin:0 0 4px; font-size:14px; font-weight:800; color:#1e293b;">${msgTitulo}</h4>
                    <p style="margin:0; font-size:12px; color:#64748b; max-width:300px; margin:0 auto;">${msgSub}</p>
                </div>
            `;
            // Asegurar que si hay modal activo se mantenga
            renderizarComandaModal();
            return;
        }

        let html = '';
        pedidosFiltrados.forEach((p) => {
            const estadoLower = (p.estado || 'pending').toLowerCase();
            const esNuevoPendiente = estadoLower === 'pending' || estadoLower === 'pending_store';
            const esTimeout = estadoLower === 'cancelled_timeout';
            const esCanceladoCliente = estadoLower === 'cancelled' || estadoLower === 'cancelled_by_client';
            const esRechazadoComercio = estadoLower === 'rejected';
            const esRechazado = esRechazadoComercio || esCanceladoCliente || esTimeout;
            const esConfirmado = estadoLower === 'confirmed' || estadoLower === 'accepted';
            const esEmbalado = estadoLower === 'ready' || estadoLower === 'embalado';
            const esEntregado = estadoLower === 'delivered';

            const esRetiroEnTienda = esModalidadRetiro(p);
            const badgeTipoEntrega = esRetiroEnTienda
                ? `<span style="background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; font-size:9.5px; font-weight:900; padding:1.5px 6px; border-radius:6px; display:inline-flex; align-items:center; gap:3px; flex-shrink:0;">${SVG_ICONOS.store}<span>Retira</span></span>`
                : `<span style="background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; font-size:9.5px; font-weight:900; padding:1.5px 6px; border-radius:6px; display:inline-flex; align-items:center; gap:3px; flex-shrink:0;">${SVG_ICONOS.bike}<span>Delivery</span></span>`;

            let badgeEstadoHtml = '';
            if (esCanceladoCliente) {
                badgeEstadoHtml = `<span style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; font-size:9.5px; font-weight:800; padding:1.5px 6px; border-radius:6px; white-space:nowrap; display:inline-flex; align-items:center; gap:2px;">${SVG_ICONOS.cruz} <span>CANCELADO</span></span>`;
            } else if (esRechazadoComercio) {
                badgeEstadoHtml = `<span style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; font-size:9.5px; font-weight:800; padding:1.5px 6px; border-radius:6px; white-space:nowrap; display:inline-flex; align-items:center; gap:2px;">${SVG_ICONOS.cruz} <span>RECHAZADO</span></span>`;
            } else if (esTimeout) {
                badgeEstadoHtml = `<span style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; font-size:9.5px; font-weight:800; padding:1.5px 6px; border-radius:6px; white-space:nowrap;">CANCELADO (1H)</span>`;
            } else if (esEntregado) {
                badgeEstadoHtml = `<span style="background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; font-size:9.5px; font-weight:800; padding:1.5px 6px; border-radius:6px; white-space:nowrap;">✓ ${esRetiroEnTienda ? 'RETIRADO' : 'ENTREGADO'}</span>`;
            } else if (esRetiroEnTienda) {
                if (esEmbalado) {
                    badgeEstadoHtml = `<span style="background:#ecfdf5; color:#065f46; border:1px solid #10b981; font-size:9.5px; font-weight:900; padding:1.5px 6px; border-radius:6px; white-space:nowrap;">LISTO</span>`;
                } else if (esConfirmado) {
                    badgeEstadoHtml = `<span style="background:#fefce8; color:#a16207; border:1px solid #fde047; font-size:9.5px; font-weight:900; padding:1.5px 6px; border-radius:6px; white-space:nowrap;">PREPARANDO</span>`;
                } else {
                    badgeEstadoHtml = `<span style="background:#FFE600; color:#2D3277; border:1px solid #eab308; font-size:9.5px; font-weight:900; padding:1.5px 6px; border-radius:6px; white-space:nowrap; box-shadow:0 0 8px rgba(255,230,0,0.5);">NUEVO</span>`;
                }
            } else if (esEmbalado) {
                badgeEstadoHtml = `<span style="background:#fef9c3; color:#713f12; border:1px solid #facc15; font-size:9.5px; font-weight:900; padding:1.5px 6px; border-radius:6px; white-space:nowrap;">EMBALADO</span>`;
            } else if (p.repartidor_nombre || p.repartidor_id) {
                badgeEstadoHtml = `<span style="background:#FFE600; color:#2D3277; border:1px solid #eab308; font-size:9.5px; font-weight:900; padding:1.5px 6px; border-radius:6px; white-space:nowrap;">EN CAMINO</span>`;
            } else if (esConfirmado) {
                badgeEstadoHtml = `<span style="background:#fefce8; color:#a16207; border:1px solid #fde047; font-size:9.5px; font-weight:900; padding:1.5px 6px; border-radius:6px; white-space:nowrap;">ASIGNANDO</span>`;
            } else {
                badgeEstadoHtml = `<span style="background:#FFE600; color:#2D3277; border:1px solid #eab308; font-size:9.5px; font-weight:900; padding:1.5px 6px; border-radius:6px; white-space:nowrap; box-shadow:0 0 8px rgba(255,230,0,0.5);">NUEVO</span>`;
            }

            // Método de pago para badge rápido
            const metodoLower = String(p.metodo_pago || 'cash').toLowerCase();
            const esEfectivo = metodoLower.includes('efectivo') || metodoLower.includes('cash');
            const esTransfer = metodoLower.includes('transfer');
            const esTarj = metodoLower.includes('tarjeta') || metodoLower.includes('card');
            const esMP = metodoLower.includes('mercado') || metodoLower.includes('mp') || metodoLower.includes('qr') || metodoLower.includes('online') || metodoLower.includes('web');

            let pagoBadgeTexto = 'Efectivo';
            let pagoBadgeBg = '#fef3c7';
            let pagoBadgeColor = '#92400e';
            let pagoBadgeBorder = '#fde68a';

            if (esTransfer) {
                pagoBadgeTexto = 'Transf.';
                pagoBadgeBg = '#eff6ff';
                pagoBadgeColor = '#1e40af';
                pagoBadgeBorder = '#bfdbfe';
            } else if (esTarj) {
                pagoBadgeTexto = 'Tarjeta';
                pagoBadgeBg = '#f0fdf4';
                pagoBadgeColor = '#166534';
                pagoBadgeBorder = '#bbf7d0';
            } else if (esMP) {
                pagoBadgeTexto = 'MPago';
                pagoBadgeBg = '#ecfdf5';
                pagoBadgeColor = '#065f46';
                pagoBadgeBorder = '#a7f3d0';
            }

            // Botón de acción rápida (Botón 3)
            let botonAccionRapidaHtml = '';
            if (esNuevoPendiente) {
                botonAccionRapidaHtml = `
                    <button type="button" onclick="event.stopPropagation(); window.RepartoFacilDespacho.aceptarPedido(${argumentoPedido(p.id)})"
                        style="background:#FFE600; color:#2D3277; border:1.5px solid #eab308; border-radius:8px; padding:5px 9px; font-size:11px; font-weight:900; cursor:pointer; display:inline-flex; align-items:center; gap:3px; box-shadow:0 2px 5px rgba(234,179,8,0.25);">
                        ${SVG_ICONOS.check}
                        <span>Aceptar</span>
                    </button>
                `;
            } else if (esConfirmado) {
                botonAccionRapidaHtml = `
                    <button type="button" onclick="event.stopPropagation(); window.RepartoFacilDespacho.marcarEmbalado(${argumentoPedido(p.id)}, 0, 0)"
                        style="background:#10b981; color:#ffffff; border:1.5px solid #059669; border-radius:8px; padding:5px 9px; font-size:11px; font-weight:900; cursor:pointer; display:inline-flex; align-items:center; gap:3px; box-shadow:0 2px 5px rgba(16,185,129,0.25);">
                        ${SVG_ICONOS.box}
                        <span>${esRetiroEnTienda ? 'Listo' : 'Embalar'}</span>
                    </button>
                `;
            } else if (esEmbalado && esRetiroEnTienda) {
                botonAccionRapidaHtml = `
                    <button type="button" onclick="event.stopPropagation(); window.RepartoFacilDespacho.entregarPedidoMostrador(${argumentoPedido(p.id)})"
                        style="background:#0284c7; color:#ffffff; border:1.5px solid #0369a1; border-radius:8px; padding:5px 9px; font-size:11px; font-weight:900; cursor:pointer; display:inline-flex; align-items:center; gap:3px; box-shadow:0 2px 5px rgba(2,132,199,0.25);">
                        ${SVG_ICONOS.check}
                        <span>Entregar</span>
                    </button>
                `;
            } else if (esEmbalado && !esRetiroEnTienda) {
                botonAccionRapidaHtml = `
                    <button type="button" onclick="event.stopPropagation(); window.RepartoFacilDespacho.abrirModal(${argumentoPedido(p.id)})"
                        style="background:#0284c7; color:#ffffff; border:1.5px solid #0369a1; border-radius:8px; padding:5px 8px; font-size:11px; font-weight:900; cursor:pointer; display:inline-flex; align-items:center; gap:3px;">
                        ${SVG_ICONOS.bike}
                        <span>Despacho</span>
                    </button>
                `;
            } else if (esEntregado) {
                botonAccionRapidaHtml = `<span style="color:#059669; font-size:10.5px; font-weight:800; padding:4px 6px;">✓ Listo</span>`;
            } else if (esRechazado) {
                botonAccionRapidaHtml = `<span style="color:#dc2626; font-size:10.5px; font-weight:800; padding:4px 6px;">Archivado</span>`;
            }

            const cardBorder = esNuevoPendiente ? '#FFE600' : (esRechazado ? '#fca5a5' : '#e2e8f0');
            const cardBg = esNuevoPendiente ? '#fffef8' : '#ffffff';

            html += `
                <div class="card rf-order-card" data-order-id="${escaparTextoChat(p.id)}" onclick="window.RepartoFacilDespacho.abrirModal(${argumentoPedido(p.id)})"
                    style="background:${cardBg}; border-radius:14px; border:1.5px solid ${cardBorder}; box-shadow:0 2px 6px rgba(15,23,42,0.04); padding:9px 12px; cursor:pointer; transition:transform 0.1s ease, box-shadow 0.1s ease;">
                    
                    <!-- LÍNEA 1: #RF, HORA, CLIENTE, BADGE MODALIDAD Y ESTADO -->
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:5px;">
                        <div style="display:flex; align-items:center; gap:6px; min-width:0; overflow:hidden;">
                            <b style="font-size:12px; color:#2D3277; font-family:monospace; flex-shrink:0;">
                                #${formatearIdCorto(p.id).toUpperCase()}
                            </b>
                            <span style="font-size:11px; color:#64748b; font-weight:700; flex-shrink:0;">
                                ${formatFecha(p.created_at)}
                            </span>
                            <span style="font-size:13px; font-weight:800; color:#1e293b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${escaparTextoChat(capitalizarNombre(p.cliente_nombre || 'Cliente'))}
                            </span>
                        </div>
                        <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
                            ${badgeTipoEntrega}
                            ${badgeEstadoHtml}
                        </div>
                    </div>

                    <!-- LÍNEA 2: PAGO, MONTO TOTAL Y 3 BOTONES EN LÍNEA -->
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                        <div style="display:flex; align-items:center; gap:6px; min-width:0;">
                            <span style="background:${pagoBadgeBg}; color:${pagoBadgeColor}; border:1px solid ${pagoBadgeBorder}; font-size:10px; font-weight:800; padding:2px 6px; border-radius:6px; white-space:nowrap;">
                                ${pagoBadgeTexto}
                            </span>
                            <b style="font-size:14px; font-weight:900; color:#2D3277; font-family:monospace; white-space:nowrap;">
                                ${formatMoney(p.total)}
                            </b>
                        </div>

                        <div style="display:flex; align-items:center; gap:5px; flex-shrink:0;" onclick="event.stopPropagation()">
                            <!-- Botón 1: Ver Ticket / Comanda (ícono SVG limpio) -->
                            <button type="button" onclick="event.stopPropagation(); window.RepartoFacilDespacho.abrirModal(${argumentoPedido(p.id)})" title="Ver Comanda completa"
                                style="background:#ffffff; color:#2D3277; border:1px solid #cbd5e1; border-radius:8px; padding:5px 7px; font-size:11px; font-weight:800; cursor:pointer; display:inline-flex; align-items:center; gap:3px; box-shadow:0 1px 2px rgba(0,0,0,0.03);">
                                ${SVG_ICONOS.ticket}
                                <span>Ticket</span>
                            </button>

                            <!-- Botón 2: Chat (con contador numérico) -->
                            <button type="button" onclick="event.stopPropagation(); window.RepartoFacilDespacho.abrirChat(${argumentoPedido(p.id)}, ${argumentoPedido(p.cliente_nombre || 'Cliente')})" title="Chat con cliente"
                                style="background:${p.unread_chat_count > 0 ? '#ef4444' : '#eff6ff'}; color:${p.unread_chat_count > 0 ? '#ffffff' : '#1d4ed8'}; border:1px solid ${p.unread_chat_count > 0 ? '#dc2626' : '#bfdbfe'}; border-radius:8px; padding:5px 7px; font-size:11px; font-weight:800; cursor:pointer; display:inline-flex; align-items:center; gap:3px; box-shadow:0 1px 2px rgba(0,0,0,0.03);">
                                ${SVG_ICONOS.chat}
                                <span>Chat</span>
                                ${p.unread_chat_count > 0 ? `<span style="background:#ffffff; color:#ef4444; font-size:9.5px; font-weight:900; padding:0 5px; border-radius:999px;">${p.unread_chat_count}</span>` : ''}
                            </button>

                            <!-- Botón 3: Acción Principal -->
                            ${botonAccionRapidaHtml}
                        </div>
                    </div>

                </div>
            `;
        });

        contenedor.innerHTML = html;

        // Si hay comanda modal abierta, asegurar renderizado actualizado
        renderizarComandaModal();
    }

    // Modal centrado fixed/overlay con la comanda completa del pedido seleccionado
    function renderizarComandaModal() {
        if (!pedidoModal) {
            const m = $('rfComandaModal');
            if (m) m.style.display = 'none';
            return;
        }

        const p = pedidosLista.find(item => String(item.id) === String(pedidoModal));
        if (!p) {
            cerrarModal();
            return;
        }

        let modal = $('rfComandaModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'rfComandaModal';
            modal.style.cssText = `
                position:fixed; inset:0; z-index:999990; background:rgba(15,23,42,0.65);
                backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center;
                padding:12px; box-sizing:border-box;
            `;
            modal.onclick = (e) => {
                if (e.target === modal) cerrarModal();
            };
            document.body.appendChild(modal);
        } else {
            modal.style.display = 'flex';
        }

        const estadoLower = (p.estado || 'pending').toLowerCase();
        const esNuevoPendiente = estadoLower === 'pending' || estadoLower === 'pending_store';
        const esConfirmado = estadoLower === 'confirmed' || estadoLower === 'accepted';
        const esEmbalado = estadoLower === 'ready' || estadoLower === 'embalado';
        const esEntregado = estadoLower === 'delivered';
        const esTimeout = estadoLower === 'cancelled_timeout';
        const esCanceladoCliente = estadoLower === 'cancelled' || estadoLower === 'cancelled_by_client';
        const esRechazadoComercio = estadoLower === 'rejected';
        const esRechazado = esRechazadoComercio || esCanceladoCliente || esTimeout;

        const esRetiroEnTienda = esModalidadRetiro(p);
        const badgeTipoEntrega = esRetiroEnTienda
            ? `<span style="background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; font-size:10px; font-weight:900; padding:2px 7px; border-radius:6px; display:inline-flex; align-items:center; gap:3px;">${SVG_ICONOS.store} <span>En Tienda</span></span>`
            : `<span style="background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; font-size:10px; font-weight:900; padding:2px 7px; border-radius:6px; display:inline-flex; align-items:center; gap:3px;">${SVG_ICONOS.bike} <span>Con Delivery</span></span>`;

        const itemsArray = Array.isArray(p.items) ? p.items : [];
        const cantItems = itemsArray.reduce((acc, item) => acc + (Number(item.quantity || item.cantidad || 1)), 0);

        const subtotalCalculado = itemsArray.reduce((acc, it) => acc + (Number(it.price || it.precio || 0) * Number(it.quantity || it.cantidad || 1)), 0);
        const subtotalProd = Number(p.subtotal) > 0 ? Number(p.subtotal) : (subtotalCalculado || (Number(p.total || 0) - Number(p.costo_envio || 0)));
        const costoEnvioVal = Number(p.costo_envio || 0);
        const totalVal = Number(p.total || 0);
        const descuentoVal = Math.max(0, Math.round(((subtotalProd + costoEnvioVal) - totalVal) * 100) / 100);

        const metodoLower = String(p.metodo_pago || 'cash').toLowerCase();
        const esEfectivo = metodoLower.includes('efectivo') || metodoLower.includes('cash');
        const esTransfer = metodoLower.includes('transfer');
        const esTarj = metodoLower.includes('tarjeta') || metodoLower.includes('card');
        const esMP = metodoLower.includes('mercado') || metodoLower.includes('mp') || metodoLower.includes('qr') || metodoLower.includes('online') || metodoLower.includes('web');

        let tituloP = 'Efectivo contra entrega';
        let subtextoP = 'Cobrar en mano al entregar el pedido';
        let badgeTextoP = 'COBRAR EN EFECTIVO';
        let badgeBgP = '#fef3c7';
        let badgeColorP = '#92400e';
        let badgeBorderP = '#fde68a';
        let boxBgP = '#fffef5';
        let boxBorderP = '#fde047';

        if (esTransfer) {
            tituloP = 'Transferencia Bancaria';
            subtextoP = 'Verificar comprobante bancario antes de despachar';
            badgeTextoP = 'VERIFICAR PAGO';
            badgeBgP = '#eff6ff';
            badgeColorP = '#1e40af';
            badgeBorderP = '#bfdbfe';
            boxBgP = '#eff6ff';
            boxBorderP = '#bfdbfe';
        } else if (esTarj) {
            tituloP = 'Tarjeta Débito / Crédito';
            subtextoP = 'Cobro procesado con tarjeta / Posnet';
            badgeTextoP = 'PAGO CON TARJETA';
            badgeBgP = '#f0fdf4';
            badgeColorP = '#166534';
            badgeBorderP = '#bbf7d0';
            boxBgP = '#f0fdf4';
            boxBorderP = '#86efac';
        } else if (esMP) {
            tituloP = 'Pago Online (Mercado Pago / Web)';
            subtextoP = 'Acreditado y confirmado vía web';
            badgeTextoP = 'PAGADO ONLINE';
            badgeBgP = '#ecfdf5';
            badgeColorP = '#065f46';
            badgeBorderP = '#a7f3d0';
            boxBgP = '#ecfdf5';
            boxBorderP = '#6ee7b7';
        }

        let botonesAccionModal = '';
        if (esNuevoPendiente) {
            botonesAccionModal = `
                <button type="button" onclick="window.RepartoFacilDespacho.rechazarPedido(${argumentoPedido(p.id)})"
                    style="background:#ffffff; color:#b91c1c; border:1px solid #fca5a5; border-radius:10px; padding:9px 12px; font-size:12px; font-weight:800; cursor:pointer; display:inline-flex; align-items:center; gap:4px;">
                    ${SVG_ICONOS.cruz}
                    <span>Rechazar</span>
                </button>
                <button type="button" onclick="window.RepartoFacilDespacho.aceptarPedido(${argumentoPedido(p.id)})"
                    style="background:#FFE600; color:#2D3277; border:1.5px solid #eab308; border-radius:10px; padding:9px 14px; font-size:12px; font-weight:900; cursor:pointer; display:inline-flex; align-items:center; gap:4px; box-shadow:0 2px 8px rgba(234,179,8,0.3);">
                    ${SVG_ICONOS.check}
                    <span>${esRetiroEnTienda ? 'Aceptar y Preparar' : 'Aceptar y Publicar'}</span>
                </button>
            `;
        } else if (esConfirmado) {
            botonesAccionModal = `
                <button type="button" onclick="window.RepartoFacilDespacho.marcarEmbalado(${argumentoPedido(p.id)}, 0, 0)"
                    style="background:#10b981; color:#ffffff; border:1.5px solid #059669; border-radius:10px; padding:9px 14px; font-size:12px; font-weight:900; cursor:pointer; display:inline-flex; align-items:center; gap:4px; box-shadow:0 2px 8px rgba(16,185,129,0.3);">
                    ${SVG_ICONOS.box}
                    <span>${esRetiroEnTienda ? 'Listo p/ Retirar' : 'Embalar'}</span>
                </button>
            `;
        } else if (esEmbalado && esRetiroEnTienda) {
            botonesAccionModal = `
                <button type="button" onclick="window.RepartoFacilDespacho.entregarPedidoMostrador(${argumentoPedido(p.id)})"
                    style="background:#0284c7; color:#ffffff; border:1.5px solid #0369a1; border-radius:10px; padding:9px 14px; font-size:12px; font-weight:900; cursor:pointer; display:inline-flex; align-items:center; gap:4px; box-shadow:0 2px 8px rgba(2,132,199,0.3);">
                    ${SVG_ICONOS.check}
                    <span>Entregar al Cliente</span>
                </button>
            `;
        } else if (esEmbalado && !esRetiroEnTienda) {
            botonesAccionModal = `
                <span style="font-size:12px; font-weight:800; color:#047857; display:inline-flex; align-items:center; gap:4px; padding:8px 10px; background:#ecfdf5; border-radius:10px;">
                    <span>✓</span>
                    <span>Embalado · Esperando chofer</span>
                </span>
            `;
        }

        modal.innerHTML = `
            <div style="background:#ffffff; width:100%; max-width:440px; max-height:90vh; border-radius:20px; box-shadow:0 20px 60px rgba(0,0,0,0.3); display:flex; flex-direction:column; overflow:hidden; font-family:'Inter', sans-serif; border:2px solid #FFE600;" onclick="event.stopPropagation()">
                
                <!-- HEADER DE LA COMANDA -->
                <div style="background:#2D3277; color:#ffffff; padding:12px 16px; display:flex; align-items:center; justify-content:space-between; flex-shrink:0;">
                    <div>
                        <div style="display:flex; align-items:center; gap:6px;">
                            ${SVG_ICONOS.ticket}
                            <span style="font-size:15px; font-weight:900; color:#FFE600; font-family:monospace; letter-spacing:0.5px;">
                                #${formatearIdCorto(p.id).toUpperCase()}
                            </span>
                            ${badgeTipoEntrega}
                        </div>
                        <div style="font-size:11px; color:#cbd5e1; font-weight:700; margin-top:3px;">
                            ${escaparTextoChat(p.sucursal_origen || 'Sucursal Maciel')} · ${formatFecha(p.created_at)}
                        </div>
                    </div>
                    <button type="button" onclick="window.RepartoFacilDespacho.cerrarModal()" aria-label="Cerrar comanda"
                        style="background:rgba(255,255,255,0.22); border:1px solid rgba(255,255,255,0.35); border-radius:999px; width:30px; height:30px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:#ffffff; transition:all 0.15s ease;">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>

                <!-- CUERPO DE LA COMANDA (SCROLLABLE) -->
                <div style="overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:10px; flex:1;">
                    
                    <!-- CLIENTE Y WHATSAPP -->
                    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:10px 12px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
                        <div>
                            <div style="font-size:10px; color:#64748b; font-weight:800; text-transform:uppercase;">Cliente</div>
                            <div style="font-size:13.5px; font-weight:900; color:#1e293b; margin-top:1px;">
                                ${escaparTextoChat(capitalizarNombre(p.cliente_nombre || 'Cliente'))}
                            </div>
                            ${p.cliente_telefono ? `<div style="font-size:11px; color:#475569; font-weight:700; margin-top:2px;">Tel: ${escaparTextoChat(p.cliente_telefono)}</div>` : ''}
                        </div>
                        ${p.cliente_telefono ? `
                            <a href="https://wa.me/${String(p.cliente_telefono).replace(/[^0-9]/g, '')}?text=Hola,%20nos%20comunicamos%20desde%20Cobro%20Fácil%20por%20tu%20pedido%20${encodeURIComponent(p.id)}" target="_blank" rel="noopener noreferrer"
                                style="color:#15803d; font-size:11px; font-weight:900; text-decoration:none; display:inline-flex; align-items:center; gap:3px; background:#f0fdf4; border:1px solid #bbf7d0; padding:5px 10px; border-radius:8px; flex-shrink:0;">
                                <span>WhatsApp</span> ↗
                            </a>
                        ` : ''}
                    </div>

                    <!-- MODALIDAD DE ENTREGA / DOMICILIO -->
                    ${esRetiroEnTienda ? `
                        <div style="background:#ecfdf5; border:1px solid #a7f3d0; border-radius:12px; padding:10px 12px; font-size:11.5px; color:#065f46; font-weight:800; display:flex; align-items:center; gap:6px;">
                            ${SVG_ICONOS.store}
                            <div>
                                <div style="font-weight:900;">RETIRO EN MOSTRADOR / TIENDA</div>
                                <div style="font-size:10.5px; font-weight:600; opacity:0.9;">El comprador retira directamente en el local físico.</div>
                            </div>
                        </div>
                    ` : `
                        <div style="background:#fffef5; border:1.5px solid #fde047; border-radius:12px; padding:10px 12px; display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">
                            <div style="flex:1;">
                                <div style="font-size:10px; color:#854d0e; font-weight:800; text-transform:uppercase;">Domicilio de entrega</div>
                                <div style="font-size:12px; font-weight:800; color:#2D3277; margin-top:2px; line-height:1.35; display:flex; align-items:center; gap:4px;">
                                    ${SVG_ICONOS.bike}
                                    <span>${escaparTextoChat(limpiarDireccion(p.direccion_entrega || 'Domicilio'))}</span>
                                </div>
                            </div>
                            <a href="https://www.google.com/maps/dir/?api=1&destination=${(p.delivery_lat && p.delivery_lng) ? (p.delivery_lat + ',' + p.delivery_lng) : encodeURIComponent(p.direccion_entrega || '')}" target="_blank" rel="noopener noreferrer"
                                style="color:#2D3277; font-size:11px; font-weight:900; text-decoration:none; display:inline-flex; align-items:center; gap:3px; background:#FFE600; padding:5px 10px; border-radius:8px; border:1px solid #eab308; flex-shrink:0;">
                                <span>GPS</span> ↗
                            </a>
                        </div>
                    `}

                    <!-- LISTA DE PRODUCTOS / CORTES -->
                    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:10px 12px;">
                        <div style="font-size:10.5px; font-weight:800; color:#64748b; text-transform:uppercase; margin-bottom:6px; border-bottom:1px solid #f1f5f9; padding-bottom:4px;">
                            Productos del ticket (${cantItems} ${cantItems === 1 ? 'ítem' : 'ítems'})
                        </div>
                        <div style="display:flex; flex-direction:column; gap:5px; max-height:180px; overflow-y:auto; padding-right:2px;">
                            ${itemsArray.map(item => {
                                const cant = Number(item.quantity || item.cantidad || 1);
                                const precio = Number(item.price || item.precio || 0);
                                const subtotal = precio * cant;
                                const unidadTexto = item.unit || item.unidad || 'KG';
                                return `
                                    <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:3px 0; border-bottom:1px dashed #f1f5f9;">
                                        <div style="font-weight:700; color:#1e293b; min-width:0; flex:1; padding-right:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                            • ${cant} ${escaparTextoChat(unidadTexto)} · ${escaparTextoChat(capitalizarNombre(item.name || item.nombre || 'Artículo'))}
                                        </div>
                                        <div style="font-weight:900; font-family:monospace; color:#2D3277; flex-shrink:0;">
                                            ${formatMoney(subtotal)}
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>

                    <!-- DESGLOSE ECONÓMICO -->
                    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:10px 12px; font-size:12px; display:flex; flex-direction:column; gap:4px;">
                        <div style="display:flex; justify-content:space-between; color:#64748b;">
                            <span>Subtotal productos:</span>
                            <span style="font-family:monospace; font-weight:700; color:#2D3277;">${formatMoney(subtotalProd)}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; color:#64748b;">
                            <span>Costo de envío:</span>
                            <span style="font-family:monospace; font-weight:700; color:${costoEnvioVal > 0 ? '#2563eb' : '#059669'};">
                                ${costoEnvioVal > 0 ? formatMoney(costoEnvioVal) : (esRetiroEnTienda ? 'Retiro en Tienda' : 'Envío Gratis')}
                            </span>
                        </div>
                        ${descuentoVal > 0 ? `
                            <div style="display:flex; justify-content:space-between; color:#059669;">
                                <span>Descuento aplicado:</span>
                                <span style="font-family:monospace; font-weight:800;">-${formatMoney(descuentoVal)}</span>
                            </div>
                        ` : ''}
                        <div style="display:flex; justify-content:space-between; align-items:center; padding-top:6px; margin-top:2px; border-top:1.5px solid #cbd5e1; font-size:14px;">
                            <span style="font-weight:900; color:#2D3277;">TOTAL TICKET:</span>
                            <span style="font-weight:900; color:#2D3277; font-family:monospace; font-size:16px;">${formatMoney(totalVal)}</span>
                        </div>
                    </div>

                    <!-- CONDICIÓN Y MÉTODO DE PAGO -->
                    <div style="background:${boxBgP}; border:1.5px solid ${boxBorderP}; border-radius:12px; padding:9px 12px; font-size:12px; display:flex; align-items:center; justify-content:space-between; gap:6px;">
                        <div>
                            <div style="font-weight:900; color:#2D3277;">${tituloP}</div>
                            <div style="font-size:10.5px; color:#64748b; font-weight:700;">${subtextoP}</div>
                        </div>
                        <span style="background:${badgeBgP}; color:${badgeColorP}; border:1px solid ${badgeBorderP}; font-size:9.5px; font-weight:900; padding:3px 8px; border-radius:6px; white-space:nowrap; flex-shrink:0;">
                            ${badgeTextoP}
                        </span>
                    </div>

                    ${p.notas ? `
                        <div style="font-size:11px; color:#854d0e; background:#fefce8; padding:8px 10px; border-radius:10px; border:1px solid #fde047;">
                            <b>Nota del cliente:</b> "${escaparTextoChat(p.notas)}"
                        </div>
                    ` : ''}

                </div>

                <!-- FOOTER FIJO DE ACCIÓN -->
                <div style="background:#f8fafc; border-top:1px solid #e2e8f0; padding:10px 14px; display:flex; gap:8px; align-items:center; justify-content:space-between; flex-shrink:0; flex-wrap:wrap;">
                    <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                        <button type="button" onclick="window.RepartoFacilDespacho.imprimirComanda(${argumentoPedido(p.id)})"
                            style="background:#ffffff; color:#2D3277; border:1px solid #cbd5e1; border-radius:10px; padding:7px 11px; font-size:11.5px; font-weight:800; cursor:pointer; display:inline-flex; align-items:center; gap:4px; box-shadow:0 1px 2px rgba(0,0,0,0.04);">
                            ${SVG_ICONOS.print}
                            <span>Imprimir</span>
                        </button>
                        <button type="button" onclick="window.RepartoFacilDespacho.abrirChat(${argumentoPedido(p.id)}, ${argumentoPedido(p.cliente_nombre || 'Cliente')})"
                            style="background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; border-radius:10px; padding:7px 11px; font-size:11.5px; font-weight:800; cursor:pointer; display:inline-flex; align-items:center; gap:4px;">
                            ${SVG_ICONOS.chat}
                            <span>Chat</span>
                        </button>
                    </div>

                    <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                        ${botonesAccionModal}
                        <button type="button" onclick="window.RepartoFacilDespacho.cerrarModal()"
                            style="background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; border-radius:10px; padding:7px 10px; font-size:11.5px; font-weight:800; cursor:pointer;">
                            Cerrar
                        </button>
                    </div>
                </div>

            </div>
        `;
    }

    // Toggle compatible
    function toggleDetalle(orderId) {
        abrirModal(orderId);
    }

    // Acción: ACEPTAR PEDIDO (Cobro Fácil emite Ticket y publica a repartidores)
    async function aceptarPedido(orderId, forzarSinStock = false) {
        try {
            mostrarToast(`⏳ Aceptando pedido #${escaparTextoChat(orderId)} y emitiendo Ticket…`);
            const resp = await fetch(`/api/repartofacil/pedidos/${encodeURIComponent(orderId)}/aceptar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ forzar_sin_stock: forzarSinStock })
            });
            const data = await resp.json();
            if (data && data.success) {
                mostrarToast(`✅ Pedido #${escaparTextoChat(orderId)} aceptado con Ticket #${escaparTextoChat(data.ticket_id)}. Publicado a repartidores en zona.`);
                cargarPedidos(true);
            } else if (data.error === 'Stock insuficiente') {
                // Mostrar modal mejorado de aceptación parcial
                mostrarModalAceptacionParcial(orderId, data.items_sin_stock, data.items_con_stock);
            } else {
                alert('No se pudo aceptar el pedido: ' + (data.error || 'Error'));
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al aceptar pedido:', e);
            alert('Error de conexión al aceptar pedido.');
        }
    }

    // Modal de aceptación parcial con selección de items
    function mostrarModalAceptacionParcial(orderId, itemsSinStock, itemsConStock) {
        let modal = $('rfAceptacionParcialModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'rfAceptacionParcialModal';
            modal.style.cssText = `
                position:fixed; inset:0; z-index:999999; background:rgba(15,23,42,0.7);
                display:flex; align-items:center; justify-content:center;
                backdrop-filter:blur(4px);
            `;
            document.body.appendChild(modal);
        }

        const itemsHtml = itemsSinStock.map(i => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#fef2f2; border-radius:8px; margin-bottom:6px; border:1px solid #fca5a5;">
                <div>
                    <div style="font-weight:700; color:#b91c1c; font-size:12px;">${i.producto_nombre || i.name || i.nombre}</div>
                    <div style="font-size:11px; color:#991b1b;">Stock: ${i.stock_disponible} de ${i.stock_requerido} requeridos</div>
                </div>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                    <input type="checkbox" class="rf-item-checkbox" data-item-id="${i.id || i.product_id}" data-nombre="${i.producto_nombre || i.name || i.nombre}" style="width:18px; height:18px; accent-color:#10b981;">
                    <span style="font-size:11px; font-weight:600; color:#059669;">Acepto igual</span>
                </label>
            </div>
        `).join('');

        modal.innerHTML = `
            <div style="background:#fff; width:100%; max-width:420px; border-radius:20px; box-shadow:0 20px 60px rgba(0,0,0,0.3); padding:24px; max-height:85vh; overflow-y:auto; margin:16px;">
                <h2 style="margin:0 0 16px; font-size:18px; font-weight:800; color:#0f172a;">⚠️ Stock insuficiente</h2>
                <p style="margin:0 0 16px; font-size:13px; color:#64748b; line-height:1.5;">
                    Los siguientes productos no tienen stock suficiente. Podés aceptar solo los que sí tienen stock, o marcar algunos para aceptarlos igual.
                </p>

                <div style="margin-bottom:20px;">
                    <div style="font-size:11px; font-weight:700; color:#b91c1c; margin-bottom:8px; text-transform:uppercase;">Productos sin stock (${itemsSinStock.length}):</div>
                    ${itemsHtml}
                </div>

                <div style="background:#ecfdf5; padding:12px; border-radius:10px; margin-bottom:20px; border:1px solid #a7f3d0;">
                    <div style="font-size:11px; font-weight:700; color:#047857; margin-bottom:4px;">📦 Productos con stock:</div>
                    <div style="font-size:12px; color:#065f46;">${itemsConStock.length} items disponibles para aceptar</div>
                </div>

                <div style="display:flex; flex-direction:column; gap:10px;">
                    <button type="button" id="btnAceptarParcial" style="width:100%; background:#10b981; color:#fff; border:none; border-radius:12px; padding:12px; font-size:14px; font-weight:800; cursor:pointer; box-shadow:0 4px 12px rgba(16,185,129,0.3);">
                        ✓ Aceptar solo productos con stock
                    </button>
                    <button type="button" id="btnAceptarSeleccionados" style="width:100%; background:#f59e0b; color:#fff; border:none; border-radius:12px; padding:12px; font-size:14px; font-weight:800; cursor:pointer; box-shadow:0 4px 12px rgba(245,158,11,0.3);">
                        ✓ Aceptar selección (incluye marcados)
                    </button>
                    <button type="button" id="btnCancelar" style="width:100%; background:#f1f5f9; color:#64748b; border:none; border-radius:12px; padding:10px; font-size:13px; font-weight:700; cursor:pointer;">
                        Cancelar
                    </button>
                </div>
            </div>
        `;

        modal.style.display = 'flex';

        // Event listeners
        modal.querySelector('#btnCancelar').onclick = () => {
            modal.style.display = 'none';
        };

        modal.querySelector('#btnAceptarParcial').onclick = async () => {
            modal.style.display = 'none';
            await aceptarPedidoConItems(orderId, itemsConStock);
        };

        modal.querySelector('#btnAceptarSeleccionados').onclick = async () => {
            const checkboxes = modal.querySelectorAll('.rf-item-checkbox:checked');
            const itemsMarcados = Array.from(checkboxes).map(cb => {
                const itemOriginal = itemsSinStock.find(i =>
                    (i.id || i.product_id) === cb.dataset.itemId ||
                    (i.producto_nombre || i.name || i.nombre) === cb.dataset.nombre
                );
                return itemOriginal;
            }).filter(Boolean);

            const itemsFinales = [...itemsConStock, ...itemsMarcados];
            modal.style.display = 'none';
            await aceptarPedidoConItems(orderId, itemsFinales);
        };
    }

    async function aceptarPedidoConItems(orderId, items) {
        try {
            mostrarToast(`⏳ Aceptando pedido #${escaparTextoChat(orderId)} con ${items.length} items…`);
            const resp = await fetch(`/api/repartofacil/pedidos/${encodeURIComponent(orderId)}/aceptar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items_aceptados: items })
            });
            const data = await resp.json();
            if (data && data.success) {
                mostrarToast(`✅ Pedido #${escaparTextoChat(orderId)} aceptado con Ticket #${escaparTextoChat(data.ticket_id)}.`);
                cargarPedidos(true);
            } else {
                alert('No se pudo aceptar: ' + (data.error || 'Error'));
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al aceptar con items:', e);
            alert('Error de conexión.');
        }
    }

    // Acción: RECHAZAR PEDIDO
    async function rechazarPedido(orderId) {
        const conf = confirm(`¿Rechazar el pedido #${orderId}? Se notificará al comprador.`);
        if (!conf) return;

        try {
            const resp = await fetch(`/api/repartofacil/pedidos/${encodeURIComponent(orderId)}/rechazar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ motivo: 'Falta de stock en sucursal' })
            });
            const data = await resp.json();
            if (data && data.success) {
                mostrarToast(`Pedido #${escaparTextoChat(orderId)} rechazado.`);
                cargarPedidos(true);
            } else {
                alert('No se pudo rechazar el pedido: ' + (data.error || 'Error'));
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al rechazar pedido:', e);
            alert('Error de conexión al rechazar pedido.');
        }
    }

    // Acción de marcar EMBALADO con impacto de demora y compensación al chofer
    async function marcarEmbalado(orderId, recargoEspera = 0, minutosDemora = 0) {
        const order = pedidosLista.find(p => p.id === orderId);
        const card = Array.from(document.querySelectorAll('.rf-order-card'))
            .find(element => element.dataset.orderId === String(orderId));
        const btn = card ? card.querySelector('.btn-embalar-pedido') : null;

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<span>⏳</span><span>Embalando…</span>`;
        }

        try {
            const resp = await fetch(`/api/repartofacil/pedidos/${encodeURIComponent(orderId)}/embalar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    recargo_espera: Number(recargoEspera) || 0,
                    minutos_demora: Number(minutosDemora) || 0
                })
            });
            const data = await resp.json();

            if (data && data.success) {
                const tipoEntregaNormalizado = String(order ? order.tipo_entrega : '').toLowerCase();
                const esRetiro = tipoEntregaNormalizado === 'pickup' || tipoEntregaNormalizado === 'takeaway' || tipoEntregaNormalizado === 'retiro' || tipoEntregaNormalizado === 'tienda' || tipoEntregaNormalizado === 'mostrador';
                if (esRetiro) {
                    mostrarToast(`🛍️ Pedido #${escaparTextoChat(formatearIdCorto(orderId))} listo para retirar en mostrador.`);
                } else if (recargoEspera > 0) {
                    mostrarToast(`✅ Pedido embalado. Chofer esperando: se acreditó +$${Number(recargoEspera).toLocaleString('es-AR')} extra de compensación 📦⏱️`);
                } else {
                    mostrarToast(`✅ Pedido #${escaparTextoChat(formatearIdCorto(orderId))} embalado. Mensaje enviado al repartidor: "Pedido listo y embalado" 📦`);
                }

                if (order) {
                    order.estado = 'ready';
                    if (recargoEspera > 0 && order.ganancia_repartidor !== undefined) {
                        order.ganancia_repartidor = Number(order.ganancia_repartidor || 0) + Number(recargoEspera);
                    }
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

    // Acción: Entregar pedido en mostrador al cliente
    async function entregarPedidoMostrador(orderId) {
        if (!confirm(`¿Confirmás que el cliente retiró el pedido #${escaparTextoChat(orderId)} en el mostrador?`)) {
            return;
        }
        try {
            mostrarToast(`Entregando pedido #${escaparTextoChat(orderId)} en mostrador…`);
            const resp = await fetch(`/api/repartofacil/pedidos/${encodeURIComponent(orderId)}/entregar-mostrador`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await resp.json();
            if (data && data.success) {
                mostrarToast(`✓ Pedido #${escaparTextoChat(orderId)} entregado en mostrador.`);
                if (pedidoModal === String(orderId)) {
                    cerrarModal();
                }
                cargarPedidos(true);
            } else {
                alert(`Error: ${data && data.error ? data.error : 'No se pudo entregar el pedido'}`);
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al entregar en mostrador:', e);
            alert(`Error de conexión: ${e.message}`);
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
                    
                    <div style="width:36px; height:4px; background:#fde047; border-radius:999px; margin:0 auto 16px;"></div>

                    <h2 id="rfTicketNumero" style="margin:0 0 16px; font-size:22px; font-weight:900; color:#2D3277;">Ticket #------</h2>

                    <div style="display:flex; flex-direction:column; gap:10px; font-size:14px; margin-bottom:16px;">
                        <div style="display:flex; justify-content:space-between; color:#64748b;">
                            <span>Cuándo</span>
                            <b id="rfTicketFecha" style="color:#0f172a; font-weight:700;">2026-11-20 09:54:56</b>
                        </div>
                        <div style="display:flex; justify-content:space-between; color:#64748b;">
                            <span>Modalidad</span>
                            <b id="rfTicketModalidad" style="color:#0f172a; font-weight:700;">—</b>
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

                    <!-- Lista de Cortes e Ítems con Scroll Controlado si el Ticket es muy largo -->
                    <div id="rfTicketItems" style="border-top:1px solid #fef9c3; border-bottom:1px solid #fef9c3; padding:12px 0; margin-bottom:16px; display:flex; flex-direction:column; gap:8px; max-height:240px; overflow-y:auto; padding-right:4px;">
                        <!-- Items inyectados -->
                    </div>

                    <!-- Total -->
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; font-size:16px;">
                        <span style="color:#64748b; font-weight:700;">Total</span>
                        <b id="rfTicketTotal" style="font-size:20px; font-weight:900; color:#2D3277; font-family:monospace;">$0,00</b>
                    </div>

                    <button type="button" onclick="window.RepartoFacilDespacho.cerrarTicketModal()" style="width:100%; background:#FFE600; color:#2D3277; border:1.5px solid #eab308; border-radius:14px; padding:12px; font-size:14px; font-weight:900; cursor:pointer; box-shadow:0 3px 10px rgba(255,230,0,0.35);">
                        Cerrar
                    </button>

                </div>
            `;
            document.body.appendChild(modal);
        } else {
            modal.style.display = 'flex';
        }

        try {
            const resp = await fetch(`/api/repartofacil/ticket/${encodeURIComponent(targetId)}`);
            const t = await resp.json();
            if (!resp.ok || !t.encontrado) {
                throw new Error(t.error || 'No se pudo cargar el ticket.');
            }

            {
                $('rfTicketNumero').textContent = `Ticket #${t.ticket_numero || t.id}`;
                $('rfTicketFecha').textContent = t.fecha || '2026-11-20 09:54:56';
                const esPickupTicket = String(t.tipo_entrega || '').toLowerCase() === 'pickup' || String(t.tipo_entrega || '').toLowerCase() === 'takeaway' || String(t.tipo_entrega || '').toLowerCase() === 'retiro' || String(t.tipo_entrega || '').toLowerCase() === 'tienda';
                if ($('rfTicketModalidad')) {
                    $('rfTicketModalidad').innerHTML = esPickupTicket
                        ? '<span style="color:#047857; font-weight:800;">🏪 En Tienda (Retiro)</span>'
                        : '<span style="color:#1d4ed8; font-weight:800;">🛵 Con Delivery</span>';
                }
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
                            <span>${escaparTextoChat(nombre)} · ${escaparTextoChat(cant)}</span>
                            <b style="font-weight:700;">${formatMoneyDecimal(sub)}</b>
                        </div>
                    `;
                }).join('') || '<div style="color:#94a3b8; font-size:12px;">Detalle de cortes registrado</div>';
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al cargar ticket:', e);
            cerrarTicketModal();
            alert(e.message || 'No se pudo cargar el ticket.');
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
                <div style="background:#fff; width:100%; max-width:440px; border-radius:24px; box-shadow:0 25px 50px -12px rgba(45,50,119,0.35); display:flex; flex-direction:column; max-height:85vh; overflow:hidden; border:2px solid #FFE600;">
                    
                    <!-- Header Chat con Ticket Digital Integrado (Estilo Reparto Fácil Blanco y Amarillo con Navy) -->
                    <div style="background:#2D3277; color:#fff; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; border-bottom:3px solid #FFE600;">
                        <div style="display:flex; align-items:center; gap:10px; min-width:0; flex:1;">
                            <div style="width:36px; height:36px; border-radius:12px; background:#FFE600; color:#2D3277; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:16px; border:1.5px solid #eab308; box-shadow:0 2px 4px rgba(0,0,0,0.15); flex-shrink:0;">
                                💬
                            </div>
                            <div style="min-width:0; flex:1;">
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <h4 id="rfChatTitle" style="margin:0; font-size:13.5px; font-weight:900; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Chat con Cliente</h4>
                                    <span style="position:relative; display:inline-flex; width:8px; height:8px; flex-shrink:0;" title="Canal en vivo">
                                        <span style="position:absolute; width:100%; height:100%; border-radius:999px; background:#10b981; opacity:0.75; animation:pulse 1.5s infinite;"></span>
                                        <span style="position:relative; width:8px; height:8px; border-radius:999px; background:#10b981; border:1.5px solid #fff;"></span>
                                    </span>
                                </div>
                                <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
                                    <small id="rfChatSub" style="color:#fde047; font-size:10.5px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;">📍 Dirección</small>
                                    <button type="button" id="rfChatTicketBtn" style="display:none; background:#FFE600; color:#2D3277; border:1px solid #eab308; border-radius:6px; font-size:10px; font-weight:900; padding:1.5px 7px; cursor:pointer; flex-shrink:0;">
                                        🧾 Ticket
                                    </button>
                                </div>
                            </div>
                        </div>
                        <button type="button" onclick="window.RepartoFacilDespacho.cerrarChatModal()" aria-label="Cerrar chat" style="background:transparent; border:none; cursor:pointer; line-height:1; padding:4px 6px; display:flex; align-items:center; justify-content:center;">
                            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#FFE600" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>

                    <!-- Mensajes Cuerpo -->
                    <div id="rfChatMessages" style="flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; background:#fffef5; min-height:260px;">
                        <div style="text-align:center; color:#64748b; font-size:12px; padding:20px;">Cargando mensajes del pedido…</div>
                    </div>

                    <!-- Input Footer -->
                    <form onsubmit="window.RepartoFacilDespacho.enviarMensajeChat(event)" style="padding:12px; background:#fff; border-top:1.5px solid #fef08a; display:flex; gap:8px;">
                        <input id="rfChatInput" type="text" placeholder="Escribir al comprador o chofer…" style="flex:1; border:1.5px solid #fde047; border-radius:12px; padding:10px 14px; font-size:13px; outline:none; background:#fffef5;" autocomplete="off" />
                        <button type="submit" style="background:#FFE600; color:#2D3277; border:1.5px solid #eab308; border-radius:12px; padding:0 18px; font-weight:900; font-size:13px; cursor:pointer; box-shadow:0 2px 6px rgba(255,230,0,0.3);">
                            Enviar
                        </button>
                    </form>

                </div>
            `;
            document.body.appendChild(modal);
        } else {
            modal.style.display = 'flex';
        }

        const shortCode = formatearIdCorto(orderId);
        $('rfChatTitle').textContent = `Chat · ${clienteNombre}`;
        $('rfChatSub').textContent = `📍 ${order && order.direccion_entrega ? limpiarDireccion(order.direccion_entrega) : 'Entrega a domicilio'} · #${shortCode}`;
        
        // Descontar automáticamente mensajes no leídos al abrir el chat
        if (order && order.unread_chat_count) {
            order.unread_chat_count = 0;
            actualizarBadge();
            renderizarCards();
        }

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

    function argumentoPedido(valor) {
        return escaparTextoChat(JSON.stringify(String(valor)));
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

                const estabaAlFondo = (box.scrollHeight - box.scrollTop - box.clientHeight) < 65;
                const prevCant = parseInt(box.dataset.cantMensajes || '0', 10);
                const nuevaCant = data.mensajes.length;
                const esCargaInicial = !box.dataset.cantMensajes;

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

                    const checksHtml = m.is_read
                        ? '<span style="color:#2D3277; font-weight:900; font-size:10.5px; margin-left:3px;" title="Leído por destinatario ✓✓">✓✓</span>'
                        : '<span style="color:#854d0e; font-size:10.5px; margin-left:3px;" title="Enviado al chat ✓">✓</span>';

                    return `
                        <div style="align-self:${esMio ? 'flex-end' : 'flex-start'}; max-width:82%; display:flex; flex-direction:column; align-items:${esMio ? 'flex-end' : 'flex-start'};">
                            <span style="font-size:10px; color:#64748b; font-weight:700; margin-bottom:2px; padding:0 4px;">${escaparTextoChat(emisor)} · ${escaparTextoChat(m.timestamp_str || '')} ${esMio ? checksHtml : ''}</span>
                            <div style="background:${esMio ? '#FFE600' : (esChofer ? '#2D3277' : '#ffffff')}; color:${esMio ? '#2D3277' : (esChofer ? '#ffffff' : '#0f172a')}; padding:8px 12px; border-radius:14px; font-size:12.5px; font-weight:${esMio ? '700' : '500'}; border:1.5px solid ${esMio ? '#eab308' : (esChofer ? '#1e293b' : '#fde047')}; box-shadow:0 1px 3px rgba(0,0,0,0.06); word-break:break-word;">
                                ${escaparTextoChat(m.content)}
                            </div>
                        </div>
                    `;
                }).join('');

                box.dataset.cantMensajes = String(nuevaCant);

                // Auto-scroll sólo en la primera carga o si el usuario estaba al fondo y llegaron mensajes nuevos
                if (esCargaInicial || (estabaAlFondo && nuevaCant > prevCant)) {
                    box.scrollTop = box.scrollHeight;
                }
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al cargar chat:', e);
            if (orderChatActivo === orderId) {
                box.innerHTML = `
                    <div style="text-align:center; padding:32px 16px; color:#64748b;">
                        <div style="font-size:26px; margin-bottom:8px;">💬</div>
                        <div style="font-weight:900; font-size:13px; color:#2D3277; margin-bottom:4px;">Canal de Chat con el Cliente</div>
                        <div style="font-size:11px; color:#64748b; margin-bottom:12px;">Escribí tu mensaje abajo para comunicarte con el cliente o chofer en tiempo real.</div>
                    </div>
                `;
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
                const box = $('rfChatMensajes');
                if (box) delete box.dataset.cantMensajes;
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
            const resp = await fetch(`/api/repartofacil/pedidos/${encodeURIComponent(orderId)}/custodio/liberar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ motivo: 'inactividad y falta de respuesta del chofer' })
            });
            const data = await resp.json();
            if (data.success) {
                mostrarToast(`Pedido #${escaparTextoChat(orderId)} devuelto a la bandeja disponible`);
                cargarPedidos();
                if (orderChatActivo === orderId) {
                    cargarMensajesChat(orderId);
                }
            } else {
                alert(data.error || 'No se pudo liberar el pedido');
            }
        } catch (e) {
            console.error('[RepartoFacil] Error al liberar:', e);
            alert('Error de conexión al liberar el pedido.');
        }
    }

    // Cargar métricas consolidadas omnicanal (Tienda Física + E-Commerce)
    async function cargarMetricasOmnicanal() {
        const host = $('repartoFacilOmnicanalBanner');
        if (!host) return;

        try {
            const resp = await fetch('/api/repartofacil/metricas-omnicanal');
            const data = await resp.json();
            if (!data || !data.success) return;

            const formatMoneyNum = (num) => '$' + Math.round(Number(num || 0)).toLocaleString('es-AR');

            host.innerHTML = `
                <div style="background:#ffffff; border:2px solid #FFE600; border-radius:18px; padding:12px 14px; box-shadow:0 3px 12px rgba(234,179,8,0.1); display:flex; flex-direction:column; gap:10px;">
                    <!-- Fila Superior: Enlace con Servidor de la Tienda Física + Controles de Pedidos -->
                    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; border-bottom:1px dashed #fde047; padding-bottom:8px;">
                        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                            <span style="display:inline-block; width:9px; height:9px; border-radius:999px; background:#10b981; box-shadow:0 0 6px rgba(16,185,129,0.8); animation:pulse 2s infinite;"></span>
                            <span style="font-size:11.5px; font-weight:900; color:#2D3277; text-transform:uppercase; letter-spacing:0.3px;">
                                SERVIDOR EN LÍNEA
                            </span>
                            <span id="repartoFacilCountBadge" style="display:none; background:#ef4444; color:#ffffff; border:1px solid #dc2626; font-size:10px; font-weight:900; padding:1px 7px; border-radius:999px; box-shadow:0 2px 5px rgba(239,68,68,0.4);">0</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <button type="button" id="btnToggleSonidoReparto" onclick="window.RepartoFacilDespacho.toggleSonido()" style="background:#ffffff; border:1.5px solid #fde047; border-radius:10px; font-size:11px; padding:5px 8px; cursor:pointer; color:#2D3277; display:inline-flex; align-items:center; gap:4px; box-shadow:0 1px 3px rgba(0,0,0,0.04);" title="Activar / Silenciar timbre">
                                <span id="iconoSonidoReparto">${sonidoHabilitado ? SVG_ICONOS.bell : SVG_ICONOS.bellOff}</span>
                                <span id="lblSonidoReparto" style="font-size:10px; font-weight:900;">${sonidoHabilitado ? 'ON' : 'OFF'}</span>
                            </button>
                            <button type="button" onclick="window.RepartoFacilDespacho.cargarPedidos(true)" style="background:#ffffff; border:1.5px solid #fde047; border-radius:10px; font-size:13px; font-weight:900; padding:5px 8px; cursor:pointer; color:#2D3277; box-shadow:0 1px 3px rgba(0,0,0,0.04); display:inline-flex; align-items:center; justify-content:center;" title="Refrescar pedidos">
                                ${SVG_ICONOS.refresh}
                            </button>
                            <button type="button" onclick="window.RepartoFacilDespacho.sincronizarStockTpv()" style="background:#FFE600; color:#2D3277; border:1.5px solid #eab308; border-radius:10px; font-size:10.5px; font-weight:900; padding:5px 9px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; box-shadow:0 1px 4px rgba(234,179,8,0.25);">
                                ${SVG_ICONOS.sync}
                                <span>Sincronizar Stock</span>
                            </button>
                        </div>
                    </div>

                    <!-- Fila Inferior: Las 3 tarjetas de Pedidos Web exclusivas -->
                    <div style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:4px; text-align:center;">
                        <div style="background:#fffef5; border:1.5px solid #fde047; border-radius:12px; padding:7px 2px; min-width:0;">
                            <span style="font-size:9px; color:#64748b; font-weight:900; display:block; text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">RETIRO LOCAL</span>
                            <b style="font-size:12px; font-weight:900; color:#2D3277; font-family:monospace; display:block; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${formatMoneyNum(data.retiro_local_monto || 0)}
                            </b>
                            <small style="font-size:8.5px; color:#854d0e; font-weight:700; white-space:nowrap; display:block; overflow:hidden; text-overflow:ellipsis;">
                                ${data.retiro_local_cant || 0} ped. (${data.retiro_local_activos || 0} act.)
                            </small>
                        </div>

                        <div style="background:#fffef5; border:1.5px solid #fde047; border-radius:12px; padding:7px 2px; min-width:0;">
                            <span style="font-size:9px; color:#64748b; font-weight:900; display:block; text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">CON DELIVERY</span>
                            <b style="font-size:12px; font-weight:900; color:#2D3277; font-family:monospace; display:block; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${formatMoneyNum(data.delivery_monto || 0)}
                            </b>
                            <small style="font-size:8.5px; color:#854d0e; font-weight:700; white-space:nowrap; display:block; overflow:hidden; text-overflow:ellipsis;">
                                ${data.delivery_cant || 0} ped. (${data.delivery_activos || 0} act.)
                            </small>
                        </div>

                        <div style="background:#FFE600; border:1.5px solid #eab308; border-radius:12px; padding:7px 2px; min-width:0; box-shadow:0 2px 6px rgba(234,179,8,0.25);">
                            <span style="font-size:9px; color:#2D3277; font-weight:900; display:block; text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">PEDIDOS WEB</span>
                            <b style="font-size:12px; font-weight:900; color:#2D3277; font-family:monospace; display:block; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${formatMoneyNum(data.total_web_monto != null ? data.total_web_monto : data.monto_web_total)}
                            </b>
                            <small style="font-size:8.5px; color:#2D3277; font-weight:900; white-space:nowrap; display:block; overflow:hidden; text-overflow:ellipsis;">
                                ${data.total_web_cant != null ? data.total_web_cant : (data.cant_pedidos_web_hoy || 0)} ped. (${data.total_web_activos != null ? data.total_web_activos : (data.pedidos_activos_web || 0)} act.)
                            </small>
                        </div>
                    </div>
                </div>
            `;
            actualizarBadge();
        } catch (e) {
            console.warn('[RepartoFacil] No se pudieron cargar métricas omnicanal:', e);
        }
    }

    // Acción para sincronizar stock del TPV físico con la tienda online
    async function sincronizarStockTpv() {
        try {
            mostrarToast('⚡ Sincronizando stock del TPV físico con Reparto Fácil Cloud…');
            const resp = await fetch('/api/repartofacil/sincronizar-stock-tpv', { method: 'POST' });
            const data = await resp.json();
            if (data.success) {
                mostrarToast('✅ ¡Inventario y stock de tienda física sincronizado con la tienda online!');
                cargarMetricasOmnicanal();
                cargarPedidos(true);
            } else {
                alert(data.error || 'No se pudo sincronizar el stock.');
            }
        } catch (e) {
            alert('Error de conexión al sincronizar el stock del TPV.');
        }
    }

    // API pública del módulo
    global.RepartoFacilDespacho = {
        iniciar,
        detener,
        cargarPedidos,
        cargarMetricasOmnicanal,
        sincronizarStockTpv,
        toggleSonido,
        toggleDetalle,
        setTab,
        setBusquedaHistorial,
        abrirModal,
        cerrarModal,
        imprimirComanda,
        aceptarPedido,
        rechazarPedido,
        marcarEmbalado,
        entregarPedidoMostrador,
        liberarPorCustodio,
        verTicket,
        cerrarTicketModal,
        abrirChat,
        cerrarChatModal,
        enviarMensajeChat
    };

})(window);
