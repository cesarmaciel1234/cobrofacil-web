/**
 * Cara Frontend de Caja (app/static/js/barra/caja/caja-ui.js).
 *
 * Responsabilidad:
 * - Renderizar visualmente el arqueo diario y desglose por medios de pago en #contaCuerpo.
 * - Manejar totales de venta, cobros de fiado vinculados a cartera y gastos.
 * - Asegurar que el estado "Cargando el libro…" SIEMPRE se oculte y limpie de la pantalla.
 *
 * REGLA DE ARQUITECTURA: Cara pura. Solo manipulación de vistas, componentes y HTML seguro.
 */
(function (global) {
    'use strict';

    function $(id) {
        return document.getElementById(id);
    }

    function escaparTexto(valor) {
        return String(valor ?? '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function formatearPlata(monto) {
        if (typeof global.plataJefe === 'function') {
            return global.plataJefe(monto);
        }
        return '$' + Number(monto || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function calcularPorcentajes(montos) {
        if (typeof global.porcentajesQueCierran === 'function') {
            return global.porcentajesQueCierran(montos);
        }
        const total = montos.reduce((acc, n) => acc + (Number(n) || 0), 0);
        if (total <= 0) return montos.map(() => '0,0');
        return montos.map((n) => (((Number(n) || 0) / total) * 100).toFixed(1).replace('.', ','));
    }

    function mostrarCargando() {
        const cuerpo = $('contaCuerpo');
        if (!cuerpo) return;
        cuerpo.innerHTML = `
            <div style="padding:28px 14px; text-align:center; color:#64748b;">
                <div class="spinner-border spinner-border-sm text-primary mb-2" role="status" style="width:1.5rem; height:1.5rem;"></div>
                <p style="margin:8px 0 0; font-size:0.95rem; font-weight:500;">Consultando libro de caja…</p>
            </div>
        `;
    }

    function mostrarError(mensaje, onReintentar) {
        const cuerpo = $('contaCuerpo');
        if (!cuerpo) return;
        cuerpo.innerHTML = `
            <div style="padding:24px 14px; text-align:center;">
                <p style="margin:0 0 12px; color:#e11d48; font-weight:500;">⚠️ ${escaparTexto(mensaje || 'No se pudo cargar el libro de caja.')}</p>
                <button type="button" class="btn btn-sm btn-outline-secondary" id="btnReintentarCaja" style="border-radius:8px; padding:6px 16px;">
                    🔄 Reintentar
                </button>
            </div>
        `;
        const btn = $('btnReintentarCaja');
        if (btn && typeof onReintentar === 'function') {
            btn.onclick = onReintentar;
        }
    }

    /**
     * Renderiza el contenido del arqueo en #contaCuerpo.
     * Garantiza que el mensaje inicial 'Cargando el libro…' sea reemplazado siempre.
     */
    function render(dato, sucursalId, periodo) {
        const cuerpo = $('contaCuerpo');
        if (!cuerpo) return;

        // Avisos de sincronización si están disponibles
        if (global.renderAlertaSync) {
            try { global.renderAlertaSync('alertaSyncCaja', dato); } catch (_) {}
        }

        // Si la pantalla activa es 'digital', delegar
        if (global.cajaPantalla === 'digital') return;

        dato = dato || {};
        const c = dato.contabilidad || {};
        const resumen = dato.resumen || {};

        // 1. Título y período
        const contaDia = $('contaDia');
        if (contaDia) {
            let sucursalNombre = '';
            const sel = $('topbarSucursalSelect');
            if (sel && sel.selectedIndex >= 0 && sel.value) {
                sucursalNombre = sel.options[sel.selectedIndex].text;
            }
            const diaTxt = resumen.dia ? ('Libro · ' + resumen.dia) : 'Espejo de la caja';
            contaDia.textContent = sucursalNombre ? `${diaTxt} (${sucursalNombre})` : diaTxt;
        }

        if (typeof global.pintarChipPeriodo === 'function') {
            global.pintarChipPeriodo('cajaPeriodo', periodo || 'Hoy');
        }

        // 2. Si no hay libro o vino vacío del servidor
        if (!dato.libro && (!c.medios_pago || c.medios_pago.length === 0)) {
            const aviso = dato.mensaje || 'El libro de Cobro Fácil todavía no llegó a la nube para esta sucursal. Cuando termine el envío, este número sale de ahí.';
            cuerpo.innerHTML = `<p style="margin:0; padding:16px; color:#64748b; text-align:center;">${escaparTexto(aviso)}</p>`;
            return;
        }

        const medios = c.medios_pago || [];
        const cobrosTotal = Number(c.cobros) || 0;
        const cobrosCant = Number(c.cobros_cant) || 0;
        const cobrosPorMedio = c.cobros_por_medio || {};

        if (cobrosTotal > 0 && Object.keys(cobrosPorMedio).length === 0) {
            cobrosPorMedio['Efectivo'] = { monto: cobrosTotal, cant: cobrosCant || 1 };
        }

        const sumaMedios = medios.reduce((acc, m) => acc + (Number(m.monto != null ? m.monto : m.total) || 0), 0);
        const periodoCajaTxt = c.etiqueta ? `<p class="caja-periodo">${escaparTexto(c.etiqueta)}</p>` : '';
        let html = `${periodoCajaTxt}<div data-pantalla="arqueo" class="arqueo-lista">`;

        // 3. Caso sin movimientos en el día
        if (medios.length === 0 && cobrosTotal === 0) {
            const msgVacio = (c.etiqueta && !String(c.etiqueta).startsWith('Hoy'))
                ? 'Sin movimientos de pago en este período.'
                : 'Sin movimientos de pago ese día.';
            html += `<p class="caja-vacio" style="padding:16px; text-align:center; color:#64748b;">${msgVacio}</p>`;
        } else {
            const montos = medios.map((m) => Number(m.monto != null ? m.monto : m.total) || 0);
            const partes = calcularPorcentajes(montos);

            medios.forEach((m, i) => {
                const cant = Number(m.tickets) || 0;
                const ticketsTexto = cant + (cant === 1 ? ' ticket' : ' tickets');
                const monto = montos[i];
                const nombreMedio = String(m.medio || 'Efectivo');

                // Cobro de fiado extra en el mismo medio
                let extraCobro = 0;
                const nmLower = nombreMedio.trim().toLowerCase();
                for (const [k, v] of Object.entries(cobrosPorMedio)) {
                    if (String(k).trim().toLowerCase() === nmLower) {
                        extraCobro += Number(v.monto != null ? v.monto : v) || 0;
                    }
                }
                const badgeExtra = extraCobro > 0
                    ? `<small class="arqueo-extra-badge" title="Cobro deuda cliente en ${escaparTexto(nombreMedio)}: +${formatearPlata(extraCobro)}">+${formatearPlata(extraCobro)} cobro</small>`
                    : '';

                html += `<div class="arqueo-fila">
                    <div>
                        <b>${escaparTexto(nombreMedio)}</b>
                        ${badgeExtra}
                    </div>
                    <span>${escaparTexto(ticketsTexto)}</span>
                    <span><b>${formatearPlata(monto)}</b><small class="arqueo-pct">${partes[i]}%</small></span>
                </div>`;
            });
        }

        html += `<div class="arqueo-pie"><span>Total ventas</span><b>${formatearPlata(sumaMedios)}</b></div>`;

        // 4. Fila especial "Cobro deuda cliente"
        if (cobrosTotal > 0 || cobrosCant > 0) {
            const txtCobros = cobrosCant + (cobrosCant === 1 ? ' cobro registrado' : ' cobros registrados');
            html += `
            <div class="arqueo-deuda-cliente" onclick="window.irAHistorialCobros && window.irAHistorialCobros()" role="button" tabindex="0" title="Tocar para ver detalle en Cartera → Historial de cobros">
                <div class="arqueo-deuda-info">
                    <span class="arqueo-deuda-titulo">🤝 Cobro deuda cliente</span>
                    <small class="arqueo-deuda-sub">${escaparTexto(txtCobros)} · Ver en Cartera ↗</small>
                </div>
                <div class="arqueo-deuda-monto">
                    <b>+ ${formatearPlata(cobrosTotal)}</b>
                </div>
            </div>
            <div class="arqueo-total-caja">
                <span>Total en caja / ingresos</span>
                <b>${formatearPlata(sumaMedios + cobrosTotal)}</b>
            </div>`;
        }

        html += `</div>`;

        // Reemplazo definitivo del contenido en el DOM
        cuerpo.innerHTML = html;

        // Actualizar estado activo en la barra de herramientas
        document.querySelectorAll('#herramientasLista .herramienta-btn').forEach((boton) => {
            boton.classList.toggle('active', boton.textContent.trim() === 'Arqueo por medio de pago');
        });
    }

    global.CajaUI = {
        render: render,
        mostrarCargando: mostrarCargando,
        mostrarError: mostrarError,
    };
})(typeof window !== 'undefined' ? window : this);
