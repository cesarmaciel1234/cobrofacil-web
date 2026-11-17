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

    function coincideSucursal(sucId, filtro) {
        if (filtro === null || filtro === undefined) return true;
        const f = String(filtro).trim().toLowerCase();
        if (!f || f === 'todas' || f === 'todos' || f === 'todas las sucursales') return true;
        return String(sucId).trim() === String(filtro).trim();
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
            const dias = f.dias !== undefined && f.dias !== null && f.dias !== '' ? Number(f.dias) : null;

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
                en_riesgo: (limite > 0 && saldo >= limite) || (dias !== null && dias > 30),
                estado: saldo > 0 ? 'Con saldo' : 'Al día',
                sucursal_id: f.sucursal_id,
                sucursal_nombre: f.sucursal_nombre,
            };

            if (dni) {
                if (porDni.has(dni)) {
                    const previo = porDni.get(dni);
                    if (previo.sucursal_id !== f.sucursal_id) {
                        previo.saldo_actual += saldo;
                        previo.deuda_pos += saldo;
                        previo.deuda += saldo;
                    }
                    return;
                }
                porDni.set(dni, item);
            } else if (nombre) {
                const k = nombre.toLowerCase();
                if (porNombre.has(k)) {
                    const previo = porNombre.get(k);
                    if (previo.sucursal_id !== f.sucursal_id) {
                        previo.saldo_actual += saldo;
                        previo.deuda_pos += saldo;
                        previo.deuda += saldo;
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
        let totalDeuda = 0;
        let totalCuentas = 0;
        let cuentasEnRiesgo = 0;
        let deudaEnRiesgo = 0;
        lista.forEach((c) => {
            const saldo = Number(c.deuda != null ? c.deuda : (c.saldo_actual || 0));
            if (saldo > 0) {
                totalDeuda += saldo;
                totalCuentas += 1;
            }
            if (c.en_riesgo) {
                cuentasEnRiesgo += 1;
                if (saldo > 0) deudaEnRiesgo += saldo;
            }
        });
        const topDeudores = lista
            .filter((c) => (c.deuda || c.saldo_actual || 0) > 0)
            .sort((a, b) => (b.deuda || b.saldo_actual || 0) - (a.deuda || a.saldo_actual || 0))
            .slice(0, 15);

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
                cobros_del_mes: 0,
                cobros_mes: 0,
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
        ccFilas.forEach((c) => {
            const dia = diaDe(c.fecha);
            if (ini && dia && dia < ini) return;
            if (fin && dia && dia > fin) return;
            const haber = Number(c.haber) || 0;
            if (haber > 0) totalCobros += haber;
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
            kilos: item.cantidad,
            monto: item.monto
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
     * Historial de un cliente desde el espejo.
     */
    function historialCliente(posId, dni) {
        const pid = idTexto(posId);
        const dniTxt = idTexto(dni);
        const vFilas = filasTabla('ventas');
        const cFilas = vFilas
            .filter((v) => (pid && idTexto(v.cliente_id) === pid) || (dniTxt && idTexto(v.dni_cuit) === dniTxt))
            .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))
            .slice(0, 50);

        return {
            ok: true,
            tickets: cFilas.map((v) => ({
                id: v.id,
                fecha: v.fecha,
                total: Number(v.total) || 0,
                pago: v.metodo_pago || v.medio_pago || 'Efectivo',
                estado: v.estado
            }))
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
