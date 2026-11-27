/* =========================================================================
   COORDINADOR MI EMPRESA (Perfil, Sucursales, Terminales y Colaboradores)
   Cobro Fácil - Arquitectura Modular (<400 líneas por archivo)
   ========================================================================= */
(function (global) {
    global.BarraModulos = global.BarraModulos || [];
    global.BarraModulos.push({
        id: 'mi-empresa',
        nombre: 'Perfil',
        vista: 'mi-empresa',
        herramientas: [],
    });

    async function entrar(usuario) {
        if (!usuario) return;
        if (global.MiEmpresaPerfil) {
            await global.MiEmpresaPerfil.entrar(usuario);
        }
        if (global.MiEmpresaSucursales) {
            await global.MiEmpresaSucursales.cargarSucursales();
        }
        if (global.MiEmpresaColaboradores) {
            await global.MiEmpresaColaboradores.cargarColaboradores();
        }
    }

    function init() {
        global.MiEmpresaPerfil?.init();
        global.MiEmpresaSucursales?.init();
        global.MiEmpresaTerminales?.init();
        global.MiEmpresaColaboradores?.init();
    }

    // Inicializar listeners del DOM cuando el documento esté listo
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    global.MiEmpresa = {
        entrar,
        cargarSucursales: () => global.MiEmpresaSucursales?.cargarSucursales(),
        cargarColaboradores: () => global.MiEmpresaColaboradores?.cargarColaboradores(),
    };
})(window);
