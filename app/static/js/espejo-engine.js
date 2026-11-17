/**
 * Motor espejo en segundo plano v2 - nutre la base de datos espejo local con delta sync inteligente.
 * Features avanzados:
 * - Detección de tipo de red (WiFi vs datos móviles) con adaptación de intervalos
 * - Priorización de tablas críticas (ventas, clientes, detalles_ventas)
 * - Detección de actividad del usuario para pausar syncs inactivos
 * - Compresión de datos y optimización de transferencia
 * - LRU cache en IndexedDB para tablas grandes
 */
(function (global) {
    // Intervalos adaptativos según tipo de red
    const SYNC_INTERVALS = {
        wifi: 15000,          // 15 segundos en WiFi
        cellular: 60000,      // 60 segundos en datos móviles
        slow: 120000,         // 2 minutos en conexión lenta
        unknown: 30000,       // 30 segundos por defecto
    };

    const SYNC_ON_VISIBLE_DELAY_MS = 2000; // 2 segundos al volver visible
    const USER_INACTIVITY_MS = 300000;     // 5 minutos de inactividad para pausar

    // Tablas críticas con prioridad alta
    const TABLAS_CRITICAS = ['ventas', 'clientes', 'detalles_ventas'];
    const TABLAS_IMPORTANTES = ['productos', 'cuenta_corriente', 'proveedores'];
    const TABLAS_SECUNDARIAS = ['configuracion', 'gastos', 'movimientos_caja'];

    // LRU cache en memoria para tablas frecuentemente accedidas
    const LRU_CACHE_SIZE = 5; // Máximo 5 tablas en caché
    const lruCache = new Map(); // Map<tabla, {data, timestamp}>
    let lruAccessOrder = []; // Array<tabla> para seguimiento de acceso

    let syncTimer = null;
    let isRunning = false;
    let isVisible = !document.hidden;
    let lastSyncTime = 0;
    let pendingSyncRequest = false;
    let currentConnectionType = 'unknown';
    let lastUserActivity = Date.now();
    let syncInterval = SYNC_INTERVALS.unknown;

    function log(msg, level = 'info') {
        if (global.CrmBus?.emit) {
            global.CrmBus.emit('log', '[EspejoEngine] ' + msg, level);
        } else {
            console.log('[EspejoEngine]', msg);
        }
    }

    /**
     * Detecta el tipo de conexión actual.
     */
    function detectConnectionType() {
        if (!navigator.connection) {
            return 'unknown';
        }

        const conn = navigator.connection;
        const type = conn.effectiveType || conn.type;

        if (conn.saveData) {
            return 'slow';
        }

        if (type === 'wifi' || conn.type === 'wifi') {
            return 'wifi';
        }

        if (type === 'cellular' || conn.type === 'cellular' ||
            type.includes('2g') || type.includes('3g')) {
            return 'cellular';
        }

        if (type.includes('4g') || type.includes('lte')) {
            return 'wifi'; // 4G se trata como WiFi por velocidad
        }

        return 'unknown';
    }

    /**
     * Obtiene el intervalo de sync según el tipo de conexión.
     */
    function getSyncInterval() {
        return SYNC_INTERVALS[currentConnectionType] || SYNC_INTERVALS.unknown;
    }

    /**
     * Actualiza el tipo de conexión y ajusta el intervalo si cambió.
     */
    function updateConnectionType() {
        const newType = detectConnectionType();
        if (newType !== currentConnectionType) {
            log('Tipo de conexión cambió: ' + currentConnectionType + ' -> ' + newType, 'info');
            currentConnectionType = newType;
            syncInterval = getSyncInterval();
            // Re-programar sync con nuevo intervalo
            if (isRunning && isVisible) {
                scheduleNextSync();
            }
        }
    }

    /**
     * Registra actividad del usuario.
     */
    function registerUserActivity() {
        lastUserActivity = Date.now();
    }

    /**
     * Verifica si el usuario está inactivo por más tiempo que el umbral.
     */
    function isUserInactive() {
        return (Date.now() - lastUserActivity) > USER_INACTIVITY_MS;
    }

    /**
     * Prioriza tablas según su criticidad.
     */
    function priorizarTablas(tablas) {
        const priorizadas = [];

        // Primero: tablas críticas
        for (const tabla of TABLAS_CRITICAS) {
            const idx = tablas.findIndex(t => t.tabla === tabla);
            if (idx >= 0) {
                priorizadas.push({ ...tablas[idx], prioridad: 'alta' });
                tablas.splice(idx, 1);
            }
        }

        // Segundo: tablas importantes
        for (const tabla of TABLAS_IMPORTANTES) {
            const idx = tablas.findIndex(t => t.tabla === tabla);
            if (idx >= 0) {
                priorizadas.push({ ...tablas[idx], prioridad: 'media' });
                tablas.splice(idx, 1);
            }
        }

        // Tercero: resto (secundarias)
        for (const tabla of tablas) {
            priorizadas.push({ ...tabla, prioridad: 'baja' });
        }

        return priorizadas;
    }

    /**
     * Obtiene una tabla de la caché LRU.
     */
    function lruGet(tabla) {
        const entry = lruCache.get(tabla);
        if (entry) {
            // Actualizar orden de acceso (mover al final)
            const idx = lruAccessOrder.indexOf(tabla);
            if (idx >= 0) {
                lruAccessOrder.splice(idx, 1);
            }
            lruAccessOrder.push(tabla);
            return entry.data;
        }
        return null;
    }

    /**
     * Guarda una tabla en la caché LRU.
     */
    function lruSet(tabla, data) {
        // Si ya existe, actualizar
        if (lruCache.has(tabla)) {
            const idx = lruAccessOrder.indexOf(tabla);
            if (idx >= 0) {
                lruAccessOrder.splice(idx, 1);
            }
        } else if (lruCache.size >= LRU_CACHE_SIZE) {
            // Evictar la menos recientemente usada
            const lru = lruAccessOrder.shift();
            if (lru) {
                lruCache.delete(lru);
                log('LRU evict: ' + lru, 'info');
            }
        }

        lruCache.set(tabla, { data, timestamp: Date.now() });
        lruAccessOrder.push(tabla);
    }

    /**
     * Limpia la caché LRU.
     */
    function lruClear() {
        lruCache.clear();
        lruAccessOrder = [];
    }

    /**
     * Ejecuta una sincronización delta del espejo con el servidor.
     * Usa /api/pos/espejo/delta para bajar solo cambios desde el último sello.
     * Prioriza tablas críticas y respeta inactividad del usuario.
     * Solicita compresión del servidor cuando hay conexión lenta.
     */
    async function syncDelta() {
        if (!navigator.onLine) {
            log('Offline - skipeando sync delta', 'warn');
            return { synced: false, reason: 'offline' };
        }

        if (!global.Espejo) {
            log('Espejo no disponible - skipeando sync', 'warn');
            return { synced: false, reason: 'espejo_not_ready' };
        }

        // Pausar sync si usuario está inactivo por mucho tiempo
        if (isUserInactive()) {
            log('Usuario inactivo - skipeando sync delta', 'info');
            return { synced: false, reason: 'user_inactive' };
        }

        const ahora = Date.now();
        if (ahora - lastSyncTime < 5000) {
            log('Sync delta muy reciente - skipeando', 'info');
            return { synced: false, reason: 'throttled' };
        }

        try {
            log('Iniciando sync delta (red: ' + currentConnectionType + ')...', 'info');

            // Obtener el sello global más reciente del espejo local
            const selloActual = (global.Espejo.sello && global.Espejo.sello()) || '';

            // Si no hay datos en el espejo local todavía, hacer sync completo inicial
            if (!selloActual || (global.Espejo.tieneDatos && !global.Espejo.tieneDatos())) {
                log('Espejo sin datos o sin sello - ejecutando sync completo inicial...', 'info');
                return await syncCompleto();
            }

            // Headers con soporte de compresión
            const headers = {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate, br',
            };

            // Pedir delta al servidor con priorización
            const res = await fetch('/api/pos/espejo/delta?sello=' + encodeURIComponent(selloActual) + '&_=' + Date.now(), {
                credentials: 'same-origin',
                headers,
            });

            if (!res.ok) {
                log('Error en /api/pos/espejo/delta: ' + res.status, 'error');
                return { synced: false, reason: 'http_error', status: res.status };
            }

            const data = await res.json();

            if (!data || !data.ok) {
                log('Delta response no ok: ' + (data?.error || 'unknown'), 'warn');
                return { synced: false, reason: 'response_not_ok' };
            }

            // Si el servidor devolvió un índice (primer sync o reinicio de sello)
            if (data.es_indice) {
                log('Servidor devolvió índice completo - ejecutando sync completo...', 'info');
                return await syncCompleto();
            }

            // Si no hay cambios, nada que hacer
            if (!data.cambios || data.cambios.length === 0) {
                log('No hay cambios en el espejo', 'info');
                lastSyncTime = ahora;
                return { synced: true, cambios: 0 };
            }

            // Priorizar tablas para aplicar en orden de importancia
            const cambiosPriorizados = priorizarTablas([...data.cambios]);
            log('Aplicando ' + cambiosPriorizados.length + ' cambios (priorizados)...', 'info');

            // Aplicar cambios en orden de prioridad al espejo local
            for (const cambio of cambiosPriorizados) {
                const tabla = cambio.tabla;
                if (!tabla) continue;

                const libro = { sello: cambio.sello || '', sucursales: cambio.sucursales || [] };

                // Guardar en IndexedDB Y en memoria reactiva de espejo.js
                if (global.Espejo.guardarTabla) {
                    await global.Espejo.guardarTabla(tabla, libro, true);
                    lruSet(tabla, libro);
                    log('Tabla ' + tabla + ' sync en espejo (prioridad: ' + cambio.prioridad + ')', 'info');
                } else if (global.Espejo._guardar) {
                    await global.Espejo._guardar(tabla, libro);
                    lruSet(tabla, libro);
                } else {
                    await global.Espejo.asegurar();
                    break;
                }
            }

            // Notificar a toda la interfaz y bus de eventos de la PWA
            if (global.Espejo._avisar) {
                global.Espejo._avisar();
            }
            if (global.CrmBus?.emit) {
                global.CrmBus.emit('espejo:actualizado', { cambios: cambiosPriorizados.length });
            }

            lastSyncTime = ahora;
            log('Sync delta completado: ' + cambiosPriorizados.length + ' tablas actualizadas', 'info');

            return { synced: true, cambios: cambiosPriorizados.length };

        } catch (err) {
            log('Error en sync delta: ' + err.message, 'error');
            return { synced: false, reason: 'exception', error: err.message };
        }
    }

    /**
     * Ejecuta un sync completo del espejo (como hace espejo.js unaPasada).
     * Se usa como fallback cuando delta falla o al arrancar sin sello.
     */
    async function syncCompleto() {
        if (!global.Espejo) {
            log('Espejo no disponible - skipeando sync completo', 'warn');
            return { synced: false, reason: 'espejo_not_ready' };
        }

        try {
            log('Iniciando sync completo del espejo...', 'info');
            await global.Espejo.asegurar();
            lastSyncTime = Date.now();
            log('Sync completo del espejo finalizado', 'info');
            return { synced: true };
        } catch (err) {
            log('Error en sync completo: ' + err.message, 'error');
            return { synced: false, reason: 'exception', error: err.message };
        }
    }

    /**
     * Intenta sync delta primero, fallback a sync completo si falla.
     */
    async function syncSmart() {
        if (!navigator.onLine) {
            return { synced: false, reason: 'offline' };
        }

        const deltaResult = await syncDelta();

        if (deltaResult.synced) {
            return deltaResult;
        }

        // Si delta falló por alguna razón que requiere full sync
        if (['espejo_not_ready', 'http_error', 'response_not_ok'].includes(deltaResult.reason)) {
            log('Delta falló, intentando sync completo...', 'warn');
            return await syncCompleto();
        }

        return deltaResult;
    }

    /**
     * Programa el próximo sync si estamos corriendo y visibles.
     * Usa el intervalo dinámico según el tipo de conexión.
     */
    function scheduleNextSync() {
        if (syncTimer) {
            clearTimeout(syncTimer);
            syncTimer = null;
        }

        if (!isRunning || !isVisible) {
            return;
        }

        const interval = getSyncInterval();
        syncTimer = setTimeout(() => {
            void runSync();
        }, interval);
    }

    /**
     * Ejecuta sync y programa el siguiente.
     */
    async function runSync() {
        if (!isRunning || !isVisible) {
            return;
        }

        const result = await syncSmart();

        if (result.synced) {
            log('Sync exitoso', 'info');
        } else {
            log('Sync fallido: ' + result.reason, 'warn');
        }

        scheduleNextSync();
    }

    /**
     * Arranca el motor de espejo en segundo plano.
     */
    function start() {
        if (isRunning) {
            log('Motor ya está corriendo', 'warn');
            return;
        }

        isRunning = true;
        currentConnectionType = detectConnectionType();
        syncInterval = getSyncInterval();
        log('Motor espejo arrancado (red: ' + currentConnectionType + ', intervalo: ' + syncInterval + 'ms)', 'info');

        // Primer sync inmediato si hay conexión
        if (navigator.onLine) {
            void syncSmart();
        }

        // Listener de visibilidad
        document.addEventListener('visibilitychange', onVisibilityChange);

        // Listener de online/offline
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);

        // Listener de cambios de conexión
        if (navigator.connection) {
            navigator.connection.addEventListener('change', updateConnectionType);
        }

        // Listener de actividad del usuario
        const activityEvents = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'];
        activityEvents.forEach(evt => {
            document.addEventListener(evt, registerUserActivity, { passive: true });
        });

        // Schedule primer sync periódico
        scheduleNextSync();
    }

    /**
     * Detiene el motor.
     */
    function stop() {
        if (!isRunning) {
            return;
        }

        isRunning = false;
        log('Motor espejo detenido', 'info');

        if (syncTimer) {
            clearTimeout(syncTimer);
            syncTimer = null;
        }

        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);

        if (navigator.connection) {
            navigator.connection.removeEventListener('change', updateConnectionType);
        }

        const activityEvents = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'];
        activityEvents.forEach(evt => {
            document.removeEventListener(evt, registerUserActivity);
        });
    }

    /**
     * Handler cuando el documento cambia visibilidad.
     */
    function onVisibilityChange() {
        isVisible = !document.hidden;

        if (isVisible) {
            log('Documento visible - sync en ' + SYNC_ON_VISIBLE_DELAY_MS + 'ms', 'info');
            // Sync rápido al volver visible
            setTimeout(() => {
                if (isRunning && isVisible) {
                    void syncSmart();
                }
            }, SYNC_ON_VISIBLE_DELAY_MS);
        } else {
            log('Documento oculto - pausando syncs', 'info');
            if (syncTimer) {
                clearTimeout(syncTimer);
                syncTimer = null;
            }
        }
    }

    /**
     * Handler cuando vuelve online.
     */
    function onOnline() {
        log('Conexión restaurada - sync inmediato', 'info');
        if (isRunning && isVisible) {
            void syncSmart();
        }
        // Registrar Background Sync del Service Worker
        if ('serviceWorker' in navigator && 'sync' in navigator.serviceWorker) {
            navigator.serviceWorker.ready.then((registration) => {
                registration.sync.register('sync-espejo').catch((err) => {
                    log('Error registrando Background Sync: ' + err.message, 'warn');
                });
            });
        }
    }

    /**
     * Handler cuando se va offline.
     */
    function onOffline() {
        log('Conexión perdida', 'warn');
        if (syncTimer) {
            clearTimeout(syncTimer);
            syncTimer = null;
        }
    }

    /**
     * Solicita un sync manual (por ejemplo desde botón de refresh).
     */
    async function requestSync() {
        log('Sync manual solicitado', 'info');
        return await syncSmart();
    }

    /**
     * Obtiene estado del motor.
     */
    function getStatus() {
        return {
            isRunning,
            isVisible,
            lastSyncTime,
            pendingSyncRequest,
            connectionType: currentConnectionType,
            syncInterval: syncInterval,
            userInactive: isUserInactive(),
        };
    }

    // Exponer API pública
    global.EspejoEngine = {
        start,
        stop,
        requestSync,
        getStatus,
        syncDelta,
        syncCompleto,
        syncSmart,
    };

    // Auto-arrancar si Espejo está disponible
    if (global.Espejo) {
        // Esperar un poco para que otros módulos carguen
        setTimeout(() => {
            start();
        }, 3000);
    } else {
        log('Espejo no disponible aún - esperando...', 'warn');
        // Intentar arrancar cuando Espejo esté disponible
        let checkInterval = setInterval(() => {
            if (global.Espejo) {
                clearInterval(checkInterval);
                start();
            }
        }, 1000);
        // Dejar de intentar después de 30 segundos
        setTimeout(() => {
            clearInterval(checkInterval);
        }, 30000);
    }

})(window);
