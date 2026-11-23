# Plano de Rama: Frontend Web SPA y PWA (app/static/)

**Ubicación:** `app/static/`  
**Propósito:** Alojar los componentes visuales, controladores JavaScript del lado del cliente, estilos CSS modernos (Glassmorphism), Service Worker offline y recursos de la Progressive Web App (PWA).

---

## 1. De dónde viene (Entradas / Triggers)
- Servido por Flask a través de `app/templates/terminal.html` y demás vistas web.
- Ejecutado en el navegador del usuario al interactuar con el panel ejecutivo.

---

## 2. Frente (Experiencia de Usuario)
- **Diseño Glassmorphism:** Fondo oscuro (#0f172a), tarjetas translúcidas (#1e293b), bordes finos (#334155), badges pulsantes y tipografía nítida (`Segoe UI`, `Consolas` para valores numéricos).
- **Controlador SPA (`app.js`):** Navegación fluida entre paneles (`Reporte`, `Jefe`, `Vitrina`, `Contabilidad`, `Cartera`, `Digitales`, `Pedidos`) sin recarga de página completa.
- **Ficha y Edición de Cliente Estilo WhatsApp:** En la ficha individual de cliente, el botón superior `#btnRefresh` cambia automáticamente de filtro a lápiz de edición (`.es-editar-cliente`). Al tocar el lápiz, el avatar o la cabecera superior se abre la hoja modal con datos de contacto (nombre, DNI, teléfono, dirección, límite) y accesos directos de llamada/WhatsApp. El botón de ticket en movimientos se destaca en azul claro (`#eff6ff`) con flecha `↗` para abrir cortes.
- **Selector de Sucursales:** Menú desplegable y modal flotante que permite alternar entre `Todas`, `Maciel` (ID 1) y `alfaro 1964` (ID 2), actualizando instantáneamente la barra superior (`MACIEL · ALFARO 1964`) y los montos filtrados.
- **Pedidos y chat:** La bandeja de despacho muestra errores de sesión y envío, conserva el texto no enviado y escapa los datos del pedido y del chat antes de renderizarlos.
- **Caja y Perfil:** Caja ofrece historial y desglose de ventas desde su menú lateral. El primer botón abre el perfil público, sus reseñas y la edición con selección de ubicación en el mapa.
- **Inventario:** el resumen destaca quiebres, productos sin contar hoy y diferencias de auditoría. Los indicadores describen el catálogo recibido, no reservas ni umbrales de stock bajo; la lista muestra el stock del sistema. Se advierte que la selección de sucursal no filtra esta vista ni sus conteos.

---

## 3. Fondo (Módulos JavaScript del Cliente)

```
app/static/
├── enterprise.css        <-- Estilos globales del sistema
├── manifest.json         <-- PWA Manifest para instalación en móviles/escritorios
├── sw.js                 <-- Service Worker con caché offline y Background Sync
└── js/                   <-- Controladores del cliente
    ├── app.js            <-- Controlador central y enrutador SPA
    ├── modulo-panel.js   <-- Renderizador de tarjetas y métricas
    ├── pos-offline.js    <-- Almacenamiento local Dexie / IndexedDB
    ├── espejo.js         <-- Copia del libro en el teléfono, la PC y la tablet
    ├── espejo-engine.js  <-- Motor en segundo plano que nutre el espejo con delta sync
    ├── nodo.js           <-- Esclavo: verifica el sello y precarga las piezas sin tocar la cara
    ├── sync-engine.js    <-- Sincronización offline en segundo plano (CRM)
    ├── crm-bus.js        <-- Receptor de eventos SSE en vivo (/api/stream)
    └── barra/            <-- Submódulos de paneles especializados
```

- **Sincronización de Sucursal:**
  `actualizarNombreEmpresaTopbar()` compara `String(s.id) === String(activeSucursalId)` para reflejar la sucursal activa en el topbar.
- **Service Worker (`sw.js`):** Cachea los assets estáticos para respuesta instantánea. Las peticiones a `/api/` pasan directamente a la red (`network-first` o `network-only`). Usa Background Sync API para reintentar sincronización al volver online.
- **Arquitectura Espejo Local (Mirror-First):**
  - **Espejo (`espejo.js`):** Mantiene en IndexedDB y memoria reactiva una copia local completa de la base de datos de la nube (`ventas`, `detalles_ventas`, `clientes`, `productos`, `cuenta_corriente`, `proveedores`, `gastos`, `movimientos_caja`). La PWA consulta este espejo para renderizar métricas, tickets, caja y cartera en 0ms sin colisiones ni saturación de sockets en Neon.
  - **Motor en Segundo Plano (`espejo-engine.js`):** Corre en segundo plano preguntando a la nube si hay algo nuevo (`/api/pos/espejo/delta?sello=...`). Si hay novedades, nutre el espejo local con compresión y priorización de tablas críticas, y dispara avisos de actualización reactivos sin intervención del usuario.

---

## 4. A dónde va (Salidas e Impacto)
- Envía peticiones `fetch()` hacia `app/routes/api_pos.py`, `api_finanzas.py`, `api_clientes.py`.
- Renderiza el DOM dinámicamente en el contenedor `#panel-contenido` de `terminal.html`.
- Guarda credenciales y preferencias en `localStorage` o `sessionStorage`.

---

## 5. Resiliencia y Fallos
- **Manejo de desconexión:** Si el servidor no responde o hay pérdida de señal, el banner de estado pasa a `⚠️ Sin conexión` y el motor offline (`pos-offline.js`) recurre a datos cacheados en IndexedDB.

---

## 6. Qué NO romper
- Al modificar `app.js` o estilos CSS, incrementar `CACHE_VERSION` en `sw.js` y el parámetro de versión `?v=...` en `terminal.html` para forzar la actualización de caché en los navegadores.
