/* =========================================================================
   COLABORADORES Y ROLES POR SUCURSAL - Cobro Fácil
   Maneja miembros del equipo, permisos de operador vs. administrador y
   asignación exclusiva por sucursal o acceso global a la red.
   ========================================================================= */
(function (global) {
    let colaboradoresLista = [];

    function textoSeguro(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = String(str);
        return d.innerHTML;
    }

    async function cargarColaboradores() {
        const subtitulo = document.getElementById('empresaColaboradoresSubtitulo');
        const listaCont = document.getElementById('empresaListaColaboradores');
        if (!listaCont) return;

        try {
            if (subtitulo) subtitulo.textContent = 'Consultando equipo...';
            const res = await fetch('/api/usuarios');
            if (!res.ok) {
                if (subtitulo) subtitulo.textContent = 'Solo administradores pueden gestionar colaboradores.';
                return;
            }
            colaboradoresLista = await res.json();
            if (!Array.isArray(colaboradoresLista)) {
                if (subtitulo) subtitulo.textContent = 'No se pudo cargar la lista.';
                return;
            }
            if (subtitulo) {
                const conCandado = colaboradoresLista.filter((u) => u.sucursal_id != null).length;
                subtitulo.textContent = `${colaboradoresLista.length} miembros · ${conCandado} con sucursal exclusiva`;
            }

            if (colaboradoresLista.length === 0) {
                listaCont.innerHTML = '<p style="color:#64748b; font-size:13px; padding:10px 0;">No hay colaboradores registrados.</p>';
                return;
            }

            let html = '';
            colaboradoresLista.forEach((u) => {
                const esGlobal = !u.sucursal_id;
                const badgeColor = esGlobal ? '#2D3277' : '#0369a1';
                const badgeBg = esGlobal ? '#f1f5f9' : '#e0f2fe';
                const badgeTexto = esGlobal ? '👑 Toda la Red (Gerente Comercial)' : `🏪 ${textoSeguro(u.sucursal_nombre || 'Sucursal ' + u.sucursal_id)}`;
                const rolTexto = u.role === 'admin' ? 'Administrador' : (u.role === 'visor' ? 'Visor' : 'Operador / Cajero');
                const letra = (u.nombre || u.username || 'U')[0].toUpperCase();

                html += `
                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:12px 14px; display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <div style="width:36px; height:36px; border-radius:50%; background:${esGlobal ? '#2D3277' : '#0284c7'}; color:#ffffff; font-weight:800; font-size:14px; display:flex; align-items:center; justify-content:center;">
                                ${letra}
                            </div>
                            <div>
                                <strong style="font-size:14px; color:#1e293b; display:block;">${textoSeguro(u.nombre || u.username)}</strong>
                                <small style="font-size:11px; color:#64748b;">@${textoSeguro(u.username)} · ${rolTexto}</small>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:6px;">
                            <button type="button" class="btn btn-ghost btn-sm btn-editar-colaborador" data-id="${u.id}" style="padding:4px 8px; font-size:12px; font-weight:700; color:#2D3277;">
                                ✎ Editar
                            </button>
                            <button type="button" class="btn btn-ghost btn-sm btn-toggle-colaborador" data-id="${u.id}" data-activo="${u.activo ? '0' : '1'}" style="padding:4px 8px; font-size:11px; color:${u.activo ? '#dc2626' : '#16a34a'};">
                                ${u.activo ? 'Desactivar' : 'Activar'}
                            </button>
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                        <span style="font-size:11px; font-weight:800; padding:3px 10px; border-radius:20px; background:${badgeBg}; color:${badgeColor}; border:1px solid ${badgeColor}33;">
                            ${badgeTexto}
                        </span>
                        <span style="font-size:10px; font-weight:700; color:${u.activo ? '#16a34a' : '#94a3b8'};">
                            ● ${u.activo ? 'Activo' : 'Inactivo'}
                        </span>
                    </div>
                </div>`;
            });

            listaCont.innerHTML = html;

            listaCont.querySelectorAll('.btn-editar-colaborador').forEach((btn) => {
                btn.onclick = () => {
                    const uid = Number(btn.dataset.id);
                    const user = colaboradoresLista.find((u) => u.id === uid);
                    if (user) abrirModalColaborador(user);
                };
            });

            listaCont.querySelectorAll('.btn-toggle-colaborador').forEach((btn) => {
                btn.onclick = async () => {
                    const uid = Number(btn.dataset.id);
                    const nuevoActivo = btn.dataset.activo === '1';
                    try {
                        const res = await fetch(`/api/usuarios/${uid}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ activo: nuevoActivo }),
                        });
                        if (res.ok) {
                            cargarColaboradores();
                        } else {
                            const d = await res.json();
                            alert(d.error || 'Error al actualizar colaborador');
                        }
                    } catch (e) {
                        alert('Error de conexión');
                    }
                };
            });
        } catch (e) {
            if (subtitulo) subtitulo.textContent = 'Error al consultar colaboradores.';
        }
    }

    function poblarSelectSucursalesColaborador(sucursalSeleccionada = null) {
        const sel = document.getElementById('colaboradorFormSucursal');
        if (!sel) return;
        const sucursales = global.MiEmpresaSucursales?.getSucursalesDisponibles() || [];
        let opts = '<option value="">👑 Toda la Red (Gerente Comercial - Acceso Global)</option>';
        sucursales.forEach((s) => {
            const isSel = sucursalSeleccionada != null && String(s.id) === String(sucursalSeleccionada);
            opts += `<option value="${s.id}" ${isSel ? 'selected' : ''}>🏪 ${textoSeguro(s.nombre || 'Sucursal ' + s.id)}</option>`;
        });
        sel.innerHTML = opts;
    }

    function abrirModalColaborador(user = null) {
        const modal = document.getElementById('modalColaborador');
        const tit = document.getElementById('modalColaboradorTitulo');
        const passGrupo = document.getElementById('colaboradorPasswordGrupo');
        const passInput = document.getElementById('colaboradorFormPassword');
        if (!modal) return;

        poblarSelectSucursalesColaborador(user ? user.sucursal_id : null);

        document.getElementById('colaboradorFormId').value = user ? user.id : '';
        document.getElementById('colaboradorFormNombre').value = user ? (user.nombre || '') : '';
        document.getElementById('colaboradorFormUsername').value = user ? user.username : '';
        document.getElementById('colaboradorFormUsername').disabled = !!user;
        document.getElementById('colaboradorFormRole').value = user ? user.role : 'operador';
        document.getElementById('colaboradorFormSucursal').value = (user && user.sucursal_id != null) ? String(user.sucursal_id) : '';

        if (user) {
            if (passGrupo) passGrupo.style.display = 'none';
            if (passInput) passInput.required = false;
            if (tit) tit.textContent = '✎ Editar Colaborador';
        } else {
            if (passGrupo) passGrupo.style.display = '';
            if (passInput) {
                passInput.value = '';
                passInput.required = true;
            }
            if (tit) tit.textContent = '+ Nuevo Colaborador';
        }
        modal.style.display = 'block';
    }

    function cerrarModalColaborador() {
        const modal = document.getElementById('modalColaborador');
        if (modal) modal.style.display = 'none';
    }

    function init() {
        document.getElementById('empresaBtnNuevoColaborador')?.addEventListener('click', () => abrirModalColaborador());
        document.getElementById('modalColaboradorCerrar')?.addEventListener('click', cerrarModalColaborador);
        document.getElementById('modalColaboradorCancelar')?.addEventListener('click', cerrarModalColaborador);

        document.getElementById('formColaborador')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = e.target;
            const idVal = f.elements['id'].value;
            const sidVal = f.elements['sucursal_id'].value;
            const sucursalId = sidVal ? parseInt(sidVal, 10) : null;

            if (idVal) {
                const datos = {
                    nombre: f.elements['nombre'].value.trim(),
                    role: f.elements['role'].value,
                    sucursal_id: sucursalId,
                };
                try {
                    const res = await fetch(`/api/usuarios/${idVal}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(datos),
                    });
                    const data = await res.json();
                    if (res.ok) {
                        cerrarModalColaborador();
                        cargarColaboradores();
                    } else {
                        alert(data.error || 'Error al actualizar colaborador');
                    }
                } catch (err) {
                    alert('Error de red al actualizar colaborador');
                }
            } else {
                const datos = {
                    nombre: f.elements['nombre'].value.trim(),
                    username: f.elements['username'].value.trim(),
                    password: f.elements['password'].value,
                    role: f.elements['role'].value,
                    sucursal_id: sucursalId,
                };
                try {
                    const res = await fetch('/api/usuarios', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(datos),
                    });
                    const data = await res.json();
                    if (res.ok) {
                        cerrarModalColaborador();
                        cargarColaboradores();
                    } else {
                        alert(data.error || 'Error al crear colaborador');
                    }
                } catch (err) {
                    alert('Error de red al crear colaborador');
                }
            }
        });
    }

    global.MiEmpresaColaboradores = {
        init,
        cargarColaboradores,
        poblarSelectSucursalesColaborador,
        abrirModalColaborador,
        cerrarModalColaborador,
    };
})(window);
