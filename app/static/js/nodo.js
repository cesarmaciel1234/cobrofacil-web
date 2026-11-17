/**
 * Esclavo de la PWA. La nube es la maestra.
 * Este módulo no pinta: copia el nodo y avisa cuando hay una pieza nueva.
 */
(function (global) {
    const ORDEN = [
        ['reporte', 'periodo=Hoy'],
        ['contabilidad', 'periodo=Hoy'],
        ['ticket', 'alcance=mes'],
        ['cartera', '']
    ];
    let basePromise = null;
    let memoria = {};
    let sello = '';
    let avisos = [];
    let arranco = false;
    let pasando = false;
    const enCurso = {};

    function abrir() {
        if (basePromise) return basePromise;
        basePromise = new Promise((resolve, reject) => {
            const pedido = indexedDB.open('crm-nodo', 1);
            pedido.onupgradeneeded = () => {
                const db = pedido.result;
                if (!db.objectStoreNames.contains('piezas')) db.createObjectStore('piezas');
            };
            pedido.onsuccess = () => resolve(pedido.result);
            pedido.onerror = () => {
                basePromise = null;
                reject(pedido.error);
            };
        });
        return basePromise;
    }

    function leerGuardado(clave) {
        return abrir().then((db) => new Promise((resolve) => {
            const tx = db.transaction('piezas', 'readonly');
            const pedido = tx.objectStore('piezas').get(clave);
            pedido.onsuccess = () => resolve(pedido.result || null);
            pedido.onerror = () => resolve(null);
        })).catch(() => null);
    }

    function guardar(clave, dato) {
        return abrir().then((db) => new Promise((resolve) => {
            const tx = db.transaction('piezas', 'readwrite');
            tx.objectStore('piezas').put(dato, clave);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        })).catch(() => {});
    }

    function clavesGuardadas() {
        return abrir().then((db) => new Promise((resolve) => {
            const tx = db.transaction('piezas', 'readonly');
            const pedido = tx.objectStore('piezas').getAllKeys();
            pedido.onsuccess = () => resolve(pedido.result || []);
            pedido.onerror = () => resolve([]);
        })).catch(() => []);
    }

    function avisar(pieza, consulta, dato) {
        avisos.forEach((fn) => {
            try { fn(pieza, consulta, dato); } catch (e) {}
        });
    }

    function claveDe(pieza, consulta) {
        return pieza + '?' + (consulta || '');
    }

    async function hidratar() {
        const claves = await clavesGuardadas();
        for (let i = 0; i < claves.length; i++) {
            const clave = String(claves[i]);
            const dato = await leerGuardado(clave);
            if (!dato) continue;
            memoria[clave] = dato;
            if (dato.nodo && dato.nodo.sello && dato.nodo.sello > sello) sello = dato.nodo.sello;
        }
        const reporte = memoria['reporte?periodo=Hoy'];
        if (reporte) avisar('reporte', 'periodo=Hoy', reporte);
    }

    async function pedir(pieza, consulta) {
        const clave = claveDe(pieza, consulta);
        const url = '/api/pos/nodo?pieza=' + encodeURIComponent(pieza) + (consulta ? '&' + consulta : '');
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return memoria[clave] || null;
        const dato = await res.json();
        if (!dato || dato.ok === false) return memoria[clave] || null;
        memoria[clave] = dato;
        if (dato.nodo && dato.nodo.sello) sello = dato.nodo.sello;
        await guardar(clave, dato);
        avisar(pieza, consulta || '', dato);
        return dato;
    }

    function encargar(pieza, consulta) {
        const clave = claveDe(pieza, consulta);
        const previo = memoria[clave];
        if (previo && previo.nodo && sello && previo.nodo.sello === sello) return Promise.resolve(previo);
        if (enCurso[clave]) return enCurso[clave];
        enCurso[clave] = pedir(pieza, consulta).finally(() => { delete enCurso[clave]; });
        return enCurso[clave];
    }

    async function pasada() {
        if (pasando || !navigator.onLine) return;
        pasando = true;
        try {
            const res = await fetch('/api/pos/nodo?pieza=estado', { cache: 'no-store' });
            if (!res.ok) return;
            const est = await res.json();
            const nuevo = est.sello || '';
            const mismas = nuevo && nuevo === sello && ORDEN.every((item) => {
                const dato = memoria[claveDe(item[0], item[1])];
                return dato && dato.nodo && dato.nodo.sello === sello;
            });
            if (mismas) return;
            if (nuevo) sello = nuevo;
            for (let i = 0; i < ORDEN.length; i++) {
                await encargar(ORDEN[i][0], ORDEN[i][1]);
            }
        } catch (e) {
        } finally {
            pasando = false;
        }
    }

    function arrancar() {
        if (arranco) return;
        arranco = true;
        hidratar().then(() => pasada());
        setInterval(() => {
            if (!document.hidden) void pasada();
        }, 5000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) void pasada();
        });
    }

    global.Nodo = {
        arrancar: arrancar,
        tomar: function (pieza, consulta) { return memoria[claveDe(pieza, consulta)] || null; },
        encargar: encargar,
        alCambiar: function (fn) { avisos.push(fn); }
    };

    arrancar();
})(window);
