const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Caja ofrece Ventas y conserva la selección al abrir el desglose', () => {
    class Element {
        constructor() {
            this.children = [];
            this.dataset = {};
            this.style = {};
            this.className = '';
            this.listeners = {};
            this.classList = { remove() {} };
        }
        appendChild(node) { this.children.push(node); }
        replaceChildren() { this.children = []; }
        querySelectorAll() { return []; }
        querySelector() { return null; }
        setAttribute() {}
        addEventListener(name, callback) { this.listeners[name] = callback; }
        set innerHTML(value) { if (!value) this.children = []; }
    }

    const ids = Object.fromEntries(
        ['herramientasLista', 'herramientasTitulo', 'herramientasDetalle', 'bolsaHerramientas',
            'view-contabilidad', 'view-ticket'].map(id => [id, new Element()])
    );
    const events = [];
    const document = {
        body: new Element(),
        getElementById: id => ids[id] || null,
        createElement: () => new Element(),
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    const window = { document, CrmBus: { emit: (...args) => events.push(args) } };
    const context = vm.createContext({ window, document });
    const root = path.join(__dirname, '..', 'app', 'static', 'js');
    for (const file of [path.join(root, 'barra', 'caja.js'), path.join(root, 'modulo-panel.js')]) {
        vm.runInContext(fs.readFileSync(file, 'utf8'), context);
    }
    window.BarraPiramide = window.BarraModulos;
    window.ModuloPanel.usar('contabilidad');
    const buttons = () => ids.herramientasLista.children.filter(node => node.listeners.click);
    assert.deepEqual(buttons().map(node => node.textContent), [
        'Arqueo por medio de pago', 'Pago digital', 'Historial de ventas', 'Desglose de artículos',
    ]);
    buttons()[3].listeners.click({ stopPropagation() {} });
    assert.deepEqual(events.pop(), ['pantallaModulo', 'contabilidad', 'desglose']);

    window.ModuloPanel.usar('ticket', 'desglose');
    assert.equal(ids.herramientasTitulo.textContent, 'Herramientas · Caja');
    assert.match(buttons()[3].className, /\bactive\b/);
    buttons()[0].listeners.click({ stopPropagation() {} });
    assert.deepEqual(events.pop(), ['pantallaModulo', 'contabilidad', 'arqueo']);
});

test('Caja vuelve al arqueo al tocar su botón desde el historial de ventas', async () => {
    let activeView = 'view-ticket';
    const active = new Set(['contabilidad']);
    const events = [];
    const buttons = ['reporte', 'mi-empresa', 'contabilidad'].map(name => ({
        dataset: { pwaView: name },
        classList: {
            contains: (value) => value === 'active' && active.has(name),
            toggle: (_value, on) => on ? active.add(name) : active.delete(name),
        },
    }));
    const views = ['view-ticket', 'view-contabilidad'].map(id => ({
        id, classList: {
            contains: (value) => value === 'active' && activeView === id,
            toggle: (_value, on) => { if (on) activeView = id; },
        },
    }));
    let click;
    const bar = {
        querySelector: () => buttons.find((button) => active.has(button.dataset.pwaView)),
        querySelectorAll: () => buttons,
        contains: () => true,
        addEventListener: (_name, callback) => { click = callback; },
    };
    const document = {
        getElementById: (id) => id === 'bottomPwaBar' ? bar : views.find(view => view.id === id),
        querySelectorAll: () => views,
    };
    const window = { CrmBus: { get: () => true, emit: (...args) => events.push(args) } };
    const file = path.join(__dirname, '..', 'app', 'static', 'js', 'barra', 'toque.js');
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window, document, navigator: {}, setTimeout });
    click({ target: { closest: () => buttons[2] } });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(activeView, 'view-contabilidad');
    assert.deepEqual(events, [['switchView', 'contabilidad']]);
});
