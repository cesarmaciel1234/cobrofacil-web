const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function pantalla() {
    class Element {
        constructor() { this.listeners = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.children = []; }
        addEventListener(event, callback) { this.listeners[event] = callback; }
        trigger(event) { return this.listeners[event]({ preventDefault() {} }); }
        replaceChildren() { this.children = []; }
        appendChild(node) { this.children.push(node); }
    }
    const ids = {};
    for (const id of [
        'empresaPerfilForm', 'empresaPerfilEstado', 'empresaPerfilResumen', 'empresaPerfilEditar',
        'empresaPerfilResenas', 'empresaPerfilValoracion', 'empresaPerfilMapaPanel', 'empresaPerfilMapaEstado',
        'empresaPerfilUbicacion', 'empresaPerfilInicial', 'empresaPerfilNombre', 'empresaPerfilDireccion',
        'empresaPerfilWhatsapp', 'empresaPerfilHorario', 'empresaPerfilDescripcion', 'empresaPerfilCancelar',
        'empresaPerfilAbrirMapa', 'empresaPerfilCerrarMapa', 'empresaPerfilGps',
    ]) ids[id] = new Element();
    const controls = [];
    for (const name of ['nombre', 'descripcion', 'direccion', 'latitud', 'longitud', 'whatsapp', 'horario']) {
        const element = new Element();
        controls.push(element);
        controls[name] = element;
    }
    ids.empresaPerfilForm.elements = controls;
    let user = { empresa_id: 1, role: 'admin' };
    let saved;
    let gps;
    let map;
    let profile = { nombre: 'Comercio', descripcion: '', direccion: 'Calle 1', latitud: -32.9, longitud: -60.6, whatsapp: '', horario: '' };
    const document = { getElementById: id => ids[id], createElement: () => new Element() };
    const window = {
        CrmBus: { emit: () => user },
        CrmSafe: { apiFetch: async (_url, options) => {
            if (options && options.method === 'PUT') {
                saved = JSON.parse(options.body);
                profile = { ...profile, ...saved };
            }
            return { ok: true, json: async () => ({ empresa_id: 1, perfil: profile, cantidad: 0, resenas: [] }) };
        } },
        L: {
            map: () => {
                map = {
                    setView() { return this; }, invalidateSize() {}, remove() {},
                    on(event, callback) { if (event === 'click') this.click = callback; },
                };
                return map;
            },
            tileLayer: () => ({ addTo() { return this; }, on() {} }),
            divIcon: () => ({}),
            marker: () => ({ addTo() { return this; }, setLatLng() {}, remove() {} }),
        },
    };
    const navigator = { geolocation: { getCurrentPosition(success, failure) { gps = { success, failure }; } } };
    const source = fs.readFileSync(path.join(root, 'app', 'static', 'js', 'barra', 'mi-empresa.js'), 'utf8');
    vm.runInNewContext(source, { window, document, navigator });
    return { ids, window, controls, getMap: () => map, getGps: () => gps, getSaved: () => saved, setUser: value => { user = value; } };
}

test('Perfil es el primer botón y conserva la vista Reporte inicial', () => {
    const html = fs.readFileSync(path.join(root, 'app', 'templates', 'terminal.html'), 'utf8');
    const bar = html.split('<nav class="bottom-pwa-bar"')[1].split('</nav>')[0];
    assert.deepEqual([...bar.matchAll(/data-pwa-view="([^"]+)"/g)].map(match => match[1]),
        ['mi-empresa', 'reporte', 'contabilidad', 'cartera', 'pedidos']);
    assert.match(bar, /class="pwa-nav-btn active" data-pwa-view="reporte"/);
    assert.match(bar, />Perfil<\/span>/);
});

test('el mapa guarda el punto confirmado y descarta GPS tardío', async () => {
    const ui = pantalla();
    await ui.window.MiEmpresa.entrar({ empresa_id: 1, role: 'admin' });
    assert.equal(ui.ids.empresaPerfilNombre.textContent, 'Comercio');
    ui.ids.empresaPerfilEditar.trigger('click');
    ui.controls.direccion.value = 'Calle 2';
    ui.controls.direccion.trigger('input');
    assert.equal(ui.controls.latitud.value, '');
    ui.ids.empresaPerfilAbrirMapa.trigger('click');
    ui.ids.empresaPerfilGps.trigger('click');
    ui.getMap().click({ latlng: { lat: -32.9, lng: -60.6 } });
    ui.getGps().success({ coords: { latitude: -30, longitude: -61 } });
    assert.equal(ui.controls.latitud.value, '-32.9');
    await ui.ids.empresaPerfilForm.trigger('submit');
    assert.equal(ui.getSaved().ubicacion_confirmada, true);
    assert.equal(ui.getSaved().direccion, 'Calle 2');
    assert.equal(ui.ids.empresaPerfilResumen.hidden, false);
});

test('visor no puede editar y el cambio de sesión impide guardar', async () => {
    const ui = pantalla();
    ui.setUser({ empresa_id: 1, role: 'visor' });
    await ui.window.MiEmpresa.entrar({ empresa_id: 1, role: 'visor' });
    assert.equal(ui.ids.empresaPerfilEditar.hidden, true);
    ui.setUser({ empresa_id: 1, role: 'admin' });
    await ui.window.MiEmpresa.entrar({ empresa_id: 1, role: 'admin' });
    ui.ids.empresaPerfilEditar.trigger('click');
    ui.setUser({ empresa_id: 2, role: 'admin' });
    await ui.ids.empresaPerfilForm.trigger('submit');
    assert.equal(ui.getSaved(), undefined);
    assert.match(ui.ids.empresaPerfilEstado.textContent, /sesión cambió/);
});
