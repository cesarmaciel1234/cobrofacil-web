const $ = id => document.getElementById(id);
        const esc = s => (window.CrmSafe && window.CrmSafe.esc(s)) || String(s ?? '');

        window.onerror = function(msg, url, lineNo, columnNo, error) {
            if (String(msg).includes('api.open-meteo.com')) return false;
            console.error("Error global de JS:", msg, "Línea:", lineNo, "Error:", error);
            // Usar toast en lugar de alert para no bloquear la UI
            try {
                const toastEl = document.getElementById('toast');
                if (toastEl) {
                    toastEl.textContent = 'Error inesperado: ' + msg;
                    toastEl.className = 'toast show error';
                    clearTimeout(toastEl._t);
                    toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 5000);
                }
            } catch (_) {}
            return false;
        };


        // --- Módulos CRM (crm-db, crm-sync-api, crm-loader, crm-delete) ---
        const db = CrmDb.db;
        const ensureDataShape = CrmDb.ensureDataShape;
        const tenantCacheGet = (name) => CrmDb.tenantCacheGet(name);
        const tenantCacheGetEntry = (name) => CrmDb.tenantCacheGetEntry(name);
        const tenantCachePut = (name, payload) => CrmDb.tenantCachePut(name, payload);
        const api = CrmApi.api.bind(CrmApi);
        const countPendingOutbox = CrmApi.countPendingOutbox.bind(CrmApi);
        const drainOutboxAll = CrmApi.drainOutboxAll.bind(CrmApi);
        const dispararSyncInmediato = CrmApi.dispararSyncInmediato.bind(CrmApi);
        const actualizarUIOffline = CrmApi.actualizarUIOffline.bind(CrmApi);
        const sincronizarSolicitudesPendientes = CrmApi.sincronizarSolicitudesPendientes.bind(CrmApi);
        const publishNodeBackupAfterSync = CrmApi.publishNodeBackupAfterSync.bind(CrmApi);
        const loadAll = CrmLoader.loadAll.bind(CrmLoader);
        const descargarDatosDeLaNube = CrmLoader.descargarDatosDeLaNube.bind(CrmLoader);
        const refrescarManual = CrmLoader.refrescarManual.bind(CrmLoader);
        const servidorTieneDatos = CrmLoader.servidorTieneDatos.bind(CrmLoader);
        const aplicarCambioOptimista = CrmDelete.aplicarCambioOptimista.bind(CrmDelete);

        const { parseNumLocal, fmt, fmtFecha, fmtCompact, fmtDual, fmtDualCompact, fmtPct, parseKgInput, csvCell, getEmpresaDatos } = CrmFormat;
        const {
            remitoEstado,
            remitoSaldoPendiente,
            invalidateRemitosFullCache,
            toast,
            setLoading,
            REMITOS_FULL_CACHE_MS,
        } = CrmUi;
        const {
            abrirModalBackup,
            cerrarModalBackup,
            obtenerPayloadBackup,
            guardarCacheDispositivo,
            leerArchivoJson,
            subirBackupAlServidor,
            descargarArchivoJson,
            initBackupUi,
        } = CrmBackup;

        async function registrarTransaccion(datos) {
            const uuid = crypto.randomUUID();
            toast('Obligación registrada');
            void aplicarOperacionOptimista(datos, uuid)
                .then(() => void enviarOperacionFinanciera(datos, uuid))
                .catch((e) => {
                    console.error('Error al guardar localmente:', e);
                    toast(e.message || 'Error al guardar', true);
                });
            return true;
        }

        async function enviarOperacionFinanciera(payload, uuid) {
            const body = JSON.stringify({ ...payload, uuid });
            try {
                if (!navigator.onLine) {
                    if (window.CrmSync?.enqueueChange) {
                        await CrmSync.enqueueChange({
                            entity: 'operacion',
                            entity_uuid: uuid,
                            action: 'CREATE',
                            payload: { ...payload, uuid },
                        });
                    } else {
                        await db.solicitudes_pendientes.add({
                            url: '/api/operaciones',
                            method: 'POST',
                            body,
                            created_at: new Date().toISOString(),
                        });
                    }
                    void actualizarUIOffline();
                    void dispararSyncInmediato(false);
                    return;
                }
                const res = await api('/api/operaciones', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    _skipOfflineOptimistic: true,
                });
                if (res?.id) {
                    data = ensureDataShape(data);
                    const e = data.enemigos.find(x => x.uuid === uuid);
                    if (e) e.id = res.id;
                    void persistirYRefrescarUI();
                }
            } catch (e) {
                console.warn('enviar operación financiera:', e);
                toast(e.message || 'No se pudo sincronizar la obligación', true);
            }
        }

        function aplicarPagoLocalOptimista(opId, numero, monto) {
            data = ensureDataShape(data);
            CrmDelete.aplicarPagoCuotaOptimista(data, opId, numero, monto);
            recalcularMetricasLocales();
            void persistirYRefrescarUI();
        }

        function aplicarCobroRemitoLocal(remitoId, monto) {
            data = ensureDataShape(data);
            CrmDelete.aplicarCobroRemitoOptimista(data, remitoId, monto);
            void persistirYRefrescarUI();
            if (currentClientData && $('view-cliente-detalle')?.classList.contains('active')) {
                renderClientDashboard();
            } else {
                renderRemitosFull();
            }
        }

        function aplicarCobroClienteLocal(clientId, monto) {
            data = ensureDataShape(data);
            CrmDelete.aplicarCobroClienteOptimista(data, clientId, monto);
            void persistirYRefrescarUI();
            renderCobranzas();
        }

        // -----------------------------------
        function buildEnemigoOptimista(payload, uuid) {
            const tipo = String(payload.tipo || '').toLowerCase();
            const recibido = tipo === 'cheque' ? parseNumLocal(payload.monto) : parseNumLocal(payload.recibido);
            let pagar = parseNumLocal(payload.pagar);
            if (tipo === 'cheque') {
                const monto = parseNumLocal(payload.monto);
                let imp = 0;
                if (payload.impuesto_cheque_tipo === 'porcentaje') {
                    imp = monto * parseNumLocal(payload.impuesto_cheque_valor) / 100;
                } else if (payload.impuesto_cheque_tipo === 'monto') {
                    imp = parseNumLocal(payload.impuesto_cheque_valor);
                }
                pagar = monto + imp;
            } else if (tipo === 'proveedor' && !pagar) {
                pagar = recibido;
            }
            const meses = parseInt(payload.meses, 10) || 0;
            const es_cheque = tipo === 'cheque';
            const es_proveedor = tipo === 'proveedor';
            const es_tarjeta = tipo === 'tarjeta';
            let impuestoCheque = 0;
            if (es_cheque) {
                if (payload.impuesto_cheque_tipo === 'porcentaje') {
                    impuestoCheque = recibido * parseNumLocal(payload.impuesto_cheque_valor) / 100;
                } else if (payload.impuesto_cheque_tipo === 'monto') {
                    impuestoCheque = parseNumLocal(payload.impuesto_cheque_valor);
                } else if (payload.impuesto_cheque) {
                    impuestoCheque = parseNumLocal(payload.impuesto_cheque);
                } else {
                    impuestoCheque = Math.max(0, pagar - recibido);
                }
            }
            const sin_interes = es_cheque ? impuestoCheque <= 0 : (es_proveedor && pagar <= recibido);
            const interes = es_cheque ? impuestoCheque : (sin_interes ? 0 : Math.max(0, pagar - recibido));
            let cfr = null;
            if (!sin_interes && !es_cheque && recibido > 0 && meses > 0) {
                cfr = ((pagar / recibido) - 1) / meses * 100;
            }
            const tempId = 'temp_' + String(uuid).replace(/-/g, '').slice(0, 12);
            return {
                id: tempId,
                uuid,
                alias: payload.alias || 'Sin nombre',
                tipo: payload.tipo,
                recibido,
                pagar,
                total_pagar: pagar,
                meses,
                fecha_cierre: payload.fecha_cierre || null,
                fecha_vencimiento: payload.fecha_vencimiento || null,
                cuotas: parseInt(payload.cuotas, 10) || null,
                cuotas_pagadas: 0,
                interes: Math.round(interes * 100) / 100,
                cfr: cfr != null ? Math.round(cfr * 100) / 100 : null,
                sin_interes,
                urgente: cfr != null && cfr > 10,
                es_tarjeta,
                es_cheque,
                es_proveedor,
                kg: parseNumLocal(payload.kg) || null,
                precio_kg: parseNumLocal(payload.precio_kg) || null,
                plazo_dias: parseInt(payload.plazo_dias, 10) || null,
                dias_faltantes: 30,
                completa: false,
                monto_pagado: 0,
                _optimistic: true,
            };
        }

        function calcMetricasFlotantes(enemigos, estrategia) {
            let sangre_diaria = 0;
            let interes_diario = 0;
            let deuda_total = 0;
            let interes_acumulado = 0;
            for (const d of enemigos || []) {
                const monto = d.recibido || 0;
                const interes = d.interes || 0;
                const total = d.total_pagar || d.pagar || (monto + interes);
                if (d.vencido) {
                    const dias = Math.max(1, d.dias_retraso || 1);
                    sangre_diaria += total / dias;
                    interes_diario += interes / dias;
                } else {
                    const dias = Math.max(1, d.dias_faltantes || 30);
                    sangre_diaria += (monto + interes) / dias;
                    interes_diario += interes / dias;
                }
                deuda_total += total;
                interes_acumulado += interes;
            }
            const activo = estrategia?.activo || estrategia?.flujo || {};
            const capital_disponible = (activo.capital_neto || 0) + interes_acumulado;
            const cubre = (activo.activo_pendiente || 0) >= ((activo.deuda_real || 0) - interes_acumulado);
            return {
                sangre: sangre_diaria,
                int_diario: interes_diario,
                deuda: deuda_total,
                int_acumulado: interes_acumulado,
                capital: capital_disponible,
                tendencia: cubre ? 'up' : 'down',
            };
        }

        function recalcularMetricasLocales() {
            data.metricas_flotantes = calcMetricasFlotantes(data.enemigos || [], data.estrategia || {});
            data.totales = data.totales || {};
            data.totales.deudas_activas = (data.enemigos || []).length;
            data.totales.urgentes = (data.enemigos || []).filter(e => e.urgente).length;
        }

        async function persistirYRefrescarUI() {
            data = ensureDataShape(data);
            await tenantCachePut('appData', data);
            safeRenderAll();
            void actualizarUIOffline();
        }

        function safeRenderAll() {
            try {
                data = ensureDataShape(data);
                renderAll();
            } catch (e) {
                console.error('renderAll:', e);
                setLoading(false);
            }
        }

        async function aplicarOperacionOptimista(payload, uuid) {
            data = ensureDataShape(data);
            const enemigo = buildEnemigoOptimista(payload, uuid);
            if (!data.enemigos.some(e => e.uuid === uuid)) {
                data.enemigos.push(enemigo);
            }
            recalcularMetricasLocales();
            await persistirYRefrescarUI();
        }

        // -----------------------------------
        let remitoPagoActual = null;
        let cobranzaClienteActual = null;
        let pagoCentralDeudaActual = null;

        let data = CrmDb.emptyAppData();
        let isProMode = true;
        let selectedDeuda = null;
        let selectedAuditId = null;
        let sessionUser = { role: 'admin', username: '', empresa_id: 1, empresa_nombre: '' };

        let histPagosFiltro = '';
        let activeRowIndex = -1;
        let carteraEnPantalla = [];
        let faltantesEnPantalla = [];
        let mensajePedido = '';
        let filtroProveedorPedido = '';
        let carritoPedido = {};
        const CARRITO_LOCAL = 'crm-carrito-pedido';
        let ticketsEnPantalla = [];
        let cajasVentas = [];
        let ticketsResumen = { total: 0, ok: 0, recorte: false };
        let ticketsAviso = '';
        let filtroVentas = {
            q: '',
            pago: 'TODOS',
            alcance: 'mes',
            fecha: '',
            historico: false,
            franja: false,
            hora_desde: '08:00',
            hora_hasta: '21:00',
            caja: '',
            desde: '',
            hasta: ''
        };
        let redCrm = { enLinea: true, sync: '' };
        let cajaPantalla = 'arqueo';
        let periodoDigital = 'Semana';
        let periodoDigitalDesde = '';
        let periodoDigitalHasta = '';
        let periodoCaja = 'Hoy';
        let periodoCajaDesde = '';
        let periodoCajaHasta = '';
        let ventasPantalla = 'historial';
        let periodoDesglose = 'Hoy';
        let periodoDesgloseDesde = '';
        let periodoDesgloseHasta = '';
        let libroDigital = null;

        const titles = {
            home: ['Inicio', 'Resumen rápido', 'Inicio'],
            dashboard: ['', 'Análisis general del negocio', 'Panel del jefe'],
            deudas: ['Prioridad de pagos', 'Obligaciones ordenadas por impacto financiero', 'Obligaciones'],
            remitos: ['Historial de venta', 'Historial de ventas y márgenes', 'Ventas'],
            clientes: ['CRM de Clientes', 'Gestión de cuentas corrientes y créditos', 'Clientes'],
            registro: ['Nueva deuda', 'Alta de deudas, remitos y entidades', 'Deuda'],
            'compra-bulk': ['Compra Bulk', 'Registrar nuevo lote mayorista de carne', 'Bulk'],
            'ventas-express': ['Ventas Express', 'Registro rápido de ventas de mostrador', 'Express'],
            'historial-pagos': ['Historial de pagos', 'Ledger de movimientos por cuota', 'Pagos'],
            cobranzas: ['Central de Cobranzas', 'Clientes con saldo pendiente', 'Cobranzas'],
            'pago-central': ['Pago Centralizado Empresarial', 'Obligaciones pendientes de pago', 'Pagos'],
            auditoria: ['Auditoría', 'Historial completo de acciones', 'Historial'],
            usuarios: ['Usuarios', 'Gestión de accesos y roles', 'Usuarios'],
            'cliente-detalle': ['Perfil de Cliente', 'Detalle corporativo y facturación', 'Perfil'],
            'nueva-venta': ['Registrar Venta', 'Emitir remito o factura a cuenta corriente', 'Ventas'],
            'finanzas-aging': ['Antigüedad de deuda', 'Análisis de vencimiento de facturas', 'Deuda'],
            'finanzas-margenes': ['Márgenes de venta', 'Rentabilidad y costos de remitos', 'Márgenes'],
            reporte: ['Reporte', 'Cerebro Jefe, sin el historial de tickets', 'Reporte'],
            proveedor: ['Proveedor', 'Proveedores del libro de Cobro Fácil', 'Proveedor'],
            promedio: ['Promedio', 'Ticket medio del día', 'Promedio'],
            ticket: ['Ticket', 'Historial de tickets del día', 'Ticket'],
            contabilidad: ['Contabilidad', 'Caja, cobros y gastos del espejo', 'Contabilidad'],
            admin: ['Cartera & Fiado', 'Libro de la sucursal', 'Fiado'],
            'historial-fiado': ['Historial del cliente', 'Movimientos del libro de Cobro Fácil', 'Historial'],
            digitales: ['Cobros Digitales MP', 'Auditoría de Mercado Pago, QR y Point', 'Digital'],
            pedidos: ['Pedidos al Frigorífico', 'Faltantes de stock y mensaje WhatsApp', 'Pedidos'],
            cartera: ['Cartera', 'Clientes del libro', 'Cartera']
        };

        function plazoTexto(e) {
            if (e.es_proveedor) {
                let t = e.plazo_texto || (e.plazo_dias != null ? e.plazo_dias + ' días' : '—');
                if (e.kg && e.precio_kg) t = fmt(e.kg) + ' kg × $' + fmt(e.precio_kg) + ' · ' + t;
                if (e.tiene_cuotas && e.cuotas_total) t += ' · Pago ' + (e.cuotas_pagadas || 0) + '/' + e.cuotas_total;
                return t;
            }
            if (e.tiene_cuotas && e.cuotas_total) {
                let t = `Cuota ${e.cuotas_pagadas}/${e.cuotas_total}`;
                if (e.es_cheque && e.fecha_vencimiento) t += ' · vto ' + e.fecha_vencimiento;
                else if (e.es_tarjeta && e.fecha_vencimiento) t += ' · vto ' + e.fecha_vencimiento;
                return t;
            }
            if (e.es_cheque) {
                return e.fecha_vencimiento ? 'Cheque · vto ' + e.fecha_vencimiento : 'Cheque';
            }
            if (e.es_tarjeta && e.cuotas) {
                let t = e.cuotas + ' cuota' + (e.cuotas > 1 ? 's' : '');
                if (e.fecha_vencimiento) t += ' · vto ' + e.fecha_vencimiento;
                return t;
            }
            return e.meses + ' meses';
        }

        let planPagoActual = null;

        function calcDiffUi(esperado, pagado) {
            const diff = pagado - esperado;
            const box = $('modalDiff');
            if (!pagado || pagado <= 0) {
                box.className = 'diff-box';
                box.textContent = 'Ingresá el monto a pagar';
                return;
            }
            if (diff > 0.005) {
                box.className = 'diff-box punitorio';
                box.innerHTML = `<strong>Interés punitorio:</strong> $${fmt(diff)}<br><span style="font-size:0.75rem;opacity:0.85">Pago mayor a la cuota esperada</span>`;
            } else if (diff < -0.005) {
                box.className = 'diff-box descuento';
                box.innerHTML = `<strong>Descuento:</strong> $${fmt(Math.abs(diff))}<br><span style="font-size:0.75rem;opacity:0.85">Pago menor a la cuota esperada</span>`;
            } else {
                box.className = 'diff-box';
                box.textContent = 'Pago exacto de la cuota';
            }
        }

        async function abrirModalPago() {
            if (!selectedDeuda) return;
            if (!selectedDeuda.tiene_cuotas) {
                toast('Esta obligación no usa plan de cuotas', true);
                return;
            }
            if (selectedDeuda.completa) {
                toast('Todas las cuotas ya están pagadas', true);
                return;
            }
            planPagoActual = await api('/api/operaciones/' + selectedDeuda.id + '/plan-pago');
            $('modalPagoSub').textContent = planPagoActual.alias + ' · Total $' + fmt(planPagoActual.total_pagar);
            $('inpCuotaTotal').textContent = planPagoActual.cuotas_total;
            $('inpCuotaNum').min = planPagoActual.cuotas_pagadas + 1;
            $('inpCuotaNum').max = planPagoActual.cuotas_total;
            $('inpCuotaNum').value = planPagoActual.cuota_en_curso;
            $('inpMontoEsperado').value = fmt(planPagoActual.monto_cuota);
            $('inpMontoPago').value = planPagoActual.monto_cuota;

            const alert = $('modalVencidasAlert');
            if (planPagoActual.cuotas_vencidas > 1) {
                alert.classList.remove('field-hidden');
                alert.textContent = 'Cuotas vencidas: ' + planPagoActual.cuotas_vencidas_lista.join(', ') + ' de ' + planPagoActual.cuotas_total;
            } else if (planPagoActual.vencido) {
                alert.classList.remove('field-hidden');
                alert.textContent = 'Cuota ' + planPagoActual.cuota_en_curso + ' vencida · ' + (planPagoActual.mensaje_vencimiento || '');
            } else {
                alert.classList.add('field-hidden');
            }
            calcDiffUi(planPagoActual.monto_cuota, planPagoActual.monto_cuota);
            $('modalPago').classList.add('open');
        }

        function cerrarModalPago() {
            $('modalPago').classList.remove('open');
            planPagoActual = null;
        }

        function confirmarPago() {
            if (!planPagoActual) return;
            const numero = parseInt($('inpCuotaNum').value, 10);
            const monto = parseFloat($('inpMontoPago').value);
            const opId = planPagoActual.id;
            const cuotasTotal = planPagoActual.cuotas_total;

            aplicarPagoLocalOptimista(opId, numero, monto);
            toast(`Cuota ${numero}/${cuotasTotal} registrada`);
            cerrarModalPago();
            closeDrawer();

            void api('/api/operaciones/' + opId + '/pagar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ numero_cuota: numero, monto_pagado: monto }),
                _skipOfflineOptimistic: true,
            }).catch((e) => toast(e.message, true));
        }

        function abrirModalPagoRemito(remito) {
            if (!remito) return;
            const saldo = remitoSaldoPendiente(remito);
            if (saldo <= 0) {
                toast('Este remito no tiene saldo pendiente', true);
                return;
            }
            remitoPagoActual = remito;
            const cliente = currentClientData?.nombre || remito.cliente || '';
            $('modalPagoRemitoSub').textContent = `Remito #${remito.id}${cliente ? ' · ' + cliente : ''}`;
            $('inpRemitoSaldo').value = fmt(saldo);
            $('inpMontoRemitoPago').value = saldo;
            $('inpMontoRemitoPago').max = saldo;
            $('modalPagoRemito').classList.add('open');
            setTimeout(() => $('inpMontoRemitoPago')?.focus(), 100);
        }

        function cerrarModalPagoRemito() {
            $('modalPagoRemito')?.classList.remove('open');
            remitoPagoActual = null;
        }

        function confirmarPagoRemito() {
            if (!remitoPagoActual) return;
            const saldo = remitoSaldoPendiente(remitoPagoActual);
            const monto = parseFloat($('inpMontoRemitoPago').value);
            if (!monto || monto <= 0) {
                toast('Ingresá un monto válido', true);
                return;
            }
            if (monto > saldo + 0.009) {
                toast('El monto supera el saldo pendiente', true);
                return;
            }
            const remitoId = remitoPagoActual.id;
            aplicarCobroRemitoLocal(remitoId, monto);
            invalidateRemitosFullCache();
            toast('Pago registrado');
            cerrarModalPagoRemito();

            void api('/api/remitos/' + remitoId + '/cobrar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ monto_pagado: monto }),
                _skipOfflineOptimistic: true,
            }).catch((e) => toast(e.message, true));
        }

        function abrirAccionCobranza(clientId) {
            const c = (data.clientes || []).find(x => x.id === clientId);
            if (!c) return;
            cobranzaClienteActual = c;
            if ($('modalCobranzaAccionSub')) {
                $('modalCobranzaAccionSub').textContent = `${c.nombre} · Deuda $${fmt(c.saldo_actual)}`;
            }
            $('modalCobranzaAccion')?.classList.add('open');
        }
        window.abrirAccionCobranza = abrirAccionCobranza;

        function cerrarModalCobranzaAccion() {
            $('modalCobranzaAccion')?.classList.remove('open');
        }

        function cobranzaElegirVer() {
            const c = cobranzaClienteActual;
            cerrarModalCobranzaAccion();
            cobranzaClienteActual = null;
            if (c) openClientDrawer(c.id);
        }

        function cobranzaElegirCobrar() {
            if (!cobranzaClienteActual) return;
            const c = cobranzaClienteActual;
            cerrarModalCobranzaAccion();
            abrirModalPagoGlobal(c);
        }

        function abrirModalPagoGlobal(cliente) {
            if (!cliente) return;
            cobranzaClienteActual = cliente;
            const saldo = Number(cliente.saldo_actual || 0);
            if ($('modalPagoGlobalSub')) $('modalPagoGlobalSub').textContent = cliente.nombre;
            if ($('inpPagoGlobalSaldo')) $('inpPagoGlobalSaldo').value = fmt(saldo);
            if ($('inpMontoPagoGlobal')) {
                $('inpMontoPagoGlobal').value = saldo;
                $('inpMontoPagoGlobal').max = saldo;
            }
            $('modalPagoGlobal')?.classList.add('open');
            setTimeout(() => $('inpMontoPagoGlobal')?.focus(), 100);
        }

        function cerrarModalPagoGlobal() {
            $('modalPagoGlobal')?.classList.remove('open');
            cobranzaClienteActual = null;
        }

        function confirmarPagoGlobal() {
            if (!cobranzaClienteActual) return;
            const saldo = Number(cobranzaClienteActual.saldo_actual || 0);
            const monto = parseFloat($('inpMontoPagoGlobal').value);
            if (!monto || monto <= 0) {
                toast('Ingresá un monto válido', true);
                return;
            }
            if (monto > saldo + 0.009) {
                toast('El monto supera la deuda pendiente', true);
                return;
            }
            const clientId = cobranzaClienteActual.id;
            aplicarCobroClienteLocal(clientId, monto);
            toast('Cobro registrado');
            cerrarModalPagoGlobal();

            void api('/api/clientes/' + clientId + '/cobrar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ monto_pagado: monto }),
                _skipOfflineOptimistic: true,
            }).catch((e) => toast(e.message, true));
        }

        function toggleFormTipo() {
            const tipo = $('selTipo').value;
            const esTarjeta = tipo === 'tarjeta';
            const esCheque = tipo === 'cheque';
            const esProveedor = tipo === 'proveedor';
            const esPrestamo = tipo === 'prestamo';
            const form = $('formDeuda');

            ['fldCierre', 'fldCuotas', 'hintTarjeta'].forEach(id => {
                $(id).classList.toggle('field-hidden', !esTarjeta);
            });
            ['fldMonto', 'hintCheque', 'fldImpuestoChequeTipo', 'fldImpuestoChequeValor', 'fldChequeTotal'].forEach(id => {
                $(id).classList.toggle('field-hidden', !esCheque);
            });
            ['fldKg', 'fldPrecioKg', 'fldProvTotal', 'hintProveedor'].forEach(id => {
                $(id).classList.toggle('field-hidden', !esProveedor);
            });
            ['hintPrestamo', 'fldInicioFecha'].forEach(id => {
                $(id).classList.toggle('field-hidden', !esPrestamo);
            });
            $('fldPlazoDias').classList.toggle('field-hidden', !(esProveedor || esPrestamo));
            $('fldVencimiento').classList.toggle('field-hidden', !(esTarjeta || esCheque));
            $('fldRecibido').classList.toggle('field-hidden', esCheque || esProveedor);
            $('fldPagar').classList.toggle('field-hidden', esCheque);
            $('fldMeses').classList.toggle('field-hidden', esTarjeta || esCheque || esProveedor || esPrestamo);

            if (!esCheque) {
                $('lblRecibido').textContent = esTarjeta ? 'Resumen / consumo ($)' : 'Monto recibido ($)';
                $('lblPagar').textContent = esTarjeta ? 'Total a pagar ($)' : (esProveedor ? 'Total a pagar ($) — opcional si hay interés' : 'Monto a devolver ($)');
            }

            form.monto.required = esCheque;
            form.recibido.required = !esCheque && !esProveedor;
            form.pagar.required = !esCheque && !esTarjeta && !esProveedor;
            form.fecha_cierre.required = esTarjeta;
            form.fecha_vencimiento.required = esTarjeta || esCheque;
            form.cuotas.required = esTarjeta;
            form.meses.required = !esTarjeta && !esCheque && !esProveedor && !esPrestamo;
            if (form.kg) form.kg.required = esProveedor;
            if (form.precio_kg) form.precio_kg.required = esProveedor;
            if (form.plazo_dias) form.plazo_dias.required = esProveedor || esPrestamo;

            if (esTarjeta) form.meses.value = '';
            if (esCheque) { form.recibido.value = ''; form.pagar.value = ''; form.meses.value = ''; updateChequeTotal(); }
            if (esProveedor) { form.recibido.value = ''; form.meses.value = ''; updateProvTotal(); }
            if (esPrestamo) { form.meses.value = ''; }
        }

        function updateChequeTotal() {
            const monto = parseFloat(document.querySelector('[name=monto]')?.value) || 0;
            const modo = $('selImpuestoCheque')?.value || '';
            const val = parseFloat(document.querySelector('[name=impuesto_cheque_valor]')?.value) || 0;
            const box = $('inpTotalCheque');
            if (!box) return;
            let imp = 0;
            if (modo === 'porcentaje' && val > 0) imp = monto * val / 100;
            else if (modo === 'monto' && val > 0) imp = val;
            if (monto > 0) box.textContent = '$' + fmt(monto + imp) + (imp > 0 ? ' (imp. $' + fmt(imp) + ')' : '');
            else box.textContent = '—';
        }

        function updateImpuestoChequeLabel() {
            const modo = $('selImpuestoCheque')?.value || '';
            const lbl = $('lblImpuestoChequeValor');
            if (!lbl) return;
            if (modo === 'porcentaje') lbl.textContent = 'Porcentaje (%)';
            else if (modo === 'monto') lbl.textContent = 'Monto del impuesto ($)';
            else lbl.textContent = 'Valor del impuesto';
        }

        function updateProvTotal() {
            const kg = parseFloat(document.querySelector('[name=kg]')?.value) || 0;
            const pk = parseFloat(document.querySelector('[name=precio_kg]')?.value) || 0;
            const box = $('inpTotalProveedor');
            if (!box) return;
            if (kg > 0 && pk > 0) box.textContent = '$' + fmt(kg * pk);
            else box.textContent = '—';
        }

        function badgeVencimiento(e) {
            if ((!e.es_tarjeta && !e.es_cheque && !e.es_proveedor) || !e.fecha_vencimiento) return '<span class="badge-home neutro">—</span>';
            if (e.vencido) return `<span class="badge-home vencido" style="line-height:1.2;text-align:center;display:inline-block">${e.dias_retraso} días<br>retraso</span>`;
            if (e.estado_vencimiento === 'hoy') return '<span class="badge-home vencido">Hoy</span>';
            if (e.estado_vencimiento === 'proximo') return `<span class="badge-home restantes" style="line-height:1.2;text-align:center;display:inline-block">${e.dias_faltantes} días<br>restantes</span>`;
            return `<span class="badge-home verde" style="line-height:1.2;text-align:center;display:inline-block">${e.dias_faltantes} días<br>restantes</span>`;
        }

        function badgeEstado(e) {
            if (e.vencido) return '<span class="badge badge-danger">Vencido</span>';
            if (e.prioridad) return '<span class="badge badge-danger">Pagar primero</span>';
            if (e.urgente) return '<span class="badge badge-warning">Urgente CFR</span>';
            if (e.estado_vencimiento === 'proximo' || e.estado_vencimiento === 'hoy') return '<span class="badge badge-warning">Vence pronto</span>';
            return '<span class="badge badge-neutral">Normal</span>';
        }

        function vencBannerHtml(e) {
            if ((!e.es_tarjeta && !e.es_cheque && !e.es_proveedor) || !e.fecha_vencimiento) return '';
            let cls = 'ok';
            if (e.vencido) cls = 'vencido';
            else if (e.estado_vencimiento === 'hoy') cls = 'hoy';
            else if (e.estado_vencimiento === 'proximo') cls = 'proximo';
            return `<div class="venc-banner ${cls}">${esc(e.mensaje_vencimiento)}<br><span style="font-size:0.8rem;font-weight:500">Total a pagar: $${fmt(e.total_pagar)} · Vto ${esc(e.fecha_vencimiento)}</span></div>`;
        }

        function renderKpis() {
            const estrategia = data.estrategia || {};
            const s = estrategia.sangria || {};
            const a = estrategia.activo || estrategia.flujo || estrategia.respiracion || {};
            const p = estrategia.proyeccion || {};
            
            const mf = data.metricas_flotantes;
            if (mf) {
                const isMobile = window.innerWidth < 768;
                const formatVal = (val) => isMobile ? fmtCompact(val) : fmt(val);
                const formatSubVal = (val) => isMobile ? fmtCompact(val) : fmt(val);

                if ($('barSangriaValue')) $('barSangriaValue').textContent = '$' + formatVal(mf.sangre);
                if ($('barSangriaSub')) $('barSangriaSub').textContent = `Int: $${formatSubVal(mf.int_diario)}`;
                
                if ($('barDeudaValue')) $('barDeudaValue').textContent = '$' + formatVal(mf.deuda);
                if ($('barDeudaSub')) $('barDeudaSub').textContent = `Int: $${formatSubVal(mf.int_acumulado || 0)}`;
                
                const absCapital = Math.abs(mf.capital);
                const signStr = mf.capital < 0 ? '-' : (mf.capital > 0 ? '+' : '');
                const isNeg = mf.capital < 0;
                const isZero = mf.capital === 0;
                if ($('barCapitalValue')) {
                    $('barCapitalValue').textContent = signStr + '$' + formatVal(absCapital);
                    $('barCapitalValue').className = 'value ' + (isNeg ? 'capital-neg' : isZero ? 'capital-zero' : 'capital-pos');
                }
                if ($('barCapitalTrend')) {
                    const trend = isNeg ? 'down' : (isZero ? 'down' : (mf.tendencia || 'up'));
                    $('barCapitalTrend').textContent = trend === 'up' ? '▲' : '▼';
                    $('barCapitalTrend').className = 'trend ' + trend;
                    $('barCapitalTrend').style.visibility = isZero ? 'hidden' : 'visible';
                }
                if ($('barCapitalSub')) {
                    $('barCapitalSub').textContent = isNeg ? 'En déficit' : isZero ? 'Sin margen' : 'Disponible hoy';
                }
            }

            if ($('kpiMeta')) $('kpiMeta').textContent = fmt(a.stock_kg || 0) + ' kg';
            if ($('kpiExcedente')) $('kpiExcedente').textContent = '$' + fmt(a.caja_real || 0);


        }

        function renderHealth() {
            const estrategia = data.estrategia || {};
            const a = estrategia.activo || estrategia.flujo || estrategia.respiracion || {};
            $('healthGrid').innerHTML = `
                <div class="health-item"><div class="lbl">Activo ventas (Por cobrar)</div><div class="val" style="color:var(--success)">$${fmt(a.activo_pendiente || 0)}</div></div>
                <div class="health-item"><div class="lbl">Caja real (Efectivo disponible)</div><div class="val" style="color:var(--success)">$${fmt(a.caja_real || 0)}</div></div>
                <div class="health-item"><div class="lbl">Stock valorizado</div><div class="val" style="color:var(--accent)">$${fmt(a.activo_mercaderia || 0)}</div></div>
                <div class="health-item"><div class="lbl">Stock disponible</div><div class="val" style="color:var(--accent)">${fmt(a.stock_kg || 0)} kg</div></div>
                <div class="health-item"><div class="lbl">Deuda comercial (Proveedores)</div><div class="val" style="color:var(--warning)">$${fmt(a.deuda_comercial ?? 0)}</div></div>
                <div class="health-item"><div class="lbl">Deuda financiera (Total pendiente)</div><div class="val" style="color:var(--danger)">$${fmt(a.deuda_real ?? 0)}</div></div>
                <div class="health-item"><div class="lbl">Deuda neta (Capital pendiente)</div><div class="val" style="color:var(--danger)">$${fmt(a.deuda_neta ?? 0)}</div></div>
                <div class="health-item"><div class="lbl">Interés neto pendiente</div><div class="val" style="color:var(--warning)">$${fmt(a.interes_neto ?? 0)}</div></div>
            `;

            if ($('balActivos')) $('balActivos').textContent = '$' + fmt(a.activo_total || 0);
            if ($('balPasivos')) $('balPasivos').textContent = '$' + fmt(a.pasivo_total || 0);
            if ($('balPatrimonio')) $('balPatrimonio').textContent = '$' + fmt(a.patrimonio_neto || 0);
        }

        function renderChartCfr() {
            const top = (data.enemigos || [])
                .filter(e => !e.es_proveedor && e.cfr != null)
                .slice(0, 5);
            const max = top.length ? Math.max(...top.map(e => e.cfr || 0), 1) : 1;
            if (!top.length) {
                $('chartCfr').innerHTML = '<div class="empty-state"><strong>Sin deuda financiera con CFR</strong><p>Tarjetas, bancos y préstamos con interés</p></div>';
                return;
            }
            $('chartCfr').innerHTML = top.map(e => {
                const pct = Math.min(100, ((e.cfr || 0) / max) * 100);
                const cls = (e.cfr || 0) > 10 ? 'critical' : '';
                return `<div class="chart-row">
                    <label>${esc(e.alias)}</label>
                    <div class="chart-track"><div class="chart-fill ${cls}" style="width:${pct}%">${fmtPct(e.cfr)}</div></div>
                    <span style="font-size:0.75rem;color:var(--text-muted)">${esc(e.tipo)}</span>
                </div>`;
            }).join('');
        }

        function sortEnemigosPrioridad(list) {
            return [...list].sort((a, b) => {
                const getScore = e => {
                    if (e.vencido) return -1000 - (e.dias_retraso || 0);
                    if (e.estado_vencimiento === 'hoy') return 0;
                    if (e.estado_vencimiento === 'proximo') return e.dias_faltantes;
                    if (e.fecha_vencimiento) return 1000 + e.dias_faltantes;
                    return 10000;
                };
                return getScore(a) - getScore(b);
            });
        }

        function deudaCardHtml(e, opts = {}) {
            const { clickable = true, actionBtnHtml = '' } = opts;
            const isVencido = e.vencido;
            let tipoClase = (e.tipo || 'neutro').toLowerCase();
            const cfrText = e.sin_interes ? '0%' : fmtPct(e.cfr);
            const intText = e.sin_interes ? '$0' : '$' + fmtCompact(e.interes);
            const capText = '$' + fmtCompact(e.recibido);
            let icon = '💳';
            if (tipoClase === 'proveedor') icon = '🏭';
            if (tipoClase === 'cheque') icon = '🧾';
            if (tipoClase === 'banco') icon = '🏦';
            if (tipoClase.includes('préstamo') || tipoClase.includes('prestamo')) icon = '🦈';
            const totalHighlight = isVencido ? ' highlight' : '';
            let dueHtml = plazoTexto(e);
            if (dueHtml.toLowerCase().includes('- vto')) {
                dueHtml = dueHtml.replace(/ - vto /i, '<br>Vto: <strong>') + '</strong>';
            } else if (dueHtml.toLowerCase().includes('- vto:')) {
                dueHtml = dueHtml.replace(/ - vto: /i, '<br>Vto: <strong>') + '</strong>';
            }
            const clickCls = clickable && !actionBtnHtml ? ' clickable' : '';
            const extraCls = actionBtnHtml ? ' cobranza-debt-card' : '';
            return `
            <div class="debt-card${clickCls}${extraCls}" data-id="${e.id}">
                <div class="card-header">
                    <div class="card-title-group">
                        <div class="icon-box">${icon}</div>
                        <div>
                            <h3 class="card-title">${esc(e.alias)}</h3>
                            <span class="pill pill-type">${esc(e.tipo)}</span>
                        </div>
                    </div>
                    ${badgeVencimiento(e)}
                </div>
                <div class="card-body">
                    <div class="data-col">
                        <span class="data-label">Capital</span>
                        <span class="data-value">${capText}</span>
                    </div>
                    <div class="data-col">
                        <span class="data-label">Interés</span>
                        <span class="data-value">${intText}</span>
                    </div>
                    <div class="data-col">
                        <span class="data-label">CFR</span>
                        <span class="data-value">${cfrText}</span>
                    </div>
                </div>
                <div class="card-footer">
                    <div class="amount-section">
                        <span class="amount-label">TOTAL A PAGAR</span>
                        <span class="amount-total${totalHighlight}">$${fmtCompact(e.total_pagar)}</span>
                    </div>
                    <div class="due-details">
                        ${dueHtml}
                    </div>
                </div>
                ${actionBtnHtml}
            </div>`;
        }

        function tarjetaClienteFiado(d) {
            const deuda = Number(d.deuda) || 0;
            const interes = Number(d.mantenimiento) || 0;
            const total = deuda + interes;
            const atraso = d.dias != null && Number(d.dias) > 0;
            const badge = atraso
                ? `<span class="badge-home vencido" style="line-height:1.2;text-align:center;display:inline-block">${esc(d.dias)} días<br>retraso</span>`
                : (d.dias == null
                    ? '<span class="badge-home neutro">Sin días<br>en el libro</span>'
                    : '<span class="badge-home verde">Al día</span>');
            const interesTxt = d.mantenimiento_origen === 'libro'
                ? '$' + fmtCompact(interes)
                : 'est. $' + fmtCompact(interes);
            const pie = [d.dni ? 'DNI ' + d.dni : '', d.telefono || ''].filter(Boolean).join(' · ');
            return `
            <div class="debt-card" data-pos-id="${esc(d.id)}" role="button" tabindex="0">
                <div class="card-header">
                    <div class="card-title-group">
                        <div class="icon-box">👤</div>
                        <div>
                            <h3 class="card-title">${esc(d.nombre || 'Cliente')}</h3>
                            <span class="pill pill-type">${esc(d.tipo || 'Cliente')}</span>
                        </div>
                    </div>
                    ${badge}
                </div>
                <div class="card-body">
                    <div class="data-col">
                        <span class="data-label">Capital</span>
                        <span class="data-value">$${fmtCompact(deuda)}</span>
                    </div>
                    <div class="data-col">
                        <span class="data-label">Interés</span>
                        <span class="data-value">${interesTxt}</span>
                    </div>
                    <div class="data-col">
                        <span class="data-label">CFR</span>
                        <span class="data-value">${esc(d.tarifa || '—')}</span>
                    </div>
                </div>
                <div class="card-footer">
                    <div class="amount-section">
                        <span class="amount-label">TOTAL A PAGAR</span>
                        <span class="amount-total${atraso ? ' highlight' : ''}">$${fmtCompact(total)}</span>
                    </div>
                    <div class="due-details">${esc(pie || 'Ver historial')}</div>
                </div>
            </div>`;
        }

        function filaLibroCliente(fila) {
            const clase = fila.es_cobro ? 'color:#047857;font-weight:700' : '';
            const dias = fila.dias == null ? '—' : `${fila.dias} d`;
            const mant = fila.es_interes ? 'Asentado' : (fila.mantenimiento == null ? '—' : plataJefe(fila.mantenimiento));
            return `<tr style="border-bottom:1px solid #f1f5f9; font-size:13px;">
                <td style="padding:8px 10px; white-space:nowrap;">${esc(fila.fecha)}</td>
                <td style="padding:8px 10px; ${clase}">${esc(fila.etiqueta)}</td>
                <td style="padding:8px 10px; text-align:right; ${clase}">${plataJefe(fila.monto)}</td>
                <td style="padding:8px 10px; text-align:right;">${plataJefe(fila.saldo)}</td>
                <td style="padding:8px 10px;">${esc(fila.ticket)}</td>
                <td style="padding:8px 10px; color:#475569;">${esc(fila.detalle)}</td>
                <td style="padding:8px 10px; text-align:center; ${fila.dias > 30 ? 'color:#b91c1c;font-weight:800' : ''}">${dias}</td>
                <td style="padding:8px 10px; text-align:right;">${mant}</td>
            </tr>`;
        }

        async function abrirHistorialFiado(posId) {
            const cliente = carteraEnPantalla.find(c => String(c.id) === String(posId)) || {};
            switchView('historial-fiado');
            if ($('histFiadoNombre')) $('histFiadoNombre').textContent = cliente.nombre || 'Cliente';
            if ($('histFiadoSub')) $('histFiadoSub').textContent = [cliente.dni, cliente.telefono, cliente.tipo].filter(Boolean).join(' · ') || 'Libro de la cuenta';
            const cuerpo = $('histFiadoCuerpo');
            if (!cuerpo) return;
            cuerpo.innerHTML = '<p style="color:#64748b;">Cargando el libro…</p>';
            try {
                const deuda = Number(cliente.deuda) || 0;
                const res = await fetch('/api/pos/historial?pos_id=' + encodeURIComponent(posId) + '&deuda=' + encodeURIComponent(deuda));
                const dato = await res.json();
                const movs = dato.movimientos || [];
                const tel = String(cliente.telefono || '').replace(/\D/g, '');
                const wsp = tel.length >= 8
                    ? `<a href="https://wa.me/549${tel}?text=${encodeURIComponent('Hola ' + (cliente.nombre || '') + ', te escribimos de la administración. Tu saldo es ' + plataJefe(dato.deuda) + '.')}" target="_blank" style="background:#22c55e; color:#fff; padding:8px 12px; border-radius:10px; font-size:13px; font-weight:800; text-decoration:none;">Cobrar por WhatsApp</a>`
                    : '';
                const cabeza = `
                    <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:14px;">
                        <span style="font-weight:800; color:#0f172a;">${esc(dato.resumen || '')}</span>
                        <span style="background:#fff7ed; color:#9a3412; padding:4px 10px; border-radius:999px; font-weight:800;">Mantenimiento ${plataJefe(dato.mantenimiento)}</span>
                        <span style="background:#fef2f2; color:#9f1239; padding:4px 10px; border-radius:999px; font-weight:800;">Total ${plataJefe(dato.total_estimado)}</span>
                        ${wsp}
                    </div>`;
                if (!movs.length) {
                    cuerpo.innerHTML = cabeza + '<p style="color:#64748b;">El libro de esta cuenta todavía no llegó a la nube.</p>';
                    return;
                }
                cuerpo.innerHTML = cabeza + `
                    <div style="overflow-x:auto;">
                        <table class="data-table" style="width:100%; border-collapse:collapse; background:#fff;">
                            <thead>
                                <tr style="background:#f8fafc; font-size:11px; color:#64748b; text-transform:uppercase;">
                                    <th style="padding:8px 10px; text-align:left;">Fecha</th>
                                    <th style="padding:8px 10px; text-align:left;">Tipo</th>
                                    <th style="padding:8px 10px; text-align:right;">Monto</th>
                                    <th style="padding:8px 10px; text-align:right;">Saldo</th>
                                    <th style="padding:8px 10px; text-align:left;">Ticket</th>
                                    <th style="padding:8px 10px; text-align:left;">Detalle</th>
                                    <th style="padding:8px 10px; text-align:center;">Días</th>
                                    <th style="padding:8px 10px; text-align:right;">Mantenimiento</th>
                                </tr>
                            </thead>
                            <tbody>${movs.map(filaLibroCliente).join('')}</tbody>
                        </table>
                    </div>`;
            } catch (_) {
                cuerpo.innerHTML = '<p style="color:#b91c1c;">No se pudo leer el historial.</p>';
            }
        }

        function renderHomeTable() {
            if (!data.enemigos || !data.enemigos.length) {
                if (isProMode) {
                    $('tblHomeWrapperPro').innerHTML = '<div class="empty-state">No hay obligaciones cargadas</div>';
                } else {
                    $('tblHome').innerHTML = '<tr><td colspan="8"><div class="empty-state">No hay obligaciones cargadas</div></td></tr>';
                }
                return;
            }
            
            const sorted = sortEnemigosPrioridad(data.enemigos);

            if (isProMode) {
                $('tblHomeWrapperPro').innerHTML = sorted.map(e => deudaCardHtml(e)).join('');
                
                document.querySelectorAll('#tblHomeWrapperPro .clickable').forEach(card => {
                    card.addEventListener('click', () => {
                        const id = parseInt(card.dataset.id, 10);
                        const e = data.enemigos.find(x => x.id === id);
                        if (e) openDrawer(e);
                    });
                });
            } else {
                $('tblHome').innerHTML = sorted.map(e => {
                    const rowCls = e.vencido ? ' class="highlight-red clickable"' : ' class="clickable"';
                    let tipoClase = (e.tipo || 'neutro').toLowerCase();
                    if (!['tarjeta','banco','proveedor','cheque'].includes(tipoClase)) tipoClase = 'neutro';
                    
                    const cfrText = e.sin_interes ? '0%' : fmtPct(e.cfr);
                    const intText = e.sin_interes ? '$0' : '$' + fmtCompact(e.interes);
                    const capText = '$' + fmtCompact(e.recibido);

                    return `<tr${rowCls} data-id="${e.id}">
                        <td>
                            <div class="home-contraparte">${esc(e.alias)}</div>
                            <div style="margin-top:4px"><span class="badge-home ${tipoClase}">${esc(e.tipo)}</span></div>
                        </td>
                        <td style="line-height:1.4; font-size:10px;">
                            <div style="color:var(--text-muted)">Cap: <span style="color:#111827;font-weight:500">${capText}</span></div>
                            <div style="color:var(--text-muted)">Int: <span style="color:#111827;font-weight:500">${intText}</span></div>
                            <div style="color:var(--text-muted)">CFR: <span style="color:#111827;font-weight:500">${cfrText}</span></div>
                        </td>
                        <td>
                            <div class="home-amount" style="font-size:13px">$${fmtCompact(e.total_pagar)}</div>
                            <div class="home-subtext" style="font-size:9px;margin-top:4px">${plazoTexto(e)}</div>
                        </td>
                        <td>${badgeVencimiento(e)}</td>
                    </tr>`;
                }).join('');
                
                document.querySelectorAll('#tblHome .clickable').forEach(tr => {
                    tr.addEventListener('click', () => {
                        const id = parseInt(tr.dataset.id, 10);
                        const e = data.enemigos.find(x => x.id === id);
                        if (e) openDrawer(e);
                    });
                });
            }
        }

        function renderRemitosDash() {
            const rows = (data.remitos || []).slice(0, 8);
            $('tblRemitosDash').innerHTML = rows.length ? rows.map(r => {
                const badge = r.pagado || (r.estado_cobro === 'cobrado') 
                    ? '<div style="margin-bottom:4px"><span class="badge badge-success" style="font-size:9px;padding:2px 4px">Cobrado</span></div>' 
                    : '<div style="margin-bottom:4px"><span class="badge badge-danger" style="font-size:9px;padding:2px 4px">Pendiente</span></div>';
                const ventaText = fmtDualCompact(r.precio_venta_total);
                const margenText = fmtDualCompact(r.margen);
                return `<tr style="cursor:pointer;" onclick="abrirModalFacturaOriginal(${r.id})">
                    <td>
                        <div class="home-contraparte" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.cliente || '—')}</div>
                        <div style="font-size:9px;color:var(--text-muted);margin-top:2px">#${r.id} · ${r.fecha.slice(5)}</div>
                    </td>
                    <td style="line-height:1.4; font-size:10px;">
                        <div style="color:var(--text-muted)">Kg: <span style="color:#111827;font-weight:500">${fmt(r.kg)}</span></div>
                        <div style="color:var(--text-muted)">Log: <span style="color:#111827;font-weight:500">$${fmtCompact(r.costo_total_logistica)}</span></div>
                    </td>
                    <td>
                        <div class="home-amount" style="font-size:12px">${ventaText}</div>
                        <div class="home-subtext" style="font-size:9px;margin-top:2px;color:var(--success)">Mrg: ${margenText}</div>
                    </td>
                    <td style="text-align:center">${badge}</td>
                </tr>`;
            }).join('') : '<tr><td colspan="4"><div class="empty-state">Sin remitos de venta</div></td></tr>';
        }

        async function renderRemitosFull(forceRefresh = false) {
            const now = Date.now();
            let all = null;
            const cached = CrmUi.getRemitosFullCache();
            const cacheAt = CrmUi.getRemitosFullCacheAt();
            if (!forceRefresh && cached && (now - cacheAt) < REMITOS_FULL_CACHE_MS) {
                all = cached;
            } else {
                try {
                    all = await api('/api/remitos');
                    CrmUi.setRemitosFullCache(all, now);
                } catch (e) {
                    if (cached) {
                        all = cached;
                        toast('Mostrando remitos en caché', true);
                    } else {
                        throw e;
                    }
                }
            }
            $('remitoCount').textContent = all.length + ' registros';
            $('tblRemitosFull').innerHTML = all.length ? all.map(r => {
                const est = remitoEstado(r.estado_cobro ?? r.pagado);
                const badgeStatus = `<div style="margin-bottom:4px"><span class="badge ${est.badgeClass}" style="font-size:9px;padding:2px 4px">${est.label}</span></div>`;
                const actionBtn = est.cobrable
                    ? `<button type="button" class="btn btn-ghost btn-sm btn-cobrar-remito" data-rid="${r.id}" style="color:var(--success); border:1px solid var(--success); padding: 2px 4px; font-size:9px; width:100%">Cobrar</button>`
                    : '';
                
                const logisticaText = '$' + fmtCompact(r.costo_total_logistica);
                const ventaText = fmtDualCompact(r.precio_venta_total);
                const margenText = fmtDualCompact(r.margen);

                return `<tr style="cursor:pointer;" onclick="abrirModalFacturaOriginal(${r.id})">
                    <td>
                        <div class="home-contraparte" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.cliente || '—')}</div>
                        <div style="font-size:9px;color:var(--text-muted);margin-top:2px">#${r.id} · ${r.fecha.slice(5)}</div>
                    </td>
                    <td style="line-height:1.4; font-size:10px;">
                        <div style="color:var(--text-muted)">Kg: <span style="color:#111827;font-weight:500">${fmt(r.kg)}</span></div>
                        <div style="color:var(--text-muted)">Log: <span style="color:#111827;font-weight:500">${logisticaText}</span></div>
                    </td>
                    <td>
                        <div class="home-amount" style="font-size:12px">${ventaText}</div>
                        <div class="home-subtext" style="font-size:9px;margin-top:2px;color:var(--success)">Mrg: ${margenText}</div>
                    </td>
                    <td style="text-align:center">
                        ${badgeStatus}
                        ${actionBtn}
                    </td>
                </tr>`;
            }).join('') : '<tr><td colspan="4"><div class="empty-state">Sin remitos de venta registrados</div></td></tr>';

            // Vincular acciones de cobro
            document.querySelectorAll('.btn-cobrar-remito').forEach(btn => {
                btn.addEventListener('click', ev => {
                    ev.stopPropagation();
                    const rid = parseInt(btn.dataset.rid, 10);
                    const remito = all.find(r => r.id === rid);
                    if (remito) abrirModalPagoRemito(remito);
                });
            });
        }

        function getHistorialPagosFiltrados() {
            const rows = data.historialPagos || [];
            if (!histPagosFiltro) return rows;
            return rows.filter(r => (r.tipo || '').toLowerCase() === histPagosFiltro);
        }

        function exportHistorialCsv() {
            const rows = getHistorialPagosFiltrados();
            if (!rows.length) {
                toast('No hay movimientos para exportar', true);
                return;
            }
            const headers = ['Fecha', 'Contraparte', 'Tipo', 'Cuota', 'Plazo', 'Detalle', 'Monto cuota', 'Pagado', 'Punitorio', 'Descuento', 'Progreso op.'];
            const lines = rows.map(r => {
                const progreso = r.cuotas_pagadas_op != null && r.cuota_label
                    ? `${r.cuota_label} · ${r.cuotas_pagadas_op} pag.`
                    : r.cuota_label || '';
                return [
                    (r.fecha_pago || '').replace('T', ' ').slice(0, 16),
                    r.alias,
                    r.tipo,
                    r.cuota_label || '',
                    r.plazo_texto || '',
                    r.detalle || '',
                    r.monto_cuota_esperado,
                    r.monto_pagado,
                    r.interes_punitorio || 0,
                    r.descuento || 0,
                    progreso
                ].map(csvCell).join(';');
            });
            const csv = '\ufeff' + [headers.map(csvCell).join(';'), ...lines].join('\r\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const suf = histPagosFiltro ? '-' + histPagosFiltro : '';
            a.href = url;
            a.download = `historial-pagos${suf}-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            toast('CSV exportado');
        }

        function renderAuditoria() {
            const arr = data.auditoria || [];
            $('auditoriaCount').textContent = arr.length + ' registros';
            const showDelete = sessionUser.role === 'admin';
            $('tblAuditoria').innerHTML = arr.length ? arr.map(a => {
                const ipText = a.ip_address ? ` · IP: ${esc(a.ip_address)}` : '';
                const agentText = a.user_agent ? `<div style="font-size: 8px; color: var(--text-muted); margin-top: 2px;" title="${esc(a.user_agent)}">${esc(a.user_agent.length > 55 ? a.user_agent.substring(0, 55) + '...' : a.user_agent)}</div>` : '';
                return `<tr>
                    <td>${fmtFecha(a.fecha, true)}</td>
                    <td><strong>${esc(a.alias || 'Registro')}</strong><br><small style="color:var(--text-light)">Op ID: ${a.operacion_id || '—'}${a.usuario ? ' · ' + esc(a.usuario) : ''}${ipText}</small>${agentText}</td>
                    <td><span class="badge ${a.accion === 'ELIMINADO' ? 'badge-danger' : 'badge-success'}">${esc(a.accion)}</span></td>
                    <td class="money">$${fmt(a.monto)}</td>
                    <td>${showDelete ? `<button class="btn btn-ghost btn-sm" onclick="promptDeleteAuditoria(${a.id})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>` : ''}</td>
                </tr>`;
            }).join('') : '<tr><td colspan="5" class="empty-state">No hay registros de auditoría</td></tr>';
        }

        async function renderUsuarios(forceRefresh = false) {
            if (!$('tblUsuarios')) return;
            if (!forceRefresh && Array.isArray(data.usuarios) && data.usuarios.length) {
                // usar caché en memoria
            } else {
                try {
                    data.usuarios = await api('/api/usuarios');
                } catch (e) {
                    toast(e.message || 'No se pudieron cargar usuarios', true);
                    data.usuarios = [];
                }
            }
            const arr = data.usuarios || [];
            $('usuariosCount').textContent = arr.length + ' usuario' + (arr.length === 1 ? '' : 's');
            const roleLabel = { admin: 'Administrador', operador: 'Operador', visor: 'Visor' };
            $('tblUsuarios').innerHTML = arr.length ? arr.map(u => `
                <tr>
                    <td><strong>${esc(u.username)}</strong></td>
                    <td>${esc(u.nombre || u.username)}</td>
                    <td>
                        <select class="inp-usuario-role" data-uid="${u.id}" ${u.username === sessionUser.username ? 'disabled' : ''}>
                            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option>
                            <option value="operador" ${u.role === 'operador' ? 'selected' : ''}>Operador</option>
                            <option value="visor" ${u.role === 'visor' ? 'selected' : ''}>Visor</option>
                        </select>
                    </td>
                    <td><span class="badge ${u.activo ? 'badge-success' : 'badge-neutral'}">${u.activo ? 'Activo' : 'Inactivo'}</span></td>
                    <td>${fmtFecha(u.created_at)}</td>
                    <td>
                        ${u.username !== sessionUser.username ? `<button type="button" class="btn btn-ghost btn-sm btn-toggle-user" data-uid="${u.id}" data-activo="${u.activo ? '0' : '1'}">${u.activo ? 'Desactivar' : 'Activar'}</button>` : '<small style="color:var(--text-muted)">Tú</small>'}
                    </td>
                </tr>
            `).join('') : '<tr><td colspan="6" class="empty-state">Sin usuarios registrados</td></tr>';

            document.querySelectorAll('.inp-usuario-role').forEach(sel => {
                sel.addEventListener('change', async () => {
                    const uid = parseInt(sel.dataset.uid, 10);
                    try {
                        await api('/api/usuarios/' + uid, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ role: sel.value })
                        });
                        toast('Rol actualizado');
                        await renderUsuarios(true);
                    } catch (e) {
                        toast(e.message, true);
                        await renderUsuarios(true);
                    }
                });
            });
            document.querySelectorAll('.btn-toggle-user').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const uid = parseInt(btn.dataset.uid, 10);
                    const activo = btn.dataset.activo === '1';
                    try {
                        await api('/api/usuarios/' + uid, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ activo })
                        });
                        toast(activo ? 'Usuario activado' : 'Usuario desactivado');
                        await renderUsuarios(true);
                    } catch (e) {
                        toast(e.message, true);
                    }
                });
            });
        }

        function applyRoleUi() {
            const isAdmin = sessionUser.role === 'admin';
            const isVisor = sessionUser.role === 'visor';
            document.querySelectorAll('[data-admin-only]').forEach(el => {
                el.style.display = isAdmin ? '' : 'none';
            });
            document.querySelectorAll('[data-write-only]').forEach(el => {
                el.style.display = isVisor ? 'none' : '';
            });
        }

        window.promptDeleteAuditoria = (id) => {
            selectedAuditId = id;
            $('inpPasswordAuditoria').value = '';
            $('modalPasswordAuditoria').classList.add('open');
        };

        function renderHistorialPagos() {
            const rows = getHistorialPagosFiltrados();
            const total = (data.historialPagos || []).length;
            const label = rows.length === total
                ? rows.length + ' movimiento' + (rows.length === 1 ? '' : 's')
                : rows.length + ' de ' + total + ' movimientos';
            $('histPagosCount').textContent = label;
            if (!rows.length) {
                $('tblHistorialPagos').innerHTML = '<tr><td colspan="11"><div class="xls-empty"><strong>Sin pagos' + (histPagosFiltro ? ' para este filtro' : ' registrados') + '</strong><br>Usá el botón Pagar en una obligación para registrar cuotas</div></td></tr>';
                return;
            }
            $('tblHistorialPagos').innerHTML = rows.map(r => {
                const tipoCls = (r.tipo || 'neutro').toLowerCase();
                const punText = r.interes_punitorio > 0 ? `<div style="color:var(--danger);font-size:9px;margin-top:2px">+ Pun: $${fmtCompact(r.interes_punitorio)}</div>` : '';
                const descText = r.descuento > 0 ? `<div style="color:var(--success);font-size:9px;margin-top:2px">- Desc: $${fmtCompact(r.descuento)}</div>` : '';
                const progreso = r.cuotas_pagadas_op != null && r.cuota_label
                    ? `${r.cuota_label} · ${r.cuotas_pagadas_op} pag.`
                    : r.cuota_label || '—';
                return `<tr>
                    <td>
                        <div class="home-contraparte" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.alias)}</div>
                        <div style="font-size:9px;color:var(--text-muted);margin-top:2px">${(r.fecha_pago || '').slice(0, 10)}</div>
                    </td>
                    <td style="line-height:1.4; font-size:10px;">
                        <div style="color:#111827;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80px" title="${esc(r.detalle||'')}">${esc(r.detalle || '—')}</div>
                        <div style="color:var(--text-muted);font-size:9px;margin-top:2px">${esc(r.plazo_texto || '—')}</div>
                    </td>
                    <td>
                        <div class="home-amount" style="font-size:13px;color:var(--success)">$${fmtCompact(r.monto_pagado)}</div>
                        ${punText}${descText}
                    </td>
                    <td style="text-align:center">
                        <div style="margin-bottom:4px"><span class="badge-home ${tipoCls}">${esc(r.tipo)}</span></div>
                        <div style="font-size:9px;color:var(--text-muted)">${progreso}</div>
                    </td>
                </tr>`;
            }).join('');
        }

        function renderBancos() {
            const bancos = data.bancos || [];
            $('tblBancos').innerHTML = bancos.length ? bancos.map(b => `
                <tr><td>${esc(b.nombre)}</td><td>$${fmt(b.limite)}</td></tr>
            `).join('') : '<tr><td colspan="2" style="color:var(--text-muted);padding:16px">Sin entidades bancarias</td></tr>';
        }

        function renderBulkLots() {
            const list = $('bulkLotsList');
            const empty = $('bulkLotsEmpty');
            const hint = $('bulkLotsHint');
            if (!list) return;

            const lotes = data.bulk || [];
            const now = new Date();
            now.setHours(0, 0, 0, 0);

            let kgDisp = 0;
            let valorStock = 0;
            lotes.forEach(b => {
                const rem = Number(b.kg_remanentes) || 0;
                const tot = Number(b.kg_totales) || 0;
                kgDisp += rem;
                if (tot > 0 && rem > 0) {
                    valorStock += rem * (Number(b.costo_total_bulk) / tot);
                }
            });

            if ($('bulkStatLotes')) $('bulkStatLotes').textContent = String(lotes.length);
            if ($('bulkStatKg')) $('bulkStatKg').textContent = fmt(kgDisp) + ' kg';
            if ($('bulkStatValor')) $('bulkStatValor').textContent = '$' + fmtCompact(valorStock);

            if (!lotes.length) {
                list.innerHTML = '';
                empty?.classList.remove('field-hidden');
                hint?.classList.add('field-hidden');
                return;
            }

            empty?.classList.add('field-hidden');
            if (hint) {
                if (sessionUser.role === 'admin') hint.classList.remove('field-hidden');
                else hint.classList.add('field-hidden');
            }

            list.innerHTML = lotes.map(b => {
                let badge = '';
                if (b.kg_remanentes <= 0) {
                    badge = '<span class="badge badge-neutral">Agotado</span>';
                } else if (b.fecha_vencimiento) {
                    const vto = new Date(b.fecha_vencimiento + 'T00:00:00');
                    const diffDays = Math.ceil((vto - now) / (1000 * 60 * 60 * 24));
                    if (diffDays < 0) badge = '<span class="badge badge-danger">Vencido</span>';
                    else if (diffDays <= 7) badge = '<span class="badge badge-warning">Vence pronto</span>';
                    else badge = '<span class="badge badge-success">Activo</span>';
                } else {
                    badge = '<span class="badge badge-success">Activo</span>';
                }

                const loteNum = b.numero_lote ? ' · ' + esc(b.numero_lote) : '';
                const prov = b.proveedor ? 'Proveedor: ' + esc(b.proveedor) : '';
                const vto = b.fecha_vencimiento ? 'Vence: ' + b.fecha_vencimiento : '';
                const meta = [prov, vto].filter(Boolean).join(' · ');

                const deleteBtn = sessionUser.role === 'admin'
                    ? `<button type="button" class="bulk-lot-delete" title="Eliminar lote mal cargado" onclick="eliminarLoteBulk(${b.id})">Eliminar</button>`
                    : '';

                return `<article class="bulk-lot-card">
                    <div class="bulk-lot-head">
                        <div>
                            <div class="bulk-lot-title">Lote #${b.id}${loteNum}</div>
                            <div class="bulk-lot-sub">Compra: ${esc(b.fecha || '—')}${meta ? ' · ' + meta : ''}</div>
                        </div>
                        <div class="bulk-lot-actions">${badge}${deleteBtn}</div>
                    </div>
                    <div class="bulk-lot-metrics">
                        <div>
                            <div class="bulk-lot-metric-label">Kg remanentes</div>
                            <div class="bulk-lot-metric-value">${fmt(b.kg_remanentes)} kg</div>
                            <div class="bulk-lot-sub">Orig: ${fmt(b.kg_totales)} kg</div>
                        </div>
                        <div>
                            <div class="bulk-lot-metric-label">Costo total</div>
                            <div class="bulk-lot-metric-value">$${fmtCompact(b.costo_total_bulk)}</div>
                        </div>
                        <div>
                            <div class="bulk-lot-metric-label">Costo / kg</div>
                            <div class="bulk-lot-metric-value">$${fmtCompact(b.costo_kg)}</div>
                        </div>
                    </div>
                </article>`;
            }).join('');
        }

        window.filtrarClientes = (term) => {
            const termLower = term.toLowerCase();
            document.querySelectorAll('#tblClientes .clickable').forEach(el => {
                const text = el.textContent.toLowerCase();
                el.style.display = text.includes(termLower) ? 'block' : 'none';
            });
        };

        window.filtrarInrecuperables = (term) => {
            const termLower = term.toLowerCase();
            document.querySelectorAll('#tblInrecuperables .clickable').forEach(el => {
                const text = el.textContent.toLowerCase();
                el.style.display = text.includes(termLower) ? 'block' : 'none';
            });
        };

        let selectedClienteId = null;

        function renderClientes() {
            const table = $('tblClientes');
            const tableInrec = $('tblInrecuperables');
            if (!table) return;
            
            const activos = (data.clientes || []).filter(c => !c.inrecuperable);
            const inrecuperables = (data.clientes || []).filter(c => c.inrecuperable);
            
            const countEl = $('clientCount');
            if (countEl) countEl.textContent = activos.length + ' clientes';
            const inrecCountEl = $('inrecCount');
            if (inrecCountEl) inrecCountEl.textContent = inrecuperables.length + ' clientes';
            
            const renderRow = c => '<div class="clickable" data-id="' + c.id + '" style="cursor:pointer; margin-bottom:15px; width:100%;">' + cobranzaCardHtml(c, true) + '</div>';

            table.innerHTML = activos.length ? activos.map(renderRow).join('') : '<div style="color:var(--text-muted);padding:20px;text-align:center">Sin clientes activos</div>';
            
            if (tableInrec) {
                tableInrec.innerHTML = inrecuperables.length ? inrecuperables.map(renderRow).join('') : '<div style="color:var(--text-muted);padding:20px;text-align:center">No hay clientes inrecuperables</div>';
            }
            
            document.querySelectorAll('#tblClientes .clickable, #tblInrecuperables .clickable').forEach((row, idx) => {
                row.addEventListener('click', () => {
                    const cid = parseInt(row.dataset.id, 10);
                    openClientDrawer(cid);
                });
            });

            // Populate datalist for Ventas Express
            const datalist = $('clientesExpressList');
            if (datalist) {
                datalist.innerHTML = (data.clientes || []).map(c => `<option value="${esc(c.nombre)}"></option>`).join('');
            }
        }

        function badgeCobranzaMora(c) {
            if (c.en_mora) return '<span class="badge-home vencido" style="line-height:1.2;text-align:center;display:inline-block">En<br>mora</span>';
            if (c.limite_superado) return '<span class="badge-home vencido" style="line-height:1.2;text-align:center;display:inline-block">Límite<br>superado</span>';
            return '<span class="badge-home verde" style="line-height:1.2;text-align:center;display:inline-block">Al<br>día</span>';
        }

        function cobranzaCardHtml(c, hideButton = false) {
            const scoreIcons = { A: '🅰️', B: '📊', C: '⚠️', D: '⛔' };
            const icon = scoreIcons[c.scoring] || '🏪';
            const pctUso = c.techo_deuda > 0 ? Math.round((c.saldo_actual / c.techo_deuda) * 100) + '%' : '—';
            const ultimoPago = c.fecha_ultimo_pago ? fmtFecha(c.fecha_ultimo_pago) : 'Nunca';
            const moraText = c.en_mora
                ? (c.oldest_unpaid ? `En mora · desde ${fmtFecha(c.oldest_unpaid)}` : 'En mora')
                : (c.oldest_unpaid ? `Al día · ${fmtFecha(c.oldest_unpaid)}` : 'Sin vencimientos');
            const totalCls = c.en_mora ? ' highlight' : '';

            return `
            <div class="debt-card cobranza-debt-card">
                <div class="card-header">
                    <div class="card-title-group">
                        <div class="icon-box">${icon}</div>
                        <div>
                            <h3 class="card-title">${esc(c.nombre)}</h3>
                            <span class="pill pill-type">Scoring ${esc(c.scoring)}</span>
                        </div>
                    </div>
                    ${badgeCobranzaMora(c)}
                </div>
                <div class="card-body">
                    <div class="data-col">
                        <span class="data-label">Scoring</span>
                        <span class="data-value">${esc(c.scoring)}</span>
                    </div>
                    <div class="data-col">
                        <span class="data-label">Límite</span>
                        <span class="data-value">$${fmtCompact(c.techo_deuda)}</span>
                    </div>
                    <div class="data-col">
                        <span class="data-label">Uso crédito</span>
                        <span class="data-value">${pctUso}</span>
                    </div>
                </div>
                <div class="card-footer">
                    <div class="amount-section">
                        <span class="amount-label">TOTAL A COBRAR</span>
                        <span class="amount-total${totalCls}">$${fmtCompact(c.saldo_actual)}</span>
                    </div>
                    <div class="due-details">
                        Último pago: <strong>${ultimoPago}</strong><br>${moraText}
                    </div>
                </div>
                ${hideButton ? '' : `<button type="button" class="btn btn-primary btn-cobranza-accion cobranza-card-btn" data-cid="${c.id}">Cobrar / Ver</button>`}
            </div>`;
        }

        function renderCobranzas() {
            const grid = $('cobranzasGrid');
            if (!grid) return;
            let conDeuda = (data.clientes || []).filter(c => c.saldo_actual > 0);
            conDeuda.sort((a,b) => b.saldo_actual - a.saldo_actual);
            
            let totalDeuda = conDeuda.reduce((acc, c) => acc + c.saldo_actual, 0);
            const enMora = conDeuda.filter(c => c.en_mora);
            const montoMora = enMora.reduce((acc, c) => acc + c.saldo_actual, 0);

            if ($('cobranzasCount')) $('cobranzasCount').textContent = `${conDeuda.length} clientes con saldo pendiente`;

            const isMobile = window.innerWidth < 768;
            const formatVal = (val) => isMobile ? fmtCompact(val) : fmt(val);

            if ($('cobBarClientesMora')) $('cobBarClientesMora').textContent = enMora.length;
            if ($('cobBarClientesMoraSub')) $('cobBarClientesMoraSub').textContent = enMora.length === 1 ? 'Cliente con facturas vencidas' : 'Clientes con facturas vencidas';
            if ($('cobBarMontoMora')) $('cobBarMontoMora').textContent = '$' + formatVal(montoMora);
            if ($('cobBarCapitalTotal')) $('cobBarCapitalTotal').textContent = '$' + formatVal(totalDeuda);
            if ($('cobBarCapitalSub')) $('cobBarCapitalSub').textContent = `${conDeuda.length} clientes con saldo`;
            
            if (!conDeuda.length) {
                grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-secondary);">No hay clientes con saldo pendiente</div>';
            } else {
                grid.innerHTML = conDeuda.map(cobranzaCardHtml).join('');
            }

            grid.querySelectorAll('.btn-cobranza-accion').forEach(btn => {
                btn.addEventListener('click', ev => {
                    ev.stopPropagation();
                    abrirAccionCobranza(parseInt(btn.dataset.cid, 10));
                });
            });
        }

        function pagoCentralSaldo(e) {
            const s = Number(e.saldo_pendiente);
            if (!Number.isNaN(s) && s > 0) return s;
            return Number(e.total_pagar || 0);
        }

        function pagoCentralCardHtml(e) {
            return deudaCardHtml(e, {
                clickable: false,
                actionBtnHtml: `<button type="button" class="btn btn-primary btn-pago-central-accion cobranza-card-btn" data-deuda-id="${e.id}">Pagar / Ver</button>`
            });
        }

        function abrirAccionPagoCentral(deudaId) {
            const e = (data.enemigos || []).find(x => x.id === deudaId);
            if (!e) return;
            pagoCentralDeudaActual = e;
            const saldo = pagoCentralSaldo(e);
            if ($('modalPagoCentralAccionSub')) {
                $('modalPagoCentralAccionSub').textContent = `${e.alias} · Saldo $${fmt(saldo)}`;
            }
            const btnPagar = $('btnPagoCentralPagar');
            if (btnPagar) {
                const puedePagar = e.tiene_cuotas && !e.completa;
                btnPagar.disabled = !puedePagar;
                btnPagar.style.opacity = puedePagar ? '1' : '0.5';
                btnPagar.title = puedePagar ? '' : 'Esta obligación no usa plan de cuotas';
            }
            $('modalPagoCentralAccion')?.classList.add('open');
        }

        function cerrarModalPagoCentralAccion() {
            $('modalPagoCentralAccion')?.classList.remove('open');
            pagoCentralDeudaActual = null;
        }

        function pagoCentralElegirVer() {
            const e = pagoCentralDeudaActual;
            cerrarModalPagoCentralAccion();
            if (e) openDrawer(e);
        }

        function pagoCentralElegirPagar() {
            const e = pagoCentralDeudaActual;
            if (!e) return;
            cerrarModalPagoCentralAccion();
            selectedDeuda = e;
            if (e.tiene_cuotas && !e.completa) {
                abrirModalPago();
            } else {
                openDrawer(e);
                toast('Abrí el detalle para gestionar esta obligación', false);
            }
        }

        function renderPagosCentral() {
            const grid = $('pagoCentralGrid');
            if (!grid) return;
            const pendientes = (data.enemigos || []).filter(e => !e.completa && pagoCentralSaldo(e) > 0.009);
            const sorted = sortEnemigosPrioridad(pendientes);
            const vencidas = pendientes.filter(e => e.vencido);
            const totalPagar = pendientes.reduce((acc, e) => acc + pagoCentralSaldo(e), 0);
            const montoVencido = vencidas.reduce((acc, e) => acc + pagoCentralSaldo(e), 0);

            if ($('pagoCentralCount')) {
                $('pagoCentralCount').textContent = `${pendientes.length} obligacion${pendientes.length === 1 ? '' : 'es'} pendiente${pendientes.length === 1 ? '' : 's'}`;
            }

            const isMobile = window.innerWidth < 768;
            const formatVal = (val) => isMobile ? fmtCompact(val) : fmt(val);

            if ($('pcBarObligaciones')) $('pcBarObligaciones').textContent = pendientes.length;
            if ($('pcBarMontoVencido')) $('pcBarMontoVencido').textContent = '$' + formatVal(montoVencido);
            if ($('pcBarTotalPagar')) $('pcBarTotalPagar').textContent = '$' + formatVal(totalPagar);
            if ($('pcBarTotalSub')) $('pcBarTotalSub').textContent = `${pendientes.length} obligaciones activas`;

            if (!pendientes.length) {
                grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-secondary);">No hay obligaciones pendientes de pago</div>';
            } else {
                grid.innerHTML = sorted.map(pagoCentralCardHtml).join('');
            }

            grid.querySelectorAll('.btn-pago-central-accion').forEach(btn => {
                btn.addEventListener('click', ev => {
                    ev.stopPropagation();
                    abrirAccionPagoCentral(parseInt(btn.dataset.deudaId, 10));
                });
            });
        }

        let currentClientData = null;
        let currentClientFilter = 'all';
        let clientDetailReturnView = 'clientes';

        async function openClientDrawer(clientId) {
            if (!$('view-cliente-detalle')) {
                toast('Vista de cliente no disponible. Recargá la aplicación.', true);
                return;
            }
            const currentView = document.querySelector('.view.active')?.id?.replace(/^view-/, '') || '';
            if (currentView && currentView !== 'cliente-detalle') {
                clientDetailReturnView = currentView;
            }
            selectedClienteId = clientId;
            switchView('cliente-detalle');
            $('viewClientBody').innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px; background:rgba(255,255,255,0.7); border-radius:10px; align-self:center; margin-top:20px;">Cargando historial de chat...</div>';
            
            try {
                const c = await api('/api/clientes/' + clientId);
                if (selectedClienteId !== clientId) return;
                
                currentClientData = c;
                currentClientFilter = 'all';
                $('viewClientTitle').textContent = c.nombre;
                
                const initials = c.nombre.substring(0, 2).toUpperCase();
                $('wspAvatar').textContent = initials;
                
                if (c.saldo_actual > 0) {
                    $('viewClientSubtitle').innerHTML = `Deuda: <span style="color:#ef4444; font-weight:bold;">$${fmt(c.saldo_actual)}</span>`;
                } else {
                    $('viewClientSubtitle').innerHTML = `En línea`;
                }
                
                $('wspSaldoAtrasado').textContent = '$' + fmt(c.saldo_actual);
                
                const unpaid = (c.remitos || []).filter(r => remitoSaldoPendiente(r) > 0);
                // Si hay facturas impagas, tomamos la más reciente como "Factura Actual"
                const saldoActual = unpaid.length > 0 ? remitoSaldoPendiente(unpaid[unpaid.length - 1]) : 0;
                $('wspSaldoActual').textContent = '$' + fmt(saldoActual);
                
                window.wspSelectedInvoices = [];
                $('btnDeleteSeleccionados').style.display = 'none';
                
                // Toggle Topbar WSP Mode
                if ($('topbarNormalMode')) $('topbarNormalMode').style.setProperty('display', 'none', 'important');
                if ($('topbarWspMode')) $('topbarWspMode').style.setProperty('display', 'flex', 'important');
                if ($('menuToggle')) $('menuToggle').style.setProperty('display', 'none', 'important');
                if ($('btnVolverTop')) $('btnVolverTop').style.setProperty('display', 'block', 'important');
                if ($('btnClientPrintWsp')) $('btnClientPrintWsp').style.setProperty('display', 'flex', 'important');
                if ($('btnTogglePro')) $('btnTogglePro').style.setProperty('display', 'none', 'important');

                renderClientDashboard();
                
            } catch (e) {
                $('viewClientBody').innerHTML = `<div style="color:var(--danger);text-align:center;padding:20px; background:#fff; border-radius:10px; align-self:center; margin-top:20px;">Error al cargar detalles: ${esc(e.message)}</div>`;
            }
        }
        window.openClientDrawer = openClientDrawer;

        function volverDesdeClienteDetalle() {
            // Restore Topbar Normal Mode
            if ($('topbarNormalMode')) $('topbarNormalMode').style.setProperty('display', '', '');
            if ($('topbarWspMode')) $('topbarWspMode').style.setProperty('display', 'none', 'important');
            if ($('menuToggle')) $('menuToggle').style.setProperty('display', '', '');
            if ($('btnVolverTop')) $('btnVolverTop').style.setProperty('display', 'none', 'important');
            if ($('btnClientPrintWsp')) $('btnClientPrintWsp').style.setProperty('display', 'none', 'important');
            if ($('btnTogglePro')) $('btnTogglePro').style.setProperty('display', '', '');

            switchView(clientDetailReturnView || 'clientes');
        }
        window.volverDesdeClienteDetalle = volverDesdeClienteDetalle;

        function abrirPerfilCliente() {
            $('modalWspProfile').classList.add('open');
        }
        window.abrirPerfilCliente = abrirPerfilCliente;

        function toggleSelectFactura(el, rid, saldoAmnt) {
            el.classList.toggle('checked');
            if (el.classList.contains('checked')) {
                window.wspSelectedInvoices.push(rid);
            } else {
                window.wspSelectedInvoices = window.wspSelectedInvoices.filter(id => id !== rid);
            }
            $('btnDeleteSeleccionados').style.display = window.wspSelectedInvoices.length > 0 ? 'inline-block' : 'none';
        }
        window.toggleSelectFactura = toggleSelectFactura;

        function abrirCobranzaWsp() {
            abrirCobranzaClienteGlobal(selectedClienteId);
        }
        window.abrirCobranzaWsp = abrirCobranzaWsp;

        function renderClientDashboard() {
            if (!currentClientData) return;
            const c = currentClientData;
            
            const limitStatus = c.limite_superado 
                ? '<span style="color:var(--danger)">Bloqueado (Límite superado)</span>' 
                : '<span style="color:var(--success)">Activo y Operativo</span>';
                
            const items = [];
            (c.remitos || []).forEach(r => items.push({ type: 'remito', date: r.fecha, data: r }));
            (c.pagos || []).forEach(p => items.push({ type: 'pago', date: p.fecha, data: p }));
            
            items.sort((a, b) => new Date(a.date) - new Date(b.date));
            
            let html = '<div style="font-weight:800; font-size:1.1rem; color:#0f172a; margin-bottom:16px; padding:0 4px;">Historial de Cuenta</div>';
            let lastDate = '';
            
            if (items.length === 0) {
                html += `<div style="color:#64748b;text-align:center;padding:32px 20px;background:#ffffff;border:1px dashed #cbd5e1; border-radius:12px; margin-top:12px;">No hay movimientos registrados en esta cuenta.</div>`;
            }
            
            items.forEach(item => {
                const dateStr = item.date || new Date().toISOString();
                const day = dateStr.slice(0, 10);
                if (day !== lastDate) {
                    html += `<div style="text-align:center; margin:24px 0 16px 0;"><span style="background:#e2e8f0; color:#475569; font-size:0.75rem; font-weight:700; padding:4px 12px; border-radius:12px; text-transform:uppercase; letter-spacing:0.5px;">${day}</span></div>`;
                    lastDate = day;
                }
                
                const time = dateStr.slice(11, 16) || '12:00';
                
                if (item.type === 'remito') {
                    const r = item.data;
                    const est = remitoEstado(r.estado_cobro ?? r.pagado);
                    const pagadoAmnt = Number(r.monto_pagado || 0);
                    const saldoAmnt = remitoSaldoPendiente(r);
                    const isPaid = (r.pagado ?? r.estado_cobro) === 'cobrado' || (r.pagado ?? r.estado_cobro) === 1 || (r.pagado ?? r.estado_cobro) === 2;
                    
                    const checkedState = (window.wspSelectedInvoices || []).includes(r.id) ? 'checked' : '';
                    const badgeBg = isPaid ? '#dcfce7' : '#f1f5f9';
                    const badgeColor = isPaid ? '#166534' : '#475569';
                    const leftBorder = (!isPaid && saldoAmnt > 0) ? '#ef4444' : '#10b981';
                    
                    html += `
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-bottom:12px; box-shadow:0 1px 3px rgba(0,0,0,0.05); display:flex; gap:12px; align-items:flex-start; position:relative; overflow:hidden;">
                        <div class="wsp-checkbox ${checkedState}" data-rid="${r.id}" onclick="toggleSelectFactura(this, ${r.id}, ${saldoAmnt})" style="margin-top:2px;">✓</div>
                        <div style="flex:1; cursor:pointer;" onclick="abrirModalFacturaOriginal(${r.id})">
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                                <div>
                                    <div style="font-weight:800; color:#0f172a; font-size:1.05rem;">Factura #${r.id}</div>
                                    <div style="font-size:0.8rem; color:#64748b; margin-top:2px; font-weight:500;">${r.tipo_corte || 'Variedad'} · ${remitoCantidad(r)} u · ${fmt(r.kg)} kg</div>
                                </div>
                                <span style="font-size:0.7rem; font-weight:700; background:${badgeBg}; color:${badgeColor}; padding:4px 8px; border-radius:6px; text-transform:uppercase;">${est.label}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:flex-end;">
                                <div>
                                    <div style="font-size:1.15rem; font-weight:800; color:#0f172a;">$${fmt(r.precio_venta_total)}</div>
                                    ${saldoAmnt > 0 && pagadoAmnt > 0 ? `<div style="font-size:0.8rem; color:#ea580c; font-weight:700; margin-top:2px;">Resta: $${fmt(saldoAmnt)}</div>` : ''}
                                </div>
                                <div style="font-size:0.75rem; color:#94a3b8; font-weight:600;">
                                    ${time}
                                </div>
                            </div>
                        </div>
                        <div style="position:absolute; left:0; top:0; bottom:0; width:4px; background:${leftBorder};"></div>
                    </div>`;
                } else if (item.type === 'pago') {
                    const p = item.data;
                    html += `
                    <div style="background:#f8fafc; border:1px dashed #cbd5e1; border-radius:12px; padding:16px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
                        <div style="display:flex; align-items:center; gap:12px;">
                            <div style="width:36px; height:36px; border-radius:50%; background:#dcfce7; color:#166534; display:flex; align-items:center; justify-content:center; font-size:1.1rem; font-weight:bold;">↓</div>
                            <div>
                                <div style="font-weight:700; color:#0f172a; font-size:0.95rem;">Pago Registrado #${p.id}</div>
                                <div style="font-size:0.75rem; color:#64748b; font-weight:500;">${time}</div>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:12px;">
                            <div style="font-size:1.15rem; font-weight:800; color:#166534;">+$${fmt(p.monto)}</div>
                            <button onclick="eliminarPagoCliente(${p.id})" style="background:#fee2e2; border:none; color:#ef4444; cursor:pointer; font-size:0.9rem; width:28px; height:28px; border-radius:6px; display:flex; align-items:center; justify-content:center; transition:background 0.2s;" onmouseover="this.style.background='#fca5a5'" onmouseout="this.style.background='#fee2e2'">❌</button>
                        </div>
                    </div>`;
                }
            });
            
            let profileHtml = `
                <div style="background:linear-gradient(135deg, #1e293b, #0f172a); border-radius:16px; padding:24px 20px; color:#fff; display:flex; flex-direction:column; align-items:center; gap:16px; margin-bottom:24px; box-shadow:0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05); position:relative; overflow:hidden;">
                    <div style="position:absolute; top:-20px; right:-20px; width:100px; height:100px; background:rgba(255,255,255,0.05); border-radius:50%;"></div>
                    <div style="width:80px; height:80px; border-radius:50%; background:linear-gradient(to bottom right, #3b82f6, #1d4ed8); display:flex; align-items:center; justify-content:center; font-size:2rem; font-weight:800; color:#fff; border:3px solid rgba(255,255,255,0.2); box-shadow:0 4px 10px rgba(0,0,0,0.2); z-index:1;">
                        ${c.nombre ? c.nombre.substring(0, 2).toUpperCase() : 'C'}
                    </div>
                    <div style="text-align:center; z-index:1;">
                        <div style="font-size:1.6rem; font-weight:800; margin-bottom:4px; letter-spacing:-0.5px;">${c.nombre || 'Cliente'}</div>
                        <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(255,255,255,0.1); padding:4px 10px; border-radius:20px; font-size:0.85rem; font-weight:600; backdrop-filter:blur(4px);">
                            <div style="width:8px; height:8px; border-radius:50%; background:${c.limite_superado ? '#ef4444' : '#10b981'};"></div>
                            ${c.limite_superado ? 'Límite Superado' : 'Activo y Operativo'}
                        </div>
                    </div>
                </div>
                
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:24px;">
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:4px; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
                        <span style="font-size:0.75rem; color:#64748b; font-weight:700; text-transform:uppercase;">Deuda Actual</span>
                        <span style="font-size:1.3rem; font-weight:800; color:${c.saldo_actual > 0 ? '#ef4444' : '#10b981'};">$${fmt(c.saldo_actual || 0)}</span>
                    </div>
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:4px; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
                        <span style="font-size:0.75rem; color:#64748b; font-weight:700; text-transform:uppercase;">Límite Crédito</span>
                        <span style="font-size:1.3rem; font-weight:800; color:#0f172a;">$${fmt(c.techo_deuda || 0)}</span>
                    </div>
                </div>

                <div style="background:#fff; padding:20px; border-radius:16px; border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(0,0,0,0.05); font-size:0.95rem; margin-bottom:24px;">
                    <h3 style="font-size:1rem; font-weight:800; color:#0f172a; margin-top:0; margin-bottom:16px; display:flex; align-items:center; gap:8px;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Datos del Cliente
                    </h3>
                    <div style="display:flex; flex-direction:column; gap:12px;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span style="color:#64748b; font-weight:600;">Scoring</span>
                            <span style="background:#f1f5f9; padding:4px 10px; border-radius:8px; font-weight:700; color:#334155;">${c.scoring || 'A'}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span style="color:#64748b; font-weight:600;">Fecha de Alta</span>
                            <span style="color:#0f172a; font-weight:600;">${(c.created_at || '').slice(0, 10)}</span>
                        </div>
                        ${c.cuit ? `<div style="display:flex; justify-content:space-between; align-items:center;"><span style="color:#64748b; font-weight:600;">CUIT</span> <span style="color:#0f172a; font-weight:600;">${esc(c.cuit)}</span></div>` : ''}
                        ${c.direccion ? `<div style="display:flex; justify-content:space-between; align-items:center;"><span style="color:#64748b; font-weight:600;">Dirección</span> <span style="color:#0f172a; font-weight:600; text-align:right;">${esc(c.direccion)}</span></div>` : ''}
                        ${c.telefono ? `<div style="display:flex; justify-content:space-between; align-items:center;"><span style="color:#64748b; font-weight:600;">Teléfono</span> <span style="color:#0f172a; font-weight:600;">${esc(c.telefono)}</span></div>` : ''}
                        ${c.email ? `<div style="display:flex; justify-content:space-between; align-items:center;"><span style="color:#64748b; font-weight:600;">Email</span> <span style="color:#0f172a; font-weight:600;">${esc(c.email)}</span></div>` : ''}
                    </div>
                </div>
            `;
            
            // Add Profile to the top of the chat body instead of a hidden modal
            $('viewClientBody').innerHTML = profileHtml + html;
            $('wspProfileContent').innerHTML = profileHtml;
            
            if (sessionUser.role === 'admin') {
                $('btnClientEliminarWsp').style.display = 'block';
                $('btnClientEliminarWsp').onclick = () => {
                    $('modalWspProfile').classList.remove('open');
                    eliminarCliente(c.id);
                };
            } else {
                $('btnClientEliminarWsp').style.display = 'none';
            }
            
            if (c.saldo_actual > 0 && c.scoring !== 'D') {
                $('btnClientIncobrableWsp').style.display = 'block';
                // Attach correct action if incobrable is supported
            } else {
                $('btnClientIncobrableWsp').style.display = 'none';
            }
        }

        function closeClientDrawer() {
            const overlay = $('drawerClientOverlay');
            if (overlay && overlay.classList) overlay.classList.remove('open');
            selectedClienteId = null;
            // Restaurar topbar al estado normal (igual que volverDesdeClienteDetalle)
            if ($('topbarNormalMode')) $('topbarNormalMode').style.setProperty('display', '', '');
            if ($('topbarWspMode')) $('topbarWspMode').style.setProperty('display', 'none', 'important');
            if ($('menuToggle')) $('menuToggle').style.setProperty('display', '', '');
            if ($('btnVolverTop')) $('btnVolverTop').style.setProperty('display', 'none', 'important');
            if ($('btnClientPrintWsp')) $('btnClientPrintWsp').style.setProperty('display', 'none', 'important');
            if ($('btnTogglePro')) $('btnTogglePro').style.setProperty('display', '', '');
        }

        function updateSelectedRow(rows) {
            rows.forEach((r, idx) => {
                r.classList.toggle('selected', idx === activeRowIndex);
                if (idx === activeRowIndex) {
                    r.scrollIntoView({ block: 'nearest' });
                }
            });
        }

        function openDrawer(e) {
            selectedDeuda = e;
            $('drawerTitle').textContent = e.alias + ' — ' + e.tipo;
            let extra = '';
            if (e.es_tarjeta) {
                extra = `
                <div class="drawer-row"><span class="lbl">Fecha cierre</span><span class="val">${e.fecha_cierre || '—'}</span></div>
                <div class="drawer-row"><span class="lbl">Fecha vencimiento</span><span class="val">${e.fecha_vencimiento || '—'}</span></div>
                <div class="drawer-row"><span class="lbl">Cuotas</span><span class="val">${e.cuotas || '—'}</span></div>
                <div class="drawer-row"><span class="lbl">Cuotas pagadas</span><span class="val">${e.cuotas_pagadas || 0} de ${e.cuotas || '—'}</span></div>
                `;
            } else if (e.es_proveedor) {
                extra = `
                <div class="drawer-row"><span class="lbl">Kilos</span><span class="val">${e.kg ? fmt(e.kg) + ' kg' : '—'}</span></div>
                <div class="drawer-row"><span class="lbl">Precio / kg</span><span class="val">${e.precio_kg ? '$' + fmt(e.precio_kg) : '—'}</span></div>
                <div class="drawer-row"><span class="lbl">Plazo de pago</span><span class="val" style="color:var(--accent)">${e.plazo_texto || (e.plazo_dias ? e.plazo_dias + ' días' : '—')}</span></div>
                <div class="drawer-row"><span class="lbl">Vencimiento</span><span class="val">${e.fecha_vencimiento || '—'}</span></div>
                <div class="drawer-row"><span class="lbl">Reserva diaria (caja)</span><span class="val" style="color:var(--warning)">$${fmt(e.reserva_diaria || 0)}</span></div>
                `;
            }
            let pagosHtml = '';
            if (e.tiene_cuotas) {
                pagosHtml = `
                <div class="drawer-row"><span class="lbl">Cuota en curso</span><span class="val">${e.completa ? 'Completa' : e.cuota_en_curso + ' de ' + e.cuotas_total}</span></div>
                <div class="drawer-row"><span class="lbl">Monto por cuota</span><span class="val">$${fmt(e.monto_cuota)}</span></div>
                <div class="drawer-row"><span class="lbl">Saldo pendiente</span><span class="val">$${fmt(e.saldo_pendiente)}</span></div>
                ${e.cuotas_vencidas > 1 ? `<div class="drawer-row"><span class="lbl">Cuotas vencidas</span><span class="val" style="color:var(--danger)">${e.cuotas_vencidas_lista.join(', ')}</span></div>` : ''}
                `;
            }
            $('drawerBody').innerHTML = `
                ${vencBannerHtml(e)}
                ${e.es_cheque ? `
                <div class="drawer-row"><span class="lbl">Monto del cheque</span><span class="val">$${fmt(e.recibido)}</span></div>
                ${e.impuesto_cheque ? `<div class="drawer-row"><span class="lbl">Impuesto al cheque</span><span class="val" style="color:var(--warning)">$${fmt(e.impuesto_cheque)}</span></div>` : ''}
                <div class="drawer-row"><span class="lbl">Total a pagar</span><span class="val" style="color:var(--accent)">$${fmt(e.total_pagar)}</span></div>
                <div class="drawer-row"><span class="lbl">Interés financiero</span><span class="val">Sin interés</span></div>
                <div class="drawer-row"><span class="lbl">Reserva diaria (caja)</span><span class="val" style="color:var(--warning)">$${fmt(e.reserva_diaria || 0)}</span></div>
                <div class="drawer-row"><span class="lbl">Saldo pendiente</span><span class="val">$${fmt(e.saldo_pendiente || e.total_pagar)}</span></div>
                ` : e.es_proveedor ? `
                <div class="drawer-row"><span class="lbl">Compra</span><span class="val">${e.kg ? fmt(e.kg) + ' kg × $' + fmt(e.precio_kg) : '—'}</span></div>
                <div class="drawer-row"><span class="lbl">Total a pagar</span><span class="val" style="color:var(--accent)">$${fmt(e.total_pagar)}</span></div>
                <div class="drawer-row"><span class="lbl">Interés total</span><span class="val">${e.sin_interes ? 'Sin interés' : '$' + fmt(e.interes)}</span></div>
                <div class="drawer-row"><span class="lbl">Saldo pendiente</span><span class="val">$${fmt(e.saldo_pendiente || e.total_pagar)}</span></div>
                ` : `
                <div class="drawer-row"><span class="lbl">${e.es_tarjeta ? 'Resumen / consumo' : 'Monto recibido'}</span><span class="val">$${fmt(e.recibido)}</span></div>
                <div class="drawer-row"><span class="lbl">Total a pagar</span><span class="val" style="color:var(--accent)">$${fmt(e.total_pagar)}</span></div>
                <div class="drawer-row"><span class="lbl">Interés total</span><span class="val">${e.sin_interes ? 'Sin interés' : '$' + fmt(e.interes)}</span></div>
                `}
                ${extra}
                ${pagosHtml}
                ${(e.es_tarjeta || e.es_cheque || e.es_proveedor) && e.fecha_vencimiento ? `
                <div class="drawer-row"><span class="lbl">Estado vencimiento</span><span class="val">${badgeVencimiento(e)}</span></div>
                <div class="drawer-row"><span class="lbl">${e.vencido ? 'Días de retraso' : 'Días faltantes'}</span><span class="val" style="color:${e.vencido?'var(--danger)':'var(--success)'}">${e.vencido ? e.dias_retraso + ' días' : (e.dias_faltantes ?? '—') + (e.dias_faltantes != null ? ' días' : '')}</span></div>
                ` : ''}
                <div class="drawer-row"><span class="lbl">Plazo CFR</span><span class="val">${plazoTexto(e)}</span></div>
                <div class="drawer-row"><span class="lbl">CFR mensual</span><span class="val" style="color:${e.urgente?'var(--danger)':'var(--success)'}">${fmtPct(e.cfr)}</span></div>
                <div class="drawer-row"><span class="lbl">Prioridad</span><span class="val">${e.prioridad ? 'Máxima' : 'Normal'}</span></div>
                <div class="drawer-row"><span class="lbl">Registrado</span><span class="val">${e.created_at || '—'}</span></div>
            `;
            $('drawerPagar').style.display = (e.tiene_cuotas && !e.completa) ? 'inline-flex' : 'none';
            $('drawerOverlay').classList.add('open');
        }

        function closeDrawer() {
            $('drawerOverlay').classList.remove('open');
            selectedDeuda = null;
        }

        function bindDeudaEvents() {
            document.querySelectorAll('#tblDeudas tr.clickable').forEach(row => {
                row.addEventListener('click', ev => {
                    if (ev.target.closest('[data-del]')) return;
                    const e = data.enemigos.find(x => x.id === parseInt(row.dataset.id, 10));
                    if (e) openDrawer(e);
                });
            });
            document.querySelectorAll('[data-del]').forEach(btn => {
                btn.addEventListener('click', ev => {
                    ev.stopPropagation();
                    const opId = btn.dataset.del;
                    const e = data.enemigos.find(x => String(x.id) === String(opId));
                    void CrmDelete.eliminarOperacion(opId, e?.alias);
                });
            });
        }

        function updateGreeting() {
            const h = new Date().getHours();
            let msg = 'Buenos días,';
            if (h >= 13 && h < 20) msg = 'Buenas tardes,';
            else if (h >= 20 || h < 6) msg = 'Buenas noches,';
            if ($('topbarGreeting')) $('topbarGreeting').textContent = msg;
        }

        function renderAll() {
            if (!$('kpiMeta')) return;
            updateGreeting();
            renderKpis();
            renderHealth();
            renderChartCfr();
            renderHomeTable();
            renderRemitosDash();
            renderBancos();
            renderBulkLots();
            renderClientes();
            renderCobranzas();
            renderPagosCentral();
        }

        async function syncEmpresaFromServer() {
            try {
                const emp = await api('/api/empresa');
                if (emp && (emp.razon_social || emp.nombre)) {
                    localStorage.setItem('empresa_datos', JSON.stringify({
                        nombre: emp.razon_social || emp.nombre || 'Master Total',
                        cuit: emp.cuit || '',
                        direccion: emp.direccion || '',
                        telefono: emp.telefono || '',
                        email: emp.email || '',
                        cotizacion_usd: parseFloat(emp.cotizacion_usd) || 1000.0
                    }));
                }
            } catch (_) {}
        }

        const SESSION_SNAPSHOT_KEY = 'session_snapshot';

        function sessionUserFromLocalSnapshot() {
            try {
                const snap = localStorage.getItem(SESSION_SNAPSHOT_KEY);
                if (snap) return JSON.parse(snap);
            } catch (_) {}
            return {
                role: localStorage.getItem('session_role') || 'admin',
                username: localStorage.getItem('sync_user') || '',
                empresa_id: parseInt(localStorage.getItem('sync_empresa') || '1', 10),
                empresa_nombre: localStorage.getItem('session_empresa_nombre') || '',
            };
        }

        function persistSessionSnapshot(user) {
            try {
                localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify(user));
                localStorage.setItem('session_role', user.role || 'admin');
                localStorage.setItem('session_empresa_nombre', user.empresa_nombre || '');
            } catch (_) {}
        }

        function updateSessionGreetingUI() {
            const nameEl = document.getElementById('empresaNombre');
            if (!nameEl) return;
            nameEl.title = 'Cuenta: ' + sessionUser.username + ' (empresa #' + sessionUser.empresa_id + ')';
            if (window.CarteraLibro && window.CarteraLibro.cromo && window.CarteraLibro.cromo()) return;
            if (typeof actualizarNombreEmpresaTopbar === 'function') {
                actualizarNombreEmpresaTopbar();
            } else {
                const etiqueta = (sessionUser.empresa_nombre || '').toUpperCase();
                if (etiqueta && etiqueta !== 'JEFE' && nameEl.textContent !== etiqueta) nameEl.textContent = etiqueta;
            }
        }

        function hydrateSessionLocal() {
            sessionUser = sessionUserFromLocalSnapshot();
            updateSessionGreetingUI();
            if (window.CrmSync) {
                CrmSync.init(db, sessionUser);
                CrmSync.setApi(api);
            }
            applyRoleUi();
            return sessionUser;
        }

        async function loadSession() {
            let fromServer = false;
            try {
                const s = await api('/auth/session?_=' + Date.now());
                if (s.authenticated === false) throw new Error('no autenticado');
                sessionUser = {
                    role: s.role || 'admin',
                    username: s.username || '',
                    empresa_id: s.empresa_id || 1,
                    empresa_nombre: s.empresa_nombre || '',
                };
                fromServer = true;
                persistSessionSnapshot(sessionUser);
                updateSessionGreetingUI();
            } catch (_) {
                sessionUser = sessionUserFromLocalSnapshot();
                updateSessionGreetingUI();
            }
            if (window.CrmSync) {
                CrmSync.init(db, sessionUser);
                CrmSync.setApi(api);
            }
            void syncEmpresaFromServer();
            applyRoleUi();
            return fromServer;
        }

        async function logout() {
            try {
                await Promise.all([
                    db.transacciones.clear(),
                    db.cache.clear(),
                    db.solicitudes_pendientes.clear()
                ]);
                try { await db.pending_sync.clear(); } catch (_) {}
                localStorage.removeItem(SESSION_SNAPSHOT_KEY);
                localStorage.removeItem('session_role');
                localStorage.removeItem('session_empresa_nombre');
                localStorage.removeItem('sync_user');
                localStorage.removeItem('sync_empresa');
                if (window.CrmLoader && CrmLoader.limpiarCopiasDelTelefono) CrmLoader.limpiarCopiasDelTelefono();
                if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage('OLVIDAR_APP');
                }
                await api('/auth/logout', { method: 'POST' });
            } catch (_) {}
            window.location.href = '/inicio';
        }

        $('btnLogout')?.addEventListener('click', logout);
        $('btnLogoutSidebar')?.addEventListener('click', logout);

        $('btnNuevoUsuario')?.addEventListener('click', () => {
            $('formNuevoUsuario')?.reset();
            $('modalNuevoUsuario')?.classList.add('open');
        });
        $('btnCerrarModalUsuario')?.addEventListener('click', () => $('modalNuevoUsuario')?.classList.remove('open'));
        $('btnCancelarModalUsuario')?.addEventListener('click', () => $('modalNuevoUsuario')?.classList.remove('open'));
        $('modalNuevoUsuario')?.addEventListener('click', ev => { if (ev.target === $('modalNuevoUsuario')) $('modalNuevoUsuario').classList.remove('open'); });
        $('formNuevoUsuario')?.addEventListener('submit', async ev => {
            ev.preventDefault();
            try {
                await api('/api/usuarios', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: $('inpUsuarioUsername').value.trim(),
                        nombre: $('inpUsuarioNombre').value.trim(),
                        password: $('inpUsuarioPassword').value,
                        role: $('inpUsuarioRole').value
                    })
                });
                toast('Usuario creado');
                $('modalNuevoUsuario')?.classList.remove('open');
                await renderUsuarios(true);
            } catch (e) {
                toast(e.message, true);
            }
        });

        $('btnExportData')?.addEventListener('click', async () => {
            try {
                const payload = await api('/api/export');
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'master-total-export-' + new Date().toISOString().slice(0, 10) + '.json';
                a.click();
                URL.revokeObjectURL(url);
                toast('Exportación descargada');
            } catch (e) {
                toast(e.message || 'Error al exportar', true);
            }
        });

        window.abrirFormularioRegistro = abrirFormularioRegistro;
        function abrirFormularioRegistro(id, tipo = null) {
            switchView('registro');
            $('registroMenu').classList.add('field-hidden');
            document.querySelectorAll('.registro-subview').forEach(el => el.classList.add('field-hidden'));
            $(id).classList.remove('field-hidden');
            if (tipo) {
                const selectTipo = $(id).querySelector('select[name="tipo"]');
                if (selectTipo) {
                    selectTipo.value = tipo;
                    if (id === 'regDeuda') toggleFormTipo();
                }
            }
            // Small animation via CSS class
            $(id).classList.add('fade-in');
            setTimeout(() => $(id).classList.remove('fade-in'), 300);
        }

        function normalizarClienteDesdeApi(res, payload, fallbackId) {
            const saldoIni = parseFloat(payload.saldo_inicial || 0) || 0;
            const techo = parseFloat(res.techo_deuda ?? payload.techo_deuda ?? 0) || 0;
            return {
                id: res.id ?? fallbackId,
                nombre: res.nombre || payload.nombre,
                techo_deuda: techo,
                scoring: res.scoring || payload.scoring || 'A',
                telefono: res.telefono || payload.telefono || '',
                cuit: res.cuit || payload.cuit || '',
                direccion: res.direccion || payload.direccion || '',
                email: res.email || payload.email || '',
                saldo_inicial: saldoIni,
                saldo_actual: saldoIni,
                limite_superado: saldoIni > techo,
                en_mora: false,
                inrecuperable: false,
                fecha_ultimo_pago: null,
                oldest_unpaid: null,
            };
        }

        function upsertClienteEnCache(cliente) {
            if (!cliente?.id) return;
            data.clientes = data.clientes || [];
            const idx = data.clientes.findIndex(c => String(c.id) === String(cliente.id));
            if (idx >= 0) {
                data.clientes[idx] = { ...data.clientes[idx], ...cliente };
            } else {
                data.clientes.push(cliente);
            }
        }

        async function persistirAppDataLocal() {
            if (data) await tenantCachePut('appData', data);
        }

        window.abrirCarteraFiado = () => { switchView('cartera'); };

        window.abrirSubVistaClientes = (id) => {
            const resolved = id === 'cliNuevo' ? 'cliAdd' : id;
            if ($('clientesMenu')) $('clientesMenu').classList.add('field-hidden');
            document.querySelectorAll('.clientes-subview').forEach(v => v.classList.add('field-hidden'));
            if ($(resolved)) $(resolved).classList.remove('field-hidden');
            if (resolved === 'cliVer' || resolved === 'cliInrecuperables') {
                renderClientes();
            }
            window.scrollTo({top:0, behavior:'smooth'});
        };

        window.volverMenuClientes = () => {
            if ($('clientesMenu')) $('clientesMenu').classList.remove('field-hidden');
            document.querySelectorAll('.clientes-subview').forEach(v => v.classList.add('field-hidden'));
        };

        window.volverMenuRegistro = () => {
            document.querySelectorAll('.registro-subview').forEach(el => el.classList.add('field-hidden'));
            $('registroMenu').classList.remove('field-hidden');
            $('registroMenu').classList.add('fade-in');
            setTimeout(() => $('registroMenu').classList.remove('fade-in'), 300);
        }

        window.abrirSubVistaBulk = (id) => {
            $('bulkMenu').classList.add('field-hidden');
            document.querySelectorAll('.bulk-subview').forEach(el => el.classList.add('field-hidden'));
            $(id).classList.remove('field-hidden');
            $(id).classList.add('fade-in');
            if (id === 'bulkHistorial') renderBulkLots();
            setTimeout(() => $(id).classList.remove('fade-in'), 300);
        };

        window.volverMenuBulk = () => {
            document.querySelectorAll('.bulk-subview').forEach(el => el.classList.add('field-hidden'));
            $('bulkMenu').classList.remove('field-hidden');
            $('bulkMenu').classList.add('fade-in');
            setTimeout(() => $('bulkMenu').classList.remove('fade-in'), 300);
        };

        window.abrirSubVistaVentasExpress = (id) => {
            $('ventasExpressMenu').classList.add('field-hidden');
            document.querySelectorAll('.ventas-express-subview').forEach(el => el.classList.add('field-hidden'));
            $(id).classList.remove('field-hidden');
            $(id).classList.add('fade-in');
            setTimeout(() => $(id).classList.remove('fade-in'), 300);
        };

        window.volverMenuVentasExpress = () => {
            if (currentClientData) {
                // If we came from a client profile, going back means returning to the profile
                switchView('cliente-detalle');
                return;
            }
            document.querySelectorAll('.ventas-express-subview').forEach(el => el.classList.add('field-hidden'));
            $('ventasExpressMenu').classList.remove('field-hidden');
            $('ventasExpressMenu').classList.add('fade-in');
            setTimeout(() => $('ventasExpressMenu').classList.remove('fade-in'), 300);
        };

        function getGreeting() {
            const h = new Date().getHours();
            let emoji = '🌙'; let text = 'Buenas noches,';
            if (h >= 5 && h < 12) { emoji = '☀️'; text = 'Buenos días,'; }
            else if (h >= 12 && h < 20) { emoji = '🌤️'; text = 'Buenas tardes,'; }
            return `<div style="display: flex; align-items: center; gap: 6px;">
                        <span style="font-size: 28px; line-height: 1; filter: drop-shadow(0 2px 2px rgba(0,0,0,0.1)); margin-right: 4px;">${emoji}</span>
                        <div style="display: flex; flex-direction: column; line-height: 1.15; font-weight: 700; font-size: 16px; color: #111827;">
                            <span>${text}</span>
                            <span>jefe</span>
                        </div>
                    </div>`;
        }

        function plataJefe(n) {
            return '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        function porcentajesQueCierran(montos) {
            const total = montos.reduce((acc, n) => acc + (Number(n) || 0), 0);
            if (total <= 0) return montos.map(() => '0,0');
            const milesimas = montos.map((n) => ((Number(n) || 0) / total) * 1000);
            const base = milesimas.map((n) => Math.floor(n));
            let resto = 1000 - base.reduce((acc, n) => acc + n, 0);
            const orden = milesimas.map((n, i) => ({ i: i, frac: n - Math.floor(n) })).sort((a, b) => b.frac - a.frac);
            for (let k = 0; k < resto; k++) base[orden[k % orden.length].i] += 1;
            return base.map((n) => (n / 10).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
        }

        function cantidadJefe(n) {
            const x = Number(n);
            if (!Number.isFinite(x)) return '—';
            return (Math.round(x * 10) / 10).toLocaleString('es-AR', { maximumFractionDigits: 1 });
        }

        function textoJefe(valor) {
            return String(valor ?? '').replace(/[&<>"']/g, (c) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[c]));
        }

        function cerrarFaltante() {
            document.getElementById('pedidoSheet')?.remove();
        }

        function guardarCarrito() {
            try { sessionStorage.setItem(CARRITO_LOCAL, JSON.stringify(carritoPedido)); } catch (e) {}
        }

        function restaurarCarrito() {
            try {
                const crudo = sessionStorage.getItem(CARRITO_LOCAL);
                if (!crudo) return;
                const dato = JSON.parse(crudo);
                if (dato && typeof dato === 'object') carritoPedido = dato;
            } catch (e) {}
        }

        function clavePedido(item) {
            return String(item.codigo || '') + '|' + String(item.producto || '');
        }

        function entradasCarrito() {
            return Object.entries(carritoPedido);
        }

        function unidadPedido(item) {
            if (!item) return 'un';
            const cruda = String(item.unidad || '').trim();
            const baja = cruda.toLowerCase();
            if (item.pesable || baja === 'kg' || baja === 'kilo' || baja === 'kilos') return 'kg';
            if (!baja || baja === 'un' || baja === 'u' || baja === 'und' || baja === 'unidad' || baja === 'unidades') return 'un';
            return cruda;
        }

        function esKiloPedido(item) {
            return unidadPedido(item) === 'kg';
        }

        function alinearCarrito(clave, entry) {
            const item = faltantesEnPantalla.find((fila) => clavePedido(fila) === clave);
            if (!item) return entry;
            entry.unidad = unidadPedido(item);
            entry.pesable = esKiloPedido(item);
            if (!(entry.precio > 0)) entry.precio = Number(item.precio) || 0;
            if (!(entry.costo > 0)) entry.costo = Number(item.costo_unit) || 0;
            return entry;
        }

        function medidasDelCarrito(entradas) {
            let kilos = 0;
            let unidades = 0;
            entradas.forEach(([clave, entry]) => {
                alinearCarrito(clave, entry);
                if (esKiloPedido(entry)) kilos += entry.cantidad;
                else unidades += entry.cantidad;
            });
            const medidas = [];
            if (unidades) medidas.push(cantidadJefe(unidades) + ' un');
            if (kilos) medidas.push(cantidadJefe(kilos) + ' kg');
            return medidas;
        }

        function pintarCarritoFlotante() {
            let barra = document.getElementById('carritoFlotante');
            const entradas = entradasCarrito();
            const enPedidos = document.getElementById('view-pedidos')?.classList.contains('active');
            if (!entradas.length || !enPedidos) {
                barra?.remove();
                return;
            }
            const total = entradas.reduce((suma, [, entry]) => suma + entry.cantidad * entry.costo, 0);
            const medidas = medidasDelCarrito(entradas);
            if (!barra) {
                barra = document.createElement('button');
                barra.id = 'carritoFlotante';
                barra.type = 'button';
                barra.className = 'carrito-flotante';
                barra.addEventListener('click', abrirCarrito);
                document.body.appendChild(barra);
            }
            barra.innerHTML = `<span class="carrito-n">${entradas.length}</span><span class="carrito-medio"><b>${medidas.join(' · ') || 'Pedido'}</b><small>Ver pedido</small></span><span class="carrito-plata"><small>Costo</small><b>${plataJefe(total)}</b></span>`;
        }

        function marcarMasCarrito() {
            document.querySelectorAll('[data-sumar]').forEach((boton) => {
                const item = faltantesEnPantalla[Number(boton.dataset.sumar)];
                const entry = item && carritoPedido[clavePedido(item)];
                if (!entry) {
                    boton.textContent = '+';
                    boton.classList.remove('en-carrito');
                    return;
                }
                boton.innerHTML = `<b>${cantidadJefe(entry.cantidad)}</b><small>${textoJefe(unidadPedido(item))}</small>`;
                boton.classList.add('en-carrito');
            });
        }

        function sumarAlCarrito(indice) {
            const item = faltantesEnPantalla[indice];
            if (!item) return;
            const clave = clavePedido(item);
            if (!carritoPedido[clave]) {
                carritoPedido[clave] = {
                    producto: item.producto,
                    proveedor: item.proveedor || 'Sin proveedor',
                    costo: Number(item.costo_unit) || 0,
                    precio: Number(item.precio) || 0,
                    unidad: unidadPedido(item),
                    pesable: esKiloPedido(item),
                    cantidad: Number(item.a_pedir) || 1,
                };
            } else {
                carritoPedido[clave].cantidad = Math.round((carritoPedido[clave].cantidad + 1) * 10) / 10;
            }
            marcarMasCarrito();
            pintarCarritoFlotante();
            guardarCarrito();
        }

        function cambiarCarrito(clave, delta) {
            const entry = carritoPedido[clave];
            if (!entry) return;
            entry.cantidad = Math.round((entry.cantidad + delta) * 10) / 10;
            if (entry.cantidad <= 0) delete carritoPedido[clave];
            guardarCarrito();
            marcarMasCarrito();
            pintarCarritoFlotante();
            if (entradasCarrito().length) abrirCarrito();
            else cerrarFaltante();
        }

        function quitarDelCarrito(clave) {
            if (!carritoPedido[clave]) return;
            delete carritoPedido[clave];
            guardarCarrito();
            marcarMasCarrito();
            pintarCarritoFlotante();
            if (entradasCarrito().length) abrirCarrito();
            else cerrarFaltante();
        }

        function mensajeDelCarrito() {
            const grupos = {};
            entradasCarrito().forEach(([, entry]) => {
                const nombre = entry.proveedor || 'Sin proveedor';
                grupos[nombre] = grupos[nombre] || [];
                grupos[nombre].push(`- ${cantidadJefe(entry.cantidad)} ${unidadPedido(entry)} x ${entry.producto}`);
            });
            const lineas = ['PEDIDO'];
            Object.keys(grupos).forEach((nombre) => {
                lineas.push(nombre);
                grupos[nombre].forEach((linea) => lineas.push(linea));
            });
            return lineas.join('\n');
        }

        function abrirWhatsappPedido(ev) {
            if (ev) {
                ev.preventDefault();
                ev.stopPropagation();
            }
            const texto = mensajeDelCarrito();
            if (!texto || texto === 'PEDIDO') return;
            guardarCarrito();
            cerrarFaltante();
            const enlace = document.createElement('a');
            enlace.href = 'https://wa.me/?text=' + encodeURIComponent(texto);
            enlace.target = '_blank';
            enlace.rel = 'noopener noreferrer';
            document.body.appendChild(enlace);
            enlace.click();
            enlace.remove();
        }

        async function copiarPedidoCarrito(ev) {
            if (ev) ev.stopPropagation();
            const texto = mensajeDelCarrito();
            if (!texto || texto === 'PEDIDO') return;
            guardarCarrito();
            try {
                await navigator.clipboard.writeText(texto);
                if (typeof toast === 'function') toast('Pedido copiado');
            } catch (e) {
                if (typeof toast === 'function') toast('No se pudo copiar el pedido', true);
            }
            cerrarFaltante();
        }

        restaurarCarrito();

        function abrirCarrito() {
            const entradas = entradasCarrito();
            if (!entradas.length) return;
            cerrarFaltante();
            const total = entradas.reduce((suma, [, entry]) => suma + entry.cantidad * entry.costo, 0);
            const fondo = document.createElement('div');
            fondo.id = 'pedidoSheet';
            fondo.className = 'pedido-sheet-back';
            fondo.innerHTML = `<div class="pedido-sheet pedido-carrito" role="dialog" aria-label="Pedido">
                <strong class="pedido-sheet-titulo">Pedido</strong>
                <div class="pedido-carrito-lista">
                ${entradas.map(([clave, entry]) => {
                    alinearCarrito(clave, entry);
                    return `<div class="carrito-item">
                    <div><b>${textoJefe(entry.producto)}</b><span>${cantidadJefe(entry.cantidad)} ${textoJefe(unidadPedido(entry))}</span><span>Costo ${plataJefe(entry.cantidad * entry.costo)}</span>${entry.precio > 0 ? '' : '<span>Sin precio de lista</span>'}</div>
                    <div class="carrito-step">
                        <button type="button" data-menos="${textoJefe(clave)}" aria-label="Restar">−</button>
                        <b>${cantidadJefe(entry.cantidad)}</b>
                        <button type="button" data-mas="${textoJefe(clave)}" aria-label="Sumar">+</button>
                        <button type="button" class="carrito-quitar" data-quitar="${textoJefe(clave)}" aria-label="Quitar">×</button>
                    </div>
                </div>`;
                }).join('')}
                </div>
                <div class="pedido-carrito-pie">
                    <div class="pedido-dato"><span>Costo</span><b>${plataJefe(total)}</b></div>
                    <div class="pedido-carrito-acciones">
                        <button type="button" class="carrito-compartir" data-wasap>WhatsApp</button>
                        <button type="button" class="carrito-copiar" data-copiar>Copiar</button>
                    </div>
                    <button type="button" class="pedido-cerrar" data-cerrar>Cerrar</button>
                </div>
            </div>`;
            fondo.addEventListener('click', (ev) => {
                const menos = ev.target.closest('[data-menos]');
                const mas = ev.target.closest('[data-mas]');
                if (menos) { ev.stopPropagation(); cambiarCarrito(menos.dataset.menos, -1); return; }
                if (mas) { ev.stopPropagation(); cambiarCarrito(mas.dataset.mas, 1); return; }
                const quitar = ev.target.closest('[data-quitar]');
                if (quitar) { ev.stopPropagation(); quitarDelCarrito(quitar.dataset.quitar); return; }
                if (ev.target.closest('[data-wasap]')) { abrirWhatsappPedido(ev); return; }
                if (ev.target.closest('[data-copiar]')) { copiarPedidoCarrito(ev); return; }
                if (ev.target === fondo || ev.target.closest('[data-cerrar]')) cerrarFaltante();
            });
            document.body.appendChild(fondo);
        }

        function hoyLocal() {
            const ahora = new Date();
            const mes = String(ahora.getMonth() + 1).padStart(2, '0');
            const dia = String(ahora.getDate()).padStart(2, '0');
            return ahora.getFullYear() + '-' + mes + '-' + dia;
        }

        function fechaVisible(iso) {
            const texto = String(iso || '').slice(0, 10);
            if (texto.length === 10 && texto[4] === '-') return texto.slice(8, 10) + '/' + texto.slice(5, 7) + '/' + texto.slice(0, 4);
            return '';
        }

        function parseFechaAR(texto) {
            const partes = String(texto || '').trim().split('/');
            if (partes.length !== 3) return '';
            const dia = partes[0].padStart(2, '0');
            const mes = partes[1].padStart(2, '0');
            const anio = partes[2];
            if (anio.length !== 4 || Number(mes) < 1 || Number(mes) > 12 || Number(dia) < 1 || Number(dia) > 31) return '';
            return anio + '-' + mes + '-' + dia;
        }

        function escribirFechaAR(input) {
            const digitos = String(input.value || '').replace(/\D/g, '').slice(0, 8);
            let salida = digitos;
            if (digitos.length > 4) salida = digitos.slice(0, 2) + '/' + digitos.slice(2, 4) + '/' + digitos.slice(4);
            else if (digitos.length > 2) salida = digitos.slice(0, 2) + '/' + digitos.slice(2);
            input.value = salida;
        }

        function etiquetaPeriodoVentas() {
            const f = filtroVentas;
            let base = 'Hoy';
            if (f.alcance === 'semana') base = 'Semana';
            else if (f.alcance === 'mes') base = 'Mes';
            else if (f.alcance === 'periodo') {
                const desde = fechaVisible(f.desde || f.fecha);
                const hasta = fechaVisible(f.hasta || f.desde || f.fecha);
                base = desde && hasta && desde !== hasta ? (desde + ' → ' + hasta) : (desde || 'Período');
            }
            if (f.pago && f.pago !== 'TODOS') {
                const rotulos = { EFECTIVO: 'Efectivo', TARJETA: 'Tarjeta', TRANSFERENCIA: 'Transferencia', QR: 'QR', MIXTO: 'Mixto', 'CRÉDITO': 'Crédito', REDONDEO: 'Redondeo', RECARGO: 'Recargo' };
                base += ' · ' + (rotulos[f.pago] || f.pago);
            }
            if (f.q) {
                base += ' · "' + f.q + '"';
            }
            return base;
        }

        function pintarChipPeriodo(id, texto) {
            const nodo = $(id);
            if (nodo && texto) nodo.textContent = texto;
        }

        function claveFiltroVentas() {
            const f = filtroVentas;
            return [f.q, f.pago, f.alcance, f.fecha, f.desde, f.hasta, f.historico ? '1' : '0', f.franja ? '1' : '0', f.hora_desde, f.hora_hasta, f.caja].join('|');
        }

        function queryFiltroVentas() {
            const f = filtroVentas;
            let extra = '';
            if (f.q) extra += '&q=' + encodeURIComponent(f.q);
            if (f.pago && f.pago !== 'TODOS') extra += '&pago=' + encodeURIComponent(f.pago);
            if (f.historico) extra += '&historico=1';
            else if (f.alcance === 'periodo') {
                extra += '&alcance=periodo';
                if (f.desde) extra += '&fecha_ini=' + encodeURIComponent(f.desde);
                if (f.hasta || f.desde) extra += '&fecha_fin=' + encodeURIComponent(f.hasta || f.desde);
            } else if (f.alcance && f.alcance !== 'dia') {
                extra += '&alcance=' + encodeURIComponent(f.alcance);
                if (f.fecha) extra += '&fecha=' + encodeURIComponent(f.fecha);
            } else if (f.fecha) {
                extra += '&fecha=' + encodeURIComponent(f.fecha);
            }
            if (f.franja) {
                extra += '&hora_desde=' + encodeURIComponent(f.hora_desde || '00:00');
                extra += '&hora_hasta=' + encodeURIComponent(f.hora_hasta || '23:59');
            }
            if (f.caja) extra += '&caja=' + encodeURIComponent(f.caja);
            return extra;
        }

        function filtroVentasActivo() {
            const f = filtroVentas;
            const hoy = hoyLocal();
            const mesDistinto = f.alcance === 'mes' && f.fecha && f.fecha.slice(0, 7) !== hoy.slice(0, 7);
            return !!(f.q || (f.pago && f.pago !== 'TODOS') || f.historico || f.caja || f.franja
                || f.alcance === 'semana' || f.alcance === 'periodo' || f.alcance === 'dia'
                || mesDistinto);
        }

        function mostrarPantallaVentas() {
            const desglose = ventasPantalla === 'desglose';
            const lista = $('ticketLista');
            const otra = $('desgloseLista');
            if (lista) lista.hidden = desglose;
            if (otra) otra.hidden = !desglose;
        }

        function medidaJefe(cant, medida) {
            const x = Number(cant);
            if (!Number.isFinite(x)) return '—';
            const texto = x.toLocaleString('es-AR', { maximumFractionDigits: 2 });
            return texto + ' ' + (medida || 'un');
        }

        function pieDesglose(dato) {
            const partes = [(dato.articulos || 0) + ' articulos'];
            if (Number(dato.kilos) > 0) partes.push(medidaJefe(dato.kilos, 'kg'));
            if (Number(dato.unidades) > 0) partes.push(medidaJefe(dato.unidades, 'un'));
            return partes.join(' · ');
        }

        function pintarDesglose(dato) {
            mostrarPantallaVentas();
            const cuerpo = $('desgloseCuerpo');
            if (!cuerpo) return;
            const libro = (dato && dato.desglose) || { filas: [], articulos: 0, kilos: 0, unidades: 0, monto: 0, etiqueta: '' };
            const filas = libro.filas || [];
            const periodoTxt = etiquetaPeriodoVentas();
            pintarChipPeriodo('ticketPeriodo', periodoTxt);
            if (!dato || dato.libro === false) {
                cuerpo.innerHTML = '<p class="caja-vacio" style="padding:14px;">El libro de Cobro Fácil todavía no llegó a la nube para esta sucursal. Cuando termine el envío, este número sale de ahí.</p>';
                return;
            }
            if (!filas.length) {
                const vacio = periodoTxt === 'Hoy'
                    ? 'Hoy todavía no tiene ventas registradas.'
                    : ('Sin artículos en ' + periodoTxt + '.');
                cuerpo.innerHTML = `<p class="desglose-fecha">${textoJefe(libro.etiqueta || periodoTxt)}</p><p class="caja-vacio" style="padding:14px;">${textoJefe(vacio)}</p>`;
                return;
            }
            const lista = filas.map((fila, i) => `<div class="desglose-fila"><span class="nro">${i + 1}</span><b>${textoJefe(fila.nombre)}</b><span class="cant">${textoJefe(medidaJefe(fila.cantidad, fila.medida))}</span><strong>${plataJefe(fila.monto)}</strong></div>`).join('');
            cuerpo.innerHTML = `<p class="desglose-fecha">${textoJefe(libro.etiqueta || '')}</p><div class="desglose-lista">${lista}</div><div class="desglose-pie"><span>${textoJefe(pieDesglose(libro))}</span><b>${plataJefe(libro.monto)}</b></div>`;
        }

        function htmlFilaTicket(t) {
            const cancel = String(t.estado || '').toUpperCase().startsWith('CANCELAD');
            const dia = (t.fecha || '').slice(0, 10);
            const hora = (t.fecha || '').slice(11, 16);
            const cuando = (dia && dia !== hoyLocal()) ? (fechaVisible(dia) + ' ' + hora) : hora;
            return `<tr class="ticket-fila${cancel ? ' ticket-cancel' : ''}" data-ticket="${textoJefe(t.id)}"><td>${textoJefe(cuando)}</td><td>#${textoJefe(t.id)}</td><td>${textoJefe(cancel ? 'Cancelada' : (t.pago || '—'))}</td><td>${plataJefe(t.total)}</td></tr>`;
        }

        function actualizarResumenTickets() {
            const suma = $('ticketFiltro');
            if (!suma) return;
            const periodoTxt = etiquetaPeriodoVentas();
            pintarChipPeriodo('ticketPeriodo', periodoTxt);
            const totalOk = ticketsResumen.ok || ticketsEnPantalla.length;
            const cantTxt = totalOk === 1 ? '1 ticket' : (totalOk.toLocaleString('es-AR') + ' tickets');
            const viendo = ticketsEnPantalla.length;
            const progreso = (viendo < totalOk && ticketsTieneMas)
                ? ` · viendo ${viendo.toLocaleString('es-AR')} de ${cantTxt}`
                : ` · ${cantTxt}`;
            suma.textContent = (ticketsEnPantalla.length || ticketsResumen.ok)
                ? (periodoTxt + ' · ' + plataJefe(ticketsResumen.total) + progreso)
                : (periodoTxt + ' · $0,00');
        }

        let ticketsCargandoMas = false;
        let ticketsTieneMas = false;

        function asegurarSentinel() {
            const cuerpo = $('ticketCuerpo');
            if (!cuerpo) return;
            $('ticketScrollSentinel')?.remove();
            if (!ticketsTieneMas) return;
            const totalOk = ticketsResumen.ok || 0;
            const quedan = Math.max(0, totalOk - ticketsEnPantalla.length);
            const tr = document.createElement('tr');
            tr.id = 'ticketScrollSentinel';
            tr.innerHTML = `<td colspan="4" style="text-align:center; padding:16px 12px; color:#64748b; font-size:13px; font-weight:600; cursor:pointer;" onclick="void window.cargarSiguientePaginaTickets()">
                <div style="display:inline-flex; align-items:center; gap:8px;">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
                    <span>Cargar más tickets ${quedan > 0 ? ('(quedan ' + quedan.toLocaleString('es-AR') + ')') : ''}</span>
                </div>
            </td>`;
            cuerpo.appendChild(tr);
        }

        window.cargarSiguientePaginaTickets = async function() {
            if (ticketsCargandoMas || !ticketsTieneMas) return;
            if (moduloActual !== 'ticket' || ventasPantalla === 'desglose') return;
            ticketsCargandoMas = true;
            const offset = ticketsEnPantalla.length;
            const tr = $('ticketScrollSentinel');
            if (tr) {
                tr.innerHTML = `<td colspan="4" style="text-align:center; padding:16px 12px; color:#0284c7; font-size:13px; font-weight:600;">
                    <div style="display:inline-flex; align-items:center; gap:8px;">
                        <span class="spinner" style="display:inline-block; width:14px; height:14px; border:2px solid #94a3b8; border-top-color:#0284c7; border-radius:50%; animation:spin 0.8s linear infinite;"></span>
                        <span>Cargando otros 400 tickets…</span>
                    </div>
                </td>`;
            }
            try {
                let nuevos = [];
                let mas = false;
                if (window.Espejo && Espejo.tieneDatos && Espejo.tieneDatos()) {
                    const rango = Espejo.rangoVentas(filtroVentas);
                    const lista = Espejo.listar(null, rango[0], rango[1], activeSucursalId, filtroVentas, offset, 400);
                    if (lista && Array.isArray(lista.tickets)) {
                        nuevos = lista.tickets;
                        mas = !!lista.hay_mas || (nuevos.length === 400 && (offset + nuevos.length) < lista.cant);
                    }
                }
                if (!nuevos.length && navigator.onLine) {
                    let url = '/api/pos/jefe?panel=ticket' + queryFiltroVentas() + '&offset=' + offset + '&limite=400';
                    if (activeSucursalId !== null && activeSucursalId !== undefined) {
                        url += '&sucursal_id=' + encodeURIComponent(activeSucursalId);
                    }
                    const res = await fetch(url);
                    if (res.ok) {
                        const dato = await res.json();
                        if (dato && Array.isArray(dato.tickets)) {
                            nuevos = dato.tickets;
                            mas = !!dato.hay_mas || (nuevos.length === 400 && (offset + nuevos.length) < (dato.tickets_ok || 0));
                        }
                    }
                }
                if (nuevos.length > 0) {
                    const conocidos = new Set(ticketsEnPantalla.map(t => String(t.id)));
                    const paraAgregar = nuevos.filter(t => !conocidos.has(String(t.id)));
                    if (paraAgregar.length > 0) {
                        ticketsEnPantalla.push(...paraAgregar);
                        const cuerpo = $('ticketCuerpo');
                        if (cuerpo) {
                            $('ticketScrollSentinel')?.remove();
                            cuerpo.insertAdjacentHTML('beforeend', paraAgregar.map(htmlFilaTicket).join(''));
                        }
                    }
                    ticketsTieneMas = mas && (ticketsEnPantalla.length < ticketsResumen.ok);
                } else {
                    ticketsTieneMas = false;
                }
            } catch (err) {
                console.warn('[Ventas] Error cargando página de tickets:', err);
            } finally {
                ticketsCargandoMas = false;
                $('ticketScrollSentinel')?.remove();
                actualizarResumenTickets();
                asegurarSentinel();
            }
        };

        function verificarScrollTickets() {
            if (moduloActual !== 'ticket' || ventasPantalla === 'desglose') return;
            if (!ticketsTieneMas || ticketsCargandoMas) return;
            const scrollPos = window.innerHeight + window.scrollY;
            const threshold = (document.documentElement.scrollHeight || document.body.scrollHeight) - 600;
            if (scrollPos >= threshold) {
                void window.cargarSiguientePaginaTickets();
            }
        }
        window.addEventListener('scroll', verificarScrollTickets, { passive: true });

        function pintarTickets(acumular) {
            mostrarPantallaVentas();
            const cuerpo = $('ticketCuerpo');
            if (!cuerpo) return;
            actualizarResumenTickets();
            if (!acumular) {
                if (ticketsEnPantalla.length) {
                    cuerpo.innerHTML = ticketsEnPantalla.map(htmlFilaTicket).join('');
                } else {
                    cuerpo.innerHTML = `<tr><td colspan="4">${textoJefe(ticketsAviso || 'Sin tickets con ese filtro.')}</td></tr>`;
                }
            }
            asegurarSentinel();
        }

        function cerrarTicket() {
            document.getElementById('ticketSheet')?.remove();
        }

        function etiquetaPago(metodo) {
            const texto = String(metodo || '').trim();
            const alto = texto.toUpperCase();
            if (['FIADO', 'CLIENTES', 'CLIENTE', 'CUENTA CORRIENTE'].includes(alto)) return 'Crédito';
            if (alto.startsWith('MIXTO')) return texto.replace(/\b(clientes|cliente|fiado)\b/ig, 'Crédito');
            return texto || '—';
        }

        async function abrirTicket(id) {
            cerrarTicket();
            const fondo = document.createElement('div');
            fondo.id = 'ticketSheet';
            fondo.className = 'pedido-sheet-back';
            fondo.innerHTML = `<div class="pedido-sheet" role="dialog" aria-label="Ticket">
                <strong class="pedido-sheet-titulo">Ticket #${textoJefe(id)}</strong>
                <p>Buscando en el libro…</p>
                <button type="button" class="pedido-cerrar" data-cerrar>Cerrar</button>
            </div>`;
            fondo.addEventListener('click', (ev) => {
                if (ev.target === fondo || ev.target.closest('[data-cerrar]')) cerrarTicket();
            });
            document.body.appendChild(fondo);
            const hoja = fondo.querySelector('.pedido-sheet');
            try {
                let dato = null;
                if (window.Espejo && Espejo.ticket) {
                    const localT = Espejo.ticket(id);
                    if (localT) {
                        dato = {
                            encontrado: true,
                            id: localT.id,
                            fecha: localT.fecha,
                            total: localT.total,
                            pago: localT.pago,
                            estado: localT.estado,
                            usuario: '',
                            caja: '',
                            items: (localT.items || []).map((i) => ({ nombre: i.producto, cantidad: i.cantidad, subtotal: i.subtotal }))
                        };
                    }
                }
                if (!dato) {
                    dato = await fetch('/api/pos/ticket?id=' + encodeURIComponent(id)).then((r) => r.json());
                }
                if (!hoja) return;
                if (!dato.encontrado) {
                    hoja.innerHTML = `<strong class="pedido-sheet-titulo">Ticket #${textoJefe(id)}</strong><p>Ese ticket todavía no está en la nube.</p><button type="button" class="pedido-cerrar" data-cerrar>Cerrar</button>`;
                    return;
                }
                const lineas = (dato.items || []).map((item) => `<div class="pedido-dato"><span>${textoJefe(item.nombre)} · ${cantidadJefe(item.cantidad)}</span><b>${plataJefe(item.subtotal)}</b></div>`).join('');
                const extra = [];
                if (Number(dato.descuento) > 0) extra.push(`<div class="pedido-dato"><span>Descuento</span><b>-${plataJefe(dato.descuento)}</b></div>`);
                if (Number(dato.recargo) > 0) extra.push(`<div class="pedido-dato"><span>Recargo</span><b>+${plataJefe(dato.recargo)}</b></div>`);
                const cancel = String(dato.estado || '').toUpperCase().startsWith('CANCELAD');
                hoja.innerHTML = `<strong class="pedido-sheet-titulo">Ticket #${textoJefe(dato.id)}</strong>
                    <div class="pedido-dato"><span>Cuándo</span><b>${textoJefe(dato.fecha || '—')}</b></div>
                    <div class="pedido-dato"><span>Pago</span><b>${textoJefe(etiquetaPago(dato.pago))}</b></div>
                    <div class="pedido-dato"><span>Cajero</span><b>${textoJefe(dato.usuario || '—')}</b></div>
                    <div class="pedido-dato"><span>Caja</span><b>${textoJefe(dato.caja || '—')}</b></div>
                    ${dato.cliente ? `<div class="pedido-dato"><span>Cliente</span><b>${textoJefe(dato.cliente)}</b></div>` : ''}
                    ${cancel ? '<div class="pedido-dato"><span>Estado</span><b>Cancelada</b></div>' : ''}
                    ${lineas || '<p>El ticket está, sin el detalle de los cortes.</p>'}
                    ${extra.join('')}
                    <div class="pedido-dato"><span>Total</span><b>${plataJefe(dato.total)}</b></div>
                    <button type="button" class="pedido-cerrar" data-cerrar>Cerrar</button>`;
            } catch (_) {
                if (hoja) hoja.innerHTML = `<strong class="pedido-sheet-titulo">Ticket #${textoJefe(id)}</strong><p>No se pudo leer el ticket.</p><button type="button" class="pedido-cerrar" data-cerrar>Cerrar</button>`;
            }
        }

        function modoFiltroVentas(f) {
            if (f.alcance === 'semana') return 'semana';
            if (f.alcance === 'mes') return 'mes';
            if (f.alcance === 'periodo') return 'periodo';
            if (f.alcance === 'dia') return 'hoy';
            return 'mes';
        }

        function avisoSinTickets(libroLlego) {
            const periodoTxt = etiquetaPeriodoVentas();
            if (!libroLlego) return 'El libro de Cobro Fácil todavía no llegó a la nube para esta sucursal. Cuando termine el envío, este número sale de ahí.';
            if (periodoTxt === 'Hoy') return 'Hoy todavía no tiene ventas registradas.';
            return 'Sin tickets en ' + periodoTxt + '.';
        }

        function abrirFiltroVentas() {
            cerrarTicket();
            const f = filtroVentas;
            const modo = modoFiltroVentas(f);
            const pagos = ['TODOS', 'EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'QR', 'MIXTO', 'CRÉDITO', 'REDONDEO', 'RECARGO'];
            const rotulos = { TODOS: 'Todos', EFECTIVO: 'Efectivo', TARJETA: 'Tarjeta', TRANSFERENCIA: 'Transferencia', QR: 'QR', MIXTO: 'Mixto', 'CRÉDITO': 'Crédito', REDONDEO: 'Redondeo', RECARGO: 'Recargo' };
            const fondo = document.createElement('div');
            fondo.id = 'ticketSheet';
            fondo.className = 'pedido-sheet-back';
            const franjaOn = !!f.franja;
            fondo.innerHTML = `<div class="pedido-sheet filtro-venta" role="dialog" aria-label="Filtro de ventas">
                <div class="filtro-cabeza">
                    <strong class="pedido-sheet-titulo">Filtro</strong>
                    <button type="button" class="filtro-tuerca${franjaOn ? ' active' : ''}" data-franja aria-pressed="${franjaOn ? 'true' : 'false'}" aria-label="Franja horaria"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/></svg></button>
                </div>
                <div class="filtro-horas" id="filtroHoras"${franjaOn ? '' : ' hidden'}>
                    <label>De<input id="filtroDesde" type="time" value="${textoJefe(f.hora_desde || '08:00')}"></label>
                    <label>a<input id="filtroHasta" type="time" value="${textoJefe(f.hora_hasta || '21:00')}"></label>
                </div>
                <label>Buscar folio, producto o cajero<input id="filtroQ" type="search" value="${textoJefe(f.q)}" placeholder="1024, asado o cajero"></label>
                <div class="filtro-periodos" role="group" aria-label="Período">
                    <button type="button" class="filtro-periodo${modo === 'hoy' ? ' active' : ''}" data-modo="hoy">Hoy</button>
                    <button type="button" class="filtro-periodo${modo === 'semana' ? ' active' : ''}" data-modo="semana">Semana</button>
                    <button type="button" class="filtro-periodo${modo === 'mes' ? ' active' : ''}" data-modo="mes">Mes</button>
                    <button type="button" class="filtro-periodo${modo === 'periodo' ? ' active' : ''}" data-modo="periodo">Período</button>
                </div>
                <div class="filtro-horas" id="filtroFechaCampo"${modo === 'periodo' ? '' : ' hidden'}>
                    <label>Desde<input id="filtroFechaDesde" type="text" inputmode="numeric" placeholder="DD/MM/AAAA" maxlength="10" value="${textoJefe(fechaVisible(f.desde || f.fecha || hoyLocal()))}"></label>
                    <label>Hasta<input id="filtroFechaHasta" type="text" inputmode="numeric" placeholder="DD/MM/AAAA" maxlength="10" value="${textoJefe(fechaVisible(f.hasta || f.desde || f.fecha || hoyLocal()))}"></label>
                </div>
                <label>Pago<select id="filtroPago">${pagos.map((op) => `<option value="${op}"${op === (f.pago || 'TODOS') ? ' selected' : ''}>${rotulos[op]}</option>`).join('')}</select></label>
                <button type="button" class="pedido-cerrar" data-aplicar>Aplicar</button>
            </div>`;
            function pintarModo(elegido) {
                fondo.querySelectorAll('[data-modo]').forEach((boton) => {
                    boton.classList.toggle('active', boton.dataset.modo === elegido);
                });
                const campo = fondo.querySelector('#filtroFechaCampo');
                if (campo) campo.hidden = elegido !== 'periodo';
            }
            fondo.querySelectorAll('#filtroFechaDesde, #filtroFechaHasta').forEach((input) => {
                input.addEventListener('input', () => escribirFechaAR(input));
            });
            fondo.addEventListener('click', (ev) => {
                const tuerca = ev.target.closest('[data-franja]');
                if (tuerca) {
                    const horas = fondo.querySelector('#filtroHoras');
                    const activa = horas && horas.hidden;
                    if (horas) horas.hidden = !activa;
                    tuerca.classList.toggle('active', !!activa);
                    tuerca.setAttribute('aria-pressed', activa ? 'true' : 'false');
                    return;
                }
                const periodo = ev.target.closest('[data-modo]');
                if (periodo) {
                    pintarModo(periodo.dataset.modo);
                    return;
                }
                if (ev.target.closest('[data-aplicar]')) {
                    const elegido = fondo.querySelector('.filtro-periodo.active')?.dataset.modo || 'mes';
                    const desde = parseFechaAR(fondo.querySelector('#filtroFechaDesde')?.value) || hoyLocal();
                    const hasta = parseFechaAR(fondo.querySelector('#filtroFechaHasta')?.value) || desde;
                    const franja = fondo.querySelector('.filtro-tuerca')?.classList.contains('active');
                    const alcance = elegido === 'mes' ? 'mes' : (elegido === 'semana' ? 'semana' : (elegido === 'periodo' ? 'periodo' : 'dia'));
                    filtroVentas = {
                        q: (fondo.querySelector('#filtroQ')?.value || '').trim(),
                        pago: fondo.querySelector('#filtroPago')?.value || 'TODOS',
                        alcance: alcance,
                        fecha: elegido === 'hoy' ? hoyLocal() : (elegido === 'periodo' ? desde : ''),
                        historico: false,
                        franja: !!franja,
                        hora_desde: franja ? (fondo.querySelector('#filtroDesde')?.value || '08:00') : '08:00',
                        hora_hasta: franja ? (fondo.querySelector('#filtroHasta')?.value || '21:00') : '21:00',
                        caja: '',
                        desde: elegido === 'periodo' ? desde : '',
                        hasta: elegido === 'periodo' ? hasta : ''
                    };
                    cerrarTicket();
                    const refresh = $('btnRefresh');
                    if (refresh) refresh.classList.toggle('filtrando', filtroVentasActivo());
                    void cargarJefe(ventasPantalla === 'desglose' ? 'desglose' : 'ticket');
                    return;
                }
                if (ev.target === fondo) cerrarTicket();
            });
            document.body.appendChild(fondo);
        }

        function abrirFiltroProveedor() {
            cerrarFaltante();
            const proveedores = [...new Set(faltantesEnPantalla.map(item => item.proveedor || 'Sin proveedor'))].sort((a, b) => a.localeCompare(b, 'es'));
            const opciones = [{ id: '', nombre: 'Todos' }].concat(proveedores.map(nombre => ({ id: nombre, nombre })));
            const fondo = document.createElement('div');
            fondo.id = 'pedidoSheet';
            fondo.className = 'pedido-sheet-back';
            fondo.innerHTML = `<div class="pedido-sheet" role="dialog" aria-label="Proveedores">
                <strong class="pedido-sheet-titulo">Proveedores</strong>
                ${opciones.map(opcion => `<button type="button" class="pedido-opcion${opcion.id === filtroProveedorPedido ? ' active' : ''}" data-proveedor="${textoJefe(opcion.id)}">${textoJefe(opcion.nombre)}</button>`).join('')}
                <button type="button" class="pedido-cerrar" data-cerrar>Cerrar</button>
            </div>`;
            fondo.addEventListener('click', (ev) => {
                const opcion = ev.target.closest('[data-proveedor]');
                if (opcion) {
                    filtroProveedorPedido = opcion.dataset.proveedor;
                    const refresh = $('btnRefresh');
                    if (refresh) refresh.classList.toggle('filtrando', !!filtroProveedorPedido);
                    cerrarFaltante();
                    pintarFaltantes();
                    if (window.ModuloPanel) ModuloPanel.recoger('pedidos');
                    return;
                }
                if (ev.target === fondo || ev.target.closest('[data-cerrar]')) cerrarFaltante();
            });
            document.body.appendChild(fondo);
        }

        window.copiarPedidoWhatsapp = function (ev) {
            if (ev) ev.stopPropagation();
            const texto = document.getElementById('txtWspPedido');
            if (!texto) return;
            navigator.clipboard.writeText(texto.value);
            alert('Mensaje copiado. Abrí WhatsApp y pegalo.');
        };

        function abrirFaltante(indice) {
            const item = faltantesEnPantalla[indice];
            if (!item) return;
            cerrarFaltante();
            const filas = [
                ['Proveedor', item.proveedor || 'Sin proveedor'],
                ['Stock', cantidadJefe(item.stock_actual)],
                ['Mínimo', cantidadJefe(item.minimo)],
                ['Máximo', cantidadJefe(item.maximo)],
                ['Unidad', unidadPedido(item)],
                ['A pedir', cantidadJefe(item.a_pedir) + ' ' + unidadPedido(item)],
                ['Costo', plataJefe(item.costo_unit)],
                ['Precio de lista', item.precio > 0 ? plataJefe(item.precio) : 'Sin precio de lista'],
                ['Subtotal', plataJefe(item.subtotal)],
            ];
            if (item.sucursal) filas.splice(1, 0, ['Sucursal', item.sucursal]);
            if (item.codigo) filas.push(['Código', item.codigo]);
            const fondo = document.createElement('div');
            fondo.id = 'pedidoSheet';
            fondo.className = 'pedido-sheet-back';
            fondo.innerHTML = `<div class="pedido-sheet" role="dialog" aria-label="${textoJefe(item.producto)}">
                <strong class="pedido-sheet-titulo">${textoJefe(item.producto)}</strong>
                ${filas.map(([etiqueta, valor]) => `<div class="pedido-dato"><span>${textoJefe(etiqueta)}</span><b>${textoJefe(valor)}</b></div>`).join('')}
                <button type="button" class="pedido-cerrar" data-cerrar>Cerrar</button>
            </div>`;
            fondo.addEventListener('click', (ev) => {
                if (ev.target === fondo || ev.target.closest('[data-cerrar]')) cerrarFaltante();
            });
            document.body.appendChild(fondo);
        }

        function pintarFaltantes() {
            const cuerpo = $('pedidosCuerpo');
            if (!cuerpo) return;
            const lista = faltantesEnPantalla
                .map((item, indice) => ({ item, indice }))
                .filter(({ item }) => !filtroProveedorPedido || (item.proveedor || 'Sin proveedor') === filtroProveedorPedido);
            const filas = lista.length
                ? lista.map(({ item, indice }) => {
                    const enCarrito = carritoPedido[clavePedido(item)];
                    const unidad = unidadPedido(item);
                    const accion = enCarrito
                        ? `<b>${cantidadJefe(enCarrito.cantidad)}</b><small>${textoJefe(unidad)}</small>`
                        : '+';
                    return `<div class="pedido-fila">
                        <button type="button" class="pedido-cuerpo" data-pedido="${indice}">
                            <span class="pedido-nombre">${textoJefe(item.producto)}</span>
                            ${item.sucursal ? `<span class="pedido-sucursal">${textoJefe(item.sucursal)}</span>` : ''}
                            <span class="pedido-meta"><b class="pedido-stock">${cantidadJefe(item.stock_actual)}</b><span class="pedido-pedir">pedir ${cantidadJefe(item.a_pedir)} ${textoJefe(unidad)}</span></span>
                        </button>
                        <button type="button" class="pedido-mas${enCarrito ? ' en-carrito' : ''}" data-sumar="${indice}" aria-label="Sumar al pedido">${accion}</button>
                    </div>`;
                }).join('')
                : `<p class="pedido-vacio">${faltantesEnPantalla.length ? 'Ese proveedor no tiene faltantes.' : 'Todo el stock está por encima del mínimo.'}</p>`;
            cuerpo.innerHTML = `
                <div class="pedido-lista">
                    ${filas}
                </div>
                <div data-herramienta="whatsapp" data-titulo="Mensaje al frigorífico" class="pedido-wsp">
                    <textarea id="txtWspPedido" readonly>${textoJefe(mensajePedido)}</textarea>
                    <button type="button" class="btn btn-primary pedido-copiar" onclick="copiarPedidoWhatsapp(event)">Copiar para WhatsApp</button>
                </div>`;
        }

        function pintarBarraJefe(panel, dato) {
            const resumen = (dato && dato.resumen) || {};
            const cartera = (dato && dato.cartera) || {};
            const dig = (dato && dato.digitales) || {};
            const caja = (dato && dato.contabilidad) || {};
            const ped = (dato && dato.pedidos) || {};
            let items = [
                ['Ventana', '—'],
                ['', '—'],
                ['', '—'],
                ['', '—'],
            ];
            if (panel === 'admin' || panel === 'cartera' || panel === 'clientes') {
                items = [
                    ['En la calle', plataJefe(cartera.cartera_en_calle || cartera.deuda_total)],
                    ['Activas', String(cartera.cuentas_activas || cartera.con_deuda || 0)],
                    ['En riesgo', plataJefe(cartera.cartera_en_riesgo || 0)],
                    ['Cobros del mes', plataJefe(cartera.cobros_del_mes || 0)],
                ];
            } else if (panel === 'reporte' || panel === 'jefe') {
                items = [
                    (() => {
                        const v = dato.vitrina;
                        const vtot = (v && v.tickets && v.tickets.total > 0) ? v.tickets.total : resumen.ventas;
                        const vcnt = (v && v.tickets && v.tickets.cant > 0) ? v.tickets.cant : (resumen.tickets || 0);
                        const vprom = vcnt > 0 ? (vtot / vcnt) : (resumen.promedio || 0);
                        const vdig = (v && v.tickets_digitales && v.tickets_digitales.valor > 0) ? v.tickets_digitales.valor : 0;
                        const vdigPct = vtot > 0 ? Math.round(vdig / vtot * 100) : (resumen.mix_digital_pct || 0);
                        return [
                            ['Ventas', plataJefe(vtot)],
                            ['Tickets', String(vcnt)],
                            ['Promedio', plataJefe(vprom)],
                            ['Digital', vdigPct + '%'],
                        ];
                    })()[0],
                    (() => {
                        const v = dato.vitrina;
                        const vtot = (v && v.tickets && v.tickets.total > 0) ? v.tickets.total : resumen.ventas;
                        const vcnt = (v && v.tickets && v.tickets.cant > 0) ? v.tickets.cant : (resumen.tickets || 0);
                        const vprom = vcnt > 0 ? (vtot / vcnt) : (resumen.promedio || 0);
                        return ['Tickets', String(vcnt)];
                    })(),
                    (() => {
                        const v = dato.vitrina;
                        const vtot = (v && v.tickets && v.tickets.total > 0) ? v.tickets.total : resumen.ventas;
                        const vcnt = (v && v.tickets && v.tickets.cant > 0) ? v.tickets.cant : (resumen.tickets || 0);
                        const vprom = vcnt > 0 ? (vtot / vcnt) : (resumen.promedio || 0);
                        return ['Promedio', plataJefe(vprom)];
                    })(),
                    (() => {
                        const v = dato.vitrina;
                        const vtot = (v && v.tickets && v.tickets.total > 0) ? v.tickets.total : resumen.ventas;
                        const vdig = (v && v.tickets_digitales && v.tickets_digitales.valor > 0) ? v.tickets_digitales.valor : 0;
                        const vdigPct = vtot > 0 ? Math.round(vdig / vtot * 100) : (resumen.mix_digital_pct || 0);
                        return ['Digital', vdigPct + '%'];
                    })(),
                ];
            } else if (panel === 'digitales') {
                items = [
                    ['Bruto', plataJefe(dig.bruto_mp)],
                    ['Neto', plataJefe(dig.neto_mp)],
                    ['Tickets', plataJefe(dig.tickets_digitales)],
                    ['Sin ticket', plataJefe(dig.sin_ticket)],
                ];
            } else if (panel === 'contabilidad' || panel === 'tesoreria') {
                items = [
                    ['Ventas', plataJefe(caja.ventas)],
                    ['Cobros', plataJefe(caja.cobros)],
                    ['Gastos', plataJefe(caja.gastos)],
                    ['Resultado', plataJefe(caja.resultado)],
                ];
            } else if (panel === 'pedidos') {
                items = [
                    ['En quiebre', String(ped.articulos_en_quiebre || 0)],
                    ['Proveedores', String(ped.proveedores_con_pedido || 0)],
                    ['Inversión', plataJefe(ped.inversion_estimada)],
                    ['A pedir', String((ped.faltantes || []).length)],
                ];
            } else if (panel === 'proveedor') {
                const lista = (dato && dato.proveedores) || [];
                const deuda = lista.reduce((suma, p) => suma + Number(p.deuda || 0), 0);
                items = [
                    ['Proveedores', String(lista.length)],
                    ['Deuda', plataJefe(deuda)],
                    ['', '—'],
                    ['', '—'],
                ];
            } else if (panel === 'promedio') {
                items = [
                    ['Promedio', plataJefe(resumen.promedio)],
                    ['Tickets', String(resumen.tickets || 0)],
                    ['Ventas', plataJefe(resumen.ventas)],
                    ['Día', resumen.dia || '—'],
                ];
            } else if (panel === 'ticket') {
                const cant = Number(dato.tickets_ok || 0);
                const total = Number(dato.filtrado || 0);
                items = [
                    ['Tickets', String(cant)],
                    ['Ventas', plataJefe(total)],
                    ['Promedio', plataJefe(cant ? total / cant : 0)],
                    ['Día', resumen.dia || '—'],
                ];
            }
            items.forEach((par, i) => {
                const n = i + 1;
                const etiqueta = $('jefeKpi' + n + 'L');
                const valor = $('jefeKpi' + n + 'V');
                if (etiqueta) etiqueta.textContent = par[0];
                if (valor) valor.textContent = par[1];
            });
        }

        let activeSucursalId = null;
        try {
            const guardado = localStorage.getItem('crm_active_sucursal_id');
            if (guardado !== null && guardado !== '') activeSucursalId = parseInt(guardado, 10);
        } catch (_) {}
        let sucursalesConocidas = [];
        try {
            sucursalesConocidas = JSON.parse(localStorage.getItem('crm_sucursales_cache') || '[]');
        } catch (_) {}

        function actualizarNombreEmpresaTopbar() {
            const nomEl = $('empresaNombre');
            if (!nomEl) return;
            let baseEmpresa = '';
            if (typeof sessionUser !== 'undefined' && sessionUser && sessionUser.empresa_nombre) {
                baseEmpresa = sessionUser.empresa_nombre;
            }
            if (!baseEmpresa) {
                try {
                    baseEmpresa = (JSON.parse(localStorage.getItem('empresa_datos') || '{}').nombre) || '';
                } catch (_) {}
            }
            if (!baseEmpresa) {
                const puesto = (nomEl.textContent || '').trim();
                if (puesto && puesto.toUpperCase() !== 'JEFE') baseEmpresa = puesto;
            }
            if (!baseEmpresa) return;
            const elegida = sucursalesConocidas.find((s) => String(s.id) === String(activeSucursalId));
            if (elegida) {
                nomEl.textContent = baseEmpresa.toUpperCase() + ' · ' + elegida.nombre.toUpperCase();
            } else {
                nomEl.textContent = baseEmpresa.toUpperCase();
            }
        }
        window.actualizarNombreEmpresaTopbar = actualizarNombreEmpresaTopbar;
        actualizarNombreEmpresaTopbar();

        function aplicarSucursal(id) {
            activeSucursalId = id;
            try {
                if (id == null) localStorage.removeItem('crm_active_sucursal_id');
                else localStorage.setItem('crm_active_sucursal_id', String(id));
            } catch (_) {}
            const icono = $('topbarIcon');
            const elegida = sucursalesConocidas.find((s) => String(s.id) === String(id));
            if (icono) {
                icono.classList.toggle('activa', id != null);
                icono.setAttribute('aria-label', elegida ? elegida.nombre : 'Todas las sucursales');
            }
            actualizarNombreEmpresaTopbar();
            const grid = document.querySelector('.vitrina-grid');
            if (grid) grid.style.opacity = '0.5';

            if (window.CarteraLibro) {
                void window.CarteraLibro.sucursal(id);
            }
            const activeView = document.querySelector('.view.active');
            const vName = activeView ? activeView.id.replace('view-', '') : 'reporte';
            if (vName !== 'cartera') {
                cargarJefe(vName === 'dashboard' ? 'reporte' : vName);
            }
        }

        async function abrirSelectorSucursal() {
            try {
                const data = await fetch('/api/pos/sucursales').then((r) => r.json());
                if (data && Array.isArray(data.sucursales)) {
                    sucursalesConocidas = data.sucursales;
                    try { localStorage.setItem('crm_sucursales_cache', JSON.stringify(sucursalesConocidas)); } catch (_) {}
                    if (window.Espejo && Espejo.fijarSucursales) {
                        Espejo.fijarSucursales(sucursalesConocidas);
                    }
                    if (activeSucursalId != null && !sucursalesConocidas.some((s) => String(s.id) === String(activeSucursalId))) {
                        aplicarSucursal(null);
                    }
                }
            } catch (_) {}
            document.getElementById('sucursalSheet')?.remove();
            const actual = activeSucursalId == null ? '' : String(activeSucursalId);
            const opciones = [{ id: '', nombre: 'Todas' }].concat(
                sucursalesConocidas.map((s) => ({ id: String(s.id), nombre: s.nombre || ('Sucursal ' + s.id) }))
            );
            const fondo = document.createElement('div');
            fondo.id = 'sucursalSheet';
            fondo.className = 'pedido-sheet-back';
            fondo.innerHTML = `<div class="pedido-sheet" role="dialog" aria-label="Sucursales">
                <strong class="pedido-sheet-titulo">Sucursales</strong>
                ${opciones.map((op) => `<button type="button" class="pedido-opcion${op.id === actual ? ' active' : ''}" data-sucursal="${textoJefe(op.id)}">${textoJefe(op.nombre)}</button>`).join('')}
            </div>`;
            fondo.addEventListener('click', (ev) => {
                const opcion = ev.target.closest('[data-sucursal]');
                if (opcion) {
                    const valor = opcion.dataset.sucursal;
                    fondo.remove();
                    aplicarSucursal(valor ? parseInt(valor, 10) : null);
                    cargarSucursalesSelector();
                    return;
                }
                if (ev.target === fondo) fondo.remove();
            });
            document.body.appendChild(fondo);
        }

        async function cargarSucursalesSelector() {
            try {
                const res = await fetch('/api/pos/sucursales');
                const data = await res.json();
                const sucursales = data.sucursales || [];
                sucursalesConocidas = sucursales;
                try { localStorage.setItem('crm_sucursales_cache', JSON.stringify(sucursales)); } catch (_) {}
                if (window.Espejo && Espejo.fijarSucursales) {
                    Espejo.fijarSucursales(sucursalesConocidas);
                }
                if (activeSucursalId != null && !sucursales.some((s) => String(s.id) === String(activeSucursalId))) {
                    aplicarSucursal(null);
                }
                actualizarNombreEmpresaTopbar();
                const cont = $('sucursalPillsContainer');
                if (!cont) return;

                let html = `<button type="button" class="btn btn-sm ${activeSucursalId === null ? 'btn-primary' : 'btn-ghost'} sucursal-pill" data-sucursal="todas" style="border-radius:20px; font-size:12px; font-weight:700; padding:4px 14px;">Consolidado (Todas)</button>`;

                const vistas = new Set();
                sucursales.forEach(s => {
                    const idStr = String(s.id);
                    if (vistas.has(idStr)) return;
                    vistas.add(idStr);
                    const isAct = String(activeSucursalId) === idStr;
                    html += `<button type="button" class="btn btn-sm ${isAct ? 'btn-primary' : 'btn-ghost'} sucursal-pill" data-sucursal="${s.id}" style="border-radius:20px; font-size:12px; font-weight:700; padding:4px 14px;">📍 ${textoJefe(s.nombre)}</button>`;
                });
                cont.innerHTML = html;

                cont.querySelectorAll('.sucursal-pill').forEach(btn => {
                    btn.onclick = (ev) => {
                        ev.stopPropagation();
                        const val = btn.dataset.sucursal;
                        aplicarSucursal(val === 'todas' ? null : parseInt(val, 10));
                        cargarSucursalesSelector();
                    };
                });
            } catch (e) {
                console.error('Error cargando sucursales:', e);
            }
        }

        let jefeCargaToken = 0;
        let jefeVistaEnCurso = '';
        let pinturaCartera = 0;
        const panelesListos = new Map();

        function panelGuardadoVacio(dato) {
            const v = dato && dato.vitrina;
            if (!v || !v.tickets) return false;
            const cant = Number(v.tickets.cant || 0);
            const deuda = Number((v.deuda_clientes && v.deuda_clientes.valor) || 0);
            return cant === 0 && deuda === 0;
        }

        function claveJefe(panel) {
            let empresa = '';
            let usuario = '';
            try {
                empresa = (JSON.parse(localStorage.getItem('empresa_datos') || '{}').nombre) || '';
            } catch (e) {}
            try {
                usuario = (sessionUser && (sessionUser.username || sessionUser.usuario || sessionUser.nombre)) || '';
            } catch (e) {}
            const suc = activeSucursalId == null ? 'todas' : String(activeSucursalId);
            const per = (panel === 'reporte' && window.vitrinaPeriodo)
                ? (':' + window.vitrinaPeriodo + (window.vitrinaPeriodo === 'Período' ? (':' + (window.vitrinaDesde || '') + ':' + (window.vitrinaHasta || '')) : ''))
                : (panel === 'contabilidad'
                    ? (':' + periodoCaja + (periodoCaja === 'Período' ? (':' + periodoCajaDesde + ':' + periodoCajaHasta) : ''))
                    : (panel === 'desglose'
                        ? (':' + periodoDesglose + (periodoDesglose === 'Período' ? (':' + periodoDesgloseDesde + ':' + periodoDesgloseHasta) : ''))
                        : ''));
            const filtro = panel === 'ticket' ? (':' + claveFiltroVentas()) : '';
            return 'crm-jefe:' + usuario + ':' + empresa + ':' + panel + per + filtro + ':' + suc;
        }

        function pintarTarjetasCliente(deudores, cartera) {
            const cuerpo = $('adminCuerpo');
            if (!cuerpo) return;
            const marca = ++pinturaCartera;

            let headerDiv = null;
            if (cartera) {
                headerDiv = document.createElement('div');
                headerDiv.className = 'cartera-kpis-top';
                headerDiv.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-bottom:18px;';
                headerDiv.innerHTML = `
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 18px; border-left:4px solid #059669;">
                        <div style="font-size:11px; font-weight:700; color:#059669; text-transform:uppercase;">CARTERA EN LA CALLE</div>
                        <div style="font-size:22px; font-weight:800; color:#0f172a; margin-top:2px;">${plataJefe(cartera.total_deuda || cartera.cartera_en_la_calle || 0)}</div>
                        <div style="font-size:11px; color:#94a3b8; margin-top:2px;">${cartera.con_deuda || cartera.cuentas_activas || 0} cuentas activas · colocación total</div>
                    </div>
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 18px; border-left:4px solid #2563eb;">
                        <div style="font-size:11px; font-weight:700; color:#2563eb; text-transform:uppercase;">CUENTAS ACTIVAS</div>
                        <div style="font-size:22px; font-weight:800; color:#0f172a; margin-top:2px;">${cartera.con_deuda || cartera.cuentas_activas || 0}</div>
                        <div style="font-size:11px; color:#94a3b8; margin-top:2px;">de ${cartera.total_cuentas || deudores.length} clientes registrados</div>
                    </div>
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 18px; border-left:4px solid #dc2626;">
                        <div style="font-size:11px; font-weight:700; color:#dc2626; text-transform:uppercase;">CARTERA EN RIESGO</div>
                        <div style="font-size:22px; font-weight:800; color:#b91c1c; margin-top:2px;">${plataJefe(cartera.deuda_en_riesgo || cartera.cartera_en_riesgo || 0)}</div>
                        <div style="font-size:11px; color:#94a3b8; margin-top:2px;">${cartera.cuentas_en_riesgo || 0} en riesgo/mora · mayor: ${cartera.mayor_deudor || '—'}</div>
                    </div>
                    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 18px; border-left:4px solid #0d9488;">
                        <div style="font-size:11px; font-weight:700; color:#0d9488; text-transform:uppercase;">COBROS DEL MES</div>
                        <div style="font-size:22px; font-weight:800; color:#0f766e; margin-top:2px;">${plataJefe(cartera.cobros_mes || cartera.cobros_del_mes || 0)}</div>
                        <div style="font-size:11px; color:#94a3b8; margin-top:2px;">Abonado este mes</div>
                    </div>
                `;
            }

            const grid = document.createElement('div');
            grid.className = 'cards-grid';
            if (headerDiv) {
                cuerpo.replaceChildren(headerDiv, grid);
            } else {
                cuerpo.replaceChildren(grid);
            }
            let i = 0;
            const paso = 8;
            function lote() {
                if (marca !== pinturaCartera) return;
                const fin = Math.min(i + paso, deudores.length);
                for (; i < fin; i++) {
                    const wrap = document.createElement('div');
                    wrap.innerHTML = tarjetaClienteFiado(deudores[i]);
                    const card = wrap.firstElementChild;
                    if (!card) continue;
                    card.addEventListener('click', () => abrirHistorialFiado(card.dataset.posId));
                    grid.appendChild(card);
                }
                if (i < deudores.length) requestAnimationFrame(lote);
            }
            lote();
        }

        function fijarPeriodo(periodo, desde, hasta) {
            const nombre = periodo || 'Hoy';
            const ini = nombre === 'Período' ? (desde || hoyLocal()) : '';
            const fin = nombre === 'Período' ? (hasta || ini) : '';
            window.vitrinaPeriodo = nombre;
            window.vitrinaDesde = ini;
            window.vitrinaHasta = fin;
        }

        window.cambiarPeriodoCaja = function(periodo, desde, hasta) {
            periodoCaja = periodo || 'Hoy';
            periodoCajaDesde = periodoCaja === 'Período' ? (desde || periodoCajaDesde || hoyLocal()) : '';
            periodoCajaHasta = periodoCaja === 'Período' ? (hasta || periodoCajaHasta || periodoCajaDesde) : '';
            void cargarJefe('contabilidad');
        };

        window.cambiarPeriodoVitrina = function(periodo, desde, hasta) {
            fijarPeriodo(periodo, desde, hasta);
            const refresh = $('btnRefresh');
            if (refresh && refresh.classList.contains('es-filtro')) {
                refresh.classList.toggle('filtrando', window.vitrinaPeriodo !== 'Hoy');
            }
            cargarJefe('reporte');
        };

        function abrirFiltroPeriodo(opciones) {
            cerrarTicket();
            const actual = opciones.actual || 'Hoy';
            const modos = ['Hoy', 'Semana', 'Mes', 'Período'];
            const hoy = hoyLocal();
            const fondo = document.createElement('div');
            fondo.id = 'ticketSheet';
            fondo.className = 'pedido-sheet-back';
            fondo.innerHTML = `<div class="pedido-sheet filtro-venta" role="dialog" aria-label="Período">
                <strong class="pedido-sheet-titulo">Período</strong>
                <div class="filtro-periodos" role="group" aria-label="Período">
                    ${modos.map((nombre) => `<button type="button" class="filtro-periodo${nombre === actual ? ' active' : ''}" data-modo="${nombre}">${nombre}</button>`).join('')}
                </div>
                <div class="filtro-horas" id="filtroRango"${actual === 'Período' ? '' : ' hidden'}>
                    <label>Desde<input id="filtroDesdeDia" type="text" inputmode="numeric" placeholder="DD/MM/AAAA" maxlength="10" value="${textoJefe(fechaVisible(opciones.desde || hoy))}"></label>
                    <label>Hasta<input id="filtroHastaDia" type="text" inputmode="numeric" placeholder="DD/MM/AAAA" maxlength="10" value="${textoJefe(fechaVisible(opciones.hasta || hoy))}"></label>
                </div>
                <button type="button" class="pedido-cerrar" data-aplicar>Aplicar</button>
            </div>`;
            fondo.querySelectorAll('#filtroDesdeDia, #filtroHastaDia').forEach((input) => {
                input.addEventListener('input', () => escribirFechaAR(input));
            });
            fondo.addEventListener('click', (ev) => {
                const periodo = ev.target.closest('[data-modo]');
                if (periodo) {
                    fondo.querySelectorAll('[data-modo]').forEach((boton) => {
                        boton.classList.toggle('active', boton.dataset.modo === periodo.dataset.modo);
                    });
                    const rango = fondo.querySelector('#filtroRango');
                    if (rango) rango.hidden = periodo.dataset.modo !== 'Período';
                    return;
                }
                if (ev.target.closest('[data-aplicar]')) {
                    const elegido = fondo.querySelector('.filtro-periodo.active')?.dataset.modo || 'Hoy';
                    const desde = parseFechaAR(fondo.querySelector('#filtroDesdeDia')?.value) || hoy;
                    const hasta = parseFechaAR(fondo.querySelector('#filtroHastaDia')?.value) || desde;
                    cerrarTicket();
                    opciones.alAplicar(elegido, desde, hasta);
                    return;
                }
                if (ev.target === fondo) cerrarTicket();
            });
            document.body.appendChild(fondo);
        }

        function leerPanelJefe(clave) {
            try {
                return localStorage.getItem(clave) || sessionStorage.getItem(clave);
            } catch (e) {
                return null;
            }
        }

        function guardarPanelJefe(clave, dato) {
            const texto = JSON.stringify(dato);
            try { localStorage.setItem(clave, texto); } catch (e) {}
            try { sessionStorage.setItem(clave, texto); } catch (e) {}
        }

        function avisarDesacoplado() {
            window.__crmDesacoplado = true;
            document.querySelectorAll('.vitrina-banner span:last-child').forEach((nodo) => {
                nodo.textContent = 'Motor desacoplado / Operando 100% offline';
            });
        }

        function despertarNube() {
            const corte = new AbortController();
            const reloj = setTimeout(() => corte.abort(), 8000);
            try {
                fetch('/api/pos/sync/solicitar?sucursal_id=' + (activeSucursalId || 1), { method: 'POST' }).catch(() => {});
            } catch (e) {}
            return fetch('/health', { cache: 'no-store', signal: corte.signal })
                .finally(() => clearTimeout(reloj));
        }

        async function bajarNovedades() {
            if (!navigator.onLine) {
                avisarDesacoplado();
                return;
            }
            const desde = localStorage.getItem('crm-novedad') || '';
            const params = new URLSearchParams();
            params.set('desde', desde);
            params.set('last_sync', desde);
            if (sessionUser && sessionUser.empresa_id) params.set('tenant_id', String(sessionUser.empresa_id));
            if (activeSucursalId !== null && activeSucursalId !== undefined) {
                params.set('sucursal_id', String(activeSucursalId));
                params.set('branch_id', String(activeSucursalId));
            }
            const ping = despertarNube().catch(() => {});
            try {
                const res = await fetch('/api/pos/novedades?' + params.toString());
                if (!res.ok) throw new Error('novedades');
                const dato = await res.json();
                await ping;
                window.__crmDesacoplado = false;
                if (dato && dato.actualizado_en) localStorage.setItem('crm-novedad', dato.actualizado_en);
                if (window.Espejo) void Espejo.asegurar();
                try {
                    localStorage.setItem('crm-replica', JSON.stringify({
                        filas: dato && dato.cantidad ? dato.cantidad : 0,
                        ultimo: (dato && dato.actualizado_en) || ''
                    }));
                } catch (e) {}
                const vista = document.querySelector('.view.active');
                const nombre = vista && vista.id.startsWith('view-') ? vista.id.slice(5) : '';
                const aviso = document.querySelector('.vitrina-banner');
                const hayQueRedibujar = (dato && dato.cantidad) || (aviso && aviso.textContent.includes('Motor desacoplado'));
                if (hayQueRedibujar && ['reporte', 'digitales', 'contabilidad', 'pedidos', 'proveedor', 'promedio', 'ticket'].includes(nombre)) {
                    cargarJefe(nombre === 'ticket' && ventasPantalla === 'desglose' ? 'desglose' : nombre);
                }
            } catch (e) {
                avisarDesacoplado();
            }
        }

        let jefeAbort = null;

        async function cargarJefe(panel) {
            const clave = claveJefe(panel);
            if (jefeVistaEnCurso === clave) return;
            const token = ++jefeCargaToken;
            if (jefeAbort) jefeAbort.abort();
            const ctrl = new AbortController();
            jefeAbort = ctrl;
            jefeVistaEnCurso = clave;
            const periodoPedido = window.vitrinaPeriodo;
            const desdePedido = window.vitrinaDesde;
            const hastaPedido = window.vitrinaHasta;
            const listo = panelesListos.get(clave);
            let habiaLocal = false;
            try {
                if (listo && !panelGuardadoVacio(listo.dato)) {
                    habiaLocal = true;
                    aplicarDatosJefe(panel, listo.dato, false);
                } else {
                    const crudo = leerPanelJefe(clave);
                    if (crudo) {
                        const guardado = JSON.parse(crudo);
                        if (!panelGuardadoVacio(guardado)) {
                            habiaLocal = true;
                            aplicarDatosJefe(panel, guardado, true);
                        }
                    }
                }
            } catch (e) {}
            window.vitrinaPeriodo = periodoPedido;
            window.vitrinaDesde = desdePedido;
            window.vitrinaHasta = hastaPedido;

            // 1. Consulta al Espejo local de base de datos primero (0ms, sin peticiones bloqueantes a la nube)
            let datoEspejo = null;
            if (window.Espejo && Espejo.tieneDatos && Espejo.tieneDatos()) {
                try {
                    if (panel === 'reporte' || panel === 'jefe') {
                        datoEspejo = Espejo.resumenJefe(window.vitrinaPeriodo, window.vitrinaDesde, window.vitrinaHasta, activeSucursalId);
                    } else if (panel === 'ticket') {
                        const rango = Espejo.rangoVentas(filtroVentas);
                        const lista = Espejo.listar(null, rango[0], rango[1], activeSucursalId, filtroVentas);
                        datoEspejo = {
                            ok: true, libro: true, panel: 'ticket',
                            filtrado: lista.total, tickets_ok: lista.cant,
                            tickets: lista.tickets, recorte: lista.recorte,
                            hay_mas: lista.hay_mas,
                            resumen: {
                                ventas: lista.total, tickets: lista.cant,
                                promedio: lista.cant ? Math.round(lista.total / lista.cant * 100) / 100 : 0,
                                dia: rango[0] && rango[1] ? (rango[0] === rango[1] ? rango[0] : (rango[0] + ' → ' + rango[1])) : ''
                            }
                        };
                    } else if (panel === 'desglose') {
                        const rango = Espejo.rangoVentas(filtroVentas);
                        const art = Espejo.desglose(rango[0], rango[1], activeSucursalId);
                        if (art) {
                            datoEspejo = {
                                ok: true, libro: true, panel: 'desglose',
                                desglose: Object.assign({}, art, { etiqueta: etiquetaPeriodoVentas() }),
                                resumen: { ventas: art.monto, tickets: art.tickets }
                            };
                        }
                    } else if (panel === 'contabilidad') {
                        datoEspejo = Espejo.contabilidad(periodoCaja || 'Hoy', periodoCajaDesde, periodoCajaHasta, activeSucursalId);
                    } else if (panel === 'cartera' || panel === 'admin') {
                        datoEspejo = Espejo.cartera(activeSucursalId);
                    }
                } catch (errEspejo) {
                    console.warn('[PWA] Error consultando espejo local:', errEspejo);
                }
            }

            if (datoEspejo && datoEspejo.libro) {
                habiaLocal = true;
                aplicarDatosJefe(panel, datoEspejo, false);
                marcarRed(true, "Espejo local · " + textoSync(Espejo.sello()));
                if (window.EspejoEngine && EspejoEngine.syncDelta) {
                    void EspejoEngine.syncDelta();
                }
                if (!navigator.onLine) {
                    if (jefeVistaEnCurso === clave) jefeVistaEnCurso = '';
                    return;
                }
            }

            if (window.Nodo && ['reporte', 'contabilidad', 'ticket', 'desglose', 'cartera', 'admin'].includes(panel)) {
                const pieza = piezaNodo(panel);
                const consulta = consultaNodo(panel);
                const previo = Nodo.tomar(pieza, consulta);
                if (previo && !panelGuardadoVacio(previo)) {
                    habiaLocal = true;
                    aplicarDatosJefe(panel, previo, false);
                }
                Nodo.encargar(pieza, consulta).then((dato) => {
                    if (dato && !panelGuardadoVacio(dato)) {
                        aplicarDatosJefe(panel, dato, false);
                    }
                }).catch(() => {});
                if (jefeVistaEnCurso === clave) jefeVistaEnCurso = '';
                return;
            }
            if (!navigator.onLine) {
                marcarRed(false);
                if (!habiaLocal) aplicarDatosJefe(panel, { libro: false }, false);
                return;
            }
            let dato = null;
            try {
                let url = '/api/pos/jefe?panel=' + encodeURIComponent(panel);
                if (panel === 'reporte' && window.vitrinaPeriodo) {
                    url += '&periodo=' + encodeURIComponent(window.vitrinaPeriodo);
                    if (window.vitrinaPeriodo === 'Período' && window.vitrinaDesde) {
                        url += '&desde=' + encodeURIComponent(window.vitrinaDesde);
                    }
                    if (window.vitrinaPeriodo === 'Período' && window.vitrinaHasta) {
                        url += '&hasta=' + encodeURIComponent(window.vitrinaHasta);
                    }
                }
                if (panel === 'contabilidad') {
                    url += '&periodo=' + encodeURIComponent(periodoCaja || 'Hoy');
                    if (periodoCaja === 'Período' && periodoCajaDesde) url += '&desde=' + encodeURIComponent(periodoCajaDesde);
                    if (periodoCaja === 'Período' && periodoCajaHasta) url += '&hasta=' + encodeURIComponent(periodoCajaHasta);
                }
                if (panel === 'ticket') url += queryFiltroVentas();
                if (panel === 'desglose') url += queryFiltroVentas();
                if (activeSucursalId !== null && activeSucursalId !== undefined) {
                    url += '&sucursal_id=' + encodeURIComponent(activeSucursalId);
                }
                const res = await fetch(url, { signal: ctrl.signal });
                if (!res.ok) throw new Error('panel');
                dato = await res.json();
            } catch (e) {
                if (e && e.name === 'AbortError') return;
                dato = null;
            }
            if (jefeVistaEnCurso === clave) jefeVistaEnCurso = '';
            if (token !== jefeCargaToken) return;
            if (!dato) {
                marcarRed(false);
                if (!habiaLocal) aplicarDatosJefe(panel, { libro: false }, false);
                return;
            }
            const syncTxt = (dato.vitrina && dato.vitrina.actualizado_en_texto) || textoSync(dato.actualizado_en);
            marcarRed(true, syncTxt);
            const mismoLibro = listo && dato.actualizado_en && dato.actualizado_en === listo.marca;
            panelesListos.set(clave, { marca: dato.actualizado_en || '', dato: dato });
            guardarPanelJefe(clave, dato);
            if (mismoLibro) return;
            aplicarDatosJefe(panel, dato, false);
        }

        function claseDigital(estado) {
            const texto = String(estado || '');
            if (texto === 'OK' || texto === 'FIRMADO' || texto === 'COBRADO') return 'dig-ok';
            if (texto.includes('SIN TICKET')) return 'dig-sin-ticket';
            if (texto === 'SIN ID' || texto === 'EN TICKET' || texto.includes('SIN FIRMAR')) return 'dig-sin-id';
            return '';
        }

        function badgeDigital(estado) {
            const texto = String(estado || '');
            const clase = claseDigital(texto);
            let fondo = '#e2e8f0';
            let tinta = '#334155';
            if (clase === 'dig-ok') { fondo = '#dcfce7'; tinta = '#15803d'; }
            else if (clase === 'dig-sin-ticket') { fondo = '#ffedd5'; tinta = '#c2410c'; }
            else if (clase === 'dig-sin-id') { fondo = '#fee2e2'; tinta = '#b91c1c'; }
            else if (texto.includes('CANCEL')) { fondo = '#f1f5f9'; tinta = '#64748b'; }
            return `<span class="dig-estado" style="background:${fondo};color:${tinta};">${textoJefe(texto || '—')}</span>`;
        }

        function fechaEnPeriodoDigital(fecha) {
            const dia = String(fecha || '').slice(0, 10);
            if (!dia) return false;
            const hoy = hoyLocal();
            if (periodoDigital === 'Hoy') return dia === hoy;
            if (periodoDigital === 'Semana') {
                const base = new Date(hoy + 'T12:00:00');
                const lunes = new Date(base);
                lunes.setDate(base.getDate() - ((base.getDay() + 6) % 7));
                const mes = String(lunes.getMonth() + 1).padStart(2, '0');
                const numero = String(lunes.getDate()).padStart(2, '0');
                return dia >= (lunes.getFullYear() + '-' + mes + '-' + numero) && dia <= hoy;
            }
            if (periodoDigital === 'Mes') return dia.slice(0, 7) === hoy.slice(0, 7);
            if (periodoDigital === 'Período') {
                const desde = periodoDigitalDesde || hoy;
                const hasta = periodoDigitalHasta || desde;
                return dia >= (desde < hasta ? desde : hasta) && dia <= (desde < hasta ? hasta : desde);
            }
            return true;
        }

        function abrirLibroLocal() {
            return new Promise((resolve, reject) => {
                const pedido = indexedDB.open('crm-digital', 1);
                pedido.onupgradeneeded = () => {
                    const base = pedido.result;
                    if (!base.objectStoreNames.contains('libro')) base.createObjectStore('libro');
                };
                pedido.onsuccess = () => resolve(pedido.result);
                pedido.onerror = () => reject(pedido.error);
            });
        }

        async function leerLibroLocal(clave) {
            try {
                const base = await abrirLibroLocal();
                return await new Promise((resolve) => {
                    const tx = base.transaction('libro', 'readonly');
                    const pedido = tx.objectStore('libro').get(clave);
                    pedido.onsuccess = () => resolve(pedido.result || null);
                    pedido.onerror = () => resolve(null);
                });
            } catch (e) {
                return null;
            }
        }

        async function guardarLibroLocal(clave, libro) {
            try {
                const base = await abrirLibroLocal();
                await new Promise((resolve) => {
                    const tx = base.transaction('libro', 'readwrite');
                    tx.objectStore('libro').put(libro, clave);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => resolve();
                });
            } catch (e) {}
        }

        let visiblesDigital = [];

        function pintarLibroDigital() {
            const cuerpo = $('contaCuerpo');
            const dig = libroDigital || {};
            if (!cuerpo) return;
            const txs = ((dig.transacciones) || []).filter((t) => fechaEnPeriodoDigital(t.fecha));
            visiblesDigital = txs;
            const corta = (n) => {
                const x = Number(n);
                if (!Number.isFinite(x)) return '—';
                const abs = Math.abs(x);
                const signo = x < 0 ? '-' : '';
                if (abs >= 1000000) return signo + '$' + (abs / 1000000).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + 'M';
                if (abs >= 1000) return signo + '$' + Math.round(abs).toLocaleString('es-AR');
                return plataJefe(x);
            };
            let bruto = 0;
            let tickets = 0;
            let cliente = 0;
            let sinTicket = 0;
            txs.forEach((t) => {
                const monto = Number(t.monto) || 0;
                bruto += monto;
                if (t.origen === 'abono') cliente += monto;
                else if (t.estado === 'SIN TICKET') sinTicket += monto;
                else tickets += monto;
            });
            const cards = [
                ['Bruto', corta(bruto), 'cobros'],
                ['Tickets', corta(tickets), 'ventas'],
                ['Cliente', corta(cliente), 'abonos'],
                ['Sin ticket', corta(sinTicket), 'sin venta']
            ];
            const filas = txs.length
                ? txs.map((t, i) => {
                    const fecha = (t.fecha || '').replace('T', ' ').slice(0, 16) || '—';
                    return `<button type="button" class="dig-fila ${claseDigital(t.estado)}" data-dig="${i}">
                        <b>${textoJefe(t.concepto || t.cuenta || 'Cobro')}</b>
                        <strong>${plataJefe(t.monto)}</strong>
                        <span>${textoJefe(fecha)}</span>
                        ${badgeDigital(t.estado)}
                    </button>`;
                }).join('')
                : '<p class="dig-vacio">Sin cobros digitales en este período.</p>';
            const nota = dig.fuente === 'libro'
                ? 'El libro queda en el aparato. El ticket y el id digital no se repiten.'
                : (txs.length ? 'Estos tickets todavía no tienen id digital.' : 'Todavía no hay cobros digitales en la nube.');
            cuerpo.innerHTML = `<div class="pago-digital">
                <div class="dig-numeros">${cards.map(([titulo, valor, pie]) => `<div><small>${titulo}</small><b>${valor}</b><span>${pie}</span></div>`).join('')}</div>
                <div class="dig-lista">${filas}</div>
                <p class="dig-nota">${nota}</p>
            </div>`;
            cuerpo.querySelectorAll('[data-dig]').forEach((boton) => {
                boton.addEventListener('click', () => abrirCobroDigital(Number(boton.dataset.dig)));
            });
        }

        function abrirCobroDigital(indice) {
            const t = visiblesDigital[indice];
            if (!t) return;
            cerrarTicket();
            const fecha = (t.fecha || '').replace('T', ' ').slice(0, 16) || '—';
            const datos = [
                ['Fecha', fecha],
                ['ID de pago', t.id_pago || '—'],
                ['Cuenta', t.cuenta || '—'],
                ['Concepto', t.concepto || '—'],
                ['Monto', plataJefe(t.monto)],
                ['Estado', t.estado || '—'],
                ['Ticket', t.ticket_venta || '—'],
                ['Cobro', t.ticket_cobro || '—']
            ];
            const fondo = document.createElement('div');
            fondo.id = 'ticketSheet';
            fondo.className = 'pedido-sheet-back';
            fondo.innerHTML = `<div class="pedido-sheet" role="dialog" aria-label="Cobro digital">
                <strong class="pedido-sheet-titulo">${textoJefe(t.concepto || 'Cobro')}</strong>
                ${datos.map(([nombre, valor]) => `<div class="pedido-dato"><span>${nombre}</span><b>${textoJefe(valor)}</b></div>`).join('')}
                <button type="button" class="pedido-cerrar" data-cerrar>Cerrar</button>
            </div>`;
            fondo.addEventListener('click', (ev) => {
                if (ev.target === fondo || ev.target.closest('[data-cerrar]')) cerrarTicket();
            });
            document.body.appendChild(fondo);
        }

        let digitalCarga = 0;
        let libroEnCurso = false;

        function isoDia(fecha) {
            const d = fecha instanceof Date ? fecha : new Date(fecha);
            const mes = String(d.getMonth() + 1).padStart(2, '0');
            const dia = String(d.getDate()).padStart(2, '0');
            return d.getFullYear() + '-' + mes + '-' + dia;
        }

        function sumarDias(iso, cantidad) {
            const d = new Date(iso + 'T12:00:00');
            d.setDate(d.getDate() + cantidad);
            return isoDia(d);
        }

        function lunesDe(iso) {
            const d = new Date(iso + 'T12:00:00');
            d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
            return isoDia(d);
        }

        function claveFilaDigital(fila) {
            const pago = String(fila.id_pago || '').replace(/—/g, '').trim();
            if (pago) return 'p:' + pago;
            const ticket = String(fila.ticket_venta || '').replace(/—/g, '').trim();
            if (ticket && fila.origen !== 'cobro') return 't:' + (fila.sucursal || '') + ':' + ticket;
            return 'f:' + [fila.sucursal || '', fila.origen || '', fila.id || '', fila.fecha || '', fila.monto || ''].join(':');
        }

        function mezclarDigital(base, nuevas) {
            const mapa = new Map();
            (base || []).forEach((fila) => mapa.set(claveFilaDigital(fila), fila));
            (nuevas || []).forEach((fila) => mapa.set(claveFilaDigital(fila), fila));
            return [...mapa.values()].sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
        }

        function leerDigitalRapido(clave) {
            try {
                const texto = localStorage.getItem('crm-digital:' + clave);
                return texto ? JSON.parse(texto) : null;
            } catch (e) {
                return null;
            }
        }

        function guardarDigitalRapido(clave, libro) {
            try {
                localStorage.setItem('crm-digital:' + clave, JSON.stringify(libro));
            } catch (e) {}
        }

        async function pedirDigitalRango(desde, hasta) {
            let url = '/api/pos/jefe?panel=digitales&periodo=' + encodeURIComponent('Período')
                + '&desde=' + encodeURIComponent(desde)
                + '&hasta=' + encodeURIComponent(hasta);
            if (activeSucursalId !== null && activeSucursalId !== undefined) {
                url += '&sucursal_id=' + encodeURIComponent(activeSucursalId);
            }
            const res = await fetch(url);
            if (!res.ok) throw new Error('digital');
            const dato = await res.json();
            return {
                filas: (dato.digitales && dato.digitales.transacciones) || [],
                fuente: (dato.digitales && dato.digitales.fuente) || 'vacio'
            };
        }

        async function guardarLibroDigital(libro) {
            libro.clave = claveJefe('digitales');
            libroDigital = libro;
            guardarDigitalRapido(libro.clave, libro);
            await guardarLibroLocal(libro.clave, libro);
        }

        function pintarSiDigital() {
            if (cajaPantalla !== 'digital') return;
            pintarLibroDigital();
            document.querySelectorAll('#herramientasLista .herramienta-btn').forEach((boton) => {
                boton.classList.toggle('active', boton.textContent.trim() === 'Pago digital');
            });
        }

        async function asegurarSemana() {
            const clave = claveJefe('digitales');
            const hoy = hoyLocal();
            const desdeSemana = lunesDe(hoy);
            const semana = await pedirDigitalRango(desdeSemana, hoy);
            const previas = (libroDigital && libroDigital.clave === clave && libroDigital.transacciones) || [];
            const fechas = previas.map((fila) => String(fila.fecha || '').slice(0, 10)).filter((dia) => /^\d{4}-\d{2}-\d{2}$/.test(dia)).sort();
            const cubierto = libroDigital && libroDigital.cubiertoDesde;
            const piso = fechas.length ? fechas[0] : desdeSemana;
            await guardarLibroDigital({
                clave: clave,
                fuente: semana.fuente || (libroDigital && libroDigital.fuente) || 'ticket',
                transacciones: mezclarDigital(previas, semana.filas),
                cubiertoDesde: [cubierto, piso, desdeSemana].filter(Boolean).sort()[0],
                completo: !!(libroDigital && libroDigital.completo)
            });
        }

        async function completarLibro() {
            if (libroEnCurso) return;
            libroEnCurso = true;
            try {
                const clave = claveJefe('digitales');
                if (!libroDigital || libroDigital.clave !== clave || !libroDigital.cubiertoDesde) {
                    await asegurarSemana();
                }
                let libro = libroDigital;
                if (!libro || libro.completo) return;
                let cursor = libro.cubiertoDesde;
                let vacios = 0;
                for (let i = 0; i < 160 && vacios < 8; i++) {
                    const hasta = sumarDias(cursor, -1);
                    const desde = sumarDias(hasta, -6);
                    let tanda = { filas: [], fuente: libro.fuente };
                    try {
                        tanda = await pedirDigitalRango(desde, hasta);
                    } catch (e) {
                        break;
                    }
                    const antes = (libro.transacciones || []).length;
                    const transacciones = mezclarDigital(libro.transacciones, tanda.filas);
                    if (!tanda.filas.length) vacios += 1;
                    else vacios = 0;
                    libro = {
                        clave: clave,
                        fuente: tanda.fuente || libro.fuente,
                        transacciones: transacciones,
                        cubiertoDesde: desde,
                        completo: vacios >= 8
                    };
                    await guardarLibroDigital(libro);
                    cursor = desde;
                    if (tanda.filas.some((fila) => fechaEnPeriodoDigital(fila.fecha))) pintarSiDigital();
                    if (libro.completo) break;
                    await new Promise((resolver) => setTimeout(resolver, 500));
                }
            } finally {
                libroEnCurso = false;
            }
        }

        function clavePeriodo(panel, periodo) {
            const reporte = window.vitrinaPeriodo;
            const desde = window.vitrinaDesde;
            const hasta = window.vitrinaHasta;
            const caja = periodoCaja;
            const cajaDesde = periodoCajaDesde;
            const cajaHasta = periodoCajaHasta;
            const des = periodoDesglose;
            const desDesde = periodoDesgloseDesde;
            const desHasta = periodoDesgloseHasta;
            if (panel === 'reporte') {
                window.vitrinaPeriodo = periodo;
                window.vitrinaDesde = '';
                window.vitrinaHasta = '';
            }
            if (panel === 'contabilidad') {
                periodoCaja = periodo;
                periodoCajaDesde = '';
                periodoCajaHasta = '';
            }
            if (panel === 'desglose') {
                periodoDesglose = periodo;
                periodoDesgloseDesde = '';
                periodoDesgloseHasta = '';
            }
            const clave = claveJefe(panel);
            window.vitrinaPeriodo = reporte;
            window.vitrinaDesde = desde;
            window.vitrinaHasta = hasta;
            periodoCaja = caja;
            periodoCajaDesde = cajaDesde;
            periodoCajaHasta = cajaHasta;
            periodoDesglose = des;
            periodoDesgloseDesde = desDesde;
            periodoDesgloseHasta = desHasta;
            return clave;
        }

        let desgloseCaliente = false;

        async function precalentarDesglose() {
            if (desgloseCaliente) return;
            desgloseCaliente = true;
            for (const periodo of ['Semana', 'Mes', 'Año']) {
                const clave = clavePeriodo('desglose', periodo);
                if (leerPanelJefe(clave)) continue;
                try {
                    let url = '/api/pos/jefe?panel=desglose&periodo=' + encodeURIComponent(periodo);
                    if (activeSucursalId !== null && activeSucursalId !== undefined) {
                        url += '&sucursal_id=' + encodeURIComponent(activeSucursalId);
                    }
                    const res = await fetch(url);
                    if (!res.ok) continue;
                    guardarPanelJefe(clave, await res.json());
                } catch (e) {}
                await new Promise((resolver) => setTimeout(resolver, 400));
            }
        }

        async function precalentarFiltros() {
            const pedidos = [
                ['reporte', 'Semana'],
                ['contabilidad', 'Semana'],
                ['reporte', 'Mes'],
                ['contabilidad', 'Mes'],
                ['reporte', 'Año'],
                ['contabilidad', 'Año']
            ];
            for (const [panel, periodo] of pedidos) {
                const clave = clavePeriodo(panel, periodo);
                const guardado = leerPanelJefe(clave);
                if (guardado) {
                    try {
                        if (!panelGuardadoVacio(JSON.parse(guardado))) continue;
                    } catch (e) {
                        continue;
                    }
                }
                try {
                    let url = '/api/pos/jefe?panel=' + encodeURIComponent(panel) + '&periodo=' + encodeURIComponent(periodo);
                    if (activeSucursalId !== null && activeSucursalId !== undefined) {
                        url += '&sucursal_id=' + encodeURIComponent(activeSucursalId);
                    }
                    const res = await fetch(url);
                    if (!res.ok) continue;
                    guardarPanelJefe(clave, await res.json());
                } catch (e) {}
                await new Promise((resolver) => setTimeout(resolver, 400));
            }
        }

        function arrancarLibroOffline() {
            if (window.Espejo && Espejo.tieneDatos && Espejo.tieneDatos()) {
                return; // Con Espejo activo en memoria e IndexedDB, no saturar la red con bloques históricos
            }
            void completarLibro();
            void precalentarFiltros();
        }

        async function cargarPagoDigital() {
            const token = ++digitalCarga;
            const clave = claveJefe('digitales');
            const cuerpo = $('contaCuerpo');
            if (!libroDigital || libroDigital.clave !== clave) {
                const rapido = leerDigitalRapido(clave);
                if (rapido && rapido.transacciones) libroDigital = rapido;
            }
            if (libroDigital && libroDigital.clave === clave && cajaPantalla === 'digital') pintarLibroDigital();
            if (!libroDigital || libroDigital.clave !== clave || ((libroDigital.transacciones || []).length < ((await leerLibroLocal(clave)) || {}).transacciones?.length)) {
                const guardado = await leerLibroLocal(clave);
                if (token !== digitalCarga) return;
                if (guardado && guardado.transacciones && (!libroDigital || guardado.transacciones.length >= (libroDigital.transacciones || []).length)) {
                    libroDigital = guardado;
                    if (cajaPantalla === 'digital') pintarLibroDigital();
                }
            }
            if (cuerpo && cajaPantalla === 'digital' && (!libroDigital || libroDigital.clave !== clave) && !cuerpo.querySelector('.dig-lista')) {
                cuerpo.innerHTML = '<p>Cargando cobros digitales…</p>';
            }
            try {
                await asegurarSemana();
            } catch (e) {
                if (!libroDigital || libroDigital.clave !== clave) {
                    libroDigital = { clave: clave, fuente: 'vacio', transacciones: [], cubiertoDesde: lunesDe(hoyLocal()), completo: false };
                }
            }
            if (token !== digitalCarga) return;
            pintarSiDigital();
            void completarLibro();
        }

        function recargarVistaViva() {
            const activa = document.querySelector('.view.active');
            const name = activa ? activa.id.replace('view-', '') : '';
            if (name === 'cartera' && window.CarteraLibro) {
                void window.CarteraLibro.actualizar();
                return;
            }
            if (name === 'contabilidad' && cajaPantalla === 'digital') {
                void cargarPagoDigital();
                return;
            }
            if (name === 'ticket' && ventasPantalla === 'desglose') {
                void cargarJefe('desglose');
                return;
            }
            if (['reporte', 'digitales', 'contabilidad', 'pedidos', 'proveedor', 'promedio', 'ticket'].includes(name)) {
                void cargarJefe(name);
            }
        }

        function espejoTieneFilas(libro) {
            return !!(libro && (libro.sucursales || []).some((suc) => (suc.filas || []).length));
        }

        function piezaNodo(panel) {
            if (panel === 'admin' || panel === 'cartera') return 'cartera';
            if (panel === 'caja') return 'contabilidad';
            return panel;
        }

        function consultaNodo(panel) {
            let q = '';
            if (panel === 'reporte') {
                const periodo = window.vitrinaPeriodo || 'Hoy';
                q = 'periodo=' + encodeURIComponent(periodo);
                if (periodo === 'Período' && window.vitrinaDesde) q += '&desde=' + encodeURIComponent(window.vitrinaDesde);
                if (periodo === 'Período' && window.vitrinaHasta) q += '&hasta=' + encodeURIComponent(window.vitrinaHasta);
            } else if (panel === 'contabilidad') {
                q = 'periodo=' + encodeURIComponent(periodoCaja || 'Hoy');
                if (periodoCaja === 'Período' && periodoCajaDesde) q += '&desde=' + encodeURIComponent(periodoCajaDesde);
                if (periodoCaja === 'Período' && periodoCajaHasta) q += '&hasta=' + encodeURIComponent(periodoCajaHasta);
            } else if (panel === 'ticket' || panel === 'desglose') {
                q = queryFiltroVentas().replace(/^&/, '');
            }
            if (activeSucursalId !== null && activeSucursalId !== undefined) {
                q += (q ? '&' : '') + 'sucursal_id=' + encodeURIComponent(activeSucursalId);
            }
            return q;
        }

        function cruzarConEspejo(panel, dato) {
            dato = dato || {};
            if (dato.nodo) return dato;
            const libro = window.Espejo && Espejo.ventas ? Espejo.ventas() : null;
            if (!espejoTieneFilas(libro)) return dato;
            const serverMasNuevo = !!(libro.sello && dato.actualizado_en && libro.sello < dato.actualizado_en);
            if (panel === 'reporte' || panel === 'jefe') {
                if (serverMasNuevo && dato.vitrina && dato.vitrina.tickets && Number(dato.vitrina.tickets.cant) > 0) return dato;
                const rango = Espejo.rangoPeriodo(window.vitrinaPeriodo, window.vitrinaDesde, window.vitrinaHasta);
                const suma = Espejo.sumar(libro, rango[0], rango[1], activeSucursalId);
                if (!suma.cant && dato.vitrina && dato.vitrina.tickets && Number(dato.vitrina.tickets.cant) > 0) return dato;
                if (!dato.vitrina) dato.vitrina = {};
                dato.vitrina.tickets = Object.assign({}, dato.vitrina.tickets || {}, {
                    cant: suma.cant,
                    total: suma.total,
                    texto: suma.cant + ' · ' + plataJefe(suma.total)
                });
                if (dato.resumen) {
                    dato.resumen.ventas = suma.total;
                    dato.resumen.tickets = suma.cant;
                    dato.resumen.promedio = suma.cant ? Math.round((suma.total / suma.cant) * 100) / 100 : 0;
                }
                dato.libro = true;
            }
            const filtroEstrecho = filtroVentas.q || filtroVentas.franja || filtroVentas.caja || (filtroVentas.pago && filtroVentas.pago !== 'TODOS');
            if ((panel === 'ticket' || panel === 'desglose') && !filtroEstrecho) {
                const rango = Espejo.rangoVentas(filtroVentas);
                if (panel === 'desglose' && Espejo.desglose) {
                    const art = Espejo.desglose(rango[0], rango[1], activeSucursalId);
                    const serverTiene = dato.desglose && (dato.desglose.filas || []).length;
                    if (art && (art.filas.length || !serverTiene)) {
                        dato.desglose = Object.assign({}, art, { etiqueta: dato.desglose && dato.desglose.etiqueta ? dato.desglose.etiqueta : etiquetaPeriodoVentas() });
                        dato.libro = true;
                    }
                }
                if (panel === 'ticket') {
                    const lista = Espejo.listar(libro, rango[0], rango[1], activeSucursalId, filtroVentas);
                    const serverTiene = (dato.tickets || []).length > 0;
                    if (serverMasNuevo && serverTiene) return dato;
                    if (!lista.cant && serverTiene) return dato;
                    dato.filtrado = lista.total;
                    dato.tickets_ok = lista.cant;
                    dato.tickets = lista.tickets;
                    dato.recorte = lista.recorte;
                    dato.hay_mas = lista.hay_mas;
                    dato.libro = true;
                    if (dato.resumen) {
                        dato.resumen.ventas = lista.total;
                        dato.resumen.tickets = lista.cant;
                        dato.resumen.promedio = lista.cant ? Math.round((lista.total / lista.cant) * 100) / 100 : 0;
                        if (rango[0] && rango[1]) dato.resumen.dia = rango[0] === rango[1] ? rango[0] : (rango[0] + ' → ' + rango[1]);
                    }
                }
            }
            return dato;
        }

        function pintarDesdeEspejo() {
            const activa = document.querySelector('.view.active');
            const name = activa ? activa.id.replace('view-', '') : '';
            if (name === 'cartera' && window.CarteraLibro) {
                if (window.Espejo && Espejo.cartera) {
                    const carteraEspejo = Espejo.cartera(activeSucursalId);
                    if (carteraEspejo && carteraEspejo.cartera && carteraEspejo.cartera.clientes && carteraEspejo.cartera.clientes.length) {
                        CarteraLibro.recibir(carteraEspejo);
                    }
                }
                return;
            }
            const panel = name === 'ticket' && ventasPantalla === 'desglose' ? 'desglose' : name;
            if (!panel) return;
            cargarJefe(panel);
        }

        function aplicarDatosJefe(panel, dato, enCurso) {
            dato = cruzarConEspejo(panel, dato);
            const grid = document.querySelector('.vitrina-grid');
            if (grid) grid.style.opacity = '1';
            const resumen = dato.resumen || {};
            const aviso = dato.libro
                ? ''
                : 'El libro de Cobro Fácil todavía no llegó a la nube para esta sucursal. Cuando termine el envío, este número sale de ahí.';

            // 1. CONTABILIDAD & CAJA
            if (panel === 'contabilidad' && $('contaCuerpo')) {
                if (cajaPantalla === 'digital') return;
                const c = dato.contabilidad || {};
                if ($('contaDia')) $('contaDia').textContent = resumen.dia ? ('Libro · ' + resumen.dia) : 'Espejo de la caja';
                if (!dato.libro) {
                    $('contaCuerpo').innerHTML = `<p style="margin:0; color:#64748b;">${aviso}</p>`;
                } else {
                    const medios = c.medios_pago || [];
                    const sumaMedios = medios.reduce((acc, m) => acc + (Number(m.monto != null ? m.monto : m.total) || 0), 0);
                    const totalMedios = sumaMedios || 1;
                    pintarChipPeriodo('cajaPeriodo', periodoCaja || 'Hoy');
                    const periodoCajaTxt = c.etiqueta ? `<p class="caja-periodo">${textoJefe(c.etiqueta)}</p>` : '';
                    let html = `${periodoCajaTxt}<div data-pantalla="arqueo" class="arqueo-lista">`;
                    if (medios.length === 0) {
                        html += `<p class="caja-vacio" style="padding:14px;">${(c.etiqueta && !String(c.etiqueta).startsWith('Hoy')) ? 'Sin movimientos de pago en este período.' : 'Sin movimientos de pago ese día.'}</p>`;
                    } else {
                        const montos = medios.map((m) => Number(m.monto != null ? m.monto : m.total) || 0);
                        const partes = porcentajesQueCierran(montos);
                        medios.forEach((m, i) => {
                            const cant = Number(m.tickets) || 0;
                            const tickets = cant + (cant === 1 ? ' ticket' : ' tickets');
                            const monto = montos[i];
                            html += `<div class="arqueo-fila"><b>${textoJefe(m.medio)}</b><span>${textoJefe(tickets)}</span><span><b>${plataJefe(monto)}</b><small class="arqueo-pct">${partes[i]}%</small></span></div>`;
                        });
                    }
                    html += `<div class="arqueo-pie"><span>Total</span><b>${plataJefe(sumaMedios)}</b></div></div>`;

                    $('contaCuerpo').innerHTML = html;
                }
                document.querySelectorAll('#herramientasLista .herramienta-btn').forEach((boton) => {
                    boton.classList.toggle('active', boton.textContent.trim() === 'Arqueo por medio de pago');
                });
            }

            // 2. JEFE / REPORTE & VITRINA
            if (panel === 'reporte' && $('reporteCuerpo')) {
                const v = dato.vitrina || null;
                if (!window.vitrinaPeriodo) window.vitrinaPeriodo = 'Hoy';
                const perActual = window.vitrinaPeriodo;

                pintarChipPeriodo('reporteDia', perActual);
                if (v && v.actualizado_en_texto) marcarRed(redCrm.enLinea, v.actualizado_en_texto);

                if (!dato.libro && !v) {
                    $('reporteCuerpo').innerHTML = `<p style="margin:0; color:#64748b;">${aviso}</p>`;
                } else {
                    let html = '';

                    if (v) {
                        html += `
                        <div class="vitrina-wrap">
                            <div class="vitrina-banner">
                                <span>⚠️</span>
                                <span>${textoBannerRed(v && v.actualizado_en_texto, v && (v.progreso_carga || (v.carga && v.carga.progreso_texto)))}</span>
                            </div>

                            <div class="vitrina-grid">
                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.tickets?.titulo || 'Tickets'}</span>
                                    </div>
                                    <div class="vitrina-card-val">${v.tickets?.texto || '0'}</div>
                                    <div class="vitrina-card-sub">Operaciones registradas</div>
                                </div>

                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.ganancia_parcial?.titulo || 'Ganancia parcial'}</span>
                                    </div>
                                    <div class="vitrina-card-val ${(!v.ganancia_parcial || v.ganancia_parcial.valor === null) ? 'val-muted' : ''}">
                                        ${v.ganancia_parcial?.texto || '—'}
                                    </div>
                                    <div class="vitrina-card-sub">${v.ganancia_parcial?.subtitulo || ''}</div>
                                </div>

                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.deuda_clientes?.titulo || 'Deuda clientes'}</span>
                                    </div>
                                    <div class="vitrina-card-val">${v.deuda_clientes?.texto || '—'}</div>
                                    <div class="vitrina-card-sub">${v.deuda_clientes?.subtitulo || 'Saldo en la calle'}</div>
                                </div>

                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.pagos_clientes?.titulo || 'Pagos clientes'}</span>
                                    </div>
                                    <div class="vitrina-card-val">${v.pagos_clientes?.texto || '—'}</div>
                                    <div class="vitrina-card-sub">Cobranzas de cuenta corriente</div>
                                </div>

                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.tickets_digitales?.titulo || 'Tickets digitales'}</span>
                                    </div>
                                    <div class="vitrina-card-val">${v.tickets_digitales?.texto || '—'}</div>
                                    <div class="vitrina-card-sub">${v.tickets_digitales?.subtitulo || ''}</div>
                                </div>

                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.cancelaciones?.titulo || 'Cancelaciones'}</span>
                                    </div>
                                    <div class="vitrina-card-val">${v.cancelaciones?.texto || '0'}</div>
                                    <div class="vitrina-card-sub">Ventas canceladas</div>
                                </div>

                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.sin_firmar?.titulo || 'Sin firmar / F9'}</span>
                                        ${v.sin_firmar?.badge ? `<span class="vitrina-card-badge badge-amber">${v.sin_firmar.badge}</span>` : ''}
                                    </div>
                                    <div class="vitrina-card-val">${v.sin_firmar?.texto || '—'}</div>
                                    <div class="vitrina-card-sub">Tickets sin firma MP</div>
                                </div>

                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.mp_sin_ticket?.titulo || 'MP sin ticket'}</span>
                                        ${v.mp_sin_ticket?.badge ? `<span class="vitrina-card-badge badge-red">${v.mp_sin_ticket.badge}</span>` : ''}
                                    </div>
                                    <div class="vitrina-card-val">${v.mp_sin_ticket?.texto || '—'}</div>
                                    <div class="vitrina-card-sub">${v.mp_sin_ticket?.subtitulo || ''}</div>
                                </div>

                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.cliente?.titulo || 'Cliente'}</span>
                                    </div>
                                    <div class="vitrina-card-val">${v.cliente?.texto || '—'}</div>
                                    <div class="vitrina-card-sub">${v.cliente?.subtitulo || ''}</div>
                                </div>

                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.descuento?.titulo || 'Descuento'}</span>
                                    </div>
                                    <div class="vitrina-card-val">${v.descuento?.texto || '—'}</div>
                                    <div class="vitrina-card-sub">${v.descuento?.subtitulo || ''}</div>
                                </div>

                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.redondeo?.titulo || 'Redondeo'}</span>
                                    </div>
                                    <div class="vitrina-card-val">${v.redondeo?.texto || '—'}</div>
                                    <div class="vitrina-card-sub">${v.redondeo?.subtitulo || ''}</div>
                                </div>

                                <div class="vitrina-card">
                                    <div class="vitrina-card-top">
                                        <span class="vitrina-card-lbl">${v.inventario_costo?.titulo || 'Inventario al costo'}</span>
                                    </div>
                                    <div class="vitrina-card-val">${v.inventario_costo?.texto || '—'}</div>
                                    <div class="vitrina-card-sub">${v.inventario_costo?.subtitulo || 'Valuación a costo real'}</div>
                                </div>
                            </div>
                        </div>`;
                    }

                    const des = dato.desglose_sucursales || [];
                    const rank = dato.ranking_cortes || [];
                    const totalVentas = (v && v.tickets && v.tickets.total > 0) ? v.tickets.total : (resumen.ventas || 1);
                    const alertas = (dato.pulso && dato.pulso.alertas) || [];
                    const chips = alertas.length
                        ? `<div data-herramienta="alertas" data-titulo="Alertas del día" style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px;">${alertas.map(a => {
                            const bg = a.nivel === 'riesgo' ? '#fef2f2' : (a.nivel === 'ok' ? '#f0fdf4' : '#fffbeb');
                            const fg = a.nivel === 'riesgo' ? '#991b1b' : (a.nivel === 'ok' ? '#166534' : '#92400e');
                            return `<span style="background:${bg}; color:${fg}; border-radius:999px; padding:6px 12px; font-size:12px; font-weight:700;">${textoJefe(a.texto)}</span>`;
                        }).join('')}</div>`
                        : '';

                    html += chips;

                    if (rank.length > 0) {
                        html += `
                        <div data-herramienta="ranking" data-titulo="Ranking de cortes" style="background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:18px; margin-bottom:20px;">
                            <div style="font-size:14px; font-weight:800; color:#1e293b; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
                                <span>🥩 Ranking de Cortes y Productos Más Vendidos</span>
                                <span style="font-size:12px; font-weight:600; color:#64748b;">Top ${rank.length} productos</span>
                            </div>
                            <div style="overflow-x:auto;">
                                <table class="data-table" style="width:100%; border-collapse:collapse;">
                                    <thead>
                                        <tr style="background:#f8fafc; font-size:11px; color:#64748b; text-transform:uppercase; border-bottom:1px solid #e2e8f0;">
                                            <th style="padding:10px 14px; text-align:center; width:45px;">#</th>
                                            <th style="padding:10px 14px; text-align:left;">Producto / Corte</th>
                                            <th style="padding:10px 14px; text-align:right;">Kilos / Cantidad</th>
                                            <th style="padding:10px 14px; text-align:right;">Total Recaudado</th>
                                            <th style="padding:10px 14px; text-align:right;">Operaciones</th>
                                        </tr>
                                    </thead>
                                    <tbody>`;
                        rank.forEach((item, idx) => {
                            const badgeColor = idx === 0 ? '#fbbf24' : (idx === 1 ? '#94a3b8' : (idx === 2 ? '#b45309' : '#f1f5f9'));
                            const textColor = idx < 3 ? '#fff' : '#475569';
                            html += `
                            <tr style="border-bottom:1px solid #f1f5f9;">
                                <td style="padding:10px 14px; text-align:center;">
                                    <span style="display:inline-block; width:24px; height:24px; line-height:24px; border-radius:50%; background:${badgeColor}; color:${textColor}; font-size:11px; font-weight:800;">${idx + 1}</span>
                                </td>
                                <td style="padding:10px 14px; font-weight:700; color:#1e293b;">${textoJefe(item.producto)}</td>
                                <td style="padding:10px 14px; text-align:right; font-weight:600; color:#475569;">${(Number(item.cantidad != null ? item.cantidad : item.kilos) || 0).toLocaleString('es-AR')} kg</td>
                                <td style="padding:10px 14px; text-align:right; font-weight:800; color:#0f172a;">${plataJefe(item.total != null ? item.total : item.monto)}</td>
                                <td style="padding:10px 14px; text-align:right; color:#64748b;">${item.operaciones != null ? item.operaciones : (item.tickets || '—')}</td>
                            </tr>`;
                        });
                        html += `</tbody></table></div></div>`;
                    }

                    if (des.length > 0) {
                        const locales = des.length === 1 ? '1 local' : (des.length + ' locales');
                        html += `
                        <div class="sucursal-rend" data-herramienta="sucursales" data-titulo="Rendimiento por sucursal">
                            <div class="sucursal-rend-head">
                                <span>Rendimiento por sucursal</span>
                                <span>${locales}</span>
                            </div>
                            ${des.map((s) => {
                                const pct = Math.round((s.ventas / totalVentas) * 100);
                                return `<article class="sucursal-rend-fila">
                                    <div class="sucursal-rend-top"><b>${textoJefe(s.nombre)}</b><span>${pct}%</span></div>
                                    <div class="sucursal-rend-nums">
                                        <div><small>Ventas</small><b>${plataJefe(s.ventas)}</b></div>
                                        <div><small>Tickets</small><b>${s.tickets}</b></div>
                                        <div><small>Promedio</small><b>${plataJefe(s.promedio)}</b></div>
                                    </div>
                                </article>`;
                            }).join('')}
                        </div>`;
                    }

                    $('reporteCuerpo').innerHTML = html;
                    actualizarNombreEmpresaTopbar();
                }
            }

            // 3. COBROS DIGITALES (MERCADO PAGO & TARJETAS) - RECONCILIACIÓN EN TIEMPO REAL
            if (panel === 'digitales' && $('digitalesCuerpo')) {
                const dig = dato.digitales || {};
                $('digitalesDia').textContent = resumen.dia ? ('Libro · ' + resumen.dia) : 'Mercado Pago · QR · Tarjetas';

                const txs = dig.transacciones || [];
                let html = `<p class="modulo-esencial">Bruto, neto y tickets están en el resumen. El libro de cada cobro se abre en Opciones.</p>
                <div style="background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:18px;">
                    <div style="font-size:14px; font-weight:800; color:#1e293b; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
                        <span>📋 Libro de Auditoría Transaccional Digital (${txs.length})</span>
                        <span style="font-size:12px; color:#64748b;">${dig.fuente === 'libro' ? 'Libro de Mercado Pago' : 'Reconstruido desde tickets'}</span>
                    </div>
                    <div style="overflow-x:auto;">
                        <table class="data-table" style="width:100%; border-collapse:collapse;">
                            <thead>
                                <tr style="background:#f8fafc; font-size:11px; color:#64748b; text-transform:uppercase; border-bottom:1px solid #e2e8f0;">
                                    <th style="padding:10px 12px; text-align:left;">Fecha</th>
                                    <th style="padding:10px 12px; text-align:left;">ID Pago</th>
                                    <th style="padding:10px 12px; text-align:left;">Cuenta / Token</th>
                                    <th style="padding:10px 12px; text-align:left;">Concepto</th>
                                    <th style="padding:10px 12px; text-align:right;">Monto</th>
                                    <th style="padding:10px 12px; text-align:center;">Estado</th>
                                    <th style="padding:10px 12px; text-align:center;">Ticket Venta</th>
                                </tr>
                            </thead>
                            <tbody>`;
                if (txs.length === 0) {
                    html += `<tr><td colspan="7" style="padding:16px; text-align:center; color:#64748b;">Sin movimientos digitales registrados hoy.</td></tr>`;
                } else {
                    txs.forEach(t => {
                        const estado = String(t.estado || '');
                        let stBadge = `<span style="background:#dcfce7; color:#15803d; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:700;">${textoJefe(estado || 'FIRMADO')}</span>`;
                        if (estado.includes('SIN TICKET')) {
                            stBadge = `<span style="background:#fee2e2; color:#b91c1c; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:800;">SIN TICKET</span>`;
                        } else if (estado.includes('SIN FIRMAR')) {
                            stBadge = `<span style="background:#fef3c7; color:#92400e; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:700;">SIN FIRMAR</span>`;
                        } else if (estado === 'EN TICKET') {
                            stBadge = `<span style="background:#dbeafe; color:#1d4ed8; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:700;">EN TICKET</span>`;
                        }
                        html += `
                        <tr style="border-bottom:1px solid #f1f5f9; font-size:13px;">
                            <td style="padding:10px 12px; color:#475569;">${textoJefe((t.fecha || '').slice(0, 16))}</td>
                            <td style="padding:10px 12px; font-family:monospace; color:#334155;">${textoJefe(t.id_pago)}</td>
                            <td style="padding:10px 12px; color:#1e293b; font-weight:600;">${textoJefe(t.cuenta)}</td>
                            <td style="padding:10px 12px; color:#334155;">${textoJefe(t.concepto)}</td>
                            <td style="padding:10px 12px; text-align:right; font-weight:900; color:#0f172a;">${plataJefe(t.monto)}</td>
                            <td style="padding:10px 12px; text-align:center;">${stBadge}</td>
                            <td style="padding:10px 12px; text-align:center; font-family:monospace; color:#2563eb; font-weight:700;">#${textoJefe(t.ticket_venta)}</td>
                        </tr>`;
                    });
                }
                html += `</tbody></table></div></div>`;

                $('digitalesCuerpo').innerHTML = html;
            }

            // 4. ADMIN / CARTERA & FIADO (CON MORA, INTERÉS Y BOTÓN WHATSAPP)
            if (panel === 'admin' && $('adminCuerpo')) {
                const cartera = dato.cartera || {};
                const deudores = cartera.clientes || cartera.top_deudores || [];
                $('adminDia').textContent = `Espejo en tiempo real · ${cartera.total_cuentas || 0} cuentas registradas`;

                if (enCurso) $('adminDia').textContent += ' · actualizando';

                carteraEnPantalla = deudores;
                if (!deudores.length) {
                    $('adminCuerpo').innerHTML = `<p style="margin:0; color:#64748b;">No hay clientes en el libro de esta sucursal.</p>`;
                } else {
                    pintarTarjetasCliente(deudores, cartera);
                }
            }

            // 5. PEDIDOS AL FRIGORÍFICO (ABASTECIMIENTO & WHATSAPP)
            if (panel === 'pedidos' && $('pedidosCuerpo')) {
                const ped = dato.pedidos || {};
                faltantesEnPantalla = ped.faltantes || [];
                mensajePedido = ped.mensaje_whatsapp || '';
                const nombres = new Set(faltantesEnPantalla.map(item => item.proveedor || 'Sin proveedor'));
                if (filtroProveedorPedido && !nombres.has(filtroProveedorPedido)) filtroProveedorPedido = '';
                pintarFaltantes();
            }

            // 4. PROVEEDOR
            if (panel === 'proveedor' && $('proveedorCuerpo')) {
                const lista = dato.proveedores || [];
                $('proveedorCount').textContent = lista.length ? lista.length + ' en el libro' : 'Del libro de Cobro Fácil';
                $('proveedorCuerpo').innerHTML = lista.length
                    ? lista.map(p => `<div style="display:flex; justify-content:space-between; gap:12px; padding:12px 0; border-bottom:1px solid #f1f5f9;"><strong>${textoJefe(p.nombre)}</strong><span>${plataJefe(p.deuda)}</span></div>`).join('')
                    : `<p>${aviso || 'No hay proveedores en el libro.'}</p>`;
            }

            // 5. PROMEDIO
            if (panel === 'promedio' && $('promedioCuerpo')) {
                $('promedioCuerpo').innerHTML = dato.libro
                    ? `<div style="font-size:2rem; font-weight:800;">${plataJefe(resumen.promedio)}</div><p style="color:#64748b;">${resumen.tickets} tickets · venta ${plataJefe(resumen.ventas)} · ${resumen.dia}</p>`
                    : `<p>${aviso}</p>`;
            }

            if (panel === 'desglose') {
                pintarDesglose(dato);
                if (!enCurso) void precalentarDesglose();
            }

            // 6. TICKET
            if (panel === 'ticket' && $('ticketCuerpo') && ventasPantalla !== 'desglose') {
                ticketsEnPantalla = dato.tickets || [];
                cajasVentas = dato.cajas || [];
                ticketsResumen = {
                    total: dato.filtrado || 0,
                    ok: dato.tickets_ok || 0,
                    recorte: !!dato.recorte
                };
                ticketsTieneMas = !!dato.hay_mas || (ticketsEnPantalla.length === 400 && ticketsEnPantalla.length < ticketsResumen.ok);
                ticketsAviso = avisoSinTickets(dato.libro !== false);
                pintarTickets(false);
                const refresh = $('btnRefresh');
                if (refresh && refresh.classList.contains('es-filtro')) {
                    refresh.classList.toggle('filtrando', filtroVentasActivo());
                }
            }
            if (window.ModuloPanel) ModuloPanel.recoger(panel);
            pintarBarraJefe(panel, dato);
        }

        const vistasRaiz = new Set(['reporte', 'ticket', 'digitales', 'contabilidad', 'pedidos', 'cartera']);
        let moduloActual = 'reporte';

        function marcarEntrada(name) {
            const boton = $('menuToggle');
            const raiz = vistasRaiz.has(name);
            if (raiz) moduloActual = name;
            if (boton) {
                boton.classList.toggle('es-atras', !raiz);
                const etiqueta = raiz ? 'Opciones del módulo' : 'Volver';
                boton.setAttribute('aria-label', etiqueta);
                boton.title = etiqueta;
            }
            const refresh = $('btnRefresh');
            if (refresh) {
                const caja = name === 'contabilidad';
                const digital = caja && cajaPantalla === 'digital';
                const filtrar = name === 'pedidos' || name === 'ticket' || name === 'reporte' || caja;
                refresh.classList.toggle('es-filtro', filtrar);
                if (name === 'ticket') refresh.classList.toggle('filtrando', filtroVentasActivo());
                else if (name === 'pedidos') refresh.classList.toggle('filtrando', !!filtroProveedorPedido);
                else if (name === 'reporte') refresh.classList.toggle('filtrando', (window.vitrinaPeriodo || 'Hoy') !== 'Hoy');
                else if (digital) refresh.classList.toggle('filtrando', periodoDigital !== 'Semana');
                else if (caja) refresh.classList.toggle('filtrando', (periodoCaja || 'Hoy') !== 'Hoy');
                else refresh.classList.remove('filtrando');
                const etiqueta = name === 'pedidos' ? 'Filtrar proveedor' : (name === 'ticket' ? 'Filtrar ventas' : ((name === 'reporte' || caja) ? 'Filtrar período' : 'Actualizar'));
                refresh.setAttribute('aria-label', etiqueta);
                refresh.title = etiqueta;
                const icono = refresh.querySelector('svg');
                if (icono && !icono.classList.contains('ico-filtro')) icono.classList.add('ico-refresh');
                if (!refresh.querySelector('.ico-filtro')) {
                    refresh.insertAdjacentHTML('beforeend', '<svg class="ico-filtro" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16l-6 7v6l-4 2v-8L4 5z"/></svg>');
                }
            }
            pintarCarritoFlotante();
            if (name === 'cartera' && window.CarteraLibro && window.CarteraLibro.cromo) window.CarteraLibro.cromo();
        }

        let datosVista = 0;
        function programarDatos(name) {
            const token = ++datosVista;
            setTimeout(() => {
                if (token !== datosVista) return;
                if (name === 'cartera' && window.CarteraLibro) void window.CarteraLibro.entrar(activeSucursalId);
                if (['reporte', 'digitales', 'contabilidad', 'admin', 'pedidos', 'proveedor', 'promedio', 'ticket'].includes(name)) cargarJefe(name);
                if (name === 'home') renderHomeTable();
                if (name === 'remitos') renderRemitosFull();
                if (name === 'clientes') {
                    volverMenuClientes();
                    renderClientes();
                }
                if (name === 'historial-pagos') renderHistorialPagos();
                if (name === 'cobranzas') renderCobranzas();
                if (name === 'pago-central') renderPagosCentral();
                if (name === 'auditoria') renderAuditoria();
                if (name === 'usuarios') renderUsuarios();
                if (name === 'registro') volverMenuRegistro();
                if (name === 'finanzas-aging') renderFinanzasAging();
                if (name === 'finanzas-margenes') renderFinanzasMargenes();
                if (name === 'dashboard') void actualizarInformeEstado();
                if (window.ModuloPanel) ModuloPanel.usar(name);
            }, 0);
        }

        function switchView(name) {
            if (name === 'admin') name = 'cartera';
            if (name === 'usuarios' && sessionUser.role !== 'admin') {
                toast('Solo administradores pueden gestionar usuarios', true);
                return;
            }
            if (activeRowIndex >= 0) {
                const trs = Array.from(document.querySelectorAll('#tblHome tr.clickable'));
                const el = trs[activeRowIndex];
                if (el && el.nextElementSibling && el.nextElementSibling.classList.contains('detail-row')) {
                    el.nextElementSibling.remove();
                }
                activeRowIndex = -1;
            }
            if (!titles[name]) return;
            document.querySelectorAll('.nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === name));
            document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
            document.querySelectorAll('.pwa-nav-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.pwaView === name);
            });
            
            const jefeVistas = ['dashboard', 'reporte', 'digitales', 'contabilidad', 'admin', 'pedidos', 'proveedor', 'promedio', 'ticket'];
            if ($('dashboardBar')) {
                if (name === 'home' || name === 'deudas') {
                    $('dashboardBar').classList.remove('field-hidden');
                } else {
                    $('dashboardBar').classList.add('field-hidden');
                }
            }
            if ($('jefeBar')) {
                $('jefeBar').classList.toggle('field-hidden', !jefeVistas.includes(name));
            }
            cerrarFaltante();
            if (name === 'ticket') {
                ventasPantalla = 'historial';
                filtroVentas.alcance = 'mes';
                filtroVentas.historico = false;
                filtroVentas.fecha = '';
                filtroVentas.desde = '';
                filtroVentas.hasta = '';
            }
            if (name === 'contabilidad') {
                cajaPantalla = 'arqueo';
            }
            programarDatos(name);
            if ($('cobranzasBar')) {
                if (name === 'cobranzas') {
                    $('cobranzasBar').classList.remove('field-hidden');
                } else {
                    $('cobranzasBar').classList.add('field-hidden');
                }
            }
            if ($('pagosCentralBar')) {
                if (name === 'pago-central') {
                    $('pagosCentralBar').classList.remove('field-hidden');
                } else {
                    $('pagosCentralBar').classList.add('field-hidden');
                }
            }

            if (name === 'dashboard' || name === 'home') {
                titles[name][0] = getGreeting();
                if ($('weatherWidget')) $('weatherWidget').classList.remove('field-hidden');
            } else {
                if ($('weatherWidget')) $('weatherWidget').classList.add('field-hidden');
            }

            if (name === 'home') {
                if ($('btnTogglePro')) $('btnTogglePro').style.setProperty('display', 'flex', 'important');
            } else if ($('btnTogglePro')) {
                $('btnTogglePro').style.setProperty('display', 'none', 'important');
            }

            if (name !== 'cartera' && window.CarteraLibro) window.CarteraLibro.salir();
            const [t, s, bc] = titles[name] || ['', '', name];
            if ($('pageTitle')) $('pageTitle').innerHTML = t;
            if ($('pageSub')) $('pageSub').textContent = s;
            if ($('breadcrumbPage')) $('breadcrumbPage').textContent = bc || t;
            marcarEntrada(name);
            setSidebarOpen(false);
        }

        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', () => switchView(btn.dataset.view));
        });
        document.querySelectorAll('.jefe-btn').forEach(btn => {
            btn.addEventListener('click', () => switchView(btn.dataset.jefe));
        });
        document.querySelectorAll('.corp-area').forEach(btn => {
            btn.addEventListener('click', () => switchView(btn.dataset.corp));
        });

        if ($('btnTogglePro')) $('btnTogglePro').addEventListener('click', () => {
            isProMode = !isProMode;
            const btn = $('btnTogglePro');
            if (isProMode) {
                btn.style.background = '#1e293b';
                btn.style.color = '#fff';
                $('tblHomeWrapperNormal').classList.add('field-hidden');
                $('tblHomeWrapperPro').classList.remove('field-hidden');
            } else {
                btn.style.background = '#e2e8f0';
                btn.style.color = '#111827';
                $('tblHomeWrapperNormal').classList.remove('field-hidden');
                $('tblHomeWrapperPro').classList.add('field-hidden');
            }
            renderHomeTable();
        });
        
        $('btnRefresh').addEventListener('click', () => {
            const btn = $('btnRefresh');
            if (btn.classList.contains('es-filtro')) {
                const vista = document.querySelector('.view.active');
                const nombre = vista && vista.id.startsWith('view-') ? vista.id.slice(5) : '';
                if (nombre === 'ticket') abrirFiltroVentas();
                else if (nombre === 'reporte') abrirFiltroPeriodo({
                    actual: window.vitrinaPeriodo || 'Hoy',
                    desde: window.vitrinaDesde,
                    hasta: window.vitrinaHasta,
                    alAplicar: (elegido, desde, hasta) => window.cambiarPeriodoVitrina(elegido, desde, hasta)
                });
                else if (nombre === 'contabilidad' && cajaPantalla !== 'digital') abrirFiltroPeriodo({
                    actual: periodoCaja || 'Hoy',
                    desde: periodoCajaDesde,
                    hasta: periodoCajaHasta,
                    alAplicar: (elegido, desde, hasta) => {
                        window.cambiarPeriodoCaja(elegido, desde, hasta);
                        marcarEntrada('contabilidad');
                    }
                });
                else if (nombre === 'contabilidad' && cajaPantalla === 'digital') abrirFiltroPeriodo({
                    actual: periodoDigital || 'Semana',
                    desde: periodoDigitalDesde,
                    hasta: periodoDigitalHasta,
                    alAplicar: (elegido, desde, hasta) => {
                        periodoDigital = elegido;
                        periodoDigitalDesde = elegido === 'Período' ? desde : '';
                        periodoDigitalHasta = elegido === 'Período' ? hasta : '';
                        marcarEntrada('contabilidad');
                        pintarLibroDigital();
                    }
                });
                else abrirFiltroProveedor();
                return;
            }
            if (btn.disabled) return;
            btn.disabled = true;
            btn.classList.add('btn-spinning');
            fetch('/api/pos/sync/solicitar?sucursal_id=' + (activeSucursalId || 1), { method: 'POST' }).catch(() => {});
            void (async () => {
                try {
                    const vista = document.querySelector('.view.active');
                    const nombre = vista && vista.id.startsWith('view-') ? vista.id.slice(5) : '';
                    if (nombre === 'cartera' && window.CarteraLibro) {
                        await window.CarteraLibro.actualizar();
                        return;
                    }
                    await bajarNovedades();
                    if (['reporte', 'digitales', 'contabilidad', 'pedidos', 'proveedor', 'promedio', 'ticket'].includes(nombre)) {
                        await cargarJefe(nombre);
                    }
                    await refrescarManual();
                    const v = document.querySelector('.nav-item.active')?.dataset.view;
                    if (v === 'remitos') void renderRemitosFull();
                    if (v === 'historial-pagos') renderHistorialPagos();
                    if (v === 'auditoria') renderAuditoria();
                    if (v === 'usuarios') renderUsuarios();
                    if (v === 'finanzas-aging') renderFinanzasAging();
                    if (v === 'finanzas-margenes') renderFinanzasMargenes();
                } catch (e) {
                } finally {
                    btn.disabled = false;
                    btn.classList.remove('btn-spinning');
                }
            })();
        });

        function setSidebarOpen(open) {
            const sidebar = $('sidebar');
            const backdrop = $('sidebarBackdrop');
            if (sidebar) sidebar.classList.toggle('open', open);
            if (backdrop) {
                backdrop.classList.toggle('active', open);
                backdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
            }
            document.body.classList.toggle('sidebar-open', open);
            document.querySelectorAll('.dashboard-bar').forEach(el => {
                el.classList.toggle('bar-suppressed', open);
                if (open) {
                    el.dataset.prevDisplay = el.style.display || '';
                    el.style.display = 'none';
                } else {
                    el.style.display = el.dataset.prevDisplay || '';
                    delete el.dataset.prevDisplay;
                }
            });
        }

        $('menuToggle')?.addEventListener('click', () => {
            const boton = $('menuToggle');
            if (boton && boton.classList.contains('es-atras')) {
                if (window.CarteraLibro && window.CarteraLibro.atras()) return;
                switchView(moduloActual);
                return;
            }
            setSidebarOpen(!$('sidebar').classList.contains('open'));
        });
        $('pwaBtnMenu')?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            setSidebarOpen(!$('sidebar').classList.contains('open'));
        });
        if ($('sidebarCloseMobile')) $('sidebarCloseMobile').addEventListener('click', () => setSidebarOpen(false));
        $('sidebarBackdrop')?.addEventListener('click', () => setSidebarOpen(false));
        document.addEventListener('click', ev => {
            const sidebar = $('sidebar');
            const toggle = $('menuToggle');
            const pwaMenu = $('pwaBtnMenu');
            if (sidebar && sidebar.classList.contains('open')) {
                if (!sidebar.contains(ev.target) && (!toggle || !toggle.contains(ev.target)) && (!pwaMenu || !pwaMenu.contains(ev.target))) {
                    setSidebarOpen(false);
                }
            }
        });
        $('drawerClose')?.addEventListener('click', closeDrawer);
        $('drawerOverlay')?.addEventListener('click', ev => { if (ev.target === $('drawerOverlay')) closeDrawer(); });

        document.body.addEventListener('blur', ev => {
            if (ev.target && ev.target.classList.contains('calc-input')) {
                let val = ev.target.value.replace(/,/g, '.');
                if (/^\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)+$/.test(val.trim())) {
                    const parsed = parseKgInput(val);
                    ev.target.dataset.pesos = JSON.stringify(parsed.pesos_piezas);
                    ev.target.value = parsed.kg;
                    return;
                }
                delete ev.target.dataset.pesos;
                if (/^[0-9+\-.*\/()\s]+$/.test(val) && val.trim() !== '') {
                    try {
                        let res = Function('"use strict";return (' + val + ')')();
                        if (!isNaN(res) && isFinite(res)) {
                            ev.target.value = Math.round(res * 100) / 100;
                        }
                    } catch (e) {}
                }
            }
        }, true);

        $('drawerPagar')?.addEventListener('click', abrirModalPago);
        $('drawerDelete')?.addEventListener('click', () => {
            if (!selectedDeuda) return;
            void CrmDelete.eliminarOperacion(selectedDeuda.id, selectedDeuda.alias);
        });

        $('btnConfirmDeleteAuditoria')?.addEventListener('click', () => {
            if (!selectedAuditId) return;
            void CrmDelete.eliminarAuditoria(selectedAuditId);
        });

        $('btnCancelarPago')?.addEventListener('click', cerrarModalPago);
        $('btnConfirmarPago')?.addEventListener('click', confirmarPago);
        $('modalPago')?.addEventListener('click', ev => { if (ev.target === $('modalPago')) cerrarModalPago(); });
        $('btnCancelarPagoRemito')?.addEventListener('click', cerrarModalPagoRemito);
        $('btnConfirmarPagoRemito')?.addEventListener('click', confirmarPagoRemito);
        $('modalPagoRemito')?.addEventListener('click', ev => { if (ev.target === $('modalPagoRemito')) cerrarModalPagoRemito(); });
        $('inpMontoRemitoPago')?.addEventListener('keydown', ev => { if (ev.key === 'Enter') confirmarPagoRemito(); });
        $('btnCobranzaCobrar')?.addEventListener('click', cobranzaElegirCobrar);
        $('btnCobranzaVer')?.addEventListener('click', cobranzaElegirVer);
        $('btnCobranzaCancelar')?.addEventListener('click', cerrarModalCobranzaAccion);
        $('modalCobranzaAccion')?.addEventListener('click', ev => { if (ev.target === $('modalCobranzaAccion')) cerrarModalCobranzaAccion(); });
        $('btnPagoCentralPagar')?.addEventListener('click', pagoCentralElegirPagar);
        $('btnPagoCentralVer')?.addEventListener('click', pagoCentralElegirVer);
        $('btnPagoCentralCancelar')?.addEventListener('click', cerrarModalPagoCentralAccion);
        $('modalPagoCentralAccion')?.addEventListener('click', ev => { if (ev.target === $('modalPagoCentralAccion')) cerrarModalPagoCentralAccion(); });
        $('btnCancelarPagoGlobal')?.addEventListener('click', cerrarModalPagoGlobal);
        $('btnConfirmarPagoGlobal')?.addEventListener('click', confirmarPagoGlobal);
        $('modalPagoGlobal')?.addEventListener('click', ev => { if (ev.target === $('modalPagoGlobal')) cerrarModalPagoGlobal(); });
        $('inpMontoPagoGlobal')?.addEventListener('keydown', ev => { if (ev.key === 'Enter') confirmarPagoGlobal(); });
        $('modalEmpresa')?.addEventListener('click', ev => { if (ev.target === $('modalEmpresa')) cerrarModalEmpresa(); });
        $('modalFacturaOriginal')?.addEventListener('click', ev => { if (ev.target === $('modalFacturaOriginal')) cerrarModalFacturaOriginal(); });
        $('formEmpresa')?.addEventListener('submit', async ev => {
            ev.preventDefault();
            const data = {
                nombre: $('inpEmpresaNombre')?.value.trim() || "Master Total",
                cuit: $('inpEmpresaCuit')?.value.trim() || "",
                direccion: $('inpEmpresaDireccion')?.value.trim() || "",
                telefono: $('inpEmpresaTelefono')?.value.trim() || "",
                email: $('inpEmpresaEmail')?.value.trim() || "",
                cotizacion_usd: parseFloat($('inpEmpresaUsd')?.value || 1000) || 1000.0
            };
            localStorage.setItem('empresa_datos', JSON.stringify(data));
            if (sessionUser.role === 'admin') {
                try {
                    await api('/api/empresa', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            razon_social: data.nombre,
                            cuit: data.cuit,
                            direccion: data.direccion,
                            telefono: data.telefono,
                            email: data.email,
                            cotizacion_usd: data.cotizacion_usd
                        })
                    });
                } catch (e) {
                    toast(e.message || 'No se pudo guardar en servidor', true);
                    return;
                }
            }
            toast('Datos guardados. Informe automático los lunes al email indicado.');
            cerrarModalEmpresa();
            void actualizarInformeEstado();
        });
        $('inpMontoPago')?.addEventListener('input', () => {
            const esp = planPagoActual ? planPagoActual.monto_cuota : 0;
            calcDiffUi(esp, parseFloat($('inpMontoPago').value) || 0);
        });
        $('inpCuotaNum')?.addEventListener('change', () => {
            if (!planPagoActual) return;
            const n = parseInt($('inpCuotaNum').value, 10);
            if (n < planPagoActual.cuotas_pagadas + 1) {
                $('inpCuotaNum').value = planPagoActual.cuota_en_curso;
            }
        });

        $('formDeuda')?.addEventListener('submit', async ev => {
            ev.preventDefault();
            const btn = ev.target.querySelector('button[type=submit]');
            if (btn?.disabled) return;

            const fd = new FormData(ev.target);
            const payload = Object.fromEntries(fd);
            if (payload.tipo === 'tarjeta') {
                delete payload.meses;
                delete payload.monto;
                delete payload.kg;
                delete payload.precio_kg;
                delete payload.plazo_dias;
            } else if (payload.tipo === 'cheque') {
                delete payload.recibido;
                delete payload.pagar;
                delete payload.meses;
                delete payload.fecha_cierre;
                delete payload.cuotas;
                delete payload.kg;
                delete payload.precio_kg;
                delete payload.plazo_dias;
                if (!payload.impuesto_cheque_tipo) {
                    delete payload.impuesto_cheque_tipo;
                    delete payload.impuesto_cheque_valor;
                }
            } else if (payload.tipo === 'proveedor') {
                delete payload.monto;
                delete payload.meses;
                delete payload.fecha_cierre;
                delete payload.fecha_vencimiento;
                delete payload.cuotas;
                delete payload.recibido;
                if (!payload.pagar) delete payload.pagar;
            } else if (payload.tipo === 'prestamo') {
                delete payload.monto;
                delete payload.meses;
                delete payload.fecha_cierre;
                delete payload.fecha_vencimiento;
                delete payload.cuotas;
                delete payload.kg;
                delete payload.precio_kg;
            } else {
                delete payload.monto;
                delete payload.fecha_cierre;
                delete payload.fecha_vencimiento;
                delete payload.cuotas;
                delete payload.kg;
                delete payload.precio_kg;
                delete payload.plazo_dias;
            }

            const uuid = crypto.randomUUID();
            toast('Obligación registrada');
            ev.target.reset();
            toggleFormTipo();
            switchView('home');
            void aplicarOperacionOptimista(payload, uuid)
                .then(() => void enviarOperacionFinanciera(payload, uuid))
                .catch((e) => toast(e.message || 'Error al guardar', true));
        });

        $('selTipo')?.addEventListener('change', toggleFormTipo);
        document.querySelector('[name=kg]')?.addEventListener('input', updateProvTotal);
        document.querySelector('[name=precio_kg]')?.addEventListener('input', updateProvTotal);
        document.querySelector('[name=monto]')?.addEventListener('input', updateChequeTotal);
        document.querySelector('[name=impuesto_cheque_valor]')?.addEventListener('input', updateChequeTotal);
        $('selImpuestoCheque')?.addEventListener('change', () => { updateImpuestoChequeLabel(); updateChequeTotal(); });
        if ($('selTipo')) toggleFormTipo();

        $('selHistPagosTipo')?.addEventListener('change', ev => {
            histPagosFiltro = ev.target.value;
            renderHistorialPagos();
        });
        $('btnHistPagosCsv')?.addEventListener('click', exportHistorialCsv);

        $('formRemito')?.addEventListener('submit', async ev => {
            ev.preventDefault();
            const fd = new FormData(ev.target);
            const kgInput = ev.target.querySelector('[name=kg]');
            let pesos_piezas = [];
            if (kgInput?.dataset?.pesos) {
                try { pesos_piezas = JSON.parse(kgInput.dataset.pesos); } catch (e) { pesos_piezas = []; }
            }
            if (!pesos_piezas.length) {
                const parsed = parseKgInput(fd.get('kg'));
                pesos_piezas = parsed.pesos_piezas;
            }
            try {
                await api('/api/remitos', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cliente: fd.get('cliente'),
                        tipo_corte: fd.get('tipo_corte'),
                        cantidad: fd.get('cantidad') || (pesos_piezas.length || 0),
                        pesos_piezas: pesos_piezas.length ? pesos_piezas : undefined,
                        kg: fd.get('kg'),
                        precio_por_kg: fd.get('precio_por_kg'),
                        plazo_cobro_dias: fd.get('plazo')
                    })
                });
                toast('Remito de venta registrado');
                ev.target.reset();
                if (ev.target.plazo) ev.target.plazo.value = 30;
                invalidateRemitosFullCache();
                await loadAll();
                if (currentClientData) {
                    await openClientDrawer(currentClientData.id);
                }
            } catch (e) { toast(e.message, true); }
        });

        $('formBanco')?.addEventListener('submit', async ev => {
            ev.preventDefault();
            const fd = new FormData(ev.target);
            try {
                await api('/api/bancos', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(Object.fromEntries(fd))
                });
                toast('Entidad bancaria agregada');
                ev.target.reset();
                await loadAll();
            } catch (e) { toast(e.message, true); }
        });

        $('formBulk')?.addEventListener('submit', async ev => {
            ev.preventDefault();
            const fd = new FormData(ev.target);
            try {
                await api('/api/bulk', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(Object.fromEntries(fd))
                });
                toast('Lote bulk registrado');
                ev.target.reset();
                $('inpBulkFecha').value = new Date().toISOString().split('T')[0];
                await loadAll();
            } catch (e) { toast(e.message, true); }
        });

        $('formCliente')?.addEventListener('submit', async ev => {
            ev.preventDefault();
            const fd = new FormData(ev.target);
            const nombre = fd.get('nombre') ? fd.get('nombre').trim() : "";
            
            // Buscar si ya existe por nombre
            const existe = (data.clientes || []).find(c => c.nombre.trim().toLowerCase() === nombre.toLowerCase());
            
            let isUpdating = false;
            let clientIdToUpdate = null;
            
            if (existe) {
                const conf = confirm(`El cliente "${existe.nombre}" ya existe. ¿Desea actualizar los datos del cliente existente?`);
                if (!conf) return;
                isUpdating = true;
                clientIdToUpdate = existe.id;
            }
            
            const payload = {
                nombre: nombre,
                techo_deuda: fd.get('techo_deuda'),
                scoring: fd.get('scoring'),
                telefono: fd.get('telefono') || undefined,
                cuit: fd.get('cuit') || undefined,
                direccion: fd.get('direccion') || undefined,
                email: fd.get('email') || undefined,
                saldo_inicial: fd.get('saldo_inicial') ? parseFloat(fd.get('saldo_inicial')) : undefined
            };
            
            try {
                let res;
                if (isUpdating) {
                    res = await api('/api/clientes/' + clientIdToUpdate, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    upsertClienteEnCache(normalizarClienteDesdeApi(
                        { id: clientIdToUpdate, ...payload },
                        payload,
                        clientIdToUpdate
                    ));
                    toast('Cliente actualizado con éxito');
                } else {
                    res = await api('/api/clientes', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    upsertClienteEnCache(normalizarClienteDesdeApi(res, payload));
                    toast('Cliente registrado con éxito');
                }
                ev.target.reset();
                await persistirAppDataLocal();
                renderClientes();
                abrirSubVistaClientes('cliVer');
                void loadAll({ enSegundoPlano: true, bloquearUI: false });
            } catch (e) { toast(e.message, true); }
        });
        
        $('btnClientIncobrableWsp')?.addEventListener('click', async () => {
            if (!currentClientData) return;
            if (!confirm('⚠️ ¿ESTÁ SEGURO DE DECLARAR ESTE CLIENTE COMO INCOBRABLE?\nSu deuda de saldo pendiente se pasará a pérdidas y el crédito se bloqueará a $0 para siempre.')) return;
            try {
                await api('/api/clientes/' + currentClientData.id + '/incobrable', { method: 'POST' });
                toast('Cliente declarado como Incobrable');
                await loadAll();
                $('modalWspProfile').classList.remove('open');
                await openClientDrawer(currentClientData.id);
            } catch (e) { toast(e.message, true); }
        });

        const PESO_REF_CORTE = {
            'media res': 60,
            'cuartos': 30,
            'parrilleros': 25,
            'pechos': 20,
            'novillo': 280,
        };

        function remitoPesosPiezas(r) {
            if (Array.isArray(r?.pesos_piezas) && r.pesos_piezas.length) {
                return r.pesos_piezas.map(Number);
            }
            return [];
        }

        function remitoCantidad(r) {
            const piezas = remitoPesosPiezas(r);
            if (piezas.length) return piezas.length;
            const q = parseInt(r.cantidad, 10);
            if (q > 0) return q;
            const tipo = (r.tipo_corte || '').toLowerCase().trim();
            const peso = PESO_REF_CORTE[tipo];
            if (peso && r.kg > 0) {
                const est = r.kg / peso;
                if (Math.abs(est - Math.round(est)) < 0.12) return Math.round(est);
            }
            return 1;
        }

        function remitoKgPorUnidad(r) {
            const piezas = remitoPesosPiezas(r);
            if (piezas.length === 1) return piezas[0];
            const q = remitoCantidad(r);
            return q > 0 ? r.kg / q : r.kg;
        }

        function fmtFechaRemito(iso) {
            if (!iso) return '—';
            const p = String(iso).split('T')[0].split('-');
            if (p.length === 3) return `${p[2]}/${p[1]}/${p[0]}`;
            return iso;
        }

        function pesosPiezasHtml(piezas) {
            if (!piezas.length) return '';
            return `<div class="pesos-grid">${piezas.map(p => `<span class="peso-chip">${Number(p).toFixed(2)}</span>`).join('')}</div>`;
        }

        function reporteEstadoClass(label) {
            const l = (label || '').toLowerCase();
            if (l.includes('cobrado')) return 'st-paid';
            if (l.includes('parcial')) return 'st-partial';
            if (l.includes('incobrable')) return 'st-bad';
            return 'st-pending';
        }

        window.getEmpresaDatos = getEmpresaDatos;

        window.abrirModalEmpresa = function() {
            const emp = getEmpresaDatos();
            if ($('inpEmpresaNombre')) $('inpEmpresaNombre').value = emp.nombre || '';
            if ($('inpEmpresaCuit')) $('inpEmpresaCuit').value = emp.cuit || '';
            if ($('inpEmpresaDireccion')) $('inpEmpresaDireccion').value = emp.direccion || '';
            if ($('inpEmpresaTelefono')) $('inpEmpresaTelefono').value = emp.telefono || '';
            if ($('inpEmpresaEmail')) $('inpEmpresaEmail').value = emp.email || '';
            if ($('inpEmpresaUsd')) $('inpEmpresaUsd').value = emp.cotizacion_usd || 1000.0;
            $('modalEmpresa')?.classList.add('open');
        };

        window.cerrarModalEmpresa = function() {
            $('modalEmpresa').classList.remove('open');
        };

        window.abrirModalFacturaOriginal = async function(remitoId) {
            $('facturaOriginalSub').textContent = `Cargando comprobante de remito #${remitoId}...`;
            $('facturaOriginalBody').innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:30px">Obteniendo detalles del servidor...</div>';
            $('modalFacturaOriginal').classList.add('open');
            
            try {
                const r = await api('/api/remitos/' + remitoId);
                $('facturaOriginalSub').textContent = `Detalles del remito #${String(r.id).padStart(3, '0')}`;
                
                const emp = getEmpresaDatos();
                const initials = emp.nombre
                    .split(' ')
                    .map(w => w[0])
                    .join('')
                    .toUpperCase()
                    .slice(0, 2) || 'MT';
                    
                const pagado = Number(r.monto_pagado || 0);
                const saldo = Math.max(0, r.precio_venta_total - pagado);
                const estado = remitoEstado(r.estado_cobro ?? r.pagado);
                
                // Generar lista de pesos piezas en cuadrícula si existen
                let piezasHtml = '';
                if (Array.isArray(r.pesos_piezas) && r.pesos_piezas.length) {
                    piezasHtml = `
                    <div style="margin-top: 15px;">
                        <h4 style="font-size: 11px; color: #64748b; font-weight: bold; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;">Detalle de Pesos por Pieza</h4>
                        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                            ${r.pesos_piezas.map((p, idx) => `
                                <div style="font-family: monospace; font-size: 11px; background: #f1f5f9; border: 1px solid #cbd5e1; padding: 4px 8px; border-radius: 6px; color: #1e293b;">
                                    U#${idx+1}: <strong>${fmt(p)} kg</strong>
                                </div>
                            `).join('')}
                        </div>
                    </div>`;
                }

                $('facturaOriginalBody').innerHTML = `
                <div style="font-family:'Segoe UI',system-ui,sans-serif; display:flex; flex-direction:column; gap:16px;">
                    <!-- Cabecera de la empresa -->
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:12px; border-bottom:2px solid var(--brand, #0d6efd);">
                        <div style="display:flex; gap:10px; align-items:center;">
                            <div style="width:40px; height:40px; background:var(--brand, #0d6efd); color:#fff; border-radius:8px; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:14px;">${esc(initials)}</div>
                            <div>
                                <div style="font-weight:700; font-size:14px; color:#0f172a;">${esc(emp.nombre)}</div>
                                <div style="font-size:9px; color:#64748b;">Distribuidora de Carne</div>
                            </div>
                        </div>
                        <div style="text-align:right; font-size:10px; color:#475569; line-height:1.3;">
                            ${emp.cuit ? `CUIT: ${esc(emp.cuit)}<br>` : ''}
                            ${emp.telefono ? `Tel: ${esc(emp.telefono)}<br>` : ''}
                            ${emp.email ? `Email: ${esc(emp.email)}` : ''}
                        </div>
                    </div>

                    <!-- Datos del cliente y factura -->
                    <div style="display:grid; grid-template-columns:1.2fr 1fr; gap:12px; font-size:11px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px;">
                        <div>
                            <h4 style="font-size:9px; color:#64748b; font-weight:bold; text-transform:uppercase; margin-bottom:4px; letter-spacing:0.04em;">Cliente Facturado</h4>
                            <div style="font-weight:700; color:#0f172a; font-size:12px; margin-bottom:4px;">${esc(r.cliente_nombre || r.cliente)}</div>
                            ${r.cliente_cuit ? `<div style="color:#475569;">CUIT: ${esc(r.cliente_cuit)}</div>` : ''}
                            ${r.cliente_direccion ? `<div style="color:#475569;">Dir: ${esc(r.cliente_direccion)}</div>` : ''}
                            ${r.cliente_telefono ? `<div style="color:#475569;">Tel: ${esc(r.cliente_telefono)}</div>` : ''}
                        </div>
                        <div style="text-align:right;">
                            <h4 style="font-size:9px; color:#64748b; font-weight:bold; text-transform:uppercase; margin-bottom:4px; letter-spacing:0.04em;">Detalle Remito</h4>
                            <div style="color:#475569;">Emisión: <span style="font-weight:600; color:#111827;">${r.fecha}</span></div>
                            <div style="color:#475569;">Plazo acordado: <span style="font-weight:600; color:#111827;">${r.plazo_cobro_dias} días</span></div>
                            <div style="margin-top:6px;"><span class="badge ${estado.badgeClass}" style="font-size:9px; padding:3px 8px;">${estado.label.toUpperCase()}</span></div>
                        </div>
                    </div>

                    <!-- Tabla de productos -->
                    <table style="width:100%; border-collapse:collapse; font-size:11px; margin-top:5px;">
                        <thead>
                            <tr style="background:#0f172a; color:#ffffff;">
                                <th style="text-align:left; padding:8px; border-radius:6px 0 0 6px;">Corte / Concepto</th>
                                <th style="text-align:right; padding:8px;">Cant.</th>
                                <th style="text-align:right; padding:8px;">Kilos</th>
                                <th style="text-align:right; padding:8px;">Precio Unit.</th>
                                <th style="text-align:right; padding:8px; border-radius:0 6px 6px 0;">Importe</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr style="border-bottom:1px solid #e2e8f0; background:#ffffff;">
                                <td style="padding:10px 8px; font-weight:700; color:#0f172a;">${esc((r.tipo_corte || 'Carne').toUpperCase())}</td>
                                <td style="padding:10px 8px; text-align:right;">${remitoCantidad(r)}</td>
                                <td style="padding:10px 8px; text-align:right;">${fmt(r.kg)} kg</td>
                                <td style="padding:10px 8px; text-align:right;">$${fmt(r.precio_por_kg || (r.kg > 0 ? (r.precio_venta_total - r.costo_total_logistica) / r.kg : 0))}</td>
                                <td style="padding:10px 8px; text-align:right; font-weight:600; color:#0f172a;">$${fmt(r.precio_venta_total - r.costo_total_logistica)}</td>
                            </tr>
                            ${r.costo_total_logistica > 0 ? `
                            <tr style="border-bottom:1px solid #e2e8f0; background:#f8fafc;">
                                <td style="padding:10px 8px; color:#475569;" colspan="4">Servicio de Reparto (Logística Distribuida FIFO)</td>
                                <td style="padding:10px 8px; text-align:right; font-weight:600; color:#0f172a;">$${fmt(r.costo_total_logistica)}</td>
                            </tr>
                            ` : ''}
                        </tbody>
                    </table>

                    <!-- Piezas en detalle -->
                    ${piezasHtml}

                    <!-- Cuadro de Totales -->
                    <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                        <div style="width:250px; display:flex; flex-direction:column; gap:6px; font-size:11px; background:#f8fafc; border:1px solid #cbd5e1; border-radius:8px; padding:10px;">
                            <div style="display:flex; justify-content:space-between;"><span style="color:#64748b;">Subtotal Carne:</span><span style="font-weight:600; color:#0f172a;">$${fmt(r.precio_venta_total - r.costo_total_logistica)}</span></div>
                            <div style="display:flex; justify-content:space-between;"><span style="color:#64748b;">Costo Logística (Flete):</span><span style="font-weight:600; color:#0f172a;">$${fmt(r.costo_total_logistica)}</span></div>
                            <div style="display:flex; justify-content:space-between; border-top:1px solid #cbd5e1; padding-top:4px;"><span style="color:#475569; font-weight:bold;">TOTAL FACTURADO:</span><span style="font-weight:700; color:#0f172a;">$${fmt(r.precio_venta_total)}</span></div>
                            <div style="display:flex; justify-content:space-between;"><span style="color:#10b981; font-weight:600;">Monto Cobrado:</span><span style="font-weight:700; color:#10b981;">$${fmt(pagado)}</span></div>
                            <div style="display:flex; justify-content:space-between; border-top:1px solid #cbd5e1; padding-top:6px; font-size:12px;"><span style="font-weight:700; color:#0f172a;">SALDO PENDIENTE:</span><span style="font-weight:800; color:${saldo > 0 ? '#ef4444' : '#111827'};">$${fmt(saldo)}</span></div>
                        </div>
                    </div>
                </div>`;
                
                let actionsHtml = '';
                if (pagado > 0) {
                    actionsHtml += `<button type="button" class="btn btn-warning btn-sm" onclick="restablecerPagoFactura(${r.id})" style="font-size: 11px; padding: 6px 10px; font-weight:bold; cursor:pointer;">⚠️ Restablecer Pago</button>`;
                }
                actionsHtml += `<button type="button" class="btn btn-danger btn-sm" onclick="eliminarFactura(${r.id})" style="font-size: 11px; padding: 6px 10px; font-weight:bold; cursor:pointer;">❌ Eliminar Factura</button>`;
                actionsHtml += `<button type="button" class="btn btn-primary" onclick="cerrarModalFacturaOriginal()" style="font-size: 11px; padding: 6px 12px; cursor:pointer; margin-left: auto;">Cerrar</button>`;
                
                $('facturaOriginalActions').innerHTML = actionsHtml;
            } catch (e) {
                $('facturaOriginalBody').innerHTML = `<div style="color:var(--danger);text-align:center;padding:30px">Error al cargar comprobante: ${esc(e.message)}</div>`;
                $('facturaOriginalActions').innerHTML = `<button type="button" class="btn btn-primary" onclick="cerrarModalFacturaOriginal()">Cerrar</button>`;
            }
        };

        window.cerrarModalFacturaOriginal = function() {
            $('modalFacturaOriginal').classList.remove('open');
        };

        window.cargarSaldoViejo = async function(clientId) {
            const val = prompt("Ingrese el saldo viejo/anterior del cliente (ej: 15000):");
            if (val === null) return;
            const parsed = parseFloat(val);
            if (isNaN(parsed) || parsed < 0) {
                toast("Monto inválido", true);
                return;
            }
            const pass = await window.promptMasterPasswordAsync("Ingrese la contraseña maestra para actualizar el saldo inicial:");
            if (!pass) return;
            try {
                const res = await api('/api/clientes/' + clientId + '/saldo-inicial', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ saldo_inicial: parsed, password: pass })
                });
                toast(res.message || "Saldo actualizado");
                await loadAll();
                await openClientDrawer(clientId);
            } catch(e) {
                toast(e.message, true);
            }
        };

        window.promptMasterPasswordAsync = function(text) {
            return new Promise(resolve => {
                const textEl = document.getElementById('masterPasswordText');
                const inpEl = document.getElementById('inputMasterPassword');
                const modalEl = document.getElementById('modalMasterPassword');
                const btnConfirm = document.getElementById('btnConfirmMasterPassword');
                const btnClose = modalEl.querySelector('.modal-close');
                const btnCancel = modalEl.querySelector('.btn-ghost');
                
                textEl.textContent = text;
                inpEl.value = '';
                modalEl.classList.add('open');
                inpEl.focus();
                
                const cleanup = () => {
                    btnConfirm.onclick = null;
                    if (btnClose) btnClose.onclick = null;
                    if (btnCancel) btnCancel.onclick = null;
                    modalEl.classList.remove('open');
                };
                
                btnConfirm.onclick = () => {
                    resolve(inpEl.value);
                    cleanup();
                };
                btnConfirm.textContent = 'Confirmar';
                
                if (btnClose) {
                    btnClose.onclick = () => {
                        resolve(null);
                        cleanup();
                    };
                }
                
                if (btnCancel) {
                    btnCancel.onclick = () => {
                        resolve(null);
                        cleanup();
                    };
                }
            });
        };

        window.restablecerPagoFactura = async function(remitoId) {
            if (!confirm("⚠️ ¿Está seguro de restablecer el pago de esta factura?\nEl monto pagado volverá a cero y se sumará a la deuda del cliente.")) return;
            const pass = await window.promptMasterPasswordAsync("⚠️ Ingrese la contraseña maestra para restablecer el pago de esta factura:");
            if (!pass) return;
            try {
                const res = await api('/api/remitos/' + remitoId + '/reset-pago', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pass })
                });
                toast(res.message || "Pago restablecido");
                cerrarModalFacturaOriginal();
                await loadAll();
                if (selectedClienteId) {
                    await openClientDrawer(selectedClienteId);
                }
            } catch(e) {
                toast(e.message, true);
            }
        };

        function buildReporteClienteHtml(c) {
            const remitos = c.remitos || [];
            const genAt = new Date().toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
            const emp = getEmpresaDatos();
            const initials = emp.nombre
                .split(' ')
                .map(w => w[0])
                .join('')
                .toUpperCase()
                .slice(0, 2) || 'MT';
            const totalKg = remitos.reduce((acc, r) => acc + r.kg, 0);
            const totalVendido = remitos.reduce((acc, r) => acc + r.precio_venta_total, 0);
            const totalCobrado = remitos.reduce((acc, r) => acc + (Number(r.monto_pagado || 0) || (Number(r.pagado) === 1 ? r.precio_venta_total : 0)), 0);
            const disponible = Math.max(0, c.techo_deuda - c.saldo_actual);
            const totalUnidades = remitos.reduce((acc, r) => acc + remitoCantidad(r), 0);

            const remitosRows = remitos.length
                ? remitos.map((r) => {
                    const est = remitoEstado(r.estado_cobro ?? r.pagado);
                    const piezas = remitoPesosPiezas(r);
                    const cant = remitoCantidad(r);
                    const corte = (r.tipo_corte || '—').toUpperCase();
                    const pxKg = r.precio_por_kg || (r.kg > 0 ? r.precio_venta_total / r.kg : 0);
                    const pagado = Number(r.monto_pagado || 0) || (Number(r.pagado) === 1 ? r.precio_venta_total : 0);
                    const saldo = Math.max(0, r.precio_venta_total - pagado);
                    const plazo = r.plazo_cobro_dias != null ? `${r.plazo_cobro_dias} días` : '—';
                    const importe = r.precio_venta_total;
                    const detalleCarneHtml = piezas.length
                        ? `<div class="detalle-cell"><span class="corte-nombre">${esc(corte)}</span>${pesosPiezasHtml(piezas)}</div>`
                        : `<div class="detalle-cell"><span class="corte-nombre">${esc(corte)}</span><span class="sin-piezas">${fmt(r.kg)} kg total</span></div>`;

                    if (r.costo_total_logistica > 0) {
                        const importeCarne = r.precio_venta_total - r.costo_total_logistica;
                        const logisticaPxKg = r.costo_total_logistica / (r.kg || 1);
                        return `
                            <tr style="border-bottom: none;">
                                <td rowspan="2" style="vertical-align: middle; border-bottom: 1px solid #e2e8f0;">${fmtFechaRemito(r.fecha)}</td>
                                <td rowspan="2" class="col-mono" style="vertical-align: middle; border-bottom: 1px solid #e2e8f0;">${String(r.id).padStart(3, '0')}</td>
                                <td class="col-qty" style="border-bottom: none; padding-bottom: 4px;">${cant}</td>
                                <td class="col-detalle" style="border-bottom: none; padding-bottom: 4px;">${detalleCarneHtml}</td>
                                <td class="col-num" style="border-bottom: none; padding-bottom: 4px;">${Number(r.kg).toFixed(2)}</td>
                                <td class="col-num" style="border-bottom: none; padding-bottom: 4px;">${Number(pxKg).toFixed(2)}</td>
                                <td class="col-num col-total" style="border-bottom: none; padding-bottom: 4px;">$${fmt(importeCarne)}</td>
                                <td rowspan="2" class="col-num" style="vertical-align: middle; border-bottom: 1px solid #e2e8f0;">$${fmt(pagado)}</td>
                                <td rowspan="2" class="col-num col-saldo" style="vertical-align: middle; border-bottom: 1px solid #e2e8f0;">$${fmt(saldo)}</td>
                                <td rowspan="2" class="col-plazo" style="vertical-align: middle; border-bottom: 1px solid #e2e8f0;">${plazo}</td>
                                <td rowspan="2" class="col-estado" style="vertical-align: middle; border-bottom: 1px solid #e2e8f0;"><span class="status ${reporteEstadoClass(est.label)}">${esc(est.label.toUpperCase())}</span></td>
                            </tr>
                            <tr>
                                <td class="col-qty" style="padding-top: 0; color: #94a3b8;">—</td>
                                <td class="col-detalle" style="padding-top: 0;"><div class="detalle-cell"><span class="corte-nombre" style="color:#64748b; font-size: 11px;">🚚 LOGÍSTICA</span></div></td>
                                <td class="col-num" style="color:#64748b; font-size: 11px; padding-top: 0;">${Number(r.kg).toFixed(2)}</td>
                                <td class="col-num" style="color:#64748b; font-size: 11px; padding-top: 0;">${Number(logisticaPxKg).toFixed(2)}</td>
                                <td class="col-num col-total" style="font-size: 12px; color: #475569; padding-top: 0;">$${fmt(r.costo_total_logistica)}</td>
                            </tr>
                        `;
                    } else {
                        return `
                            <tr>
                                <td>${fmtFechaRemito(r.fecha)}</td>
                                <td class="col-mono">${String(r.id).padStart(3, '0')}</td>
                                <td class="col-qty">${cant}</td>
                                <td class="col-detalle">${detalleCarneHtml}</td>
                                <td class="col-num">${Number(r.kg).toFixed(2)}</td>
                                <td class="col-num">${Number(pxKg).toFixed(2)}</td>
                                <td class="col-num col-total">$${fmt(importe)}</td>
                                <td class="col-num">$${fmt(pagado)}</td>
                                <td class="col-num col-saldo">$${fmt(saldo)}</td>
                                <td class="col-plazo">${plazo}</td>
                                <td class="col-estado"><span class="status ${reporteEstadoClass(est.label)}">${esc(est.label.toUpperCase())}</span></td>
                            </tr>`;
                    }
                }).join('')
                : '<tr><td colspan="11" class="empty-row">Sin movimientos registrados</td></tr>';

            const totalesRemitosRow = remitos.length ? `
                <tr class="totales-row">
                    <td colspan="2"><strong>TOTALES</strong></td>
                    <td class="col-qty"><strong>${totalUnidades}</strong></td>
                    <td></td>
                    <td class="col-num"><strong>${Number(totalKg).toFixed(2)}</strong></td>
                    <td></td>
                    <td class="col-num col-total"><strong>$${fmt(totalVendido)}</strong></td>
                    <td class="col-num"><strong>$${fmt(totalCobrado)}</strong></td>
                    <td class="col-num"><strong>$${fmt(c.saldo_actual)}</strong></td>
                    <td colspan="2"></td>
                </tr>` : '';

            return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <title>Estado de cuenta — ${esc(c.nombre)}</title>
    <style>
        @media print { * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
            color: #111827;
            font-size: 10pt;
            line-height: 1.45;
            background: #fff;
            padding: 28px 32px;
        }
        .doc-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 24px;
            padding-bottom: 20px;
            border-bottom: 3px solid #0d6efd;
            margin-bottom: 22px;
        }
        .brand-block { display: flex; gap: 14px; align-items: center; }
        .brand-logo {
            width: 52px; height: 52px; background: #0d6efd; color: #fff;
            border-radius: 10px; display: flex; align-items: center; justify-content: center;
            font-weight: 800; font-size: 17px; letter-spacing: -0.5px; flex-shrink: 0;
        }
        .brand-name { font-size: 17pt; font-weight: 700; color: #0f172a; letter-spacing: -0.3px; }
        .brand-tag { font-size: 9pt; color: #64748b; margin-top: 2px; }
        .doc-meta { text-align: right; font-size: 9pt; color: #475569; }
        .doc-meta .doc-type {
            display: inline-block; background: #eff6ff; color: #1d4ed8;
            font-weight: 700; font-size: 8.5pt; letter-spacing: 0.06em;
            text-transform: uppercase; padding: 4px 10px; border-radius: 6px; margin-bottom: 6px;
        }
        .doc-meta .doc-date { font-weight: 600; color: #334155; }
        .info-grid {
            display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 22px;
        }
        .info-card {
            border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px; background: #f8fafc;
        }
        .info-card h4 {
            font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em;
            color: #64748b; margin-bottom: 10px; font-weight: 700;
        }
        .info-row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 9.5pt; }
        .info-row .lbl { color: #64748b; }
        .info-row .val { font-weight: 600; text-align: right; }
        .info-row.highlight .val { color: #b45309; font-size: 11pt; }
        .info-row.balance .val { color: #dc2626; font-size: 12pt; font-weight: 800; }
        .section-title {
            font-size: 9pt; font-weight: 700; text-transform: uppercase;
            letter-spacing: 0.07em; color: #334155; margin-bottom: 10px;
            padding-bottom: 6px; border-bottom: 1px solid #e2e8f0;
        }
        .items-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 9pt; }
        .items-table thead th {
            background: #0f172a; color: #fff; font-weight: 600; font-size: 8pt;
            text-transform: uppercase; letter-spacing: 0.04em;
            padding: 9px 7px; text-align: left; white-space: nowrap;
        }
        .items-table thead th.col-num, .items-table tbody td.col-num,
        .items-table thead th.col-qty, .items-table tbody td.col-qty { text-align: right; }
        .items-table tbody td {
            padding: 10px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top;
        }
        .items-table tbody tr:nth-child(even) { background: #f8fafc; }
        .items-table tbody tr:hover { background: #eff6ff; }
        .col-detalle { min-width: 180px; max-width: 340px; }
        .detalle-cell .corte-nombre {
            display: block; font-weight: 700; font-size: 8.5pt; letter-spacing: 0.04em;
            color: #0f172a; margin-bottom: 6px;
        }
        .pesos-grid { display: flex; flex-wrap: wrap; gap: 4px; }
        .peso-chip {
            font-family: 'Consolas', 'Courier New', monospace;
            font-size: 8pt; font-weight: 600; color: #1e40af;
            background: #eff6ff; border: 1px solid #bfdbfe;
            padding: 2px 6px; border-radius: 4px; min-width: 42px; text-align: center;
        }
        .sin-piezas { font-size: 8pt; color: #64748b; }
        .totales-row { background: #0f172a !important; color: #fff; }
        .totales-row td { border-bottom: none; padding: 10px 8px; font-size: 9pt; }
        .totales-row .col-total { color: #fff; }
        .col-mono { font-family: 'Consolas', 'Courier New', monospace; font-size: 8.5pt; color: #475569; }
        .col-total { font-weight: 700; color: #0f172a; }
        .col-saldo { font-weight: 700; color: #dc2626; }
        .col-plazo { font-size: 8.5pt; color: #64748b; white-space: nowrap; text-align: center; }
        .col-estado { text-align: center; white-space: nowrap; }
        .empty-row { text-align: center; padding: 24px !important; color: #94a3b8; }
        .status {
            display: inline-block; font-size: 7.5pt; font-weight: 700;
            letter-spacing: 0.05em; padding: 4px 10px; border-radius: 6px; white-space: nowrap;
        }
        .st-paid { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
        .st-partial { background: #fef9c3; color: #854d0e; border: 1px solid #fde68a; }
        .st-pending { background: #ffffff; color: #dc2626; border: 1.5px solid #dc2626; }
        .st-bad { background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; }
        .totals-grid {
            display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 4px;
        }
        .totals-card {
            border: 2px solid #0f172a; border-radius: 10px; padding: 16px 18px;
        }
        .totals-card.secondary { border-color: #cbd5e1; }
        .totals-card h4 {
            font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em;
            color: #64748b; margin-bottom: 12px; font-weight: 700;
        }
        .total-row {
            display: flex; justify-content: space-between; align-items: baseline;
            padding: 5px 0; font-size: 9.5pt; border-bottom: 1px dashed #e2e8f0;
        }
        .total-row:last-child { border-bottom: none; }
        .total-row.grand {
            margin-top: 8px; padding-top: 10px; border-top: 2px solid #0f172a;
            border-bottom: none; font-size: 11pt;
        }
        .total-row.grand .lbl { font-weight: 700; color: #0f172a; }
        .total-row.grand .val { font-weight: 800; color: #dc2626; font-size: 14pt; }
        .total-row .lbl { color: #475569; }
        .total-row .val { font-weight: 700; color: #0f172a; }
        .total-row.credit .val { color: #059669; }
        .doc-footer {
            margin-top: 28px; padding-top: 14px; border-top: 1px solid #e2e8f0;
            text-align: center; font-size: 8pt; color: #94a3b8;
        }
        .doc-footer p + p { margin-top: 3px; }
        .legal-note {
            margin-top: 16px; font-size: 8pt; color: #64748b;
            background: #f1f5f9; border-radius: 8px; padding: 10px 14px;
            border-left: 3px solid #0d6efd;
        }
        @media print {
            body { padding: 12px 16px; }
            .items-table tbody tr:hover { background: inherit; }
            @page { margin: 12mm; }
        }
    </style>
</head>
<body>
    <header class="doc-header">
        <div class="brand-block">
            <div class="brand-logo">${esc(initials)}</div>
            <div>
                <div class="brand-name">${esc(emp.nombre)}</div>
                <div class="brand-tag">Distribuidora de Carne · Cuenta Corriente</div>
                <div style="font-size: 8.5pt; color: #475569; margin-top: 4px; line-height: 1.3;">
                    ${emp.cuit ? `CUIT: ${esc(emp.cuit)}<br>` : ''}
                    ${emp.direccion ? `Dirección: ${esc(emp.direccion)}<br>` : ''}
                    ${emp.telefono || emp.email ? `${emp.telefono ? `Tel: ${esc(emp.telefono)}` : ''}${emp.telefono && emp.email ? ' | ' : ''}${emp.email ? `Email: ${esc(emp.email)}` : ''}` : ''}
                </div>
            </div>
        </div>
        <div class="doc-meta">
            <div class="doc-type">Estado de Cuenta</div>
            <div class="doc-date">Generado: ${genAt}</div>
        </div>
    </header>

    <div class="info-grid">
        <div class="info-card">
            <h4>Datos del cliente</h4>
            <div class="info-row"><span class="lbl">Razón social</span><span class="val">${esc(c.nombre)}</span></div>
            ${c.cuit ? `<div class="info-row"><span class="lbl">CUIT</span><span class="val">${esc(c.cuit)}</span></div>` : ''}
            ${c.direccion ? `<div class="info-row"><span class="lbl">Dirección</span><span class="val">${esc(c.direccion)}</span></div>` : ''}
            ${c.telefono ? `<div class="info-row"><span class="lbl">Teléfono</span><span class="val">${esc(c.telefono)}</span></div>` : ''}
            ${c.email ? `<div class="info-row"><span class="lbl">Email</span><span class="val">${esc(c.email)}</span></div>` : ''}
            <div class="info-row"><span class="lbl">Scoring de crédito</span><span class="val">${esc(c.scoring)}</span></div>
            <div class="info-row"><span class="lbl">Techo de deuda</span><span class="val">$${fmt(c.techo_deuda)}</span></div>
        </div>
        <div class="info-card">
            <h4>Situación financiera</h4>
            <div class="info-row highlight"><span class="lbl">Saldo deudor</span><span class="val">$${fmt(c.saldo_actual)}</span></div>
            <div class="info-row credit"><span class="lbl">Crédito disponible</span><span class="val">$${fmt(disponible)}</span></div>
            <div class="info-row"><span class="lbl">Remitos en cuenta</span><span class="val">${remitos.length}</span></div>
        </div>
    </div>

    <div class="section-title">Detalle de remitos — facturación por pieza</div>
    <table class="items-table">
        <thead>
            <tr>
                <th>Fecha</th>
                <th>Cód.</th>
                <th class="col-qty">Cant.</th>
                <th>Detalle (pesos por pieza)</th>
                <th class="col-num">Kilos</th>
                <th class="col-num">Precio</th>
                <th class="col-num">Importe</th>
                <th class="col-num">Pagado</th>
                <th class="col-num">Saldo</th>
                <th>Plazo</th>
                <th>Estado</th>
            </tr>
        </thead>
        <tbody>${remitosRows}${totalesRemitosRow}</tbody>
    </table>

    <div class="totals-grid">
        <div class="totals-card secondary">
            <h4>Resumen operativo</h4>
            <div class="total-row"><span class="lbl">Unidades totales</span><span class="val">${totalUnidades}</span></div>
            <div class="total-row"><span class="lbl">Kilos facturados</span><span class="val">${fmt(totalKg)} kg</span></div>
            <div class="total-row"><span class="lbl">Total facturado</span><span class="val">$${fmt(totalVendido)}</span></div>
            <div class="total-row"><span class="lbl">Total cobrado</span><span class="val">$${fmt(totalCobrado)}</span></div>
        </div>
        <div class="totals-card">
            <h4>Balance de cuenta</h4>
            <div class="total-row"><span class="lbl">Facturación acumulada</span><span class="val">$${fmt(totalVendido)}</span></div>
            <div class="total-row"><span class="lbl">Pagos recibidos</span><span class="val">$${fmt(totalCobrado)}</span></div>
            <div class="total-row grand"><span class="lbl">SALDO IMPAGO</span><span class="val">$${fmt(c.saldo_actual)}</span></div>
            <div class="total-row credit"><span class="lbl">Crédito libre</span><span class="val">$${fmt(disponible)}</span></div>
        </div>
    </div>

    <div class="legal-note">
        Documento informativo de cuenta corriente. Los montos en pesos argentinos ($). 
        El plazo de cobro indicado por remito corresponde al acuerdo comercial vigente al momento de la entrega.
    </div>

    <footer class="doc-footer">
        <p>${esc(emp.nombre)} Terminal · Distribuidoras de Carne</p>
        <p>— Fin del estado de cuenta —</p>
    </footer>
    <script>
        window.onload = function() { window.print(); setTimeout(function() { window.close(); }, 600); };
    <\/script>
</body>
</html>`;
        }

        async function actualizarInformeEstado() {
            const el = $('informeEmailEstado');
            if (!el) return;
            try {
                let email = '';
                try {
                    const emp = await api('/api/empresa');
                    email = (emp.email || '').trim();
                } catch (_) {
                    const local = JSON.parse(localStorage.getItem('empresa_datos') || '{}');
                    email = (local.email || '').trim();
                }
                let html = '📅 Cada <strong>lunes 05:00</strong> se envía el informe al email de la empresa.';
                if (email) {
                    html += '<br>Destino: <strong>' + esc(email) + '</strong>';
                } else {
                    html += '<br><span style="color:#b45309;">Completá el email en <strong>Datos de la Empresa</strong> para recibirlo automáticamente.</span>';
                }
                html += '<br><span style="color:#64748b;">¿Lo necesitás antes? Usá <strong>Descargar PDF</strong>.</span>';
                el.innerHTML = html;
            } catch (_) {
                el.textContent = '';
            }
        }

        async function abrirInformeJefe() {
            try {
                setLoading(true, 'Generando informe…');
                const html = await fetch('/api/reportes/diario/html?_=' + Date.now(), { credentials: 'same-origin' }).then(r => {
                    if (!r.ok) throw new Error('No se pudo generar el informe');
                    return r.text();
                });
                const w = window.open('', '_blank', 'width=960,height=720');
                if (!w) {
                    toast('Permití ventanas emergentes para ver el informe', true);
                    return;
                }
                w.document.write(html);
                w.document.close();
            } catch (e) {
                toast(e.message || 'Error al abrir informe', true);
            } finally {
                setLoading(false);
            }
        }

        async function descargarInformeJefePdf() {
            try {
                setLoading(true, 'Generando PDF…');
                const r = await fetch('/api/reportes/diario/pdf?_=' + Date.now(), { credentials: 'same-origin' });
                if (!r.ok) {
                    const d = await r.json().catch(() => ({}));
                    throw new Error(d.error || 'Error al generar PDF');
                }
                const blob = await r.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'informe-empresarial-' + new Date().toISOString().slice(0, 10) + '.pdf';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                toast('PDF descargado');
            } catch (e) {
                toast(e.message || 'Error al descargar PDF', true);
            } finally {
                setLoading(false);
            }
        }

        async function compartirInformeWhatsApp() {
            try {
                setLoading(true, 'Preparando informe…');
                const [wa, pdfRes] = await Promise.all([
                    api('/api/reportes/diario/whatsapp?_=' + Date.now()),
                    fetch('/api/reportes/diario/pdf?_=' + Date.now(), { credentials: 'same-origin' }),
                ]);
                if (!pdfRes.ok) throw new Error('No se pudo generar el PDF');
                const blob = await pdfRes.blob();
                const file = new File([blob], 'informe-empresarial.pdf', { type: 'application/pdf' });
                const texto = wa.texto || '';

                if (navigator.share && navigator.canShare?.({ files: [file] })) {
                    await navigator.share({
                        files: [file],
                        title: 'Informe diario',
                        text: texto,
                    });
                    toast('Listo para compartir');
                    return;
                }

                await descargarInformeJefePdf();
                window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank');
                toast('PDF descargado — adjuntalo en WhatsApp');
            } catch (e) {
                if (e.name !== 'AbortError') toast(e.message || 'Error al compartir', true);
            } finally {
                setLoading(false);
            }
        }

        $('btnInformeVer')?.addEventListener('click', abrirInformeJefe);
        $('btnInformePdf')?.addEventListener('click', descargarInformeJefePdf);
        $('btnInformeWhatsApp')?.addEventListener('click', compartirInformeWhatsApp);

        $('btnClientPrint')?.addEventListener('click', async () => {
            if (!currentClientData) return;
            try {
                const c = await api('/api/clientes/' + currentClientData.id);
                
                const printWindow = window.open('', '_blank', 'width=900,height=700');
                if (!printWindow) {
                    toast('El navegador bloqueó la ventana emergente de impresión', true);
                    return;
                }
                
                printWindow.document.write(buildReporteClienteHtml(c));
                printWindow.document.close();
            } catch (e) {
                toast('Error al generar reporte impreso: ' + e.message, true);
            }
        });

        document.addEventListener('keydown', ev => {
            const activeView = document.querySelector('.view.active');
            if (!activeView) return;

            // Evitar interferir con la escritura en campos de formulario
            if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT' || ev.target.tagName === 'TEXTAREA') {
                if (ev.key === 'Escape') {
                    ev.target.blur();
                }
                return;
            }

            // Cambiar de vista con las teclas 1 a 6
            if (ev.key === '1') { switchView('dashboard'); return; }
            if (ev.key === '2') { switchView('home'); return; }
            if (ev.key === '3') { switchView('remitos'); return; }
            if (ev.key === '4') { switchView('clientes'); return; }
            if (ev.key === '5') { switchView('registro'); return; }
            if (ev.key === '6') { switchView('historial-pagos'); return; }

            // Buscar filas en el cuerpo de la tabla activa de la pestaña
            const tbody = activeView.querySelector('tbody');
            if (!tbody) return;
            const rows = Array.from(tbody.querySelectorAll('tr'));
            if (!rows.length) return;

            if (ev.key === 'ArrowDown') {
                ev.preventDefault();
                activeRowIndex = (activeRowIndex + 1) % rows.length;
                updateSelectedRow(rows);
            } else if (ev.key === 'ArrowUp') {
                ev.preventDefault();
                activeRowIndex = (activeRowIndex - 1 + rows.length) % rows.length;
                updateSelectedRow(rows);
            } else if (ev.key === 'Enter') {
                if (activeRowIndex >= 0 && activeRowIndex < rows.length) {
                    ev.preventDefault();
                    rows[activeRowIndex].click();
                }
            } else if (ev.key === 'Escape') {
                closeClientDrawer();
                closeDrawer();
                if (typeof closeLossDrawer === 'function') closeLossDrawer();
            }
        });

        if ($('inpBulkFecha')) {
            $('inpBulkFecha').value = new Date().toISOString().split('T')[0];
        }

        function tickClock() {
            if ($('clock')) {
                $('clock').textContent = new Date().toLocaleString('es-AR', {
                    weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
                });
            }
        }
        tickClock();
        setInterval(tickClock, 30000);

        // Connection status monitoring
        function textoSync(marca) {
            const texto = String(marca || '').trim();
            if (!texto) return '';
            if (/^\d{2}\/\d{2}( \d{2}:\d{2})?$/.test(texto.slice(0, 14))) return texto.slice(0, 14);
            const fecha = new Date(texto);
            if (!Number.isNaN(fecha.getTime())) {
                const dia = String(fecha.getDate()).padStart(2, '0');
                const mes = String(fecha.getMonth() + 1).padStart(2, '0');
                const hora = String(fecha.getHours()).padStart(2, '0');
                const min = String(fecha.getMinutes()).padStart(2, '0');
                return dia + '/' + mes + ' ' + hora + ':' + min;
            }
            return texto.replace('T', ' ').slice(0, 16);
        }

        function textoBannerRed(sync, progreso) {
            const marca = sync || redCrm.sync || '—';
            const extra = progreso ? ' (Ventas: ' + progreso + ')' : '';
            if (window.__crmDesacoplado || !(navigator.onLine && redCrm.enLinea)) {
                return 'Modo offline — último dato ' + marca + extra;
            }
            return 'En línea — datos de la tienda al ' + marca + extra;
        }

        function marcarRed(enLinea, sync) {
            if (typeof enLinea === 'boolean') redCrm.enLinea = enLinea;
            if (sync) redCrm.sync = sync;
            pintarRed();
        }

        function pintarRed() {
            const enLinea = navigator.onLine && redCrm.enLinea;
            const sync = redCrm.sync;
            const horaMatch = String(sync || '').match(/(\d{2}:\d{2})/);
            const hora = horaMatch ? horaMatch[1] : '';
            let texto = 'Sin red';
            let modo = 'offline';
            if (enLinea) {
                texto = hora ? ('En línea · Sync ' + hora) : 'En línea';
                modo = 'online';
            } else if (sync) {
                texto = 'Modo offline · Último dato ' + sync;
                modo = 'reposo';
            }
            const pill = $('statusPill');
            const mobilePill = $('mobileConnPill');
            const mobileText = $('mobileConnText');
            if (pill) {
                pill.innerHTML = '<span class="pulse"></span> ' + texto;
                pill.style.background = modo === 'online' ? 'var(--success-muted)' : (modo === 'reposo' ? '#f1f5f9' : 'var(--danger-muted)');
                pill.style.color = modo === 'online' ? 'var(--success)' : (modo === 'reposo' ? '#475569' : 'var(--danger)');
                pill.style.border = '1px solid rgba(15, 23, 42, 0.08)';
            }
            if (mobilePill) {
                mobilePill.classList.toggle('online', modo === 'online');
                mobilePill.classList.toggle('reposo', modo === 'reposo');
                mobilePill.classList.toggle('offline', modo === 'offline');
                if (mobileText) mobileText.textContent = texto;
            }
        }

        function updateConnectionStatus(avisar) {
            if (!navigator.onLine) redCrm.enLinea = false;
            pintarRed();
            if (avisar && !navigator.onLine) toast('Sin conexión: mostrando el libro guardado en este aparato', true);
        }
        window.addEventListener('online', () => {
            redCrm.enLinea = true;
            updateConnectionStatus();
            void sincronizarSolicitudesPendientes();
            if (window.CrmLoader) CrmLoader.initSignalListener();
            void despertarNube().catch(() => {}).finally(() => recargarVistaViva());
        });
        window.addEventListener('offline', () => updateConnectionStatus(true));
        
        document.getElementById('offlineBadge')?.addEventListener('click', sincronizarSolicitudesPendientes);
        document.getElementById('contaCuerpo')?.addEventListener('click', (ev) => {
            const fila = ev.target.closest('[data-dig]');
            if (!fila || cajaPantalla !== 'digital') return;
            abrirCobroDigital(Number(fila.dataset.dig));
        });
        document.getElementById('ticketCuerpo')?.addEventListener('click', (ev) => {
            const fila = ev.target.closest('[data-ticket]');
            if (fila) void abrirTicket(fila.dataset.ticket);
        });
        document.getElementById('pedidosCuerpo')?.addEventListener('click', (ev) => {
            const sumar = ev.target.closest('[data-sumar]');
            if (sumar) {
                sumarAlCarrito(Number(sumar.dataset.sumar));
                return;
            }
            const fila = ev.target.closest('[data-pedido]');
            if (fila) abrirFaltante(Number(fila.dataset.pedido));
        });
        actualizarUIOffline();
        window.abrirNuevaVenta = function() {
            $('formRemito').reset();
            if (currentClientData) {
                $('inpVentaCliente').value = currentClientData.nombre;
                $('btnVolverVentasExpress').textContent = '← Volver al Perfil de ' + currentClientData.nombre;
            } else {
                $('btnVolverVentasExpress').textContent = '← Volver a opciones';
            }
            switchView('ventas-express');
            abrirSubVistaVentasExpress('ventasExpressNueva');
        }
        updateConnectionStatus();

        // PWA Installation handling
        let deferredPrompt;
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            const btn = $('btnInstallApp');
            const sect = $('installSection');
            if (btn) btn.style.display = 'flex';
            if (sect) sect.style.display = 'block';
        });

        $('btnInstallApp')?.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`PWA install prompt outcome: ${outcome}`);
            deferredPrompt = null;
            const btn = $('btnInstallApp');
            const sect = $('installSection');
            if (btn) btn.style.display = 'none';
            if (sect) sect.style.display = 'none';
        });

        window.addEventListener('appinstalled', () => {
            toast('¡Aplicación instalada con éxito!');
            const btn = $('btnInstallApp');
            const sect = $('installSection');
            if (btn) btn.style.display = 'none';
            if (sect) sect.style.display = 'none';
            localStorage.setItem('pwa_ios_hint_dismissed', '1');
            $('iosInstallBanner')?.classList.add('field-hidden');
        });

        async function renderFinanzasAging() {
            setLoading(true);
            try {
                const res = await api('/api/finanzas/aging');
                
                // Set total cards
                const t0_30 = $('ageTotal0_30');
                const t31_60 = $('ageTotal31_60');
                const t61_90 = $('ageTotal61_90');
                const t90_plus = $('ageTotal90_plus');
                
                if (t0_30) t0_30.innerHTML = fmtDual(res.totales['0_30'] || 0);
                if (t31_60) t31_60.innerHTML = fmtDual(res.totales['31_60'] || 0);
                if (t61_90) t61_90.innerHTML = fmtDual(res.totales['61_90'] || 0);
                if (t90_plus) t90_plus.innerHTML = fmtDual(res.totales['90_plus'] || 0);
                
                const tbody = $('tblFinanzasAging');
                if (tbody) {
                    tbody.innerHTML = '';
                    if (!res.clientes || res.clientes.length === 0) {
                        tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted);padding:16px;text-align:center">No hay clientes con saldo pendiente de pago.</td></tr>`;
                        return;
                    }
                    
                    const withBalance = res.clientes.filter(c => c.saldo_actual > 0);
                    if (withBalance.length === 0) {
                        tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted);padding:16px;text-align:center">No hay clientes con saldo pendiente de pago.</td></tr>`;
                        return;
                    }

                    withBalance.forEach(c => {
                        const tr = document.createElement('tr');
                        tr.innerHTML = `
                            <td><strong>${esc(c.nombre)}</strong></td>
                            <td>${fmtDual(c.saldo_actual)}</td>
                            <td>${c.buckets['0_30'] > 0 ? fmtDual(c.buckets['0_30']) : '—'}</td>
                            <td>${c.buckets['31_60'] > 0 ? fmtDual(c.buckets['31_60']) : '—'}</td>
                            <td>${c.buckets['61_90'] > 0 ? fmtDual(c.buckets['61_90']) : '—'}</td>
                            <td>${c.buckets['90_plus'] > 0 ? fmtDual(c.buckets['90_plus']) : '—'}</td>
                        `;
                        tbody.appendChild(tr);
                    });
                }
            } catch (e) {
                console.error("Error al cargar la antigüedad de deuda:", e);
                toast("Error al cargar reporte de antigüedad de deuda", true);
            } finally {
                setLoading(false);
            }
        }

        async function renderFinanzasMargenes() {
            setLoading(true);
            try {
                const res = await api('/api/finanzas/margenes?limit=200');
                const tbody = $('tblFinanzasMargenes');
                if (tbody) {
                    tbody.innerHTML = '';
                    if (!res || res.length === 0) {
                        tbody.innerHTML = `<tr><td colspan="8" style="color:var(--text-muted);padding:16px;text-align:center">No hay remitos de carga para analizar.</td></tr>`;
                        return;
                    }
                    
                    res.forEach(r => {
                        const tr = document.createElement('tr');
                        const pctColor = r.porcentaje_margen >= 15 ? 'var(--success)' : (r.porcentaje_margen >= 5 ? 'var(--warning)' : 'var(--danger)');
                        
                        tr.innerHTML = `
                            <td><strong>#${esc(r.id)}</strong></td>
                            <td>${esc(r.fecha)}</td>
                            <td>${fmt(r.kg)} kg</td>
                            <td>${fmtDual(r.precio_venta_total)}</td>
                            <td>${fmtDual(r.costo_carne)}</td>
                            <td>${fmtDual(r.costo_logistica)}</td>
                            <td><strong style="color: ${r.margen_neto >= 0 ? 'inherit' : 'var(--danger)'}">${fmtDual(r.margen_neto)}</strong></td>
                            <td><span class="badge" style="background-color: ${pctColor}22; color: ${pctColor}; font-weight: 700;">${r.porcentaje_margen.toFixed(1)}%</span></td>
                        `;
                        tbody.appendChild(tr);
                    });
                }
            } catch (e) {
                console.error("Error al cargar márgenes de venta:", e);
                toast("Error al cargar reporte de márgenes de venta", true);
            } finally {
                setLoading(false);
            }
        }

        function registerServiceWorker() {
            if (!('serviceWorker' in navigator)) return;
            navigator.serviceWorker.register('/sw.js').catch(e => console.warn('PWA SW err:', e));
        }

        function initIosInstallHint() {
            const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
            const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
            const dismissed = localStorage.getItem('pwa_ios_hint_dismissed');
            const banner = $('iosInstallBanner');
            if (isIos && !standalone && !dismissed && banner) {
                banner.classList.remove('field-hidden');
            }
            $('iosInstallDismiss')?.addEventListener('click', () => {
                localStorage.setItem('pwa_ios_hint_dismissed', '1');
                banner?.classList.add('field-hidden');
            });
        }

        function applyPwaDeepLink() {
            const params = new URLSearchParams(window.location.search);
            const view = params.get('view');
            if (view && titles[view]) {
                switchView(view);
            }
        }

        registerServiceWorker();
        initIosInstallHint();

        function wireCrmModules() {
            CrmDb.setEmpresaIdResolver(() => sessionUser?.empresa_id || 1);
            CrmBus.on('getData', () => data);
            CrmBus.on('setData', (d) => { data = d; });
            CrmBus.on('getSessionUser', () => sessionUser);
            CrmBus.on('toast', (msg, err) => toast(msg, err));
            CrmBus.on('setLoading', (on, texto) => setLoading(on, texto));
            CrmBus.on('renderAll', () => renderAll());
            CrmBus.on('safeRenderAll', () => safeRenderAll());
            CrmBus.on('loadAll', (opts) => loadAll(opts));
            CrmBus.on('loadSession', () => loadSession());
            CrmBus.on('hydrateSessionLocal', () => hydrateSessionLocal());
            CrmBus.on('switchView', (name) => switchView(name));
            CrmBus.on('libroNuevo', () => recargarVistaViva());
            CrmBus.on('pantallaModulo', (vista, id) => {
                if (vista === 'ticket') {
                    ventasPantalla = id || 'historial';
                    marcarEntrada('ticket');
                    const abierta = document.querySelector('.view.active');
                    if (abierta && abierta.id === 'view-ticket') {
                        void cargarJefe(ventasPantalla === 'desglose' ? 'desglose' : 'ticket');
                    }
                    return;
                }
                if (vista !== 'contabilidad') return;
                cajaPantalla = id || 'arqueo';
                if (cajaPantalla === 'digital') {
                    periodoDigital = 'Semana';
                    periodoDigitalDesde = '';
                    periodoDigitalHasta = '';
                    marcarEntrada('contabilidad');
                    void cargarPagoDigital();
                    return;
                }
                marcarEntrada('contabilidad');
                const vistaActiva = document.querySelector('.view.active');
                if (vistaActiva && vistaActiva.id === 'view-contabilidad') void cargarJefe('contabilidad');
            });
            CrmBus.on('applyPwaDeepLink', () => applyPwaDeepLink());
            CrmBus.on('aplicarCambioOptimista', (url, method, body) => aplicarCambioOptimista(url, method, body));
            CrmBus.on('aplicarOperacionOptimista', (payload, uuid) => aplicarOperacionOptimista(payload, uuid));
            CrmBus.on('persistirYRefrescarUI', () => persistirYRefrescarUI());
            CrmBus.on('recalcularMetricasLocales', () => recalcularMetricasLocales());
            CrmBus.on('getSelectedClienteId', () => selectedClienteId);
            CrmBus.on('getCurrentClientData', () => currentClientData);
            CrmBus.on('openClientDrawer', (id) => openClientDrawer(id));
            CrmBus.on('closeDrawer', () => closeDrawer());
            CrmBus.on('cerrarModalFacturaOriginal', () => cerrarModalFacturaOriginal());
            CrmBus.on('closeAuditModal', () => $('modalPasswordAuditoria')?.classList.remove('open'));
            CrmBus.on('getAuditDeletePassword', () => $('inpPasswordAuditoria')?.value || '');
            CrmBus.on('invalidateRemitosCache', () => invalidateRemitosFullCache());
            CrmBus.on('syncEmpresaFromServer', () => syncEmpresaFromServer());
            CrmBus.on('setSidebarOpen', (open) => setSidebarOpen(open));
        }

        function marcarVersion() {
            const marca = $('versionTag');
            if (!marca) return;
            marca.style.cursor = 'pointer';
            marca.title = 'Toca para forzar actualización';
            marca.onclick = async () => {
                if (confirm('¿Forzar actualización de la app y recargar?')) {
                    if ('serviceWorker' in navigator) {
                        try {
                            const regs = await navigator.serviceWorker.getRegistrations();
                            for (const r of regs) await r.unregister();
                        } catch (_) {}
                    }
                    if ('caches' in window) {
                        try {
                            const keys = await caches.keys();
                            for (const k of keys) await caches.delete(k);
                        } catch (_) {}
                    }
                    window.location.reload(true);
                }
            };
            fetch('/health', { cache: 'no-store' })
                .then((respuesta) => respuesta.ok ? respuesta.json() : null)
                .then((dato) => {
                    const numero = dato && dato.app_version;
                    if (numero) marca.textContent = 'v' + numero + ' PRO';
                })
                .catch(() => {});
        }

        function seguirCargaLibro() {
            const caja = $('cargaLibro');
            if (!caja) return;
            const texto = $('cargaLibroTexto');
            const cuenta = $('cargaLibroCuenta');
            const barra = $('cargaLibroBarra');
            let ocupado = false;
            const pintar = async () => {
                if (ocupado) return;
                ocupado = true;
                try {
                    const res = await fetch('/api/pos/carga', { cache: 'no-store' });
                    if (!res.ok) return;
                    const dato = await res.json();
                    const subidos = Number(dato.subidos) || 0;
                    const total = Number(dato.total) || subidos;
                    const completo = dato.completo || (total > 0 && subidos >= total);
                    if (!dato.visible || !dato.cargando || completo) {
                        if (completo && !window.__avisoSyncCompleto && total > 0) {
                            window.__avisoSyncCompleto = true;
                            if (typeof toast === 'function') {
                                toast('Sincronización completa: ventas al día (' + subidos.toLocaleString('es-AR') + ' / ' + total.toLocaleString('es-AR') + ')');
                            }
                        }
                        caja.hidden = true;
                        return;
                    }
                    window.__avisoSyncCompleto = false;
                    const pct = total > 0 ? Math.max(2, Math.min(100, Math.round((subidos / total) * 100))) : 0;
                    caja.hidden = false;
                    if (texto) {
                        texto.textContent = (dato.dia ? 'Sincronizando' : 'Subiendo ventas') +
                            ' (' + subidos.toLocaleString('es-AR') + ' / ' + total.toLocaleString('es-AR') + ')';
                    }
                    if (cuenta) {
                        cuenta.textContent = subidos.toLocaleString('es-AR') + ' / ' + total.toLocaleString('es-AR');
                    }
                    if (barra) barra.style.width = pct + '%';
                } catch (e) {
                } finally {
                    ocupado = false;
                }
            };
            void pintar();
            setInterval(pintar, 4000);
        }

        async function boot() {
            try {
                if (window.Nodo) {
                    Nodo.arrancar();
                    Nodo.alCambiar((pieza, consulta, dato) => {
                        if (!dato) return;
                        if (pieza === 'cartera' && window.CarteraLibro && CarteraLibro.recibir) {
                            const activa = document.querySelector('.view.active');
                            if (activa && activa.id === 'view-cartera') {
                                CarteraLibro.recibir(dato);
                            }
                            return;
                        }
                        const activa = document.querySelector('.view.active');
                        const name = activa ? activa.id.replace('view-', '') : '';
                        const panel = name === 'ticket' && ventasPantalla === 'desglose' ? 'desglose' : name;
                        if (piezaNodo(panel) !== pieza) return;
                        aplicarDatosJefe(panel, dato, false);
                        const syncTxt = (dato.vitrina && dato.vitrina.actualizado_en_texto) || textoSync(dato.actualizado_en);
                        marcarRed(true, syncTxt);
                    });
                }
                if (window.Espejo) {
                    Espejo.alActualizar(pintarDesdeEspejo);
                    void Espejo.asegurar();
                }
                const CRM_CACHE_EPOCH = '2026-11-17-epoch6';
                if (localStorage.getItem('crm_cache_epoch') !== CRM_CACHE_EPOCH) {
                    localStorage.setItem('crm_cache_epoch', CRM_CACHE_EPOCH);
                    localStorage.removeItem('crm_sucursales_cache');
                    localStorage.removeItem('crm-cartera-app');
                    for (let k of Object.keys(localStorage)) {
                        if (k.startsWith('crm_jefe_') || k.startsWith('crm_paneles_') || k.startsWith('nodo_')) {
                            localStorage.removeItem(k);
                        }
                    }
                    if (window.Espejo && Espejo.limpiarTodo) {
                        try { await Espejo.limpiarTodo(); } catch (_) {}
                    }
                    try { indexedDB.deleteDatabase('crm-nodo'); } catch (_) {}
                }
                marcarVersion();
                wireCrmModules();
                initBackupUi();
                seguirCargaLibro();
                cargarSucursalesSelector();
                $('topbarIcon')?.addEventListener('click', () => abrirSelectorSucursal());
                await CrmLoader.runBoot();
                setTimeout(() => arrancarLibroOffline(), 15000);
            } catch (e) {
                console.error('boot:', e);
                setLoading(false);
                data = ensureDataShape(data);
                switchView('reporte');
                toast('Error al cargar. Recargá la página.', true);
            }
        }

        window.loadAll = loadAll;
        window.descargarDatosDeLaNube = descargarDatosDeLaNube;

        async function updateWeather() {
            function fetchW(lat, lon) {
                fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`)
                    .then(r => r.json())
                    .then(data => {
                        const ww = $('weatherWidget');
                        if (ww && data && data.current_weather) ww.textContent = Math.round(data.current_weather.temperature) + '°';
                    }).catch(e => console.warn('Clima offline', e));
            }
            try {
                if ("geolocation" in navigator && window.isSecureContext) {
                    navigator.geolocation.getCurrentPosition(
                        pos => fetchW(pos.coords.latitude, pos.coords.longitude),
                        () => fetchW(-34.61, -58.38),
                        { timeout: 3000 }
                    );
                } else {
                    fetchW(-34.61, -58.38);
                }
            } catch (_) {
                fetchW(-34.61, -58.38);
            }
        }
        updateWeather();
        setInterval(updateWeather, 1800000); // 30 mins

        if ($('btnVolverCartera')) $('btnVolverCartera').addEventListener('click', () => switchView('admin'));

        boot();
        if ($('kpiMeta')) setInterval(() => void loadAll({ enSegundoPlano: true, bloquearUI: false }), 60000);
        setInterval(async () => {
            if (!navigator.onLine) return;
            const pending = await countPendingOutbox();
            if (pending > 0) void dispararSyncInmediato();
        }, 12000);