/* Reporte Financiero (Cerebro Jefe). Curvas interactivas, insights y KPIs oficiales. */
(function (global) {
    let periodoActual = 'Semana Actual';
    let compararActual = false;
    let sucursalId = '';
    let datosActuales = null;
    let pantallaActual = 'vitrina'; // 'vitrina' | 'financiero'

    function $(id) { return document.getElementById(id); }

    function formatPesos(n) {
        if (n == null) return '$0,00';
        try {
            const val = Number(n) || 0;
            const neg = val < 0;
            const abs = Math.abs(val);
            const entero = Math.floor(abs);
            const dec = Math.round((abs - entero) * 100);
            const sEntero = entero.toLocaleString('es-AR');
            const res = `$${sEntero},${String(dec).padStart(2, '0')}`;
            return neg ? `-${res}` : res;
        } catch (e) {
            return '$0,00';
        }
    }

    function cambiarPantalla(pantalla) {
        pantallaActual = pantalla || 'vitrina';
        const vitrinaBox = $('reporteVitrina');
        const finBox = $('reporteFinanciero');
        const chipDia = $('reporteDia');

        if (pantallaActual === 'financiero') {
            if (vitrinaBox) vitrinaBox.hidden = true;
            if (finBox) finBox.hidden = false;
            if (chipDia) chipDia.hidden = true;
            cargarDatos();
        } else {
            if (vitrinaBox) vitrinaBox.hidden = false;
            if (finBox) finBox.hidden = true;
            if (chipDia) chipDia.hidden = false;
        }
    }

    async function cargarDatos() {
        const cerebroList = $('rfCerebroList');
        if (cerebroList && !datosActuales) {
            cerebroList.innerHTML = '<li>Analizando métricas y armando informe financiero…</li>';
        }
        try {
            let url = `/api/pos/jefe?panel=financiero&periodo=${encodeURIComponent(periodoActual)}`;
            if (compararActual) url += '&comparar=1';
            if (sucursalId) url += `&sucursal_id=${encodeURIComponent(sucursalId)}`;
            const res = await fetch(url);
            if (res.status === 401) {
                window.location.href = '/login';
                return;
            }
            if (!res.ok) throw new Error('financiero');
            const data = await res.json();
            datosActuales = data;
            renderFinanciero(data);
        } catch (err) {
            if (cerebroList) {
                cerebroList.innerHTML = '<li style="color:#ef4444;">No se pudo conectar con el motor financiero. Tocá reintentar.</li>';
            }
        }
    }

    function renderFinanciero(data) {
        if (!data || !data.ok) return;

        // 1. Título
        const tit = $('rfTitulo');
        if (tit) tit.textContent = data.titulo || `Resumen de Ventas (${periodoActual})`;

        // 2. Cerebro Jefe Insights
        const cerebroList = $('rfCerebroList');
        if (cerebroList) {
            const items = data.cerebro_jefe || [];
            if (!items.length) {
                cerebroList.innerHTML = '<li>Sin eventos destacados para este período.</li>';
            } else {
                cerebroList.innerHTML = items.map(it => `
                    <li>
                        <strong>${it.icono} ${it.titulo}:</strong> ${it.texto}
                    </li>
                `).join('');
            }
        }

        // 3. KPIs
        const k = data.kpis || {};
        if ($('rfKpiVentas')) $('rfKpiVentas').textContent = k.ventas_texto || formatPesos(k.ventas);
        if ($('rfKpiVentasDiff')) {
            if (data.comparar && k.ventas_prev != null) {
                const diff = k.ventas_diff_pct || 0;
                const signo = diff > 0 ? '+' : '';
                const color = diff >= 0 ? '#10b981' : '#ef4444';
                $('rfKpiVentasDiff').innerHTML = `<span style="color:${color}; font-weight:700;">${signo}${diff}%</span> vs anterior (${k.ventas_prev_texto})`;
            } else {
                $('rfKpiVentasDiff').textContent = 'Venta bruta acumulada';
            }
        }

        if ($('rfKpiGanancia')) {
            $('rfKpiGanancia').textContent = k.ganancia_texto || (k.ganancia != null ? formatPesos(k.ganancia) : 'Sin costo');
        }
        if ($('rfKpiGananciaSub')) {
            if (k.hay_costo && k.margen != null) {
                $('rfKpiGananciaSub').textContent = `Margen ${k.margen}% sobre venta`;
            } else {
                $('rfKpiGananciaSub').textContent = 'Cargá precio de costo para firmarla';
            }
        }

        if ($('rfKpiTickets')) $('rfKpiTickets').textContent = (k.tickets || 0).toLocaleString('es-AR');
        if ($('rfKpiPromedio')) $('rfKpiPromedio').textContent = k.ticket_medio_texto || formatPesos(k.ticket_medio);
        if ($('rfKpiCobertura')) {
            $('rfKpiCobertura').textContent = `Cobertura costo: ${k.cobertura || 0}%`;
        }

        // 4. Curva Interactiva SVG (Bézier suave)
        renderChartSvg(data.serie || [], data.comparar);

        // 5. Departamentos
        const deptosList = $('rfDeptosList');
        if (deptosList) {
            const deps = data.deptos || [];
            if (!deps.length) {
                deptosList.innerHTML = '<div style="color:var(--text-muted); padding:10px;">Sin departamentos en el período.</div>';
            } else {
                deptosList.innerHTML = deps.slice(0, 6).map(d => `
                    <div class="rf-dist-row">
                        <div class="rf-dist-row-top">
                            <span class="rf-dist-name">${d.nombre}</span>
                            <span class="rf-dist-val">${d.texto} <small>(${d.porcentaje}%)</small></span>
                        </div>
                        <div class="rf-progress-bar">
                            <div class="rf-progress-fill" style="width:${Math.min(100, d.porcentaje)}%;"></div>
                        </div>
                    </div>
                `).join('');
            }
        }

        // 6. Medios de pago
        const pagosList = $('rfPagosList');
        if (pagosList) {
            const pags = data.pagos || [];
            if (!pags.length) {
                pagosList.innerHTML = '<div style="color:var(--text-muted); padding:10px;">Sin cobros en el período.</div>';
            } else {
                pagosList.innerHTML = pags.map(p => `
                    <div class="rf-dist-row">
                        <div class="rf-dist-row-top">
                            <span class="rf-dist-name">${p.medio}</span>
                            <span class="rf-dist-val">${p.texto} <small>(${p.porcentaje}%)</small></span>
                        </div>
                        <div class="rf-progress-bar">
                            <div class="rf-progress-fill fill-green" style="width:${Math.min(100, p.porcentaje)}%;"></div>
                        </div>
                    </div>
                `).join('');
            }
        }

        // 7. Tabla Días
        const tablaCuerpo = $('rfTablaCuerpo');
        if (tablaCuerpo) {
            const serie = data.serie || [];
            if (!serie.length) {
                tablaCuerpo.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:16px; color:var(--text-muted);">Sin datos</td></tr>';
            } else {
                tablaCuerpo.innerHTML = serie.map(s => `
                    <tr>
                        <td style="font-weight:700;">${s.label} ${s.fecha ? `<small style="color:var(--text-muted);">(${s.fecha})</small>` : ''}</td>
                        <td style="text-align:right; font-weight:800; color:var(--accent);">${formatPesos(s.ventas)}</td>
                        <td style="text-align:right; font-weight:700; color:#10b981;">${formatPesos(s.ganancia)}</td>
                        <td style="text-align:right; color:var(--text-muted);">${s.tickets || 0}</td>
                    </tr>
                `).join('');
            }
        }
    }

    function renderChartSvg(serie, comparar) {
        const svg = $('rfChartSvg');
        if (!svg) return;
        if (!serie.length) {
            svg.innerHTML = '<text x="380" y="130" text-anchor="middle" fill="#94a3b8" font-size="14">No hay datos en este período</text>';
            return;
        }

        const W = 760;
        const H = 260;
        const padL = 40;
        const padR = 20;
        const padT = 30;
        const padB = 40;

        const maxV = Math.max(...serie.map(s => Math.max(s.ventas, comparar ? (s.ventas_prev || 0) : 0)), 100);
        const ceiling = maxV * 1.15;

        const N = serie.length;
        const stepX = (W - padL - padR) / Math.max(1, N - 1);

        const ptsVentas = [];
        const ptsGanancias = [];
        const ptsPrev = [];

        serie.forEach((s, i) => {
            const x = padL + i * stepX;
            const yV = H - padB - ((s.ventas / ceiling) * (H - padT - padB));
            const yG = H - padB - ((s.ganancia / ceiling) * (H - padT - padB));
            ptsVentas.push({ x, y: yV, item: s });
            ptsGanancias.push({ x, y: yG, item: s });
            if (comparar) {
                const yP = H - padB - (((s.ventas_prev || 0) / ceiling) * (H - padT - padB));
                ptsPrev.push({ x, y: yP, item: s });
            }
        });

        function makeBezierPath(pts) {
            if (!pts.length) return '';
            if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
            let d = `M ${pts[0].x} ${pts[0].y}`;
            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = pts[i === 0 ? i : i - 1];
                const p1 = pts[i];
                const p2 = pts[i + 1];
                const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
                const cp1x = p1.x + (p2.x - p0.x) / 6;
                const cp1y = p1.y + (p2.y - p0.y) / 6;
                const cp2x = p2.x - (p3.x - p1.x) / 6;
                const cp2y = p2.y - (p3.y - p1.y) / 6;
                d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
            }
            return d;
        }

        const pathVentas = makeBezierPath(ptsVentas);
        const pathGanancias = makeBezierPath(ptsGanancias);
        const pathPrev = comparar ? makeBezierPath(ptsPrev) : '';

        const areaVentas = `${pathVentas} L ${ptsVentas[ptsVentas.length - 1].x} ${H - padB} L ${ptsVentas[0].x} ${H - padB} Z`;

        let gridLines = '';
        for (let r = 0; r <= 4; r++) {
            const y = padT + r * ((H - padT - padB) / 4);
            const val = ceiling * (1 - r / 4);
            gridLines += `
                <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="3 3"/>
                <text x="${padL - 6}" y="${y + 4}" fill="#64748b" font-size="10" text-anchor="end" font-weight="600">$${Math.round(val / 1000)}k</text>
            `;
        }

        let xLabels = '';
        ptsVentas.forEach((p) => {
            xLabels += `
                <text x="${p.x}" y="${H - 12}" fill="#94a3b8" font-size="11" text-anchor="middle" font-weight="700">${p.item.label}</text>
            `;
        });

        let pointsHtml = '';
        ptsVentas.forEach((p, idx) => {
            pointsHtml += `
                <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#3b82f6" stroke="#fff" stroke-width="2" class="chart-point" data-idx="${idx}"/>
            `;
        });

        svg.innerHTML = `
            <defs>
                <linearGradient id="ventasGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35"/>
                    <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0"/>
                </linearGradient>
            </defs>
            ${gridLines}
            <path d="${areaVentas}" fill="url(#ventasGrad)"/>
            ${comparar ? `<path d="${pathPrev}" fill="none" stroke="#a855f7" stroke-width="2.5" stroke-dasharray="4 4"/>` : ''}
            <path d="${pathVentas}" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round"/>
            <path d="${pathGanancias}" fill="none" stroke="#10b981" stroke-width="2.2" stroke-linecap="round"/>
            ${xLabels}
            ${pointsHtml}
        `;

        const dotP = $('dotPrev');
        const lblP = $('lblPrev');
        if (dotP && lblP) {
            dotP.style.display = comparar ? 'inline-block' : 'none';
            lblP.style.display = comparar ? 'inline-block' : 'none';
        }
    }

    function init() {
        $('rfPeriodoChips')?.addEventListener('click', (ev) => {
            const btn = ev.target.closest('[data-rf-periodo]');
            if (!btn) return;
            $('rfPeriodoChips').querySelectorAll('[data-rf-periodo]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            periodoActual = btn.dataset.rfPeriodo;
            cargarDatos();
        });

        $('chkRfComparar')?.addEventListener('change', (ev) => {
            compararActual = !!ev.target.checked;
            cargarDatos();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    global.ReporteJefe = {
        cambiarPantalla,
        cargarDatos,
        pantallaActual: () => pantallaActual,
        setSucursal: (id) => {
            sucursalId = id || '';
            if (pantallaActual === 'financiero') cargarDatos();
        }
    };
})(window);
