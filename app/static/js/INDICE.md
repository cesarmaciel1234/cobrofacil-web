# Índice: Controladores y Motores Frontend (app/static/js/)

**Ubicación:** `app/static/js/` | **Rol:** Controladores y motores SPA (`terminal.html`) y PWA.

---

## 1. Qué hace esta carpeta
- Orquesta la SPA ejecutiva en `terminal.html` y la experiencia offline de la PWA.
- Mantiene el espejo reactivo local IndexedDB (`crm-espejo`) para lectura a 0ms de latencia.
- Ejecuta el selector multi-sucursal (`aplicarSucursal`) refrescando métricas en <100ms.
- Controla el scroll infinito y la carga progresiva en lotes de 400 tickets.
- Escucha eventos Server-Sent Events (SSE) para reflejar cambios en vivo.
- **Regla sagrada:** Separar motor/API (`core/`, `motor/`) de componentes visuales (`ui/`).

---

## 2. De dónde viene su entrada
- Interacción del usuario: clics en navegación, selector de sucursales o botones.
- Eventos push en tiempo real vía EventSource (`/api/stream`).
- Respuestas JSON asíncronas desde los endpoints de `app/routes/` (`/api/pos/*`).

---

## 3. Qué archivos contiene
- `app.js`: Orquestador principal SPA, router de paneles y selector de sucursal.
- `espejo.js` & `espejo-engine.js`: Base local reactiva IndexedDB y motor de deltas en background.
- `nodo.js`: Hidratador en memoria de reporte, caja, ventas y cartera sin bloquear UI.
- `modulo-panel.js`: Renderizado de tarjetas visuales y métricas de control.
- `pos-offline.js` & `sync-engine.js`: Motor Dexie/IndexedDB y cola de subida de tickets.
- `crm-bus.js`: Conector EventSource con `/api/stream`.
- `crm-format.js`, `crm-safe.js`, `crm-loader.js`, `crm-ui.js`: Utilidades y modales.
- `barra/`: Subcarpeta modular de paneles específicos (`barra/caja/`, Cartera, Pedidos, etc.).

---

## 4. Hacia dónde sale
- **Al DOM:** Dibuja componentes visuales en `templates/terminal.html`.
- **A IndexedDB:** Almacena copias locales reactivas en el navegador.
- **Al Backend:** Emite peticiones `fetch` (JSON) hacia los endpoints REST `/api/*`.
