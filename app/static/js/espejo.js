/**
 * El libro de Cobro Fácil queda en el aparato.
 * El teléfono, la PC y la tablet leen esa misma copia.
 */
(function (global) {
    const ORDEN = ['ventas', 'detalles_ventas', 'clientes', 'productos', 'cuenta_corriente', 'proveedores', 'configuracion', 'gastos', 'movimientos_caja'];
    const CANCELADAS = { CANCELADA: 1, ANULADA: 1, CANCELADO: 1, ANULADO: 1 };
    let basePromise = null;
    let memoria = null;
    let avisos = [];
    let bajando = false;
    let otra = false;

    function abrir() {
        if (basePromise) return basePromise;
        basePromise = new Promise((resolve, reject) => {
            const pedido = indexedDB.open('crm-espejo', 1);
            pedido.onupgradeneeded = () => {
                const db = pedido.result;
                if (!db.objectStoreNames.contains('tablas')) db.createObjectStore('tablas');
            };
            pedido.onsuccess = () => resolve(pedido.result);
            pedido.onerror = () => {
                basePromise = null;
                reject(pedido.error);
            };
        });
        return basePromise;
    }

    function leer(tabla) {
        return abrir().then((db) => new Promise((resolve) => {
            const tx = db.transaction('tablas', 'readonly');
            const pedido = tx.objectStore('tablas').get(tabla);
            pedido.onsuccess = () => resolve(pedido.result || null);
            pedido.onerror = () => resolve(null);
        })).catch(() => null);
    }

    function guardar(tabla, libro) {
        return abrir().then((db) => new Promise((resolve) => {
            const tx = db.transaction('tablas', 'readwrite');
            tx.objectStore('tablas').put(libro, tabla);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        })).catch(() => {});
    }

    function avisar() {
        avisos.forEach((fn) => {
            try { fn(); } catch (e) {}
        });
    }

    function indiceDe(columnas) {
        const idx = {};
        (columnas || []).forEach((col, i) => { idx[String(col).toLowerCase()] = i; });
        return idx;
    }

    function tomar(fila, idx, nombres) {
        for (let i = 0; i < nombres.length; i++) {
            const pos = idx[nombres[i]];
            if (pos !== undefined && pos < fila.length) return fila[pos];
        }
        return null;
    }

    function idTexto(valor) {
        if (valor === null || valor === undefined || valor === '') return '';
        const texto = String(valor).trim();
        return /^\d+\.0$/.test(texto) ? texto.slice(0, -2) : texto;
    }

    function diaDe(fecha) {
        const texto = String(fecha || '').replace('T', ' ').trim();
        return texto.length >= 10 && texto[4] === '-' ? texto.slice(0, 10) : '';
    }

    function iso(fecha) {
        const mes = String(fecha.getMonth() + 1).padStart(2, '0');
        const dia = String(fecha.getDate()).padStart(2, '0');
        return fecha.getFullYear() + '-' + mes + '-' + dia;
    }

    function hoyDe() {
        return iso(new Date());
    }

    function filasVentas(libro, sucursalId) {
        const salida = [];
        const vistas = new Set();
        (libro.sucursales || []).forEach((suc) => {
            if (sucursalId !== null && sucursalId !== undefined && String(suc.sucursal_id) !== String(sucursalId)) return;
            const idx = indiceDe(suc.columnas);
            (suc.filas || []).forEach((fila) => {
                const id = idTexto(tomar(fila, idx, ['id']));
                const fecha = String(tomar(fila, idx, ['fecha']) || '').split('.')[0].replace('T', ' ');
                const clave = id + '|' + fecha.slice(0, 19);
                if (id && vistas.has(clave)) return;
                if (id) vistas.add(clave);
                salida.push({
                    id: id,
                    fecha: fecha,
                    dia: diaDe(fecha),
                    total: Number(tomar(fila, idx, ['total'])) || 0,
                    pago: String(tomar(fila, idx, ['metodo_pago', 'medio_pago']) || 'Efectivo'),
                    estado: String(tomar(fila, idx, ['estado']) || ''),
                    caja: idTexto(tomar(fila, idx, ['caja_id'])) || '1',
                    cliente: String(tomar(fila, idx, ['cliente_nombre']) || '')
                });
            });
        });
        return salida;
    }

    function rangoPeriodo(periodo, desde, hasta) {
        const hoy = hoyDe();
        const nombre = periodo || 'Hoy';
        if (nombre === 'Semana') {
            const base = new Date(hoy + 'T12:00:00');
            const lunes = new Date(base);
            lunes.setDate(base.getDate() - ((base.getDay() + 6) % 7));
            return [iso(lunes), hoy];
        }
        if (nombre === 'Mes') {
            const anio = Number(hoy.slice(0, 4));
            const mes = Number(hoy.slice(5, 7));
            const ultimo = new Date(anio, mes, 0).getDate();
            return [hoy.slice(0, 7) + '-01', hoy.slice(0, 7) + '-' + String(ultimo).padStart(2, '0')];
        }
        if (nombre === 'Período') {
            const ini = String(desde || hoy).slice(0, 10);
            const fin = String(hasta || ini).slice(0, 10);
            return ini <= fin ? [ini, fin] : [fin, ini];
        }
        return [hoy, hoy];
    }

    function rangoVentas(f) {
        const hoy = hoyDe();
        if (!f || f.historico) return ['', ''];
        const dia = String(f.fecha || hoy).slice(0, 10) || hoy;
        if (f.alcance === 'mes') {
            const anio = Number(dia.slice(0, 4));
            const mes = Number(dia.slice(5, 7));
            const ultimo = new Date(anio, mes, 0).getDate();
            return [dia.slice(0, 7) + '-01', dia.slice(0, 7) + '-' + String(ultimo).padStart(2, '0')];
        }
        return [dia, dia];
    }

    function elegir(libro, desde, hasta, sucursalId) {
        return filasVentas(libro, sucursalId).filter((fila) => {
            if (!fila.dia) return false;
            if (desde && fila.dia < desde) return false;
            if (hasta && fila.dia > hasta) return false;
            return true;
        });
    }

    function sumar(libro, desde, hasta, sucursalId) {
        let total = 0;
        let cant = 0;
        elegir(libro, desde, hasta, sucursalId).forEach((fila) => {
            if (CANCELADAS[String(fila.estado || '').trim().toUpperCase()]) return;
            total += fila.total;
            cant += 1;
        });
        return { cant: cant, total: Math.round(total * 100) / 100 };
    }

    function listar(libro, desde, hasta, sucursalId) {
        const filas = elegir(libro, desde, hasta, sucursalId);
        const suma = sumar(libro, desde, hasta, sucursalId);
        const visibles = filas.slice().sort((a, b) => (a.fecha < b.fecha ? 1 : (a.fecha > b.fecha ? -1 : (a.id < b.id ? 1 : -1))));
        return {
            cant: suma.cant,
            total: suma.total,
            recorte: visibles.length > 400,
            tickets: visibles.slice(0, 400).map((fila) => ({
                id: fila.id,
                fecha: fila.fecha,
                total: Math.round(fila.total * 100) / 100,
                pago: fila.pago,
                estado: fila.estado,
                caja: fila.caja,
                cliente: fila.cliente
            }))
        };
    }

    async function bajarTabla(tabla) {
        const res = await fetch('/api/pos/espejo/tabla?tabla=' + encodeURIComponent(tabla));
        if (!res.ok) return null;
        const dato = await res.json();
        if (!dato || !dato.ok) return null;
        const libro = { sello: dato.sello || '', sucursales: dato.sucursales || [] };
        await guardar(tabla, libro);
        if (tabla === 'ventas') {
            memoria = libro;
            avisar();
        }
        return libro;
    }

    async function unaPasada() {
        if (!memoria) {
            memoria = await leer('ventas');
            if (memoria) avisar();
        }
        if (!navigator.onLine) return;
        const res = await fetch('/api/pos/espejo');
        if (!res.ok) return;
        const indice = await res.json();
        const porTabla = {};
        (indice.tablas || []).forEach((item) => {
            const marca = item.sello || '';
            if (!porTabla[item.tabla] || marca > porTabla[item.tabla]) porTabla[item.tabla] = marca;
        });
        const nombres = ORDEN.filter((tabla) => porTabla[tabla]);
        Object.keys(porTabla).forEach((tabla) => {
            if (nombres.indexOf(tabla) === -1) nombres.push(tabla);
        });
        for (let i = 0; i < nombres.length; i++) {
            const tabla = nombres[i];
            const local = tabla === 'ventas' ? (memoria || await leer(tabla)) : await leer(tabla);
            if (local && local.sello && local.sello === porTabla[tabla]) continue;
            await bajarTabla(tabla);
        }
    }

    async function asegurar() {
        if (bajando) {
            otra = true;
            return;
        }
        bajando = true;
        try {
            do {
                otra = false;
                await unaPasada();
            } while (otra);
        } catch (e) {
        } finally {
            bajando = false;
        }
    }

    global.Espejo = {
        asegurar: asegurar,
        ventas: function () { return memoria; },
        sumar: sumar,
        listar: listar,
        rangoPeriodo: rangoPeriodo,
        rangoVentas: rangoVentas,
        alActualizar: function (fn) { avisos.push(fn); }
    };
})(window);
