# Submódulo: Caja y Arqueo Diario (app/static/js/barra/caja/)

### 1. Qué hace esta carpeta
Gestiona la lógica y la interfaz de usuario de la pestaña Caja:
- Visualiza el arqueo diario clasificado por medios de pago (Efectivo, Débito, QR, etc.).
- Detalla cobranzas de fiado y saldo total en caja.
- Garantiza que la UI nunca quede congelada en "Cargando el libro…".
- Aplica separación estricta: `caja-motor.js` (Cerebro) vs `caja-ui.js` (Cara).

### 2. De dónde viene su entrada
- Toque en botón "Caja" de la barra de navegación PWA (`data-pwa-view="contabilidad"`).
- Selector global de sucursales (`aplicarSucursal`).
- Filtro de período temporal (`cambiarPeriodoCaja`).
- Respuestas de `/api/pos/jefe?panel=contabilidad` y del Espejo IndexedDB.

### 3. Archivos y funciones
- `caja-motor.js`: Cerebro frontend. Peticiones HTTP, aborto, sincronización con Espejo.
- `caja-ui.js`: Cara frontend. Renderiza arqueo, porcentajes, badges y estados vacíos.

### 4. Hacia dónde sale
- Inserta el HTML final en `#contaCuerpo` dentro de `templates/terminal.html`.
- Emite navegación hacia Cartera al tocar cobros de deudas de clientes.
