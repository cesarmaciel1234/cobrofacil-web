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

    function formatPesosCompact(n) {
        if (n == null) return '$0';
        try {
            const val = Number(n) || 0;
            const neg = val < 0;
            const abs = Math.abs(val);
            const entero = Math.round(abs);
            const sEntero = entero.toLocaleString('es-AR');
            const res = `$${sEntero}`;
            return neg ? `-${res}` : res;
        } catch (e) {
            return '$0';
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
        if ($('rfKpiTicketsDiff')) {
            if (data.comparar && k.tickets_prev != null) {
                const tDiff = (k.tickets || 0) - (k.tickets_prev || 0);
                const tSign = tDiff > 0 ? '+' : '';
                $('rfKpiTicketsDiff').textContent = `${tSign}${tDiff} vs anterior (${k.tickets_prev || 0})`;
            } else {
                $('rfKpiTicketsDiff').textContent = 'Operaciones';
            }
        }

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
        const tablaPie = $('rfTablaPie');
        if (tablaCuerpo) {
            const serie = data.serie || [];
            if (!serie.length) {
                tablaCuerpo.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:16px; color:var(--text-muted);">Sin datos</td></tr>';
                if (tablaPie) tablaPie.innerHTML = '';
            } else {
                tablaCuerpo.innerHTML = serie.map((s, idx) => {
                    const v = Number(s.ventas) || 0;
                    const vp = Number(s.ventas_prev) || 0;
                    const t = Number(s.tickets) || 0;
                    const tp = Number(s.tickets_prev) || 0;

                    let subVentas = '';
                    if (v > 0 && vp > 0) {
                        const diff = (((v - vp) / vp) * 100).toFixed(0);
                        const isUp = v >= vp;
                        subVentas = `<div class="rf-subline"><span class="rf-subline-lbl">Ant:</span> ${formatPesosCompact(vp)} <span class="${isUp ? 'rf-diff-up' : 'rf-diff-down'}">(${isUp ? '+' : ''}${diff}%)</span></div>`;
                    } else if (v === 0 && vp > 0) {
                        subVentas = `<div class="rf-subline rf-subline-meta"><span class="rf-subline-lbl-meta">Meta:</span> ${formatPesosCompact(vp)}</div>`;
                    }

                    let subTickets = '';
                    if (tp > 0) {
                        subTickets = `<div class="rf-subline"><span class="rf-subline-lbl">Ant:</span> ${tp}</div>`;
                    }

                    return `
                        <tr class="rf-row-dia clickable" data-dia-idx="${idx}" title="Toca para ver tickets de este día">
                            <td>
                                <div style="font-weight:700; color:var(--text-primary); font-size:12.5px; line-height:1.2;">
                                    ${s.label}
                                    ${s.fecha ? `<small style="color:var(--text-muted); font-weight:500; font-size:10.5px; display:inline-block; margin-left:2px;">(${s.fecha})</small>` : ''}
                                </div>
                            </td>
                            <td style="text-align:right;">
                                <div style="font-weight:800; color:var(--accent); font-size:13px; line-height:1.2;">${formatPesos(v)}</div>
                                ${subVentas}
                            </td>
                            <td style="text-align:right;">
                                <div style="font-weight:800; color:var(--text-primary); font-size:13px; line-height:1.2;">${t} <small style="font-size:10px; color:var(--text-muted); font-weight:600;">tkt</small></div>
                                ${subTickets}
                            </td>
                        </tr>
                    `;
                }).join('');

                if (!tablaCuerpo.dataset.clickBound) {
                    tablaCuerpo.dataset.clickBound = 'true';
                    tablaCuerpo.addEventListener('click', (e) => {
                        const tr = e.target.closest('tr.rf-row-dia');
                        if (!tr) return;
                        const btnTicket = document.querySelector('[data-pwa-view="ticket"]');
                        if (btnTicket) {
                            btnTicket.click();
                        } else if (typeof marcarEntrada === 'function') {
                            marcarEntrada('ticket');
                        }
                    });
                }

                if (tablaPie) {
                    const sumV = serie.reduce((acc, s) => acc + (Number(s.ventas) || 0), 0);
                    const sumVp = serie.reduce((acc, s) => acc + (Number(s.ventas_prev) || 0), 0);
                    const sumT = serie.reduce((acc, s) => acc + (Number(s.tickets) || 0), 0);
                    const sumTp = serie.reduce((acc, s) => acc + (Number(s.tickets_prev) || 0), 0);

                    const esSemana = (periodoActual || '').toLowerCase().includes('semana');
                    const tituloTotal = esSemana ? 'TOTAL SEMANA' : 'TOTAL PERÍODO';

                    let subTotalVentas = '';
                    if (sumVp > 0 && sumV > 0) {
                        const diffTot = (((sumV - sumVp) / sumVp) * 100).toFixed(1);
                        const isUpTot = sumV >= sumVp;
                        subTotalVentas = `<div class="rf-subline"><span class="rf-subline-lbl">Ant:</span> ${formatPesosCompact(sumVp)} <span class="${isUpTot ? 'rf-diff-up' : 'rf-diff-down'}">(${isUpTot ? '+' : ''}${diffTot}%)</span></div>`;
                    } else if (sumVp > 0) {
                        subTotalVentas = `<div class="rf-subline"><span class="rf-subline-lbl">Ant:</span> ${formatPesosCompact(sumVp)}</div>`;
                    }

                    const proy = data.proyeccion;
                    let proyRow = '';
                    if (proy && proy.dias_restantes > 0) {
                        const supera = (proy.ventas >= (proy.total_semana_anterior || 0));
                        proyRow = `
                            <tr class="rf-proyeccion-row">
                                <td colspan="3">
                                    <div class="rf-proyeccion-banner">
                                        <div class="rf-proy-left">
                                            <span class="rf-proy-ico">🎯</span>
                                            <div>
                                                <div class="rf-proy-tit">Proyección Cierre de Semana</div>
                                                <div class="rf-proy-sub">${proy.dias_con_venta} día(s) con ventas + meta de ${proy.dias_restantes} día(s) restantes s/ sem. anterior</div>
                                            </div>
                                        </div>
                                        <div class="rf-proy-right">
                                            <div class="rf-proy-monto">${formatPesos(proy.ventas)}</div>
                                            <div class="rf-proy-badge ${supera ? 'badge-supera' : 'badge-menor'}">
                                                ${supera ? '▲ Supera semana anterior' : '▼ Menor a semana anterior'}
                                            </div>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        `;
                    }

                    tablaPie.innerHTML = `
                        <tr class="rf-total-row">
                            <td>
                                <div class="rf-total-label">${tituloTotal}</div>
                                ${sumVp > 0 ? `<div class="rf-subline" style="justify-content:flex-start;"><span class="rf-subline-lbl">Total ant:</span> ${formatPesos(sumVp)}</div>` : ''}
                            </td>
                            <td style="text-align:right;">
                                <div class="rf-total-val" style="color:var(--accent);">${formatPesos(sumV)}</div>
                                ${subTotalVentas}
                            </td>
                            <td style="text-align:right;">
                                <div class="rf-total-val" style="color:var(--text-primary);">${sumT} <small style="font-size:11px; color:var(--text-muted); font-weight:700;">tkt</small></div>
                                ${sumTp > 0 ? `<div class="rf-subline"><span class="rf-subline-lbl">Ant:</span> ${sumTp}</div>` : ''}
                            </td>
                        </tr>
                        ${proyRow}
                    `;
                }
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
            const baseline = H - padB;
            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = pts[i === 0 ? i : i - 1];
                const p1 = pts[i];
                const p2 = pts[i + 1];
                const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
                let cp1x = p1.x + (p2.x - p0.x) / 6;
                let cp1y = p1.y + (p2.y - p0.y) / 6;
                let cp2x = p2.x - (p3.x - p1.x) / 6;
                let cp2y = p2.y - (p3.y - p1.y) / 6;
                // Clamp y between top padding and baseline (never overshoot below 0)
                cp1y = Math.min(baseline, Math.max(padT, cp1y));
                cp2y = Math.min(baseline, Math.max(padT, cp2y));
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
        const modulo = N > 14 ? Math.ceil(N / 7) : 1;
        ptsVentas.forEach((p, idx) => {
            if (N <= 14 || idx === 0 || idx === N - 1 || idx % modulo === 0) {
                const txt = (N > 14 && p.item.fecha) ? p.item.fecha : p.item.label;
                xLabels += `
                    <text x="${p.x}" y="${H - 12}" fill="#94a3b8" font-size="10" text-anchor="middle" font-weight="700">${txt}</text>
                `;
            }
        });

        let pointsHtml = '';
        ptsVentas.forEach((p, idx) => {
            pointsHtml += `
                <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#FFE600" stroke="#2D3277" stroke-width="2" class="chart-point" data-idx="${idx}"/>
            `;
        });

        svg.innerHTML = `
            <defs>
                <linearGradient id="ventasGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#FFE600" stop-opacity="0.45"/>
                    <stop offset="100%" stop-color="#FFE600" stop-opacity="0.0"/>
                </linearGradient>
            </defs>
            ${gridLines}
            <path d="${areaVentas}" fill="url(#ventasGrad)"/>
            ${comparar ? `<path d="${pathPrev}" fill="none" stroke="#2D3277" stroke-width="2.5" stroke-dasharray="4 4"/>` : ''}
            <path d="${pathVentas}" fill="none" stroke="#eab308" stroke-width="3" stroke-linecap="round"/>
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
