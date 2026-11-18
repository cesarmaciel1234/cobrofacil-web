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
- `app.js`: Script principal. Gestiona la inicialización de sesión, la navegación SPA, el filtro de sucursales (`aplicarSucursal`), la barra de subida del libro (`seguirCargaLibro`) y la actualización del topbar (`actualizarNombreEmpresaTopbar`). El período del reporte, de Caja y de Ventas se elige con el botón de filtro del encabezado y queda escrito en un chip. Ventas usa Hoy, Semana, Mes y Período, con carga progresiva y scroll infinito en lotes de a 400 tickets sin congelamiento. La pastilla de red dice En línea con la hora de sync, o Modo offline con el último dato. En un pedido largo, WhatsApp y Copiar quedan fijos abajo de la lista. Una copia guardada en cero no se muestra como la semana en curso: se espera la lectura nueva. Reporte y Ventas cuentan los tickets del espejo local cuando ya está en el aparato.
- `espejo.js`: Espejo local reactivo de la base de datos en IndexedDB (`crm-espejo`) y memoria. Permite a la PWA consultar datos al instante (0ms de latencia) sin locks ni colisiones en la nube: provee `resumenJefe()`, `cartera()`, `clientes()`, `contabilidad()`, `listar()`, `desglose()`, `ticket()` y `sucursales()`.
- `espejo-engine.js`: Motor en segundo plano que nutre continuamente el espejo local preguntando a la nube si hay novedades (`/api/pos/espejo/delta?sello=...`). Aplica deltas priorizados (críticos: ventas, clientes, detalles_ventas), actualiza la memoria activa y notifica a la UI.
- `nodo.js`: Esclavo de la PWA (`crm-nodo`). No pinta la pantalla. Al abrir hidrata el reporte guardado y, en segundo plano, pide a la nube si el sello cambió. Primero baja el reporte, después caja, ventas y cartera. La cara lee esa copia.
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
