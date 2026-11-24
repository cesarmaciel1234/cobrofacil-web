/**
 * JARVIS NEURAL HUD v10.0 // PROTOCOLO IRON MUSK
 * Telemetría cuántica, audio sintético cyber, reconocimiento de voz y diagnósticos autónomos de IA.
 * Diseñado para control omnicanal de cadenas de retail y frigoríficos a escala global.
 */
(function (global) {
    'use strict';

    // -------------------------------------------------------------------------
    // SINTETIZADOR DE AUDIO CIBERNÉTICO (Web Audio API - 0 Latencia, Sin Archivos)
    // -------------------------------------------------------------------------
    let audioCtx = null;
    let sfxActivado = true;

    function initAudio() {
        if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            audioCtx = new AudioContextClass();
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }

    function playCyberSfx(type = 'click') {
        if (!sfxActivado) return;
        try {
            initAudio();
            if (!audioCtx) return;
            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);

            if (type === 'boot') {
                // Sonido de inicio Jarvis: barrido ascendente armónico
                osc.type = 'sine';
                osc.frequency.setValueAtTime(220, now);
                osc.frequency.exponentialRampToValueAtTime(880, now + 0.16);
                gain.gain.setValueAtTime(0.08, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
                osc.start(now);
                osc.stop(now + 0.22);
            } else if (type === 'click') {
                // Clic háptico de precisión cyber
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(1400, now);
                osc.frequency.exponentialRampToValueAtTime(400, now + 0.04);
                gain.gain.setValueAtTime(0.06, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
                osc.start(now);
                osc.stop(now + 0.05);
            } else if (type === 'success') {
                // Doble tono confirmatorio estilo Tesla
                osc.type = 'sine';
                osc.frequency.setValueAtTime(523.25, now); // C5
                osc.frequency.setValueAtTime(783.99, now + 0.08); // G5
                gain.gain.setValueAtTime(0.07, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
                osc.start(now);
                osc.stop(now + 0.28);
            } else if (type === 'telemetry') {
                // Ping sonar cuántico
                osc.type = 'sine';
                osc.frequency.setValueAtTime(987.77, now); // B5
                gain.gain.setValueAtTime(0.05, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
                osc.start(now);
                osc.stop(now + 0.18);
            } else if (type === 'voice_start') {
                // Tono de escucha Jarvis
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(440, now);
                osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.1);
                gain.gain.setValueAtTime(0.08, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
                osc.start(now);
                osc.stop(now + 0.15);
            }
        } catch (_) {}
    }

    // -------------------------------------------------------------------------
    // ESTILOS CYBERPUNK GLASS // IRON MUSK HUD
    // -------------------------------------------------------------------------
    function inyectarEstilosCyber() {
        if (document.getElementById('jarvis-cyber-styles')) return;
        const style = document.createElement('style');
        style.id = 'jarvis-cyber-styles';
        style.textContent = `
            @keyframes arcRotate {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
            @keyframes arcPulse {
                0% { box-shadow: 0 0 15px rgba(0, 242, 254, 0.4), inset 0 0 15px rgba(0, 242, 254, 0.2); }
                50% { box-shadow: 0 0 35px rgba(0, 242, 254, 0.8), inset 0 0 25px rgba(0, 242, 254, 0.5); }
                100% { box-shadow: 0 0 15px rgba(0, 242, 254, 0.4), inset 0 0 15px rgba(0, 242, 254, 0.2); }
            }
            @keyframes radarSweep {
                0% { transform: scale(0.95); opacity: 0.8; }
                50% { transform: scale(1.05); opacity: 1; }
                100% { transform: scale(0.95); opacity: 0.8; }
            }
            @keyframes waveAnim {
                0%, 100% { height: 6px; }
                50% { height: 26px; }
            }

            .neural-orb-btn {
                position: fixed;
                bottom: calc(88px + env(safe-area-inset-bottom, 0px));
                right: 14px;
                width: 58px;
                height: 58px;
                border-radius: 999px;
                background: radial-gradient(circle, #0f172a 0%, #020617 100%);
                border: 2px solid #00f2fe;
                cursor: pointer;
                z-index: 8500;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: arcPulse 3s infinite ease-in-out;
                user-select: none;
                transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
            }
            .neural-orb-btn:hover {
                transform: scale(1.1);
            }
            .neural-orb-btn:active {
                transform: scale(0.92);
            }
            .neural-orb-core {
                position: absolute;
                width: 26px;
                height: 26px;
                border-radius: 50%;
                background: radial-gradient(circle, #00f2fe 0%, #3b82f6 70%, transparent 100%);
                box-shadow: 0 0 14px #00f2fe;
            }
            .neural-orb-ring {
                position: absolute;
                inset: 3px;
                border: 1.5px dashed rgba(0, 242, 254, 0.6);
                border-radius: 50%;
                animation: arcRotate 12s linear infinite;
            }
            .neural-orb-badge {
                position: absolute;
                top: -4px;
                right: -4px;
                background: #10b981;
                color: #022c22;
                font-size: 9px;
                font-weight: 900;
                padding: 2px 6px;
                border-radius: 999px;
                border: 1.5px solid #020617;
                box-shadow: 0 0 8px #10b981;
            }

            /* COCKPIT MODAL / HUD */
            .cyber-cockpit {
                position: fixed;
                inset: 0;
                background: rgba(2, 6, 23, 0.88);
                backdrop-filter: blur(28px);
                -webkit-backdrop-filter: blur(28px);
                z-index: 9600;
                display: flex;
                flex-direction: column;
                justify-content: flex-end;
                color: #f8fafc;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
            }
            .cyber-hud-sheet {
                background: linear-gradient(180deg, rgba(15, 23, 42, 0.98) 0%, rgba(2, 6, 23, 0.99) 100%);
                border-top: 2px solid #00f2fe;
                border-radius: 26px 26px 0 0;
                box-shadow: 0 -15px 45px rgba(0, 242, 254, 0.25);
                max-height: 88vh;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }
            .cyber-kpi-grid {
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 10px;
                margin-bottom: 14px;
            }
            .cyber-kpi-card {
                background: rgba(30, 41, 59, 0.6);
                border: 1px solid rgba(0, 242, 254, 0.2);
                border-radius: 14px;
                padding: 12px;
                position: relative;
                overflow: hidden;
            }
            .cyber-kpi-card::before {
                content: '';
                position: absolute;
                top: 0; left: 0; width: 4px; height: 100%;
                background: #00f2fe;
                box-shadow: 0 0 10px #00f2fe;
            }
            .cyber-insight-card {
                background: rgba(15, 23, 42, 0.8);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 12px;
                padding: 12px;
                margin-bottom: 8px;
                font-size: 12.5px;
                line-height: 1.4;
            }
            .cyber-insight-card.desempeno { border-left: 3px solid #10b981; }
            .cyber-insight-card.quiebre { border-left: 3px solid #f59e0b; }
            .cyber-insight-card.red { border-left: 3px solid #00f2fe; }

            .voice-wave-bar {
                display: inline-block;
                width: 4px;
                background: #00f2fe;
                border-radius: 99px;
                margin: 0 2px;
                animation: waveAnim 0.8s infinite ease-in-out;
            }
        `;
        document.head.appendChild(style);
    }

    // -------------------------------------------------------------------------
    // ESTADO DE TELEMETRÍA Y CONTROL
    // -------------------------------------------------------------------------
    let telemetriaData = null;
    let recognition = null;
    let escuchandoVoz = false;

    async function cargarTelemetria() {
        try {
            const res = await fetch('/api/pos/neural/telemetria?_=' + Date.now());
            if (res.ok) {
                telemetriaData = await res.json();
                actualizarBadgeOrb();
            }
        } catch (_) {}
    }

    function actualizarBadgeOrb() {
        const badge = document.getElementById('neuralOrbBadge');
        if (!badge) return;
        if (telemetriaData && telemetriaData.kpis) {
            badge.textContent = telemetriaData.kpis.nodos_activos + ' NODOS';
        }
    }

    // -------------------------------------------------------------------------
    // RENDERIZAR BOTÓN ARC REACTOR ORB
    // -------------------------------------------------------------------------
    function crearBotonOrb() {
        if (document.getElementById('neuralOrbBtn')) return;
        inyectarEstilosCyber();

        const btn = document.createElement('div');
        btn.id = 'neuralOrbBtn';
        btn.className = 'neural-orb-btn';
        btn.setAttribute('role', 'button');
        btn.setAttribute('aria-label', 'Abrir Jarvis Neural HUD');
        btn.title = 'JARVIS Neural HUD // Protocolo Iron Musk';
        btn.innerHTML = `
            <div class="neural-orb-ring"></div>
            <div class="neural-orb-core"></div>
            <span style="position:relative; z-index:2; font-size:18px; filter:drop-shadow(0 0 6px #fff);">⚡</span>
            <span id="neuralOrbBadge" class="neural-orb-badge">IA LIVE</span>
        `;
        btn.addEventListener('click', () => {
            playCyberSfx('boot');
            abrirCockpitJarvis();
        });
        document.body.appendChild(btn);
    }

    // -------------------------------------------------------------------------
    // COCKPIT HOLOGRÁFICO JARVIS (MODAL HUD)
    // -------------------------------------------------------------------------
    function abrirCockpitJarvis() {
        document.getElementById('neuralCockpitModal')?.remove();

        const cockpit = document.createElement('div');
        cockpit.id = 'neuralCockpitModal';
        cockpit.className = 'cyber-cockpit';

        const kpis = (telemetriaData && telemetriaData.kpis) || {
            facturacion_hoy: 0,
            tickets_hoy: 0,
            ticket_promedio: 0,
            nodos_activos: 2,
            salud_red_pct: 98.4
        };
        const diagnosticos = (telemetriaData && telemetriaData.diagnosticos) || [];

        cockpit.innerHTML = `
            <div class="cyber-hud-sheet">
                <!-- CABECERA CIBERNÉTICA -->
                <div style="padding: 16px 20px 12px; border-bottom: 1px solid rgba(0, 242, 254, 0.2); display: flex; justify-content: space-between; align-items: center; background: rgba(2, 6, 23, 0.6);">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 24px; animation: radarSweep 2s infinite;">⚡</span>
                        <div>
                            <div style="font-size: 15px; font-weight: 900; letter-spacing: 1px; color: #00f2fe; text-shadow: 0 0 10px rgba(0, 242, 254, 0.6);">
                                JARVIS // NEURAL HUD v10.0
                            </div>
                            <div style="font-size: 10.5px; color: #94a3b8; font-family: monospace;">
                                PROTOCOLO IRON MUSK · QUANTUM SYNC 0ms
                            </div>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <button type="button" id="btnToggleSfx" style="background: rgba(0, 242, 254, 0.1); border: 1px solid #00f2fe; color: #00f2fe; border-radius: 999px; padding: 4px 10px; font-size: 11px; font-weight: 800; cursor: pointer;">
                            ${sfxActivado ? '🔊 SFX ON' : '🔇 MUTE'}
                        </button>
                        <button type="button" id="btnCerrarJarvis" style="background: rgba(255, 255, 255, 0.1); border: none; width: 32px; height: 32px; border-radius: 999px; color: #fff; font-size: 16px; font-weight: 800; cursor: pointer;">
                            ✕
                        </button>
                    </div>
                </div>

                <!-- CONTENIDO SCROLLABLE HUD -->
                <div style="padding: 16px 18px 24px; overflow-y: auto; flex: 1;">
                    <!-- TELEMETRÍA EN VIVO GRID -->
                    <div class="cyber-kpi-grid">
                        <div class="cyber-kpi-card">
                            <span style="font-size: 10.5px; color: #94a3b8; text-transform: uppercase; font-weight: 800; letter-spacing: 0.5px;">Throughput Ventas</span>
                            <div style="font-size: 19px; font-weight: 900; color: #f8fafc; margin-top: 4px; font-family: monospace;">
                                $${Number(kpis.facturacion_hoy || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                            </div>
                            <span style="font-size: 10.5px; color: #10b981; font-weight: 700;">${kpis.tickets_hoy} tickets hoy</span>
                        </div>

                        <div class="cyber-kpi-card">
                            <span style="font-size: 10.5px; color: #94a3b8; text-transform: uppercase; font-weight: 800; letter-spacing: 0.5px;">Ticket Promedio</span>
                            <div style="font-size: 19px; font-weight: 900; color: #00f2fe; margin-top: 4px; font-family: monospace;">
                                $${Number(kpis.ticket_promedio || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                            </div>
                            <span style="font-size: 10.5px; color: #38bdf8; font-weight: 700;">Ticket objetivo: $18.500</span>
                        </div>

                        <div class="cyber-kpi-card">
                            <span style="font-size: 10.5px; color: #94a3b8; text-transform: uppercase; font-weight: 800; letter-spacing: 0.5px;">Nodos Conectados</span>
                            <div style="font-size: 19px; font-weight: 900; color: #f8fafc; margin-top: 4px;">
                                ${kpis.nodos_activos} Canales
                            </div>
                            <span style="font-size: 10.5px; color: #10b981; font-weight: 700;">100% Desacoplados</span>
                        </div>

                        <div class="cyber-kpi-card">
                            <span style="font-size: 10.5px; color: #94a3b8; text-transform: uppercase; font-weight: 800; letter-spacing: 0.5px;">Salud de Red</span>
                            <div style="font-size: 19px; font-weight: 900; color: #10b981; margin-top: 4px; font-family: monospace;">
                                ${kpis.salud_red_pct}%
                            </div>
                            <span style="font-size: 10.5px; color: #a7f3d0; font-weight: 700;">Latencia &lt; 2ms</span>
                        </div>
                    </div>

                    <!-- DIAGNÓSTICOS AUTÓNOMOS DE IA -->
                    <div style="margin-bottom: 16px;">
                        <div style="font-size: 12px; font-weight: 900; color: #00f2fe; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                            <span>🧠</span> Diagnósticos Predictivos en Vivo
                        </div>
                        <div id="jarvisInsightsContainer">
                            ${diagnosticos.map(d => `
                                <div class="cyber-insight-card ${d.tipo}">
                                    <div style="display: flex; align-items: center; gap: 6px; font-weight: 800; color: #f8fafc; margin-bottom: 3px;">
                                        <span>${d.icono}</span>
                                        <span>${d.titulo}</span>
                                    </div>
                                    <div style="color: #94a3b8; font-size: 11.5px;">${d.detalle}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <!-- RESPUESTA GENERATIVA CONVERSACIONAL -->
                    <div id="jarvisLiveResponse" style="display: none; background: rgba(0, 242, 254, 0.08); border: 1.5px solid #00f2fe; border-radius: 14px; padding: 14px; margin-bottom: 16px; box-shadow: 0 0 20px rgba(0, 242, 254, 0.2);">
                        <div style="font-size: 12px; font-weight: 900; color: #00f2fe; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
                            <span>⚡</span> Jarvis Responde:
                        </div>
                        <div id="jarvisResponseText" style="font-size: 13px; color: #f8fafc; line-height: 1.45; margin-bottom: 10px;"></div>
                        <div id="jarvisActionWrapper" style="display: none;">
                            <button type="button" id="btnJarvisGenerativeAction" style="background: #00f2fe; color: #020617; border: none; padding: 9px 16px; border-radius: 10px; font-size: 12.5px; font-weight: 900; cursor: pointer; box-shadow: 0 0 15px rgba(0, 242, 254, 0.5);">
                                ⚡ Ejecutar Acción
                            </button>
                        </div>
                    </div>

                    <!-- QUICK PROMPTS CHIPS -->
                    <div style="display: flex; gap: 6px; overflow-x: auto; padding-bottom: 8px; margin-bottom: 12px; scrollbar-width: none;">
                        <button type="button" class="jarvis-quick-chip" data-prompt="Diagnostico general del negocio hoy" style="flex-shrink: 0; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15); color: #cbd5e1; border-radius: 999px; padding: 5px 12px; font-size: 11px; font-weight: 700; cursor: pointer;">
                            ⚡ Diagnóstico General
                        </button>
                        <button type="button" class="jarvis-quick-chip" data-prompt="Simular aumento de precios del 5%" style="flex-shrink: 0; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15); color: #cbd5e1; border-radius: 999px; padding: 5px 12px; font-size: 11px; font-weight: 700; cursor: pointer;">
                            📈 Simular +5% Margen
                        </button>
                        <button type="button" class="jarvis-quick-chip" data-prompt="Estado de quiebres y stock critico" style="flex-shrink: 0; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15); color: #cbd5e1; border-radius: 999px; padding: 5px 12px; font-size: 11px; font-weight: 700; cursor: pointer;">
                            ⚠️ Quiebres de Stock
                        </button>
                        <button type="button" class="jarvis-quick-chip" data-prompt="Estado del despacho y cadetes" style="flex-shrink: 0; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15); color: #cbd5e1; border-radius: 999px; padding: 5px 12px; font-size: 11px; font-weight: 700; cursor: pointer;">
                            🛵 Logística Reparto
                        </button>
                    </div>

                    <!-- CONSOLA DE ENTRADA CON VOZ Y TEXTO -->
                    <form id="formJarvisCommand" style="display: flex; gap: 6px; align-items: center; background: rgba(15, 23, 42, 0.9); border: 1.5px solid rgba(0, 242, 254, 0.4); border-radius: 14px; padding: 4px 6px 4px 10px; box-shadow: 0 0 15px rgba(0, 242, 254, 0.15); box-sizing: border-box; width: 100%;">
                        <input type="text" id="inputJarvisPrompt" placeholder="Jarvis: Orden o consulta..." autocomplete="off"
                               style="flex: 1; min-width: 0; background: transparent; border: none; color: #f8fafc; font-size: 13px; font-weight: 700; outline: none;">
                        
                        <!-- BOTÓN DE MICRÓFONO CON ONDAS CYBER -->
                        <button type="button" id="btnJarvisVoice" title="Hablarle a Jarvis" style="background: rgba(0, 242, 254, 0.15); border: 1px solid #00f2fe; color: #00f2fe; border-radius: 10px; width: 34px; height: 34px; font-size: 15px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                            🎤
                        </button>

                        <button type="submit" id="btnJarvisSend" style="background: #00f2fe; color: #020617; border: none; border-radius: 10px; padding: 0 12px; height: 34px; font-size: 12px; font-weight: 900; cursor: pointer; flex-shrink: 0;">
                            ENVIAR
                        </button>
                    </form>
                </div>
            </div>
        `;

        document.body.appendChild(cockpit);

        // EVENTOS COCKPIT
        const cerrar = () => {
            playCyberSfx('click');
            cockpit.remove();
        };
        document.getElementById('btnCerrarJarvis')?.addEventListener('click', cerrar);
        cockpit.addEventListener('click', (e) => {
            if (e.target === cockpit) cerrar();
        });

        // Toggle SFX
        document.getElementById('btnToggleSfx')?.addEventListener('click', (e) => {
            sfxActivado = !sfxActivado;
            e.target.textContent = sfxActivado ? '🔊 SFX ON' : '🔇 MUTE';
            playCyberSfx('click');
        });

        // Chips rápidos
        document.querySelectorAll('.jarvis-quick-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const prompt = chip.getAttribute('data-prompt');
                const inp = document.getElementById('inputJarvisPrompt');
                if (inp) inp.value = prompt;
                ejecutarConsultaJarvis(prompt);
            });
        });

        // Form Submit
        document.getElementById('formJarvisCommand')?.addEventListener('submit', (e) => {
            e.preventDefault();
            const inp = document.getElementById('inputJarvisPrompt');
            const prompt = (inp?.value || '').trim();
            if (!prompt) return;
            ejecutarConsultaJarvis(prompt);
        });

        // Micrófono / Reconocimiento de Voz
        const btnVoice = document.getElementById('btnJarvisVoice');
        if (btnVoice) {
            btnVoice.addEventListener('click', () => {
                toggleReconocimientoVoz();
            });
        }
    }

    // -------------------------------------------------------------------------
    // MOTOR DE VOZ (Web Speech API)
    // -------------------------------------------------------------------------
    function toggleReconocimientoVoz() {
        const btnVoice = document.getElementById('btnJarvisVoice');
        const inp = document.getElementById('inputJarvisPrompt');
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRec) {
            alert('El reconocimiento de voz no está soportado en este navegador.');
            return;
        }

        if (escuchandoVoz && recognition) {
            recognition.stop();
            escuchandoVoz = false;
            if (btnVoice) {
                btnVoice.innerHTML = '🎤';
                btnVoice.style.background = 'rgba(0, 242, 254, 0.15)';
            }
            return;
        }

        try {
            recognition = new SpeechRec();
            recognition.lang = 'es-AR';
            recognition.interimResults = true;
            recognition.continuous = false;

            recognition.onstart = () => {
                escuchandoVoz = true;
                playCyberSfx('voice_start');
                if (btnVoice) {
                    btnVoice.innerHTML = '<span class="voice-wave-bar"></span><span class="voice-wave-bar" style="animation-delay:0.2s"></span><span class="voice-wave-bar" style="animation-delay:0.4s"></span>';
                    btnVoice.style.background = 'rgba(239, 68, 68, 0.3)';
                    btnVoice.style.borderColor = '#ef4444';
                }
                if (inp) inp.placeholder = 'Escuchando tu orden, señor...';
            };

            recognition.onresult = (event) => {
                const texto = Array.from(event.results)
                    .map(r => r[0].transcript)
                    .join('');
                if (inp) inp.value = texto;
            };

            recognition.onend = () => {
                escuchandoVoz = false;
                if (btnVoice) {
                    btnVoice.innerHTML = '🎤';
                    btnVoice.style.background = 'rgba(0, 242, 254, 0.15)';
                    btnVoice.style.borderColor = '#00f2fe';
                }
                if (inp && inp.value.trim()) {
                    ejecutarConsultaJarvis(inp.value.trim());
                } else if (inp) {
                    inp.placeholder = 'Jarvis: Ingresa una orden o consulta de negocio...';
                }
            };

            recognition.onerror = () => {
                escuchandoVoz = false;
                if (btnVoice) {
                    btnVoice.innerHTML = '🎤';
                    btnVoice.style.background = 'rgba(0, 242, 254, 0.15)';
                }
            };

            recognition.start();
        } catch (_) {
            escuchandoVoz = false;
        }
    }

    // -------------------------------------------------------------------------
    // EJECUTAR CONSULTA JARVIS AL BACKEND
    // -------------------------------------------------------------------------
    async function ejecutarConsultaJarvis(prompt) {
        playCyberSfx('telemetry');
        const liveBox = document.getElementById('jarvisLiveResponse');
        const textBox = document.getElementById('jarvisResponseText');
        const actionWrap = document.getElementById('jarvisActionWrapper');
        const actionBtn = document.getElementById('btnJarvisGenerativeAction');
        const btnSend = document.getElementById('btnJarvisSend');

        if (liveBox) liveBox.style.display = 'block';
        if (textBox) textBox.innerHTML = '<span style="color:#00f2fe; animation:pulse 1s infinite;">⚡ Procesando telemetría y formulando respuesta cuántica...</span>';
        if (actionWrap) actionWrap.style.display = 'none';
        if (btnSend) { btnSend.disabled = true; btnSend.textContent = '...'; }

        try {
            const res = await fetch('/api/pos/neural/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt })
            });
            const data = await res.json();
            playCyberSfx('success');

            if (textBox) {
                textBox.textContent = data.respuesta || 'Comando analizado correctamente.';
            }

            if (data.accion_generativa && actionWrap && actionBtn) {
                actionBtn.textContent = data.accion_generativa.texto || '⚡ Ejecutar Acción';
                actionBtn.onclick = () => {
                    playCyberSfx('success');
                    ejecutarAccionGenerativa(data.accion_generativa);
                };
                actionWrap.style.display = 'block';
            }
        } catch (err) {
            if (textBox) textBox.textContent = 'Error conectando con el núcleo neuronal: ' + err.message;
        } finally {
            if (btnSend) { btnSend.disabled = false; btnSend.textContent = 'ENVIAR'; }
        }
    }

    // -------------------------------------------------------------------------
    // EJECUTOR DE ACCIONES GENERATIVAS DE JARVIS
    // -------------------------------------------------------------------------
    function ejecutarAccionGenerativa(accion) {
        if (!accion) return;
        const cmd = accion.comando;
        const params = accion.parametros || {};

        if (cmd === 'navegar_modulo') {
            document.getElementById('neuralCockpitModal')?.remove();
            if (params.modulo === 'reporte' && global.switchView) {
                global.switchView('reporte');
            } else if (params.modulo === 'pedidos' && global.switchView) {
                global.switchView('pedidos');
            }
            if (global.CrmBus) {
                global.CrmBus.emit('toast', `✓ Jarvis navegó a ${params.modulo.toUpperCase()}`);
            }
        } else if (cmd === 'ajustar_margen_sucursal') {
            document.getElementById('neuralCockpitModal')?.remove();
            if (global.CrmBus) {
                global.CrmBus.emit('toast', `⚡ Jarvis programó simulación de margen para Sucursal ${params.sucursal_id}`);
            }
        }
    }

    // -------------------------------------------------------------------------
    // INICIALIZACIÓN AUTOMÁTICA
    // -------------------------------------------------------------------------
    function iniciar() {
        crearBotonOrb();
        cargarTelemetria();
        setInterval(cargarTelemetria, 60000); // Actualiza cada 1 minuto
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }

    global.JarvisNeural = {
        abrir: abrirCockpitJarvis,
        playSfx: playCyberSfx,
        cargarTelemetria: cargarTelemetria
    };

})(window);
