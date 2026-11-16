# Subcarpeta: Controladores JavaScript del Cliente (app/static/js/)

**Ubicación:** `app/static/js/`  
**Rol:** Controladores del frontend para la SPA (Single Page Application). Gestiona el estado de la vista, los filtros de sucursales, peticiones asíncronas y eventos en vivo.

---

## 1. Qué hace
- Comanda la lógica de la página `terminal.html`.
- Carga y renderiza los datos de cada panel sin recargar el navegador.
- Escucha eventos Server-Sent Events (SSE) y actualiza métricas automáticamente.
- Provee soporte para IndexedDB (Dexie) para almacenamiento local.

---

## 2. Archivos Principales
- `app.js`: Script principal. Gestiona la inicialización de sesión, la navegación SPA, el filtro de sucursales (`aplicarSucursal`), la barra de subida del libro (`seguirCargaLibro`) y la actualización del topbar (`actualizarNombreEmpresaTopbar`).
- `modulo-panel.js`: Funciones auxiliares para construir el HTML de las tarjetas de métricas.
- `pos-offline.js`: Abstracción de IndexedDB para modo sin conexión.
- `sync-engine.js`: Motor de subida de tickets locales al servidor.
- `crm-bus.js`: Conexión EventSource con `/api/stream`.
- `barra/`: Módulos de paneles individuales (Cartera, Pedidos, Ventas, etc.).

---

## 3. Flujo de Filtrado de Sucursal (`app.js`)
1. El usuario hace clic en el selector de sucursal o modal.
2. Se ejecuta `aplicarSucursal(sucursalId)`:
   - Se guarda el ID activo en `activeSucursalId`.
   - Se invoca `actualizarNombreEmpresaTopbar()` para pintar el nombre compuesto (ej. `MACIEL · ALFARO 1964`).
   - Se invoca `cargarJefe()` o la función del panel activo con el parámetro `sucursal_id`.
   - La API responde en < 100 ms y se re-renderizan las tarjetas con los montos exactos de la sucursal seleccionada.
