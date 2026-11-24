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
        if (navigator.vibrate) {
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
            return 'RF-' + clean.slice(0, 5);
        }
        return 'RF-' + clean;
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
            const puedeEmbalar = esConfirmado || esEmbalado || estadoLower === 'assigned';
            const puedeReasignar = Boolean(p.repartidor_id) && (estadoLower === 'assigned' || esEmbalado);
            const repartidorAsignado = p.repartidor_nombre || (p.repartidor_id ? 'Lucas Motomensajero' : null);

            let badgeEstadoHtml = '';
            if (esCanceladoCliente) {
                badgeEstadoHtml = `<span style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; font-size:9.5px; font-weight:800; padding:2.5px 7px; border-radius:8px; white-space:nowrap;">✕ CANCELADO</span>`;
            } else if (esRechazadoComercio) {
                badgeEstadoHtml = `<span style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; font-size:9.5px; font-weight:800; padding:2.5px 7px; border-radius:8px; white-space:nowrap;">✕ RECHAZADO</span>`;
            } else if (esTimeout) {
                badgeEstadoHtml = `<span style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; font-size:9.5px; font-weight:800; padding:2.5px 7px; border-radius:8px; white-space:nowrap;">⏰ CANCELADO (1H)</span>`;
            } else if (esEntregado) {
                badgeEstadoHtml = `<span style="background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; font-size:9.5px; font-weight:800; padding:2.5px 7px; border-radius:8px; white-space:nowrap;">✓ ENTREGADO</span>`;
            } else if (esEmbalado) {
                badgeEstadoHtml = `<span style="background:#fef9c3; color:#713f12; border:1px solid #facc15; font-size:9.5px; font-weight:900; padding:2.5px 7px; border-radius:8px; white-space:nowrap;">📦 EMBALADO</span>`;
            } else if (repartidorAsignado) {
                badgeEstadoHtml = `<span style="background:#FFE600; color:#2D3277; border:1px solid #eab308; font-size:9.5px; font-weight:900; padding:2.5px 7px; border-radius:8px; white-space:nowrap; box-shadow:0 1px 4px rgba(234,179,8,0.25);">🛵 EN CAMINO</span>`;
            } else if (esConfirmado) {
                badgeEstadoHtml = `<span style="background:#fefce8; color:#a16207; border:1px solid #fde047; font-size:9.5px; font-weight:900; padding:2.5px 7px; border-radius:8px; white-space:nowrap;">⏳ BUSCANDO CHOFER</span>`;
            } else {
                badgeEstadoHtml = `<span style="background:#FFE600; color:#2D3277; border:1.5px solid #eab308; font-size:9.5px; font-weight:900; padding:2.5px 7px; border-radius:8px; white-space:nowrap; box-shadow:0 0 10px rgba(255,230,0,0.6); animation:pulse 2s infinite;">🔔 NUEVO</span>`;
            }

            const itemsArray = Array.isArray(p.items) ? p.items : [];
            const cantItems = itemsArray.reduce((acc, item) => acc + (Number(item.quantity || item.cantidad || 1)), 0);
            const abierto = pedidosExpandidos.has(p.id) || esNuevoPendiente;
            const iniciales = obtenerIniciales(p.cliente_nombre);

            // Validación de stock desde el backend
            const tieneStockValido = p.stock_valido !== false;
            const itemsSinStock = Array.isArray(p.items_sin_stock) ? p.items_sin_stock : [];
            const alertaStock = !tieneStockValido && itemsSinStock.length > 0;

            // Cálculo de ETA y Tiempo de Espera para el Repartidor
            const distanciaKm = Number(p.distancia_km || 1.8);
            const etaBaseMinutos = Math.max(3, Math.min(15, Math.round(Number(p.minutos_estimados || 8) * 0.5) || 6));

            let minutosRestantesChofer = etaBaseMinutos;
            let minutosDemoraChofer = 0;
            let recargoEsperaChofer = 0;

            if (repartidorAsignado && !esEntregado && !esRechazado) {
                const fechaReferencia = p.driver_last_ping ? new Date(p.driver_last_ping).getTime() : new Date(p.updated_at || p.created_at).getTime();
                const tiempoTranscurridoMin = Math.max(0, Math.floor((Date.now() - fechaReferencia) / 60000));
                
                if (tiempoTranscurridoMin < etaBaseMinutos) {
                    minutosRestantesChofer = etaBaseMinutos - tiempoTranscurridoMin;
                } else {
                    minutosRestantesChofer = 0;
                    minutosDemoraChofer = tiempoTranscurridoMin - etaBaseMinutos;
                    // Recargo por espera al chofer en mostrador: base $500 + $100/min extra (tope $2500)
                    recargoEsperaChofer = Math.min(2500, 500 + (minutosDemoraChofer * 100));
                }
            }

            // Indicador de ETA visual y Prueba de Vida dentro del ticket (Estilo Blanco y Amarillo)
            let indicadorEtaHtml = '';
            if (repartidorAsignado && !esEntregado && !esRechazado) {
                const pruebaDeVida = obtenerPruebaDeVida(p.driver_last_ping);
                if (minutosRestantesChofer > 0) {
                    indicadorEtaHtml = `
                        <div style="background:#fffef5; border:1.5px solid #fde047; border-radius:10px; padding:7px 10px; margin-bottom:8px; font-size:11px; color:#2D3277; display:flex; flex-direction:column; gap:4px; box-shadow:0 1px 3px rgba(234,179,8,0.08);">
                            <div style="display:flex; align-items:center; justify-content:space-between;">
                                <span style="font-weight:900;">🛵 ${escaparTextoChat(repartidorAsignado)} en camino</span>
                                <span style="font-weight:900; background:#FFE600; color:#2D3277; padding:1.5px 7px; border-radius:6px; border:1px solid #eab308;">Llega en ~${minutosRestantesChofer} min</span>
                            </div>
                            <div style="font-size:10px; color:${pruebaDeVida.color}; font-weight:800; border-top:1px dashed #fde047; padding-top:3px; display:flex; justify-content:space-between;">
                                <span>${pruebaDeVida.label}</span>
                                <span style="opacity:0.8;">Custodio Blindado</span>
                            </div>
                        </div>
                    `;
                } else {
                    indicadorEtaHtml = `
                        <div style="background:#fffbeb; border:1.5px solid #facc15; border-radius:10px; padding:7px 10px; margin-bottom:8px; font-size:11px; color:#92400e; display:flex; flex-direction:column; gap:4px; box-shadow:0 1px 3px rgba(234,179,8,0.08);">
                            <div style="display:flex; align-items:center; justify-content:space-between;">
                                <span style="font-weight:900;">⏱️ Chofer esperando (+${minutosDemoraChofer}m)</span>
                                <span style="font-weight:900; background:#fef3c7; color:#b45309; padding:1.5px 7px; border-radius:6px; border:1px solid #fde68a;">Demora: +$${recargoEsperaChofer} al chofer</span>
                            </div>
                            <div style="font-size:10px; color:${pruebaDeVida.color}; font-weight:800; border-top:1px dashed #fde68a; padding-top:3px; display:flex; justify-content:space-between;">
                                <span>${pruebaDeVida.label}</span>
                                <span style="opacity:0.8;">Custodio Activo</span>
                            </div>
                        </div>
                    `;
                }
            } else if (esNuevoPendiente || esConfirmado) {
                indicadorEtaHtml = `
                    <div style="background:#fffef5; border:1.5px solid #fde047; border-radius:10px; padding:6px 9px; margin-bottom:8px; font-size:11px; color:#2D3277; display:flex; align-items:center; justify-content:space-between;">
                        <span style="font-weight:800;">⏱️ Tiempo estimado chofer al local:</span>
                        <span style="font-weight:900; background:#FFE600; color:#2D3277; padding:1px 6px; border-radius:6px; border:1px solid #eab308;">~${etaBaseMinutos} min (~${distanciaKm.toFixed(1)} km)</span>
                    </div>
                `;
            }

            // Estado dinámico del botón de Embalar (Blanco con Amarillo y Navy)
            let textoBotonEmbalar = 'Embalar';
            let iconoBotonEmbalar = '📦';
            let bgBotonEmbalar = puedeEmbalar ? '#FFE600' : '#f1f5f9';
            let colorBotonEmbalar = puedeEmbalar ? '#2D3277' : '#94a3b8';
            let borderBotonEmbalar = puedeEmbalar ? '1.5px solid #eab308' : '1px solid #cbd5e1';

            if (esEmbalado) {
                textoBotonEmbalar = 'Embalado';
                iconoBotonEmbalar = '✓';
                bgBotonEmbalar = '#fef08a';
                colorBotonEmbalar = '#713f12';
                borderBotonEmbalar = '1.5px solid #facc15';
            } else if (repartidorAsignado) {
                if (minutosRestantesChofer > 0) {
                    textoBotonEmbalar = `Embalar (~${minutosRestantesChofer}m)`;
                    iconoBotonEmbalar = '📦';
                    bgBotonEmbalar = '#FFE600';
                    colorBotonEmbalar = '#2D3277';
                    borderBotonEmbalar = '1.5px solid #eab308';
                } else {
                    textoBotonEmbalar = `Embalar (+⏱️$${recargoEsperaChofer})`;
                    iconoBotonEmbalar = '⚠️';
                    bgBotonEmbalar = '#f59e0b';
                    colorBotonEmbalar = '#ffffff';
                    borderBotonEmbalar = '1.5px solid #d97706';
                }
            }

            // Tema cromático Reparto Fácil Oficial: Blanco con Amarillo (#FFE600) y Navy (#2D3277)
            let cardBg = '#ffffff';
            let cardBorder = '#fde047';
            let avatarBg = '#FFE600';
            let avatarBorder = '#eab308';
            let avatarColor = '#2D3277';
            let dotColor = '#10b981';
            let pillBg = '#fefce8';
            let pillColor = '#854d0e';
            let pillBorder = '#fde047';
            let checkIcon = '<span style="color:#eab308; font-weight:800;">✓✓</span>';
            let totalColor = '#2D3277';

            if (esRechazado) {
                cardBg = '#fffafa';
                cardBorder = '#fca5a5';
                avatarBg = '#fee2e2';
                avatarBorder = '#f87171';
                avatarColor = '#b91c1c';
                dotColor = '#dc2626';
                pillBg = '#fee2e2';
                pillColor = '#b91c1c';
                pillBorder = '#fca5a5';
                checkIcon = '<span style="color:#dc2626; font-weight:900;">✕</span>';
                totalColor = '#b91c1c';
            } else if (esEntregado) {
                cardBg = '#ffffff';
                cardBorder = '#e2e8f0';
                avatarBg = '#f1f5f9';
                avatarBorder = '#cbd5e1';
                avatarColor = '#475569';
                dotColor = '#64748b';
                pillBg = '#f8fafc';
                pillColor = '#475569';
                pillBorder = '#e2e8f0';
                checkIcon = '<span style="color:#64748b; font-weight:800;">✓✓</span>';
                totalColor = '#334155';
            } else if (repartidorAsignado) {
                cardBg = '#ffffff';
                cardBorder = '#FFE600';
                avatarBg = '#FFE600';
                avatarBorder = '#eab308';
                avatarColor = '#2D3277';
                dotColor = '#10b981';
                pillBg = '#fefce8';
                pillColor = '#854d0e';
                pillBorder = '#fde047';
                checkIcon = '<span style="color:#10b981; font-weight:800;">✓✓</span>';
                totalColor = '#2D3277';
            } else if (esEmbalado) {
                cardBg = '#ffffff';
                cardBorder = '#facc15';
                avatarBg = '#fef08a';
                avatarBorder = '#eab308';
                avatarColor = '#2D3277';
                dotColor = '#eab308';
                pillBg = '#fefce8';
                pillColor = '#854d0e';
                pillBorder = '#fde047';
            } else if (esNuevoPendiente || esConfirmado) {
                cardBg = esNuevoPendiente ? '#fffef5' : '#ffffff';
                cardBorder = alertaStock ? '#f87171' : '#FFE600';
                avatarBg = alertaStock ? '#fee2e2' : '#FFE600';
                avatarBorder = alertaStock ? '#fca5a5' : '#eab308';
                avatarColor = alertaStock ? '#b91c1c' : '#2D3277';
                dotColor = alertaStock ? '#dc2626' : '#FFE600';
                pillBg = alertaStock ? '#fee2e2' : '#fefce8';
                pillColor = alertaStock ? '#b91c1c' : '#854d0e';
                pillBorder = alertaStock ? '#fca5a5' : '#fde047';
            }

            const resumenLinea = esRechazado
                ? `<span style="color:#b91c1c; font-weight:700;">${esCanceladoCliente ? 'Cancelado por el cliente' : (esRechazadoComercio ? 'Rechazado por el comercio' : 'Cancelado por tiempo de espera')} · ${cantItems} ítems</span>`
                : (alertaStock
                    ? `⚠️ Faltan ${itemsSinStock.length} productos · ${cantItems} ítems`
                    : (repartidorAsignado
                        ? `Chofer: ${escaparTextoChat(repartidorAsignado)} · ${cantItems} ítems`
                        : (esNuevoPendiente ? `🔔 Tocar para aceptar o rechazar · ${cantItems} ítems` : `${cantItems} ítems · Pago Web`)));

            html += `
                <div class="card rf-order-card" data-order-id="${escaparTextoChat(p.id)}" style="background:${cardBg}; border-radius:18px; border:2px solid ${cardBorder}; box-shadow:0 3px 12px rgba(234,179,8,0.1), 0 1px 3px rgba(15,23,42,0.04); padding:12px 14px; position:relative; transition:all 0.18s ease;">
                    
                    <!-- FILA COMPACTA (ESTILO MENSAJERÍA BLANCO Y AMARILLO) -->
                    <div onclick="window.RepartoFacilDespacho.toggleDetalle(${argumentoPedido(p.id)})" style="display:flex; align-items:center; gap:10px; cursor:pointer; user-select:none;">
                        <!-- Avatar Circular Amarillo con Iniciales y Punto de Estado -->
                        <div style="position:relative; width:42px; height:42px; border-radius:999px; background:${avatarBg}; border:2px solid ${avatarBorder}; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:14px; color:${avatarColor}; flex-shrink:0; box-shadow:0 2px 5px rgba(234,179,8,0.25);">
                            <span>${escaparTextoChat(iniciales)}</span>
                            <span style="position:absolute; bottom:-1px; right:-1px; width:12px; height:12px; border-radius:999px; background:${dotColor}; border:2px solid #fff;"></span>
                        </div>

                        <!-- Centro: Cliente + #RF + Dirección + Resumen -->
                        <div style="flex:1; min-width:0;">
                            <!-- Fila 1: Nombre del cliente a la izquierda y Estado a la derecha -->
                            <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:3px;">
                                <span style="font-weight:900; font-size:14px; color:${esRechazado ? '#991b1b' : '#2D3277'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                    ${escaparTextoChat(p.cliente_nombre || 'Cliente')}
                                </span>
                                <div style="flex-shrink:0;">
                                    ${badgeEstadoHtml}
                                </div>
                            </div>

                            <!-- Fila 2: Dirección a la izquierda y Monto Total a la derecha -->
                            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:3px;">
                                <div style="font-size:11.5px; color:#475569; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                    📍 ${escaparTextoChat(p.direccion_entrega || 'Entrega a domicilio')}
                                </div>
                                <div style="font-size:14px; font-weight:900; color:${totalColor}; ${esRechazado ? 'text-decoration:line-through;' : ''} white-space:nowrap; flex-shrink:0;">
                                    ${formatMoney(p.total)}
                                </div>
                            </div>

                            <!-- Fila 3: Resumen ítems + ID Corto a la izquierda y Hora a la derecha -->
                            <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                                <div style="font-size:11px; color:#64748b; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center; gap:4px; min-width:0; flex:1;">
                                    ${checkIcon} <span style="overflow:hidden; text-overflow:ellipsis;">${resumenLinea}</span>
                                    <span title="#${escaparTextoChat(p.id)}" style="background:${pillBg}; color:${pillColor}; border:1px solid ${pillBorder}; font-family:monospace; font-size:9.5px; font-weight:800; padding:1px 5px; border-radius:6px; flex-shrink:0;">#${escaparTextoChat(formatearIdCorto(p.id))}</span>
                                </div>
                                <span style="color:#64748b; font-size:10.5px; font-weight:700; white-space:nowrap; flex-shrink:0;">${formatFecha(p.created_at)}</span>
                            </div>
                        </div>

                        <!-- Flecha indicadora de desplegable -->
                        <div id="chevron-pedido-${escaparTextoChat(p.id)}" style="color:#2D3277; font-size:18px; font-weight:900; flex-shrink:0; transition:transform 0.2s ease; transform:${abierto ? 'rotate(90deg)' : 'rotate(0deg)'};">
                            ›
                        </div>
                    </div>

                    <!-- PANEL EXPANDIBLE AL CLICK: DETALLES, TICKET Y ACCIONES -->
                    <div id="detalle-pedido-${escaparTextoChat(p.id)}" style="display:${abierto ? 'block' : 'none'}; margin-top:12px; padding-top:12px; border-top:1px solid #fef08a;">
                        
                        <!-- TICKET / COMANDA DIGITAL INTEGRADA (PEDIDOS ADENTRO DEL TICKET ESTILO BLANCO Y AMARILLO) -->
                        <div style="background:#ffffff; border:2px dashed #facc15; border-radius:16px; padding:12px 14px; margin-bottom:10px; position:relative; box-shadow:0 2px 8px rgba(234,179,8,0.06);">
                            <!-- Encabezado del Ticket -->
                            <div style="display:flex; align-items:center; justify-content:space-between; padding-bottom:8px; margin-bottom:8px; border-bottom:1px dashed #fde047;">
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <span style="font-size:15px;">🧾</span>
                                    <div>
                                        <div style="font-size:12px; font-weight:900; color:#2D3277; text-transform:uppercase; letter-spacing:0.3px;">
                                            ${p.ticket_id ? `Ticket #${escaparTextoChat(p.ticket_id)}` : `Comanda #${escaparTextoChat(formatearIdCorto(p.id))}`}
                                        </div>
                                        <div style="font-size:10px; color:#64748b; font-weight:700;">
                                            ${escaparTextoChat(p.sucursal_origen || 'Sucursal Maciel')} · ${formatFecha(p.created_at)}
                                        </div>
                                    </div>
                                </div>
                                <div style="display:flex; align-items:center; gap:5px;">
                                    ${p.ticket_id ? `
                                        <button type="button" onclick="window.RepartoFacilDespacho.verTicket(${argumentoPedido(p.ticket_id)})" style="background:#fef9c3; color:#2D3277; border:1px solid #fde047; border-radius:8px; font-size:10.5px; font-weight:900; padding:3px 8px; cursor:pointer; display:inline-flex; align-items:center; gap:3px;">
                                            Ver / Imprimir ↗
                                        </button>
                                    ` : ''}
                                    ${puedeReasignar ? `
                                        <button type="button" onclick="window.RepartoFacilDespacho.liberarPorCustodio(${argumentoPedido(p.id)})" style="background:#fff1f2; color:#be123c; border:1px solid #fecdd3; border-radius:8px; font-size:10px; font-weight:800; padding:3px 6px; cursor:pointer;">
                                            ⚠️ Reasignar
                                        </button>
                                    ` : ''}
                                </div>
                            </div>

                            <!-- Teléfono y WhatsApp dentro del Ticket -->
                            ${p.cliente_telefono ? `
                                <div style="display:flex; align-items:center; justify-content:space-between; background:#fffef5; border:1px solid #fde047; border-radius:9px; padding:5px 9px; margin-bottom:7px; font-size:11px;">
                                    <span style="color:#2D3277; font-weight:700;">📞 ${escaparTextoChat(p.cliente_telefono)}</span>
                                    <a href="https://wa.me/${String(p.cliente_telefono).replace(/[^0-9]/g, '')}?text=Hola,%20nos%20comunicamos%20desde%20Cobro%20Fácil%20por%20tu%20pedido%20${encodeURIComponent(p.id)}" target="_blank" rel="noopener noreferrer" style="color:#15803d; font-weight:900; text-decoration:none; display:inline-flex; align-items:center; gap:3px; background:#f0fdf4; border:1px solid #bbf7d0; padding:2px 8px; border-radius:6px;">
                                        <span>WhatsApp</span> ↗
                                    </a>
                                </div>
                            ` : ''}

                            <!-- Domicilio exacto y enlace GPS -->
                            <div style="display:flex; align-items:center; justify-content:space-between; background:#fffef5; border:1px solid #fde047; border-radius:9px; padding:5px 9px; margin-bottom:7px; font-size:11px;">
                                <span style="color:#2D3277; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:230px;" title="${escaparTextoChat(p.direccion_entrega || '')}">
                                    📍 ${escaparTextoChat(p.direccion_entrega || 'Domicilio')}
                                </span>
                                <a href="https://www.google.com/maps/dir/?api=1&destination=${(p.delivery_lat && p.delivery_lng) ? (p.delivery_lat + ',' + p.delivery_lng) : encodeURIComponent(p.direccion_entrega || '')}" target="_blank" rel="noopener noreferrer" style="color:#2D3277; font-weight:900; text-decoration:none; display:inline-flex; align-items:center; gap:2px; flex-shrink:0; background:#FFE600; padding:2px 8px; border-radius:6px; border:1px solid #eab308;">
                                    <span>GPS</span> ↗
                                </a>
                            </div>

                            <!-- Indicador de ETA y Chofer en Camino dentro del Ticket -->
                            ${indicadorEtaHtml}

                            <!-- Alerta de Stock si faltan cortes -->
                            ${alertaStock ? `
                                <div style="background:#fee2e2; color:#b91c1c; padding:6px 8px; border-radius:7px; font-size:11px; font-weight:700; margin-bottom:6px; border:1px solid #fca5a5;">
                                    ⚠️ Faltan productos en stock para este ticket:
                                    ${itemsSinStock.map(i => `
                                        <div style="margin-top:2px; font-weight:600;">• ${escaparTextoChat(i.producto_nombre || i.name || i.nombre)}: stock ${escaparTextoChat(i.stock_disponible)} de ${escaparTextoChat(i.stock_requerido)}</div>
                                    `).join('')}
                                </div>
                            ` : ''}

                            <!-- LISTA DE PEDIDOS / CORTES ADENTRO DEL TICKET (CON SCROLL CONTROLADO PARA TICKETS LARGOS) -->
                            <div style="display:flex; flex-direction:column; gap:5px; margin-bottom:8px; max-height:170px; overflow-y:auto; padding-right:4px;">
                                ${itemsArray.map(item => {
                                    const itemSinStock = itemsSinStock.find(s =>
                                        (s.name || s.nombre) === (item.name || item.nombre) ||
                                        s.id === item.id
                                    );
                                    const styleSinStock = itemSinStock ? 'color:#b91c1c; text-decoration:line-through; opacity:0.6;' : 'color:#2D3277;';
                                    const cant = Number(item.quantity || item.cantidad || 1);
                                    const precio = Number(item.price || item.precio || 0);
                                    const subtotal = precio * cant;
                                    return `
                                    <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:3px 0; border-bottom:1px solid #fef9c3;">
                                        <div style="min-width:0; flex:1; padding-right:8px;">
                                            <div style="font-weight:700; ${styleSinStock} overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                                • ${cant} ${escaparTextoChat(item.unit || item.unidad || 'KG')} de ${escaparTextoChat(item.name || item.nombre || 'Artículo')}
                                                ${itemSinStock ? `<span style="color:#b91c1c; font-size:10px; margin-left:4px;">(falta stock)</span>` : ''}
                                            </div>
                                        </div>
                                        <div style="font-weight:900; font-family:monospace; color:#2D3277; flex-shrink:0;">
                                            ${formatMoney(subtotal)}
                                        </div>
                                    </div>
                                    `;
                                }).join('')}
                            </div>
                            ${itemsArray.length > 3 ? `
                                <div style="font-size:9.5px; color:#854d0e; text-align:center; padding-bottom:5px; font-weight:700;">
                                    ↕ Deslizá para ver los ${itemsArray.length} cortes
                                </div>
                            ` : ''}

                            ${p.notas ? `
                                <div style="font-size:11px; color:#854d0e; background:#fefce8; padding:6px 9px; border-radius:8px; border:1px solid #fde047; margin-bottom:7px;">
                                    <b>Nota del cliente:</b> "${escaparTextoChat(p.notas)}"
                                </div>
                            ` : ''}

                            <!-- Pie del Ticket: Total y Método de Pago -->
                            <div style="display:flex; justify-content:space-between; align-items:center; padding-top:8px; border-top:1px dashed #fde047; font-size:12.5px;">
                                <span style="font-weight:800; color:#64748b;">TOTAL TICKET:</span>
                                <span style="font-weight:900; color:#2D3277; font-family:monospace; font-size:14.5px;">${formatMoney(p.total)}</span>
                            </div>
                        </div>

                        ${esNuevoPendiente ? `
                            <!-- DECISIÓN DE COBRO FÁCIL: ACEPTAR O RECHAZAR -->
                            <div style="background:#fffef5; border:1.5px solid #fde047; border-radius:14px; padding:12px; margin-bottom:8px; box-shadow:0 2px 6px rgba(234,179,8,0.08);">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                    <span style="font-size:11px; font-weight:900; color:#2D3277; text-transform:uppercase;">¿Aceptar pedido para despacho?</span>
                                    <span style="background:#fef9c3; color:#2D3277; border:1px solid #fde047; font-size:10px; font-weight:800; padding:1px 6px; border-radius:6px;">
                                        ⏱️ Chofer a sucursal: ~${etaBaseMinutos}m
                                    </span>
                                </div>
                                <div style="font-size:10.5px; color:#64748b; line-height:1.4; margin-bottom:10px;">
                                    💬 <i>Podés usar el <b>Chat con el cliente</b> para pulir el pedido antes de aceptar o embalar si necesitás unos minutos extra sin apurar al cliente.</i>
                                </div>
                                <div style="display:flex; gap:8px;">
                                    <button type="button" class="btn" onclick="window.RepartoFacilDespacho.rechazarPedido(${argumentoPedido(p.id)})" style="flex:1; background:#ffffff; color:#b91c1c; border:1px solid #fca5a5; border-radius:10px; font-size:11px; font-weight:800; padding:8px 6px !important; cursor:pointer;">
                                        ✕ Rechazar
                                    </button>
                                    <button type="button" class="btn" onclick="window.RepartoFacilDespacho.aceptarPedido(${argumentoPedido(p.id)})" style="flex:1.5; background:#FFE600; color:#2D3277; border:1.5px solid #eab308; border-radius:10px; font-size:12px; font-weight:900; padding:8px 8px !important; cursor:pointer; box-shadow:0 3px 10px rgba(255,230,0,0.35);">
                                        ✓ Aceptar y Publicar
                                    </button>
                                </div>
                            </div>
                        ` : ''}

                        <!-- BOTONES DE ACCIÓN: CERRAR DETALLE, CHAT Y EMBALADO CON IMPACTO DE TIEMPO -->
                        <div style="display:flex; gap:6px; width:100%; box-sizing:border-box;">
                            <button type="button" class="btn btn-ver-pedido" onclick="window.RepartoFacilDespacho.toggleDetalle(${argumentoPedido(p.id)})" style="flex:1; min-width:0; background:#ffffff; color:#475569; border:1.5px solid #e2e8f0; border-radius:12px; font-size:11px; font-weight:800; padding:8px 4px !important; gap:3px !important; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; white-space:nowrap; transition:all 0.15s ease;">
                                <span>📋</span>
                                <span>Ocultar</span>
                            </button>

                            <button type="button" class="btn btn-chat-pedido" onclick="window.RepartoFacilDespacho.abrirChat(${argumentoPedido(p.id)}, ${argumentoPedido(p.cliente_nombre || 'Cliente')})" style="flex:1; min-width:0; background:#fefce8; color:#2D3277; border:1.5px solid #fde047; border-radius:12px; font-size:11px; font-weight:900; padding:8px 4px !important; gap:3px !important; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; white-space:nowrap; transition:all 0.15s ease;">
                                <span>💬</span>
                                <span>Chat</span>
                            </button>

                            <button type="button" class="btn btn-embalar-pedido" onclick="window.RepartoFacilDespacho.marcarEmbalado(${argumentoPedido(p.id)}, ${recargoEsperaChofer}, ${minutosDemoraChofer})" ${puedeEmbalar ? '' : 'disabled'} style="flex:1.4; min-width:0; background:${bgBotonEmbalar}; color:${colorBotonEmbalar}; border:${borderBotonEmbalar}; border-radius:12px; font-size:11px; font-weight:900; padding:8px 4px !important; gap:3px !important; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; box-shadow:0 2px 8px rgba(234,179,8,0.25); white-space:nowrap; transition:all 0.15s ease;">
                                <span>${iconoBotonEmbalar}</span>
                                <span>${textoBotonEmbalar}</span>
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
                if (recargoEspera > 0) {
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
                        <button type="button" onclick="window.RepartoFacilDespacho.cerrarChatModal()" style="background:transparent; border:none; color:#fde047; font-size:22px; cursor:pointer; line-height:1; font-weight:900; padding:2px 8px;">
                            ✕
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
        $('rfChatSub').textContent = `📍 ${order && order.direccion_entrega ? order.direccion_entrega : 'Entrega a domicilio'} · #${shortCode}`;
        
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
                    <!-- Fila Superior: Enlace con Servidor de la Tienda Física -->
                    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; border-bottom:1px dashed #fde047; padding-bottom:8px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <span style="display:inline-block; width:10px; height:10px; border-radius:999px; background:#10b981; box-shadow:0 0 6px rgba(16,185,129,0.8); animation:pulse 2s infinite;"></span>
                            <span style="font-size:11.5px; font-weight:900; color:#2D3277; text-transform:uppercase; letter-spacing:0.3px;">
                                Servidor Tienda Física En Línea
                            </span>
                            <span style="background:#fefce8; color:#854d0e; border:1px solid #fde047; font-size:9.5px; font-weight:800; padding:1px 6px; border-radius:6px;">
                                TPV Omnicanal
                            </span>
                        </div>
                        <button type="button" onclick="window.RepartoFacilDespacho.sincronizarStockTpv()" style="background:#FFE600; color:#2D3277; border:1.5px solid #eab308; border-radius:10px; font-size:10px; font-weight:900; padding:5px 11px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; box-shadow:0 1px 4px rgba(234,179,8,0.25); transition:all 0.15s ease;">
                            <span>⚡ Sincronizar Stock TPV con Web</span>
                        </button>
                    </div>

                    <!-- Fila Inferior: Métricas Consolidadas del Día (Físico + E-Commerce) -->
                    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; text-align:center;">
                        <div style="background:#fffef5; border:1.5px solid #fde047; border-radius:14px; padding:8px 6px;">
                            <span style="font-size:9.5px; color:#64748b; font-weight:800; display:block; text-transform:uppercase;">🏪 Mostrador Físico</span>
                            <b style="font-size:13px; font-weight:900; color:#2D3277; font-family:monospace; display:block; margin-top:2px;">
                                ${formatMoneyNum(data.ventas_mostrador_hoy)}
                            </b>
                            <small style="font-size:9.5px; color:#854d0e; font-weight:700;">${data.cant_ventas_mostrador_hoy} venta${data.cant_ventas_mostrador_hoy === 1 ? '' : 's'}</small>
                        </div>

                        <div style="background:#fffef5; border:1.5px solid #fde047; border-radius:14px; padding:8px 6px;">
                            <span style="font-size:9.5px; color:#64748b; font-weight:800; display:block; text-transform:uppercase;">🌐 E-Commerce Web</span>
                            <b style="font-size:13px; font-weight:900; color:#2D3277; font-family:monospace; display:block; margin-top:2px;">
                                ${formatMoneyNum(data.ventas_web_hoy)}
                            </b>
                            <small style="font-size:9.5px; color:#854d0e; font-weight:700;">${data.cant_pedidos_web_hoy} pedido${data.cant_pedidos_web_hoy === 1 ? '' : 's'}</small>
                        </div>

                        <div style="background:#FFE600; border:1.5px solid #eab308; border-radius:14px; padding:8px 6px; box-shadow:0 2px 6px rgba(234,179,8,0.25);">
                            <span style="font-size:9.5px; color:#2D3277; font-weight:900; display:block; text-transform:uppercase;">📈 Total Omnicanal</span>
                            <b style="font-size:13.5px; font-weight:900; color:#2D3277; font-family:monospace; display:block; margin-top:2px;">
                                ${formatMoneyNum(data.total_omnicanal_hoy)}
                            </b>
                            <small style="font-size:9.5px; color:#2D3277; font-weight:900;">${data.pedidos_activos_web} activo${data.pedidos_activos_web === 1 ? '' : 's'}</small>
                        </div>
                    </div>
                </div>
            `;
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
