/**
 * Cerebro Frontend de Caja (app/static/js/barra/caja/caja-motor.js).
 *
 * Responsabilidad:
 * - Orquestar las consultas de caja y arqueo diario multi-sucursal.
 * - Cruce seguro con el Espejo local IndexedDB tolerando offline y frío sin excepciones.
 * - Consulta asíncrona a /api/pos/jefe y Nodo.
 *
 * REGLA DE ARQUITECTURA: Cerebro puro. Cero manipulación de DOM o HTML.
 */
(function (global) {
    'use strict';

    let estado = {
        sucursalId: null,
        periodo: 'Hoy',
        desde: '',
        hasta: '',
        cargando: false,
        ultimoDato: null,
        error: null,
    };

    let peticionEnCurso = null;

    /**
     * Cruza de forma ultra-segura los datos del servidor con el espejo local IndexedDB.
     * Previene estrictamente excepciones por lectura de propiedades nulas (e.g. libro.sello).
     */
    function cruzarConEspejo(dato, sucursalId, periodo, desde, hasta) {
        dato = dato || {};
        const c = dato.contabilidad || {};
        const cobrosServer = Number(c.cobros) || 0;

        try {
            if (global.Espejo && typeof global.Espejo.contabilidad === 'function') {
                const cEsp = global.Espejo.contabilidad(
                    periodo || estado.periodo || 'Hoy',
                    desde || estado.desde,
                    hasta || estado.hasta,
                    sucursalId !== undefined ? sucursalId : estado.sucursalId
                );
                if (cEsp && cEsp.contabilidad) {
                    const espCobros = Number(cEsp.contabilidad.cobros) || 0;
                    if (espCobros > 0 && cobrosServer === 0) {
                        c.cobros = espCobros;
                        c.cobros_cant = cEsp.contabilidad.cobros_cant || 1;
                        c.cobros_por_medio = cEsp.contabilidad.cobros_por_medio || {};
                        c.resultado = Math.round(((Number(c.ventas) || 0) + espCobros - (Number(c.gastos) || 0)) * 100) / 100;
                        dato.contabilidad = c;
                    } else if (espCobros > 0 && cEsp.contabilidad.cobros_por_medio && (!c.cobros_por_medio || Object.keys(c.cobros_por_medio).length === 0)) {
                        c.cobros_por_medio = cEsp.contabilidad.cobros_por_medio;
                    }
                }
            }
        } catch (err) {
            console.warn('[CajaMotor] Error seguro en cruzarConEspejo:', err);
        }

        return dato;
    }

    /**
     * Construye la querystring con sucursal_id y período para las peticiones HTTP.
     */
    function armarQuery(params) {
        params = params || {};
        const p = params.periodo || estado.periodo || 'Hoy';
        let q = 'periodo=' + encodeURIComponent(p);
        const d = params.desde || estado.desde;
        const h = params.hasta || estado.hasta;
        if (p === 'Período' && d) q += '&desde=' + encodeURIComponent(d);
        if (p === 'Período' && h) q += '&hasta=' + encodeURIComponent(h);

        const sid = params.sucursalId !== undefined ? params.sucursalId : estado.sucursalId;
        if (sid !== null && sid !== undefined && String(sid).trim() !== '') {
            q += '&sucursal_id=' + encodeURIComponent(sid);
        }
        return q;
    }

    /**
     * Ejecuta la carga del arqueo de caja con control de aborto y fallback offline.
     */
    async function cargar(params) {
        params = params || {};
        if (params.sucursalId !== undefined) estado.sucursalId = params.sucursalId;
        if (params.periodo) estado.periodo = params.periodo;
        if (params.desde !== undefined) estado.desde = params.desde;
        if (params.hasta !== undefined) estado.hasta = params.hasta;

        if (peticionEnCurso) {
            peticionEnCurso.abort();
            peticionEnCurso = null;
        }

        const ctrl = new AbortController();
        peticionEnCurso = ctrl;
        estado.cargando = true;
        estado.error = null;

        const q = armarQuery(params);

        // 1. Fallback inmediato al espejo local (0ms de latencia)
        let datoEspejo = null;
        try {
            if (global.Espejo && typeof global.Espejo.contabilidad === 'function') {
                datoEspejo = global.Espejo.contabilidad(estado.periodo, estado.desde, estado.hasta, estado.sucursalId);
            }
        } catch (_) {}

        if (datoEspejo && datoEspejo.libro && !navigator.onLine) {
            estado.cargando = false;
            estado.ultimoDato = datoEspejo;
            return datoEspejo;
        }

        // 2. Consulta al backend vía API
        try {
            const res = await fetch('/api/pos/jefe?panel=contabilidad&' + q, {
                signal: ctrl.signal,
                headers: { 'Accept': 'application/json' },
            });

            if (!res.ok) throw new Error('HTTP ' + res.status);
            const dato = await res.json();
            const cruzado = cruzarConEspejo(dato, estado.sucursalId, estado.periodo, estado.desde, estado.hasta);
            estado.ultimoDato = cruzado;
            estado.cargando = false;
            return cruzado;
        } catch (err) {
            if (err && err.name === 'AbortError') return null;
            estado.error = err.message || 'Error de conexión';
            estado.cargando = false;

            // Si hay espejo local disponible ante fallo de red, usarlo
            if (datoEspejo && datoEspejo.libro) {
                estado.ultimoDato = datoEspejo;
                return datoEspejo;
            }

            // Retorno seguro con estructura mínima para nunca congelar la vista
            const fallback = {
                ok: false,
                libro: false,
                panel: 'contabilidad',
                mensaje: 'No se pudo conectar con el servidor para consultar la caja.',
                contabilidad: { medios_pago: [], cobros: 0, gastos: 0, resultado: 0, etiqueta: estado.periodo },
                resumen: { dia: estado.desde || 'Hoy', es_hoy: estado.periodo === 'Hoy' },
                sucursal_id: estado.sucursalId,
            };
            estado.ultimoDato = fallback;
            return fallback;
        } finally {
            if (peticionEnCurso === ctrl) peticionEnCurso = null;
        }
    }

    global.CajaMotor = {
        cargar: cargar,
        cruzarConEspejo: cruzarConEspejo,
        obtenerEstado: () => Object.assign({}, estado),
        armarQuery: armarQuery,
    };
})(typeof window !== 'undefined' ? window : this);
