const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function pantalla(productos) {
    const nodes = {};
    let response = { ok: true, productos, departamentos: [], fuente: 'local' };
    const wrap = {
        style: {},
        set innerHTML(html) {
            this.html = html;
            for (const id of Object.keys(nodes)) if (id !== 'pedidosAuditoriaWrap') delete nodes[id];
            this.buttons = [];
            for (const match of html.matchAll(/<(button|input)\b([^>]*)>/g)) {
                const attrs = match[2];
                const attr = name => (attrs.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];
                const node = {
                    dataset: { filtro: attr('data-filtro'), depto: attr('data-depto') },
                    className: attr('class') || '',
                    listeners: {},
                    addEventListener(name, fn) { this.listeners[name] = fn; },
                    focus() {},
                };
                const id = attr('id');
                if (id) nodes[id] = node;
                if (match[1] === 'button') this.buttons.push(node);
            }
        },
        querySelectorAll(selector) {
            if (selector.startsWith('.')) return this.buttons.filter(node => node.className.split(' ').includes(selector.slice(1)));
            return [];
        },
        querySelector() { return null; },
    };
    nodes.pedidosAuditoriaWrap = wrap;
    const document = {
        readyState: 'loading',
        activeElement: null,
        getElementById: id => nodes[id] || null,
        addEventListener() {},
    };
    const window = { document };
    const fetch = async () => {
        if (response instanceof Error) throw response;
        return { ok: true, json: async () => response };
    };
    const file = path.join(__dirname, '..', 'app', 'static', 'js', 'barra', 'auditoria-inventario.js');
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window, document, fetch, console, navigator: {}, setTimeout });
    const click = (selector, value) => {
        const node = wrap.querySelectorAll(selector).find(item =>
            selector === '.audit-kpi-card' ? item.dataset.filtro === value : item.dataset.depto === value);
        assert.ok(node);
        node.listeners.click();
    };
    return { window, nodes, wrap, click, fail: () => { response = new Error('red'); }, restore: () => { response = { ok: true, productos, fuente: 'local' }; } };
}

const productos = [
    { id: 1, nombre: 'Carne', departamento: 'CARNES', stock: 3, ultimo_conteo: 8, auditado_hoy: true, diferencia: -2, unidad: 'KG' },
    { id: 2, nombre: 'Pollo', departamento: 'CARNES', stock: 0, auditado_hoy: false, unidad: 'KG' },
    { id: 3, nombre: 'Agua', departamento: 'BEBIDAS', stock: -1, auditado_hoy: true, diferencia: 0.001, unidad: 'UN' },
    { id: 4, nombre: 'Jugo', departamento: 'BEBIDAS', stock: 2, auditado_hoy: false, unidad: 'UN' },
];

test('resumen y filtros combinados usan el stock actual y distinguen resultados ocultos', async () => {
    const p = pantalla(productos);
    await p.window.AuditoriaInventario.cargarCatalogoAuditoria();
    assert.match(p.wrap.html, /Sin stock[\s\S]*?>2<\/strong>/);
    assert.match(p.wrap.html, /Sin contar hoy[\s\S]*?>2<\/strong>/);
    assert.match(p.wrap.html, /Con diferencia[\s\S]*?>1<\/strong>/);
    assert.match(p.wrap.html, /Stock: <b[^>]*>3,000 kg<\/b>/);
    assert.doesNotMatch(p.wrap.html, /Stock: <b[^>]*>8,000 kg<\/b>/);

    p.click('.audit-kpi-card', 'quiebre');
    p.click('.depto-chip', 'CARNES');
    assert.match(p.wrap.html, /CARNES · Sin stock \(1\)/);
    assert.match(p.wrap.html, /<span>Pollo<\/span>/);
    assert.doesNotMatch(p.wrap.html, /<span>Agua<\/span>/);

    p.nodes.auditoriaSearchInput.listeners.input({ target: { value: 'Agua' } });
    assert.match(p.wrap.html, /No hay artículos con estos filtros/);
    assert.doesNotMatch(p.wrap.html, /id="btnCrearDesdeVacio"/);
    p.nodes.btnRestablecerFiltros.listeners.click();
    assert.match(p.wrap.html, /<span>Agua<\/span>/);
    p.nodes.auditoriaSearchInput.listeners.input({ target: { value: 'Inexistente' } });
    assert.match(p.wrap.html, /id="btnCrearDesdeVacio"/);
});

test('un fallo de actualización identifica datos anteriores y permite reintentar', async () => {
    const p = pantalla(productos);
    await p.window.AuditoriaInventario.cargarCatalogoAuditoria();
    p.fail();
    await p.window.AuditoriaInventario.cargarCatalogoAuditoria();
    assert.match(p.wrap.html, /Se muestran los últimos datos cargados/);
    p.restore();
    p.nodes.btnReintentarActualizacionInventario.listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.doesNotMatch(p.wrap.html, /Se muestran los últimos datos cargados/);
});

test('el conteo comienza con el stock actual, no con un conteo anterior', async () => {
    const p = pantalla(productos);
    await p.window.AuditoriaInventario.cargarCatalogoAuditoria();
    for (const id of ['drawerConteoTactil', 'drawerDepto', 'drawerNombre', 'drawerCodigo',
        'drawerStockSistema', 'drawerDisplayUnidad', 'drawerPrecioDeptoBox', 'numpadPunto',
        'drawerDisplayConteo', 'drawerDiffBox', 'drawerDiferencia']) {
        p.nodes[id] = { style: {}, classList: { add() {} }, setAttribute() {} };
    }
    p.window.AuditoriaInventario.abrirDrawerConteo(productos[0]);
    assert.equal(p.nodes.drawerDisplayConteo.textContent, '3');
    assert.match(p.nodes.drawerStockSistema.textContent, /3,000 KG/);
});
