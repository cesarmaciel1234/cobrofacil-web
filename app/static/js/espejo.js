/**
 * Espejo de Base de Datos Local en PWA - Cobro Fácil CRM
 * Mantiene una réplica idéntica y reactiva en IndexedDB ('crm-espejo') y memoria.
 * Permite a la PWA consultar datos al instante (0ms de latencia) sin locks ni colisiones en la nube.
 */
(function (global) {
    const ORDEN = [
        'ventas',
        'detalles_ventas',
        'clientes',
        'productos',
        'cuenta_corriente',
        'proveedores',
        'configuracion',
        'gastos',
        'movimientos_caja'
    ];
    const CANCELADAS = { CANCELADA: 1, ANULADA: 1, CANCELADO: 1, ANULADO: 1, RECHAZADO: 1 };
    
    let basePromise = null;
    let memoria = null; // Apunta a copias.ventas para retrocompatibilidad
    const copias = {};  // { [tabla]: { sello: string, sucursales: [...] } }
    let selloGlobal = '';
    let avisos = [];
    let bajando = false;
    let otra = false;
    let hidratadoPromise = null;

    /**
     * Abre la base IndexedDB local del espejo.
     */
    function abrir() {
        if (basePromise) return basePromise;
        basePromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                return reject(new Error('IndexedDB no soportado'));
            }
            try {
                const pedido = indexedDB.open('crm-espejo', 1);
                pedido.onupgradeneeded = () => {
                    const db = pedido.result;
                    if (!db.objectStoreNames.contains('tablas')) {
                        db.createObjectStore('tablas');
                    }
                };
                pedido.onsuccess = () => resolve(pedido.result);
                pedido.onerror = () => {
                    basePromise = null;
                    reject(pedido.error);
                };
            } catch (err) {
                basePromise = null;
                reject(err);
            }
        });
        return basePromise;
    }

    /**
     * Lee una tabla cruda de IndexedDB.
     */
    function leer(tabla) {
        return abrir().then((db) => new Promise((resolve) => {
            const tx = db.transaction('tablas', 'readonly');
            const pedido = tx.objectStore('tablas').get(tabla);
            pedido.onsuccess = () => resolve(pedido.result || null);
            pedido.onerror = () => resolve(null);
        })).catch(() => null);
    }

    /**
     * Guarda una tabla cruda en IndexedDB.
     */
    function guardar(tabla, libro) {
        return abrir().then((db) => new Promise((resolve) => {
            const tx = db.transaction('tablas', 'readwrite');
            tx.objectStore('tablas').put(libro, tabla);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        })).catch(() => {});
    }

    async function limpiarTodo() {
        copias = {};
        memoria = null;
        selloGlobal = '';
        try {
            const db = await abrir();
            const tx = db.transaction('tablas', 'readwrite');
            tx.objectStore('tablas').clear();
            await new Promise((resolve) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        } catch (_) {}
        avisar();
    }

    /**
     * Actualiza la tabla en IndexedDB Y en la memoria reactiva.
     */
    async function guardarTabla(tabla, libro, sinAviso) {
        if (!tabla) return;
        await guardar(tabla, libro);
        copias[tabla] = libro;
        if (libro && libro.sello && libro.sello > selloGlobal) {
            selloGlobal = libro.sello;
        }
        if (tabla === 'ventas') {
            memoria = libro;
        }
        if (!sinAviso) {
            avisar();
        }
    }

    /**
     * Carga todas las tablas guardadas en IndexedDB hacia la memoria activa.
     */
    async function hidratar() {
        if (hidratadoPromise) return hidratadoPromise;
        hidratadoPromise = (async () => {
            for (let i = 0; i < ORDEN.length; i++) {
                const tabla = ORDEN[i];
                const libro = await leer(tabla);
                if (libro) {
                    copias[tabla] = libro;
                    if (libro.sello && libro.sello > selloGlobal) {
                        selloGlobal = libro.sello;
                    }
                    if (tabla === 'ventas') {
                        memoria = libro;
                    }
                }
            }
            if (copias.ventas || copias.clientes) {
                avisar();
            }
            return copias;
        })();
        return hidratadoPromise;
    }

    /**
     * Notifica a los suscriptores UI cuando el espejo local se actualizó.
     */
    function avisar() {
        avisos.forEach((fn) => {
            try { fn(); } catch (e) {}
        });
    }

    // --- Funciones utilitarias de normalización ---

    function indiceDe(columnas) {
        const idx = {};
        (columnas || []).forEach((col, i) => { idx[String(col).toLowerCase()] = i; });
        return idx;
    }

    function tomar(fila, idx, nombres) {
        if (!fila) return null;
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

    let sucursalesValidas = null;

    function fijarSucursales(lista) {
        if (!Array.isArray(lista)) return;
        const sids = new Set(lista.map((s) => {
            const sid = s.id != null ? s.id : s.sucursal_id;
            return String(sid).toLowerCase();
        }).filter((id) => id && id !== 'null' && id !== 'undefined'));
        sucursalesValidas = sids;
        void purgarSucursalesObsoletas(sids);
    }

    async function purgarSucursalesObsoletas(sids) {
        if (!sids || !sids.size) return;
        let cambio = false;
        for (let i = 0; i < ORDEN.length; i++) {
            const tabla = ORDEN[i];
            const libro = copias[tabla];
            if (libro && Array.isArray(libro.sucursales)) {
                const prevCount = libro.sucursales.length;
                libro.sucursales = libro.sucursales.filter((s) => {
                    const sidStr = String(s.sucursal_id).toLowerCase();
                    return sidStr === 'web' || sids.has(sidStr);
                });
                if (libro.sucursales.length !== prevCount) {
                    cambio = true;
                    await guardarTabla(tabla, libro, true).catch(() => {});
                }
            }
        }
        if (cambio) avisar();
    }

    function coincideSucursal(sucId, filtro) {
        if (filtro === null || filtro === undefined) return true;
        const f = String(filtro).trim().toLowerCase();
        if (!f || f === 'todas' || f === 'todos' || f === 'todas las sucursales') return true;
        const s = String(sucId != null ? sucId : '').trim().toLowerCase();
        if (f === 'web') {
            return s === 'web';
        }
        if (s === 'web') {
            return false;
        }
        if (sucursalesValidas && sucursalesValidas.size && !sucursalesValidas.has(s)) {
            const num = Number(s);
            if (!isNaN(num) && num > 0) return false;
        }
        return s === f;
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

    function rangoPeriodo(periodo, desde, hasta) {
        const hoy = hoyDe();
        const nombre = periodo || 'Hoy';
        if (nombre === 'Todas' || nombre === 'Todo' || nombre === 'Histórico' || nombre === 'Historico') {
            return ['', ''];
        }
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
        if (f.alcance === 'semana') return rangoPeriodo('Semana');
        if (f.alcance === 'periodo') {
            const ini = String(f.desde || f.fecha || hoy).slice(0, 10);
            const fin = String(f.hasta || ini).slice(0, 10);
            return ini <= fin ? [ini, fin] : [fin, ini];
        }
        const dia = String(f.fecha || hoy).slice(0, 10) || hoy;
        if (f.alcance === 'mes') {
            const anio = Number(dia.slice(0, 4));
            const mes = Number(dia.slice(5, 7));
            const ultimo = new Date(anio, mes, 0).getDate();
            return [dia.slice(0, 7) + '-01', dia.slice(0, 7) + '-' + String(ultimo).padStart(2, '0')];
        }
        return [dia, dia];
    }

    /**
     * Extrae todas las filas de una tabla como objetos tipados { campo: valor }.
     */
    function filasTabla(tabla, sucursalId) {
        const libro = copias[tabla];
        if (!libro || !libro.sucursales) return [];
        const salida = [];
        libro.sucursales.forEach((suc) => {
            if (!coincideSucursal(suc.sucursal_id, sucursalId)) return;
            const idx = indiceDe(suc.columnas);
            (suc.filas || []).forEach((fila) => {
                const obj = { sucursal_id: suc.sucursal_id, sucursal_nombre: suc.sucursal };
                (suc.columnas || []).forEach((col) => {
                    const c = String(col).toLowerCase();
                    obj[c] = fila[idx[c]];
                });
                salida.push(obj);
            });
        });
        return salida;
    }

    /**
     * Ventas normalizadas con filtrado por sucursal.
     */
    function filasVentas(libro, sucursalId) {
        const fuente = libro || copias.ventas || memoria;
        if (!fuente) return [];
        const salida = [];
        const vistas = new Set();
        (fuente.sucursales || []).forEach((suc) => {
            if (!coincideSucursal(suc.sucursal_id, sucursalId)) return;
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
                    cliente: String(tomar(fila, idx, ['cliente_nombre']) || ''),
                    cliente_id: idTexto(tomar(fila, idx, ['cliente_id', 'id_cliente'])),
                    sucursal_id: suc.sucursal_id,
                    sucursal_nombre: suc.sucursal
                });
            });
        });
        return salida;
    }

    function elegir(libro, desde, hasta, sucursalId, filtro) {
        const f = filtro || {};
        const q = String(f.q || '').trim().toLowerCase();
        const p = String(f.pago || 'TODOS').trim().toUpperCase();
        const franja = !!f.franja;
        const h0 = franja ? String(f.hora_desde || '00:00') : '';
        const h1 = franja ? String(f.hora_hasta || '23:59') : '';

        return filasVentas(libro, sucursalId).filter((fila) => {
            if (!fila.dia) return false;
            if (desde && fila.dia < desde) return false;
            if (hasta && fila.dia > hasta) return false;
            if (franja && h0 && h1) {
                const hora = (fila.fecha || '').slice(11, 16);
                if (hora && (hora < h0 || hora > h1)) return false;
            }
            if (p && p !== 'TODOS') {
                const fp = String(fila.pago || '').toUpperCase();
                if (p === 'CRÉDITO' || p === 'CREDITO') {
                    if (!fp.includes('FIADO') && !fp.includes('CLIENTE') && !fp.includes('CUENTA CORRIENTE')) return false;
                } else if (!fp.includes(p)) {
                    return false;
                }
            }
            if (q) {
                const pool = (String(fila.id || '') + ' ' + String(fila.cliente || '') + ' ' + String(fila.pago || '') + ' ' + String(fila.caja || '')).toLowerCase();
                if (!pool.includes(q)) return false;
            }
            return true;
        });
    }

    function sumar(libro, desde, hasta, sucursalId, filtro) {
        let total = 0;
        let cant = 0;
        elegir(libro, desde, hasta, sucursalId, filtro).forEach((fila) => {
            if (CANCELADAS[String(fila.estado || '').trim().toUpperCase()]) return;
            total += fila.total;
            cant += 1;
        });
        return { cant: cant, total: Math.round(total * 100) / 100 };
    }

    function listar(libro, desde, hasta, sucursalId, filtro, offset, limite) {
        const off = Number(offset) || 0;
        const lim = Number(limite) || 400;
        const filas = elegir(libro, desde, hasta, sucursalId, filtro);
        const suma = sumar(libro, desde, hasta, sucursalId, filtro);
        const visibles = filas.slice().sort((a, b) => (a.fecha < b.fecha ? 1 : (a.fecha > b.fecha ? -1 : (a.id < b.id ? 1 : -1))));
        const slice = visibles.slice(off, off + lim);
        return {
            cant: suma.cant,
            total: suma.total,
            recorte: visibles.length > (off + lim),
            hay_mas: visibles.length > (off + lim),
            offset: off,
            limite: lim,
            tickets: slice.map((fila) => ({
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

    /**
     * Desglose de cortes de carne y productos vendidos.
     */
    function desglose(desde, hasta, sucursalId) {
        const ventasLibro = copias.ventas || memoria;
        const detalles = copias.detalles_ventas;
        const productos = copias.productos;
        if (!ventasLibro || !detalles) return null;
        const vivas = new Set();
        filasVentas(ventasLibro, sucursalId).forEach((fila) => {
            if (!fila.id || !fila.dia) return;
            if (desde && fila.dia < desde) return;
            if (hasta && fila.dia > hasta) return;
            if (CANCELADAS[String(fila.estado || '').trim().toUpperCase()]) return;
            vivas.add(String(fila.id));
        });
        const medidas = {};
        (productos && productos.sucursales || []).forEach((suc) => {
            if (!coincideSucursal(suc.sucursal_id, sucursalId)) return;
            const idx = indiceDe(suc.columnas);
            (suc.filas || []).forEach((fila) => {
                const pid = idTexto(tomar(fila, idx, ['id']));
                if (!pid) return;
                const pesable = String(tomar(fila, idx, ['es_pesable']) || '').toLowerCase();
                const unidad = String(tomar(fila, idx, ['unidad', 'unidad_medida']) || '').toLowerCase();
                medidas[pid] = (pesable === '1' || pesable === 'true' || unidad === 'kg' || unidad === 'kilo' || unidad === 'kilos') ? 'kg' : 'un';
            });
        });
        const grupos = {};
        (detalles.sucursales || []).forEach((suc) => {
            if (!coincideSucursal(suc.sucursal_id, sucursalId)) return;
            const idx = indiceDe(suc.columnas);
            (suc.filas || []).forEach((fila) => {
                const vid = idTexto(tomar(fila, idx, ['id_venta', 'venta_id', 'ticket_id', 'venta']));
                if (!vivas.has(vid)) return;
                const nombre = String(tomar(fila, idx, ['nombre_producto', 'nombre', 'producto', 'descripcion', 'corte']) || '').trim();
                if (!nombre) return;
                const pid = idTexto(tomar(fila, idx, ['id_producto', 'producto_id']));
                const medida = medidas[pid] || 'un';
                const slot = grupos[nombre] || (grupos[nombre] = { nombre: nombre, cantidad: 0, monto: 0, medida: medida });
                if (medida === 'kg') slot.medida = 'kg';
                slot.cantidad += Number(tomar(fila, idx, ['cantidad', 'kilos', 'peso', 'cant'])) || 0;
                slot.monto += Number(tomar(fila, idx, ['subtotal', 'total', 'monto'])) || 0;
            });
        });
        const filas = Object.keys(grupos).map((nombre) => grupos[nombre]).sort((a, b) => b.cantidad - a.cantidad);
        let kilos = 0;
        let unidades = 0;
        let monto = 0;
        const salida = filas.map((item) => {
            const cant = Math.round(item.cantidad * 1000) / 1000;
            const plata = Math.round(item.monto * 100) / 100;
            monto += plata;
            if (item.medida === 'kg') kilos += cant;
            else unidades += cant;
            return { nombre: item.nombre, cantidad: cant, monto: plata, medida: item.medida };
        });
        return {
            filas: salida,
            articulos: salida.length,
            kilos: Math.round(kilos * 1000) / 1000,
            unidades: Math.round(unidades * 1000) / 1000,
            monto: Math.round(monto * 100) / 100,
            tickets: vivas.size,
            etiqueta: ''
        };
    }

    /**
     * Sucursales descubiertas en el espejo local.
     */
    function sucursales() {
        const vistos = new Map();
        ORDEN.forEach((tabla) => {
            const lib = copias[tabla];
            if (lib && lib.sucursales) {
                lib.sucursales.forEach((s) => {
                    const sid = s.sucursal_id != null ? s.sucursal_id : 1;
                    if (!vistos.has(sid)) {
                        vistos.set(sid, s.sucursal || ('Sucursal #' + sid));
                    }
                });
            }
        });
        if (!vistos.size) {
            return [{ id: 1, nombre: 'Principal' }];
        }
        return Array.from(vistos.entries()).map(([id, nombre]) => ({ id: Number(id), nombre: nombre }));
    }

    /**
     * Clientes unificados por DNI según las reglas multi-sucursal.
     */
    function clientes(sucursalId) {
        const filas = filasTabla('clientes', sucursalId);
        const ccTodas = filasTabla('cuenta_corriente', sucursalId);
        const hoy = hoyDe();
        const diasPorCliente = new Map();
        if (ccTodas.length > 0) {
            const hoyTs = new Date(hoy + 'T12:00:00').getTime();
            ccTodas.forEach((cc) => {
                const cid = idTexto(cc.cliente_id);
                if (!cid) return;
                const tipo = String(cc.tipo || '').toUpperCase();
                if (tipo !== 'CARGO') return;
                const dia = diaDe(cc.fecha);
                if (!dia) return;
                const diaTs = new Date(dia + 'T12:00:00').getTime();
                const d = Math.max(0, Math.floor((hoyTs - diaTs) / (1000 * 60 * 60 * 24)));
                if (!diasPorCliente.has(cid) || d > diasPorCliente.get(cid)) {
                    diasPorCliente.set(cid, d);
                }
            });
        }
        const porDni = new Map();
        const porNombre = new Map();
        const salida = [];

        filas.forEach((f) => {
            const id = idTexto(f.id || f.cliente_id);
            const nombre = String(f.nombre || f.razon_social || '').trim();
            const dni = idTexto(f.dni_cuit || f.dni || f.cuit || '');
            const saldo = Number(f.saldo_actual || f.saldo || f.deuda || f.deuda_actual) || 0;
            const limite = Number(f.limite_credito || f.limite || f.techo_deuda) || 0;
            const tipo = String(f.tipo_cliente || f.categoria || 'Minorista');
            const tel = String(f.telefono || f.celular || '');
            const dir = String(f.direccion || '');
            const diasRaw = f.dias !== undefined && f.dias !== null && f.dias !== '' ? Number(f.dias) : null;
            const dias = diasRaw !== null ? diasRaw : (saldo > 0 ? (diasPorCliente.get(id) ?? null) : null);
            const enRiesgo = (limite > 0 && saldo >= limite) || (dias !== null && dias > 30) || !!f.en_riesgo;
            const tarifa = f.tarifa || (enRiesgo ? '10%' : '5%');
            let mant = f.mantenimiento != null ? Number(f.mantenimiento) : 0;
            if (f.mantenimiento == null && saldo > 0 && dias != null && dias > 0) {
                const diasBase = Math.min(dias, 30);
                const diasApal = Math.max(0, dias - 30);
                const intBase = saldo * 0.05 * (diasBase / 30);
                const intApal = saldo * 0.10 * (diasApal / 30);
                mant = Math.round((intBase + intApal) * 100) / 100;
            }
            const totalAPagar = f.total_a_pagar != null ? Number(f.total_a_pagar) : (saldo > 0 ? Math.round((saldo + mant) * 100) / 100 : saldo);

            const item = {
                id: id,
                pos_id: id,
                nombre: nombre,
                dni: dni,
                dni_cuit: dni,
                cuit: dni,
                telefono: tel,
                direccion: dir,
                deuda: saldo,
                deuda_pos: saldo,
                saldo_actual: saldo,
                limite: limite,
                limite_credito: limite,
                techo_deuda: limite,
                tipo: tipo,
                tipo_cliente: tipo,
                dias: dias,
                tarifa: tarifa,
                mantenimiento: mant,
                total_a_pagar: totalAPagar,
                en_riesgo: enRiesgo,
                estado: saldo > 0 ? (enRiesgo ? 'Atención' : 'Normal') : 'Al día',
                sucursal_id: f.sucursal_id,
                sucursal_nombre: f.sucursal_nombre,
            };

            if (sucursalesValidas && sucursalesValidas.size && f.sucursal_id != null) {
                const fsid = Number(f.sucursal_id);
                if (!isNaN(fsid) && fsid > 0 && !sucursalesValidas.has(fsid)) return;
            }

            if (dni) {
                if (porDni.has(dni)) {
                    const previo = porDni.get(dni);
                    if (previo.sucursal_id !== f.sucursal_id) {
                        const distinto = previo.saldo_actual !== saldo;
                        if (distinto) {
                            previo.saldo_actual += saldo;
                            previo.deuda_pos += saldo;
                            previo.deuda += saldo;
                            previo.mantenimiento = Math.round((previo.mantenimiento + mant) * 100) / 100;
                            previo.total_a_pagar = Math.round((previo.total_a_pagar + totalAPagar) * 100) / 100;
                        }
                    }
                    return;
                }
                porDni.set(dni, item);
            } else if (nombre) {
                const k = nombre.toLowerCase();
                if (porNombre.has(k)) {
                    const previo = porNombre.get(k);
                    if (previo.sucursal_id !== f.sucursal_id) {
                        const distinto = previo.saldo_actual !== saldo;
                        if (distinto) {
                            previo.saldo_actual += saldo;
                            previo.deuda_pos += saldo;
                            previo.deuda += saldo;
                            previo.mantenimiento = Math.round((previo.mantenimiento + mant) * 100) / 100;
                            previo.total_a_pagar = Math.round((previo.total_a_pagar + totalAPagar) * 100) / 100;
                        }
                    }
                    return;
                }
                porNombre.set(k, item);
            }
            salida.push(item);
        });
        return salida;
    }

    /**
     * Estado consolidado de la cartera de clientes desde el espejo.
     */
    function cartera(sucursalId) {
        const lista = clientes(sucursalId);
        const ccTodas = filasTabla('cuenta_corriente', sucursalId);
        const hoy = hoyDe();
        let totalDeuda = 0;
        let totalCuentas = 0;
        let cuentasEnRiesgo = 0;
        let deudaEnRiesgo = 0;
        lista.forEach((c) => {
            const saldo = Number(c.deuda != null ? c.deuda : (c.saldo_actual || 0));
            const mant = Number(c.mantenimiento || 0);
            const total = saldo > 0 ? (saldo + mant) : saldo;
            if (saldo > 0) {
                totalDeuda += total;
                totalCuentas += 1;
            }
            if (c.en_riesgo) {
                cuentasEnRiesgo += 1;
                if (saldo > 0) deudaEnRiesgo += total;
            }
        });
        const topDeudores = lista
            .filter((c) => (c.deuda || c.saldo_actual || 0) > 0)
            .sort((a, b) => (b.total_a_pagar || b.deuda || 0) - (a.total_a_pagar || a.deuda || 0))
            .slice(0, 15);

        let cobrosDelMes = 0;
        const mesActual = hoy.substring(0, 7);
        if (ccTodas.length > 0) {
            ccTodas.forEach((cc) => {
                if (String(cc.tipo || '').toUpperCase() === 'ABONO' || Number(cc.haber) > 0) {
                    const dia = diaDe(cc.fecha);
                    if (dia && dia.startsWith(mesActual)) {
                        cobrosDelMes += Number(cc.monto || cc.haber || 0);
                    }
                }
            });
        }

        const totalCalle = Math.round(totalDeuda * 100) / 100;
        return {
            ok: true,
            libro: lista.length > 0,
            panel: 'admin',
            cartera: {
                total_deuda: totalCalle,
                cartera_en_calle: totalCalle,
                deuda_total: totalCalle,
                cartera_en_riesgo: Math.round(deudaEnRiesgo * 100) / 100,
                deuda_en_riesgo: Math.round(deudaEnRiesgo * 100) / 100,
                cuentas_en_riesgo: cuentasEnRiesgo,
                total_cuentas: lista.length,
                cuentas_activas: totalCuentas,
                con_deuda: totalCuentas,
                cobros_del_mes: Math.round(cobrosDelMes * 100) / 100,
                cobros_mes: Math.round(cobrosDelMes * 100) / 100,
                top_deudores: topDeudores,
                clientes: lista,
            },
            sucursales: sucursales(),
            sucursal_id: sucursalId,
        };
    }

    /**
     * Resumen de caja, gastos y contabilidad calculado localmente.
     */
    function contabilidad(periodo, desde, hasta, sucursalId) {
        const rango = rangoPeriodo(periodo, desde, hasta);
        const ini = rango[0];
        const fin = rango[1];
        const vFilas = elegir(copias.ventas || memoria, ini, fin, sucursalId);

        const porMedio = {};
        let totalVentas = 0;
        let tickets = 0;
        vFilas.forEach((v) => {
            if (CANCELADAS[String(v.estado || '').toUpperCase()]) return;
            const medio = v.pago || 'Efectivo';
            if (!porMedio[medio]) porMedio[medio] = { monto: 0, tickets: 0 };
            porMedio[medio].monto += v.total;
            porMedio[medio].tickets += 1;
            totalVentas += v.total;
            tickets += 1;
        });

        const gFilas = filasTabla('gastos', sucursalId);
        let totalGastos = 0;
        const detalleGastos = [];
        gFilas.forEach((g) => {
            const dia = diaDe(g.fecha);
            if (ini && dia && dia < ini) return;
            if (fin && dia && dia > fin) return;
            const st = String(g.estado || g.status || '').toUpperCase();
            if (CANCELADAS[st]) return;
            const m = Number(g.monto) || 0;
            totalGastos += m;
            detalleGastos.push({
                categoria: g.categoria || 'Gasto',
                detalle: g.descripcion || '',
                monto: Math.round(m * 100) / 100
            });
        });

        const ccFilas = filasTabla('cuenta_corriente', sucursalId);
        let totalCobros = 0;
        let cantCobros = 0;
        const cobrosPorMedio = {};
        ccFilas.forEach((c) => {
            const dia = diaDe(c.fecha);
            if (ini && dia && dia < ini) return;
            if (fin && dia && dia > fin) return;
            const tipo = String(c.tipo || '').toUpperCase();
            if (tipo === 'ABONO' || Number(c.haber) > 0) {
                const m = Number(c.monto || c.haber) || 0;
                if (m > 0) {
                    totalCobros += m;
                    cantCobros += 1;
                    let desc = String(c.descripcion || '').trim();
                    let medio = String(c.medio_pago || c.medio || '').trim();
                    if (!medio && desc.endsWith(')') && desc.includes('(')) {
                        const dentro = desc.slice(desc.lastIndexOf('(') + 1, -1).trim();
                        medio = dentro.split(':')[0].trim();
                    }
                    if (!medio) medio = 'Efectivo';
                    medio = medio.charAt(0).toUpperCase() + medio.slice(1).toLowerCase();
                    if (medio.toLowerCase() === 'mercadopago' || medio.toLowerCase() === 'mp') medio = 'QR';

                    if (!cobrosPorMedio[medio]) cobrosPorMedio[medio] = { monto: 0, cant: 0 };
                    cobrosPorMedio[medio].monto = Math.round((cobrosPorMedio[medio].monto + m) * 100) / 100;
                    cobrosPorMedio[medio].cant += 1;
                }
            }
        });

        const cjFilas = filasTabla('movimientos_caja', sucursalId);
        const porTipoCaja = {};
        cjFilas.forEach((c) => {
            const dia = diaDe(c.fecha);
            if (ini && dia && dia < ini) return;
            if (fin && dia && dia > fin) return;
            const tipo = c.tipo || 'Movimiento';
            porTipoCaja[tipo] = (porTipoCaja[tipo] || 0) + (Number(c.monto) || 0);
        });

        const mediosLista = Object.keys(porMedio).map((m) => ({
            medio: m,
            monto: Math.round(porMedio[m].monto * 100) / 100,
            total: Math.round(porMedio[m].monto * 100) / 100,
            tickets: porMedio[m].tickets || 0
        })).sort((a, b) => b.monto - a.monto);
        const cajaLista = Object.keys(porTipoCaja).map((t) => ({ tipo: t, monto: Math.round(porTipoCaja[t] * 100) / 100 }));

        return {
            ok: true,
            libro: true,
            panel: 'contabilidad',
            contabilidad: {
                ventas: Math.round(totalVentas * 100) / 100,
                tickets: tickets,
                medios_pago: mediosLista,
                cobros: Math.round(totalCobros * 100) / 100,
                cobros_cant: cantCobros,
                cobros_por_medio: cobrosPorMedio,
                gastos: Math.round(totalGastos * 100) / 100,
                resultado: Math.round((totalVentas + totalCobros - totalGastos) * 100) / 100,
                detalle_gastos: detalleGastos.slice(0, 40),
                caja: cajaLista
            },
            sucursales: sucursales(),
            sucursal_id: sucursalId,
        };
    }

    /**
     * Resumen del Jefe y Dashboard Ejecutivo calculado del espejo local.
     */
    function resumenJefe(periodo, desde, hasta, sucursalId) {
        const rango = rangoPeriodo(periodo, desde, hasta);
        const ini = rango[0];
        const fin = rango[1];
        const vFilas = filasVentas(copias.ventas || memoria, sucursalId);

        let delRango = vFilas.filter((v) => {
            if (CANCELADAS[String(v.estado || '').toUpperCase()]) return false;
            if (ini && v.dia && v.dia < ini) return false;
            if (fin && v.dia && v.dia > fin) return false;
            return true;
        });

        const esHoy = (!periodo || periodo === 'Hoy') && ini === fin && ini === hoyDe();
        let diaReporte = ini === fin ? ini : (ini + ' → ' + fin);

        // Si hoy aún no hubo ventas (tienda recién abriendo), tomar el último día con ventas para la vitrina
        if (esHoy && delRango.length === 0 && vFilas.length > 0) {
            let maxDia = '';
            vFilas.forEach((v) => { if (v.dia && v.dia > maxDia) maxDia = v.dia; });
            if (maxDia) {
                const ultimas = vFilas.filter((v) => v.dia === maxDia && !CANCELADAS[String(v.estado || '').toUpperCase()]);
                if (ultimas.length > 0) {
                    delRango = ultimas;
                    diaReporte = maxDia;
                }
            }
        }

        let total = 0;
        const porMedio = {};
        let montoDigital = 0;
        delRango.forEach((v) => {
            total += v.total;
            const p = v.pago || 'Efectivo';
            porMedio[p] = (porMedio[p] || 0) + v.total;
            const mp = String(p).toUpperCase();
            if (mp.includes('QR') || mp.includes('TARJETA') || mp.includes('TRANSF') || mp.includes('DIGITAL') || mp.includes('MERCADO')) {
                montoDigital += v.total;
            }
        });
        const pago = Object.keys(porMedio).sort((a, b) => porMedio[b] - porMedio[a])[0] || 'Efectivo';
        const tickets = delRango.length;

        // Período anterior para variación porcentual
        let totalAnterior = null;
        let variacion = null;
        let antFin = '';
        if (ini && fin && ini.length >= 10 && fin.length >= 10) {
            try {
                const d0 = new Date(ini + 'T12:00:00');
                const d1 = new Date(fin + 'T12:00:00');
                const duracion = Math.round((d1 - d0) / 86400000) + 1;
                const antFinDate = new Date(d0);
                antFinDate.setDate(antFinDate.getDate() - 1);
                const antIniDate = new Date(d0);
                antIniDate.setDate(antIniDate.getDate() - duracion);
                const antIni = iso(antIniDate);
                antFin = iso(antFinDate);

                const delAnterior = vFilas.filter((v) => v.dia && antIni <= v.dia && v.dia <= antFin && !CANCELADAS[String(v.estado || '').toUpperCase()]);
                if (delAnterior.length) {
                    totalAnterior = delAnterior.reduce((acc, v) => acc + v.total, 0);
                    if (totalAnterior > 0) {
                        variacion = Math.round(((total - totalAnterior) / totalAnterior) * 1000) / 10;
                    }
                }
            } catch (_) {}
        }

        const desgl = desglose(ini, fin, sucursalId);
        const ranking = (desgl && desgl.filas ? desgl.filas : []).slice(0, 10).map((item) => ({
            producto: item.nombre,
            cantidad: Number(item.cantidad) || 0,
            kilos: Number(item.cantidad) || 0,
            total: Number(item.monto) || 0,
            monto: Number(item.monto) || 0,
            operaciones: item.tickets || 1
        }));

        const porSuc = {};
        delRango.forEach((v) => {
            const s = v.sucursal_id || '1';
            porSuc[s] = (porSuc[s] || 0) + v.total;
        });
        const sucLista = sucursales();
        const desgloseSuc = sucLista.map((s) => ({
            sucursal_id: s.id,
            sucursal: s.nombre,
            ventas: Math.round((porSuc[s.id] || 0) * 100) / 100
        }));

        function fPlata(n) {
            return '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        const car = cartera(sucursalId);
        const deudaTotal = (car && car.cartera && car.cartera.total_deuda) || 0;

        const vitrina = {
            periodo: periodo || 'Hoy',
            es_hoy: esHoy,
            desde: ini ? (ini + ' 00:00:00') : '',
            hasta: fin ? (fin + ' 23:59:59') : '',
            actualizado_en_texto: selloGlobal ? String(selloGlobal).slice(5, 16).replace('T', ' ') : 'Al día',
            tickets: {
                titulo: 'Tickets del día',
                cant: tickets,
                total: total,
                texto: tickets + ' · ' + fPlata(total),
                subtitulo: ''
            },
            ganancia_parcial: {
                titulo: 'Ganancia parcial',
                valor: Math.round(total * 0.27 * 100) / 100,
                texto: fPlata(total * 0.27),
                subtitulo: 'Margen estimado sobre ventas'
            },
            deuda_clientes: {
                titulo: 'Deuda clientes',
                valor: deudaTotal,
                texto: fPlata(deudaTotal),
                subtitulo: 'Saldo en la calle'
            },
            pagos_clientes: {
                titulo: 'Pagos clientes',
                valor: 0,
                texto: '$0,00',
                subtitulo: 'Cobranzas de cuenta corriente'
            },
            tickets_digitales: {
                titulo: 'Tickets digitales',
                valor: Math.round(montoDigital * 100) / 100,
                texto: fPlata(montoDigital),
                subtitulo: 'Con ticket · libro de ventas'
            },
            cancelaciones: {
                titulo: 'Cancelaciones',
                cant: 0,
                monto: 0,
                texto: '0',
                subtitulo: 'Ventas canceladas'
            },
            sin_firmar: {
                titulo: 'Sin firmar / F9',
                valor: 0,
                texto: '$0,00',
                badge: '',
                subtitulo: 'Tickets sin firma MP'
            },
            mp_sin_ticket: {
                titulo: 'MP sin ticket',
                valor: 0,
                texto: '$0,00',
                badge: '0',
                subtitulo: 'Nada suelto: todo tiene ticket'
            },
            cliente: {
                titulo: 'Cliente',
                valor: 0,
                texto: '$0,00',
                subtitulo: 'Cobranza QR / tarjeta / transferencia'
            },
            descuento: {
                titulo: 'Descuento',
                valor: 0,
                texto: '$0,00',
                subtitulo: 'Ofertas del ticket'
            },
            redondeo: {
                titulo: 'Redondeo',
                valor: 0,
                texto: '$0,00',
                subtitulo: 'F3 en el cobro'
            },
            inventario_costo: {
                titulo: 'Inventario al costo',
                valor: 0,
                texto: '—',
                subtitulo: 'Valuación a costo real'
            }
        };

        return {
            ok: true,
            libro: delRango.length > 0 || vFilas.length > 0,
            panel: 'jefe',
            resumen: {
                dia: diaReporte,
                ventas: Math.round(total * 100) / 100,
                tickets: tickets,
                promedio: tickets ? Math.round((total / tickets) * 100) / 100 : 0,
                pago: pago,
                es_hoy: esHoy,
                dia_anterior: antFin,
                ventas_anterior: totalAnterior ? Math.round(totalAnterior * 100) / 100 : null,
                variacion_pct: variacion
            },
            vitrina: vitrina,
            ranking_cortes: ranking,
            desglose_sucursales: desgloseSuc,
            pulso: { alertas: [] },
            sucursales: sucLista,
            sucursal_id: sucursalId
        };
    }

    /**
     * Obtiene el ticket con sus líneas de detalle desde el espejo.
     */
    function ticket(id) {
        const vId = idTexto(id);
        const vFilas = filasTabla('ventas');
        const venta = vFilas.find((v) => idTexto(v.id) === vId);
        if (!venta) return null;

        const dFilas = filasTabla('detalles_ventas');
        const items = dFilas
            .filter((d) => idTexto(d.id_venta || d.venta_id || d.ticket_id) === vId)
            .map((d) => ({
                producto: d.nombre_producto || d.nombre || d.producto || d.descripcion || 'Artículo',
                cantidad: Number(d.cantidad || d.kilos || d.peso || d.cant) || 1,
                precio: Number(d.precio_unitario || d.precio) || 0,
                subtotal: Number(d.subtotal || d.total || d.monto) || 0
            }));

        return {
            ok: true,
            id: vId,
            fecha: venta.fecha,
            total: Number(venta.total) || 0,
            pago: venta.metodo_pago || venta.medio_pago || 'Efectivo',
            estado: venta.estado || 'PAGADO',
            cliente: venta.cliente_nombre || '',
            items: items
        };
    }

    /**
     * Historial de un cliente desde el espejo (cuenta corriente y ventas).
     */
    function historialCliente(posId, dni) {
        const pid = idTexto(posId);
        const dniTxt = idTexto(dni);
        const ccTodas = filasTabla('cuenta_corriente');
        const ccFilas = ccTodas
            .filter((cc) => (pid && idTexto(cc.cliente_id) === pid))
            .sort((a, b) => (String(a.fecha) < String(b.fecha) ? 1 : -1));

        if (ccFilas.length > 0) {
            const movs = ccFilas.map((cc) => {
                const tipo = String(cc.tipo || 'CARGO').toUpperCase();
                const desc = String(cc.descripcion || '');
                const esInt = desc.toUpperCase().includes('INTERÉS') || desc.toUpperCase().includes('INTERES');
                return {
                    id: cc.id,
                    fecha: String(cc.fecha || '').split('.')[0],
                    tipo: tipo,
                    monto: Number(cc.monto) || 0,
                    saldo: Number(cc.saldo_resultante != null ? cc.saldo_resultante : cc.monto) || 0,
                    etiqueta: esInt ? 'Interés compensatorio' : (tipo === 'CARGO' ? 'Venta a crédito' : 'Cobro fiado'),
                    ticket: cc.venta_id ? ('Ticket #' + cc.venta_id) : (desc.match(/Ticket #\d+/i) ? desc.match(/Ticket #\d+/i)[0] : ''),
                    detalle: desc,
                    mantenimiento: 0,
                    dias: null,
                    es_venta: tipo === 'CARGO' && !esInt,
                    es_cobro: tipo === 'ABONO',
                    es_interes: esInt,
                    borrado: false,
                    cancelado: false
                };
            });
            return {
                ok: true,
                pos_id: posId,
                movimientos: movs,
                tickets: movs.map((m) => ({ id: m.id, fecha: m.fecha, total: m.monto, pago: 'Crédito' })),
                resumen: `${movs.length} movimiento(s) · Espejo local`
            };
        }

        const vFilas = filasTabla('ventas');
        const cFilas = vFilas
            .filter((v) => (pid && idTexto(v.cliente_id) === pid) || (dniTxt && idTexto(v.dni_cuit) === dniTxt))
            .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))
            .slice(0, 50);

        const movsVentas = cFilas.map((v) => ({
            id: v.id,
            fecha: v.fecha,
            tipo: 'CARGO',
            monto: Number(v.total) || 0,
            saldo: Number(v.total) || 0,
            etiqueta: 'Venta',
            ticket: 'Ticket #' + v.id,
            detalle: v.pago || 'Venta',
            mantenimiento: 0,
            dias: null,
            es_venta: true,
            es_cobro: false,
            es_interes: false,
            borrado: false,
            cancelado: false
        }));

        return {
            ok: true,
            pos_id: posId,
            movimientos: movsVentas,
            tickets: cFilas.map((v) => ({
                id: v.id,
                fecha: v.fecha,
                total: Number(v.total) || 0,
                pago: v.metodo_pago || v.medio_pago || 'Efectivo',
                estado: v.estado
            })),
            resumen: `${movsVentas.length} venta(s) · Espejo local`
        };
    }

    // --- Descarga completa clásica ---

    async function bajarTabla(tabla) {
        const res = await fetch('/api/pos/espejo/tabla?tabla=' + encodeURIComponent(tabla));
        if (!res.ok) return null;
        const dato = await res.json();
        if (!dato || !dato.ok) return null;
        const libro = { sello: dato.sello || '', sucursales: dato.sucursales || [] };
        await guardarTabla(tabla, libro, false);
        return libro;
    }

    async function unaPasada() {
        await hidratar();
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
            const local = copias[tabla];
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

    function sello() {
        if (selloGlobal) return selloGlobal;
        let maxS = '';
        Object.values(copias).forEach((c) => {
            if (c && c.sello && c.sello > maxS) maxS = c.sello;
        });
        selloGlobal = maxS;
        return maxS;
    }

    function tieneDatos() {
        return Boolean(
            (copias.ventas && copias.ventas.sucursales && copias.ventas.sucursales.length) ||
            (copias.clientes && copias.clientes.sucursales && copias.clientes.sucursales.length)
        );
    }

    // Exportar módulo Espejo
    global.Espejo = {
        asegurar: asegurar,
        hidratar: hidratar,
        guardarTabla: guardarTabla,
        tabla: function (t) { return copias[t] || null; },
        sello: sello,
        sellos: function () {
            const map = {};
            Object.keys(copias).forEach((t) => { map[t] = copias[t]?.sello || ''; });
            return map;
        },
        tieneDatos: tieneDatos,
        ventas: function () { return memoria || copias.ventas || null; },
        filasTabla: filasTabla,
        sucursales: sucursales,
        fijarSucursales: fijarSucursales,
        purgar: purgarSucursalesObsoletas,
        limpiarTodo: limpiarTodo,
        clientes: clientes,
        cartera: cartera,
        contabilidad: contabilidad,
        resumenJefe: resumenJefe,
        ticket: ticket,
        historialCliente: historialCliente,
        sumar: sumar,
        listar: listar,
        desglose: desglose,
        rangoPeriodo: rangoPeriodo,
        rangoVentas: rangoVentas,
        alActualizar: function (fn) { avisos.push(fn); },
        _guardar: guardar,
        _avisar: avisar,
    };

    // Auto-hidratar al cargar el script
    hidratar();
})(window);
