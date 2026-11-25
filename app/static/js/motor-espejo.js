/**
 * MotorEspejo.js - Cobro Fácil
 * Arquitectura Local-First de Alto Rendimiento sobre Dexie.js (IndexedDB).
 * 
 * Características:
 * 1. Capa Única de Datos Local (0ms de latencia, desacoplada de la red).
 * 2. Tablas indexadas B-Tree con soporte nativo para multi-sucursal (sucursal_id).
 * 3. Patrón Repositorio limpio (preparado para cambiar a SQLite nativo en Capacitor).
 * 4. Sincronización Delta inteligente en background sin spinners bloqueantes.
 * 5. Cero dependencias de headers COOP/COEP (sin SQLite WASM).
 */

(function (global) {
    'use strict';

    if (typeof Dexie === 'undefined') {
        console.error('[MotorEspejo] Dexie.js no está cargado. Asegurar /static/vendor/dexie.min.js');
        return;
    }

    const db = new Dexie('CobroFacilMotorEspejo');

    db.version(1).stores({
        sucursales: 'id, nombre, activo',
        pcs: 'id, identificador_pc, sucursal_id, nombre, activo',
        inventario: 'id, sucursal_id, codigo, nombre, departamento, precio, stock, es_pesable, [sucursal_id+codigo], [sucursal_id+departamento], updated_at',
        ventas: 'id, sucursal_id, fecha, dia, total, estado, metodo_pago, [sucursal_id+dia], [sucursal_id+metodo_pago], updated_at',
        ventas_items: 'id, id_venta, sucursal_id, id_producto, [sucursal_id+id_venta]',
        cuenta_corriente: 'id, sucursal_id, cliente_id, fecha, dia, tipo, monto, saldo_resultante, [sucursal_id+dia], [sucursal_id+cliente_id], updated_at',
        cartera: 'id, sucursal_id, pos_id, nombre, cuit, telefono, deuda_pos, saldo_actual, [sucursal_id+pos_id], updated_at',
        pedidos_web: 'id, sucursal_id, cliente_nombre, estado, total, created_at, updated_at',
        resumenes_diarios: 'dia, sucursal_id, [sucursal_id+dia]',
        sync_meta: 'key'
    });

    let syncTimer = null;
    let syncIntervalMs = 25000; // 25s por defecto
    let isSyncing = false;
    let eventListeners = [];

    // Helper: Formato de fecha YYYY-MM-DD
    function diaDe(fechaStr) {
        if (!fechaStr) return '';
        const s = String(fechaStr).trim();
        return s.slice(0, 10);
    }

    function _sidInt(sid) {
        if (sid === null || sid === undefined || sid === '' || sid === 'Todas' || sid === 'todas' || sid === 'all') {
            return null;
        }
        const n = Number(sid);
        return isNaN(n) ? null : n;
    }

    // =========================================================================
    // 🏛️ REPOSITORIO DE DATOS LOCALES (Acceso instantáneo 0ms)
    // =========================================================================

    const Repositorio = {
        /**
         * Retorna el inventario filtrado estrictamente por sucursal.
         * Si la sucursal no tiene stock o cajas asignadas, devuelve [] en 0ms.
         */
        async getInventario(sucursalId) {
            const sid = _sidInt(sucursalId);
            if (sid !== null) {
                return await db.inventario.where('sucursal_id').equals(sid).toArray();
            }
            return await db.inventario.toArray();
        },

        /**
         * Retorna el arqueo de caja del día solicitado (ventas + cobros de clientes).
         */
        async getCaja(sucursalId, fechaDia) {
            const sid = _sidInt(sucursalId);
            const diaBuscado = fechaDia || diaDe(new Date().toISOString());

            let ventasFiltradas = [];
            let ccFiltradas = [];

            if (sid !== null) {
                ventasFiltradas = await db.ventas
                    .where('[sucursal_id+dia]')
                    .equals([sid, diaBuscado])
                    .toArray();

                ccFiltradas = await db.cuenta_corriente
                    .where('[sucursal_id+dia]')
                    .equals([sid, diaBuscado])
                    .toArray();
            } else {
                ventasFiltradas = await db.ventas
                    .where('dia')
                    .equals(diaBuscado)
                    .toArray();

                ccFiltradas = await db.cuenta_corriente
                    .where('dia')
                    .equals(diaBuscado)
                    .toArray();
            }

            // Excluir canceladas
            const CANCELADAS = { CANCELADA: 1, ANULADA: 1, CANCELADO: 1, ANULADO: 1, RECHAZADO: 1 };
            const ventasActivas = ventasFiltradas.filter(v => !CANCELADAS[String(v.estado || '').toUpperCase()]);

            const desglose = {};
            let totalVentas = 0;

            for (const v of ventasActivas) {
                const met = String(v.metodo_pago || 'Efectivo').trim();
                const tot = Number(v.total) || 0;
                totalVentas += tot;
                if (!desglose[met]) {
                    desglose[met] = { tickets: 0, total: 0 };
                }
                desglose[met].tickets += 1;
                desglose[met].total += tot;
            }

            // Cobros de deuda (Abonos de clientes)
            const cobrosClientes = ccFiltradas.filter(c => String(c.tipo || '').toUpperCase() === 'ABONO');
            let totalCobrosDeuda = 0;
            for (const c of cobrosClientes) {
                totalCobrosDeuda += (Number(c.monto) || 0);
            }

            return {
                dia: diaBuscado,
                sucursal_id: sid,
                total_ventas: totalVentas,
                cantidad_tickets: ventasActivas.length,
                medios_pago: desglose,
                cobros_deuda: {
                    total: totalCobrosDeuda,
                    cantidad: cobrosClientes.length,
                    items: cobrosClientes
                },
                total_ingresos_caja: totalVentas + totalCobrosDeuda
            };
        },

        /**
         * Retorna ventas en un rango de fechas.
         */
        async getVentas(sucursalId, desdeDia, hastaDia) {
            const sid = _sidInt(sucursalId);
            const d1 = desdeDia || '2000-01-01';
            const d2 = hastaDia || '2099-12-31';

            let col = db.ventas.where('dia').between(d1, d2, true, true);
            let lista = await col.toArray();
            if (sid !== null) {
                lista = lista.filter(v => v.sucursal_id === sid);
            }
            return lista;
        },

        /**
         * Resuelve el historial completo de un cliente desde IndexedDB en 0ms.
         * Evita el spinner "Cargando el libro...".
         */
        async getHistorialCliente(posId, sucursalId) {
            const sid = _sidInt(sucursalId);
            const pId = Number(posId);

            let movs = [];
            if (!isNaN(pId)) {
                if (sid !== null) {
                    movs = await db.cuenta_corriente
                        .where('[sucursal_id+cliente_id]')
                        .equals([sid, pId])
                        .toArray();
                } else {
                    movs = await db.cuenta_corriente
                        .where('cliente_id')
                        .equals(pId)
                        .toArray();
                }
            }

            // Ordenar por fecha descendente
            movs.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
            return {
                cliente_id: pId,
                sucursal_id: sid,
                movimientos: movs,
                total_movimientos: movs.length
            };
        },

        /**
         * Retorna la cartera de clientes de la sucursal.
         */
        async getCartera(sucursalId) {
            const sid = _sidInt(sucursalId);
            if (sid !== null) {
                return await db.cartera.where('sucursal_id').equals(sid).toArray();
            }
            return await db.cartera.toArray();
        },

        /**
         * Retorna pedidos de reparto web.
         */
        async getPedidos(sucursalId) {
            const sid = _sidInt(sucursalId);
            if (sid !== null) {
                return await db.pedidos_web.where('sucursal_id').equals(sid).toArray();
            }
            return await db.pedidos_web.toArray();
        },

        /**
         * Retorna lista de sucursales locales.
         */
        async getSucursales() {
            return await db.sucursales.where('activo').equals(1).toArray();
        }
    };

    // =========================================================================
    // 🔄 INGESTIÓN RÁPIDA DESDE EL FORMATO ACTUAL (Bridge / Migración Silenciosa)
    // =========================================================================

    /**
     * Ingesta lotes de filas (formato columnas + array de arrays) hacia Dexie
     * de forma transaccional ultrarrápida.
     */
    async function ingerirTablaMatriz(nombreTabla, columnas, filas, sucursalIdPorDefecto = 1) {
        if (!Array.isArray(columnas) || !Array.isArray(filas) || !filas.length) return 0;

        const idx = {};
        columnas.forEach((col, i) => { idx[String(col).toLowerCase()] = i; });

        const ahora = new Date().toISOString();

        if (nombreTabla === 'ventas') {
            const batch = filas.map(f => {
                const idVal = f[idx['id']];
                const fechaVal = f[idx['fecha']] || f[idx['fecha_hora']] || ahora;
                const sid = f[idx['sucursal_id']] !== undefined ? f[idx['sucursal_id']] : sucursalIdPorDefecto;
                return {
                    id: Number(idVal) || idVal,
                    sucursal_id: Number(sid) || 1,
                    fecha: String(fechaVal),
                    dia: diaDe(fechaVal),
                    total: Number(f[idx['total']]) || 0,
                    estado: String(f[idx['estado']] || 'COMPLETADA').toUpperCase(),
                    metodo_pago: String(f[idx['metodo_pago']] || 'Efectivo'),
                    cliente_nombre: f[idx['cliente_nombre']] || '',
                    updated_at: ahora
                };
            });
            await db.ventas.bulkPut(batch);
            return batch.length;
        }

        if (nombreTabla === 'detalles_ventas' || nombreTabla === 'ventas_items') {
            const batch = filas.map(f => {
                const idVal = f[idx['id']];
                const idVenta = f[idx['id_venta']] || f[idx['venta_id']];
                const sid = f[idx['sucursal_id']] !== undefined ? f[idx['sucursal_id']] : sucursalIdPorDefecto;
                return {
                    id: Number(idVal) || idVal,
                    id_venta: Number(idVenta) || idVenta,
                    sucursal_id: Number(sid) || 1,
                    id_producto: f[idx['id_producto']] || '',
                    nombre_producto: f[idx['nombre_producto']] || f[idx['nombre']] || '',
                    cantidad: Number(f[idx['cantidad']]) || 1,
                    precio: Number(f[idx['precio_unitario']] || f[idx['precio']]) || 0,
                    subtotal: Number(f[idx['subtotal']]) || 0
                };
            });
            await db.ventas_items.bulkPut(batch);
            return batch.length;
        }

        if (nombreTabla === 'cuenta_corriente') {
            const batch = filas.map(f => {
                const idVal = f[idx['id']];
                const fechaVal = f[idx['fecha']] || ahora;
                const sid = f[idx['sucursal_id']] !== undefined ? f[idx['sucursal_id']] : sucursalIdPorDefecto;
                return {
                    id: Number(idVal) || idVal,
                    sucursal_id: Number(sid) || 1,
                    cliente_id: Number(f[idx['cliente_id']]) || null,
                    fecha: String(fechaVal),
                    dia: diaDe(fechaVal),
                    tipo: String(f[idx['tipo']] || 'ABONO').toUpperCase(),
                    monto: Number(f[idx['monto']]) || 0,
                    saldo_resultante: Number(f[idx['saldo_resultante']]) || 0,
                    descripcion: f[idx['descripcion']] || '',
                    medio_pago: f[idx['medio_pago']] || '',
                    updated_at: ahora
                };
            });
            await db.cuenta_corriente.bulkPut(batch);
            return batch.length;
        }

        if (nombreTabla === 'productos' || nombreTabla === 'articulos') {
            const batch = filas.map(f => {
                const idVal = f[idx['id']];
                const sid = f[idx['sucursal_id']] !== undefined ? f[idx['sucursal_id']] : sucursalIdPorDefecto;
                return {
                    id: Number(idVal) || idVal,
                    sucursal_id: Number(sid) || 1,
                    codigo: String(f[idx['codigo']] || ''),
                    nombre: String(f[idx['nombre']] || ''),
                    departamento: String(f[idx['departamento']] || f[idx['categoria']] || 'GENERAL'),
                    precio: Number(f[idx['precio']]) || 0,
                    stock: Number(f[idx['stock']]) || 0,
                    es_pesable: Number(f[idx['es_pesable']]) || 0,
                    updated_at: ahora
                };
            });
            await db.inventario.bulkPut(batch);
            return batch.length;
        }

        if (nombreTabla === 'clientes') {
            const batch = filas.map(f => {
                const idVal = f[idx['id']];
                const sid = f[idx['sucursal_id']] !== undefined ? f[idx['sucursal_id']] : sucursalIdPorDefecto;
                return {
                    id: Number(idVal) || idVal,
                    sucursal_id: Number(sid) || 1,
                    pos_id: Number(f[idx['pos_id']]) || Number(idVal),
                    nombre: String(f[idx['nombre']] || ''),
                    telefono: f[idx['telefono']] || '',
                    cuit: f[idx['cuit']] || f[idx['dni']] || '',
                    deuda_pos: Number(f[idx['deuda_pos']] || f[idx['saldo']] || f[idx['deuda_actual']]) || 0,
                    saldo_actual: Number(f[idx['saldo_actual']]) || 0,
                    techo_deuda: Number(f[idx['techo_deuda']] || f[idx['limite_credito']]) || 0,
                    updated_at: ahora
                };
            });
            await db.cartera.bulkPut(batch);
            return batch.length;
        }

        return 0;
    }

    /**
     * Puente con window.Espejo: si window.Espejo ya tiene tablas en memoria,
     * las ingesta silenciosamente en Dexie para poblar los índices B-Tree.
     */
    async function sincronizarDesdeEspejoMemoria() {
        if (!global.Espejo || typeof global.Espejo.tabla !== 'function') return;

        const tablas = ['ventas', 'detalles_ventas', 'productos', 'cuenta_corriente', 'clientes'];
        for (const t of tablas) {
            const dato = global.Espejo.tabla(t);
            if (dato && Array.isArray(dato.columnas) && Array.isArray(dato.filas) && dato.filas.length) {
                try {
                    await ingerirTablaMatriz(t, dato.columnas, dato.filas, 1);
                } catch (err) {
                    console.warn('[MotorEspejo] Error sincronizando tabla desde Espejo:', t, err);
                }
            }
        }
    }

    // =========================================================================
    // 📡 SINCRONIZADOR DELTA EN SEGUNDO PLANO (Silencioso y sin bloqueos)
    // =========================================================================

    async function ejecutarSyncDelta() {
        if (isSyncing || document.hidden) return;
        isSyncing = true;

        try {
            const meta = await db.sync_meta.get('ultimo_sync');
            const ultimoSello = meta ? meta.sello : '';

            // Consultar deltas del backend
            const url = '/api/pos/espejo/delta?sello=' + encodeURIComponent(ultimoSello);
            const res = await fetch(url, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();
                if (data && data.tablas && Object.keys(data.tablas).length > 0) {
                    let totalIngerido = 0;
                    for (const [nomTabla, payload] of Object.entries(data.tablas)) {
                        if (payload && payload.columnas && payload.filas) {
                            const c = await ingerirTablaMatriz(nomTabla, payload.columnas, payload.filas, 1);
                            totalIngerido += c;
                        }
                    }

                    if (data.sello_nuevo) {
                        await db.sync_meta.put({ key: 'ultimo_sync', sello: data.sello_nuevo, updated_at: Date.now() });
                    }

                    if (totalIngerido > 0) {
                        notificarActualizacion('delta', { totalIngerido });
                    }
                }
            }
        } catch (err) {
            // Falla de red silenciosa: en offline seguimos trabajando con la base local
        } finally {
            isSyncing = false;
        }
    }

    function iniciarSyncBackground() {
        if (syncTimer) clearInterval(syncTimer);
        // Sincronización inicial rápida
        setTimeout(() => {
            sincronizarDesdeEspejoMemoria().then(() => {
                ejecutarSyncDelta();
            });
        }, 1200);

        // Timer adaptativo
        syncTimer = setInterval(ejecutarSyncDelta, syncIntervalMs);

        // Reactivar al volver la pestaña visible
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                ejecutarSyncDelta();
            }
        });
    }

    function notificarActualizacion(tipo, datos) {
        eventListeners.forEach(fn => {
            try { fn(tipo, datos); } catch (_) {}
        });
        if (global.CrmBus && typeof global.CrmBus.emit === 'function') {
            global.CrmBus.emit('motor-espejo:actualizado', { tipo, datos });
        }
        window.dispatchEvent(new CustomEvent('motor-espejo:actualizado', { detail: { tipo, datos } }));
    }

    // =========================================================================
    // 🚀 EXPOSICIÓN GLOBAL
    // =========================================================================

    global.MotorEspejo = {
        db,
        ...Repositorio,
        ingerirTablaMatriz,
        sincronizarDesdeEspejoMemoria,
        ejecutarSyncDelta,
        iniciarSyncBackground,
        alActualizar(fn) {
            if (typeof fn === 'function') eventListeners.push(fn);
        }
    };

    // Auto-arranque
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciarSyncBackground);
    } else {
        iniciarSyncBackground();
    }

})(window);
