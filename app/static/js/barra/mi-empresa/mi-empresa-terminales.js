/* =========================================================================
   TERMINALES / CAJAS TPV - Cobro Fácil
   Maneja equipos TPV conectados, saludo inicial, asignación a sucursal,
   pausa, bloqueo y desvinculación.
   ========================================================================= */
(function (global) {
    let terminalesDisponibles = [];
    let sucursalesDisponibles = [];

    function textoSeguro(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = String(str);
        return d.innerHTML;
    }

    function setTerminalesDisponibles(terms, sucs) {
        terminalesDisponibles = terms || [];
        sucursalesDisponibles = sucs || [];
    }

    function renderPendientesHtml(pendientes) {
        const cant = pendientes ? pendientes.length : 0;
        return `
        <div class="sucursal-card" style="border:1.5px solid ${cant > 0 ? '#fde68a' : '#e2e8f0'}; border-radius:14px; padding:12px 14px; background:${cant > 0 ? '#fffbeb' : '#ffffff'}; margin-bottom:12px;">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <strong style="font-size:13px; color:${cant > 0 ? '#b45309' : '#1e293b'};">
                        💻 PCs Pendientes / Sin Asignar
                    </strong>
                    <span style="background:${cant > 0 ? '#fef08a' : '#f1f5f9'}; color:${cant > 0 ? '#854d0e' : '#64748b'}; font-size:10px; font-weight:800; padding:2px 8px; border-radius:12px;">
                        ${cant}
                    </span>
                </div>
            </div>
            <p style="margin:0 0 ${cant > 0 ? '8px' : '0'} 0; font-size:11px; color:${cant > 0 ? '#92400e' : '#64748b'};">
                ${cant > 0
                    ? 'Equipos TPV que enviaron saludo por primera vez y están esperando asignación de sucursal para sincronizar tickets y stock.'
                    : '✓ No hay PCs esperando asignación. Cualquier equipo nuevo que inicie aparecerá aquí automáticamente.'}
            </p>
            ${cant > 0 ? `
            <div style="display:flex; flex-direction:column; gap:8px;">
                ${pendientes.map((pt) => `
                    <div style="display:flex; flex-direction:column; gap:8px; background:#ffffff; border:1px solid #fef08a; border-radius:10px; padding:10px 12px; font-size:11px;">
                        <div style="display:flex; flex-direction:column; gap:4px;">
                            <div style="display:flex; align-items:center; justify-content:space-between;">
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <span style="font-size:14px;">🖥️</span>
                                    <strong style="color:#1e293b; font-size:12px;">${textoSeguro(pt.nombre || 'PC Nueva')}</strong>
                                </div>
                                ${pt.activo === -1
                                    ? '<span style="background:#fee2e2; color:#b91c1c; font-size:9px; font-weight:800; padding:2px 6px; border-radius:4px;">BLOQUEADA</span>'
                                    : '<span style="background:#fef9c3; color:#a16207; font-size:9px; font-weight:800; padding:2px 6px; border-radius:4px;">PENDIENTE</span>'}
                            </div>
                            <div style="display:flex; flex-direction:column; gap:2px; color:#64748b; font-size:10px;">
                                <span>ID: <code style="background:#f1f5f9; padding:1px 4px; border-radius:4px; word-break:break-all;">${textoSeguro(pt.identificador_pc)}</code></span>
                                ${pt.ultimo_sync ? `<span>Último saludo: ${textoSeguro(pt.ultimo_sync.replace('GMT', '').trim())}</span>` : ''}
                            </div>
                        </div>
                        <div style="display:flex; flex-wrap:wrap; gap:6px;">
                            <button type="button" class="btn-asignar-terminal" data-tid="${pt.id}" style="flex:1; min-width:130px; background:#FFE600; border:none; border-radius:8px; padding:6px 10px; font-size:11px; font-weight:800; color:#2D3277; cursor:pointer; text-align:center;">
                                + Asignar Sucursal
                            </button>
                            ${pt.activo === -1
                                ? `<button type="button" class="btn-reactivar-terminal" data-tid="${pt.id}" style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:6px 10px; font-size:11px; font-weight:700; color:#15803d; cursor:pointer;">✓ Desbloquear</button>`
                                : `<button type="button" class="btn-revocar-terminal" data-tid="${pt.id}" style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:6px 10px; font-size:11px; font-weight:700; color:#b91c1c; cursor:pointer;">🚫 Revocar</button>`}
                            <button type="button" class="btn-desvincular-terminal" data-tid="${pt.id}" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:6px 10px; font-size:11px; font-weight:700; color:#64748b; cursor:pointer;">🗑️ Desvincular</button>
                        </div>
                    </div>
                `).join('')}
            </div>` : ''}
        </div>`;
    }

    function renderTerminalesSucursalHtml(terms) {
        return `
        <div style="border-top:1px dashed #cbd5e1; padding-top:8px; margin-top:2px;">
            <span style="font-size:10px; font-weight:800; text-transform:uppercase; color:#94a3b8; letter-spacing:0.5px;">
                Cajas / PCs Conectadas (${terms.length})
            </span>
            <div style="margin-top:4px; display:flex; flex-direction:column; gap:6px;">
                ${terms.length === 0 ? '<span style="font-size:11px; color:#94a3b8; font-style:italic;">⚠️ Sin cajas TPV vinculadas aún</span>' : ''}
                ${terms.map((t) => {
                    let statusBadge = '<span style="display:inline-flex; align-items:center; gap:4px; color:#16a34a; font-weight:700; font-size:10px;"><span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#16a34a;"></span>En vivo</span>';
                    if (t.activo === 0) {
                        statusBadge = '<span style="display:inline-flex; align-items:center; gap:4px; color:#d97706; font-weight:700; font-size:10px;"><span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#d97706;"></span>Pausada</span>';
                    } else if (t.activo === -1) {
                        statusBadge = '<span style="display:inline-flex; align-items:center; gap:4px; color:#dc2626; font-weight:700; font-size:10px;"><span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#dc2626;"></span>Bloqueada</span>';
                    }
                    return `
                    <div style="display:flex; flex-direction:column; gap:6px; background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:8px 10px; font-size:11px;">
                        <div style="display:flex; align-items:center; justify-content:space-between;">
                            <div style="display:flex; align-items:center; gap:6px;">
                                <span style="font-size:13px;">💻</span>
                                <strong style="color:#1e293b;">${textoSeguro(t.nombre)}</strong>
                                <code style="background:#f1f5f9; padding:1px 4px; border-radius:4px; font-size:10px; color:#64748b;" title="${textoSeguro(t.identificador_pc)}">${textoSeguro(t.identificador_pc.length > 18 ? t.identificador_pc.substring(0, 16) + '...' : t.identificador_pc)}</code>
                            </div>
                            ${statusBadge}
                        </div>
                        <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:2px;">
                            <button type="button" class="btn-editar-terminal" data-tid="${t.id}" title="Cambiar nombre o mover de sucursal" style="flex:1; min-width:120px; background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px; padding:5px 8px; font-size:10px; font-weight:700; color:#1e293b; cursor:pointer;">
                                ✎ Renombrar / Mover
                            </button>
                            ${t.activo === -1
                                ? `<button type="button" class="btn-reactivar-terminal" data-tid="${t.id}" style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:5px 8px; font-size:10px; font-weight:700; color:#15803d; cursor:pointer;">✓ Desbloquear</button>`
                                : `<button type="button" class="btn-revocar-terminal" data-tid="${t.id}" style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:5px 8px; font-size:10px; font-weight:700; color:#b91c1c; cursor:pointer;">🚫 Revocar</button>`}
                            <button type="button" class="btn-desvincular-terminal" data-tid="${t.id}" style="background:#ffffff; border:1px solid #e2e8f0; border-radius:6px; padding:5px 8px; font-size:10px; font-weight:700; color:#64748b; cursor:pointer;">🗑️ Desvincular</button>
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }

    function bindTerminalesEvents(container) {
        container.querySelectorAll('.btn-editar-terminal, .btn-asignar-terminal').forEach((btn) => {
            btn.onclick = () => {
                const tid = Number(btn.dataset.tid);
                const term = terminalesDisponibles.find((t) => t.id === tid);
                if (term) abrirModalTerminal(term);
            };
        });

        container.querySelectorAll('.btn-revocar-terminal').forEach((btn) => {
            btn.onclick = () => {
                const tid = Number(btn.dataset.tid);
                const t = terminalesDisponibles.find((x) => x.id === tid);
                if (confirm(`¿Bloquear/Revocar ${t ? t.nombre : 'esta PC'}? La nube rechazará sus sincronizaciones con código 403.`)) {
                    actualizarEstadoTerminal(tid, -1);
                }
            };
        });

        container.querySelectorAll('.btn-reactivar-terminal').forEach((btn) => {
            btn.onclick = () => {
                const tid = Number(btn.dataset.tid);
                actualizarEstadoTerminal(tid, 1);
            };
        });

        container.querySelectorAll('.btn-desvincular-terminal').forEach((btn) => {
            btn.onclick = () => {
                const tid = Number(btn.dataset.tid);
                desvincularTerminal(tid);
            };
        });
    }

    async function actualizarEstadoTerminal(tid, nuevoActivo) {
        try {
            const res = await fetch(`/api/terminales/${tid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ activo: nuevoActivo }),
            });
            const data = await res.json();
            if (data.success) {
                cerrarModalTerminal();
                global.MiEmpresaSucursales?.cargarSucursales();
            } else {
                alert(data.error || 'Error al actualizar estado');
            }
        } catch (e) {
            alert('Error de red al actualizar estado');
        }
    }

    async function desvincularTerminal(tid) {
        if (!confirm('¿Estás seguro de desvincular esta caja TPV de la empresa? Se eliminará el registro de la nube.')) {
            return;
        }
        try {
            const res = await fetch(`/api/terminales/${tid}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                cerrarModalTerminal();
                global.MiEmpresaSucursales?.cargarSucursales();
            } else {
                alert(data.error || 'Error al desvincular la caja');
            }
        } catch (e) {
            alert('Error de red al desvincular la caja');
        }
    }

    function abrirModalTerminal(term) {
        const modal = document.getElementById('modalTerminal');
        const tit = document.getElementById('modalTerminalTitulo');
        if (!modal) return;
        document.getElementById('terminalFormId').value = term.id;
        document.getElementById('terminalFormIdentificador').textContent = term.identificador_pc || '-';
        document.getElementById('terminalFormUltimoSync').textContent = term.ultimo_sync ? term.ultimo_sync.replace('GMT', '').trim() : 'Sin contacto';
        document.getElementById('terminalFormNombre').value = term.nombre || '';

        if (tit) {
            tit.textContent = (!term.sucursal_id || term.sucursal_id === 0) ? '📥 Asignar PC a Sucursal' : '💻 Administrar Caja TPV';
        }

        const selectSuc = document.getElementById('terminalFormSucursal');
        if (selectSuc) {
            let opts = '<option value="">-- Sin Asignar (Mover a Pendientes) --</option>';
            opts += sucursalesDisponibles.map((s) => `
                <option value="${s.id}" ${s.id === term.sucursal_id ? 'selected' : ''}>${textoSeguro(s.nombre)}</option>
            `).join('');
            selectSuc.innerHTML = opts;
        }

        const selectActivo = document.getElementById('terminalFormActivo');
        if (selectActivo) {
            if (!term.sucursal_id || term.sucursal_id === 0) {
                selectActivo.value = term.activo === -1 ? '-1' : '1';
            } else {
                selectActivo.value = term.activo != null ? String(term.activo) : '1';
            }
        }

        modal.style.display = 'block';
    }

    function cerrarModalTerminal() {
        const modal = document.getElementById('modalTerminal');
        if (modal) modal.style.display = 'none';
    }

    function init() {
        document.getElementById('modalTerminalCerrar')?.addEventListener('click', cerrarModalTerminal);
        document.getElementById('modalTerminalCancelar')?.addEventListener('click', cerrarModalTerminal);

        document.getElementById('formTerminal')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = e.target;
            const tid = f.elements['id'].value;
            const nombre = f.elements['nombre'].value.trim();
            const sucursal_id = f.elements['sucursal_id'].value;
            const activo = f.elements['activo'].value;

            if (!tid) return;

            try {
                const res = await fetch(`/api/terminales/${tid}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        nombre,
                        sucursal_id: sucursal_id ? parseInt(sucursal_id, 10) : null,
                        activo: parseInt(activo, 10),
                    }),
                });
                const data = await res.json();
                if (data.success) {
                    cerrarModalTerminal();
                    global.MiEmpresaSucursales?.cargarSucursales();
                } else {
                    alert(data.error || 'Error al actualizar la caja');
                }
            } catch (err) {
                alert('Error de red al actualizar la caja');
            }
        });

        document.getElementById('modalTerminalRevocar')?.addEventListener('click', async () => {
            const tid = document.getElementById('terminalFormId')?.value;
            if (!tid) return;
            if (!confirm('¿Deseas bloquear y revocar esta PC? La nube rechazará sus sincronizaciones con código 403.')) {
                return;
            }
            await actualizarEstadoTerminal(tid, -1);
        });

        document.getElementById('modalTerminalEliminar')?.addEventListener('click', async () => {
            const tid = document.getElementById('terminalFormId')?.value;
            if (!tid) return;
            await desvincularTerminal(tid);
        });
    }

    global.MiEmpresaTerminales = {
        init,
        setTerminalesDisponibles,
        renderPendientesHtml,
        renderTerminalesSucursalHtml,
        bindTerminalesEvents,
        abrirModalTerminal,
        cerrarModalTerminal,
        actualizarEstadoTerminal,
        desvincularTerminal,
    };
})(window);
