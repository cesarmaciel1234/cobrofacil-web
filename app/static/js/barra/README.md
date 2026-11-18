# Submódulo: Barra de Navegación Móvil (app/static/js/barra/)

Controla la barra inferior fija de cinco botones de la PWA móvil y desktop de **Cobro Fácil**, orquestando la alternancia instantánea entre las vistas principales del sistema.

---

## 1. De dónde viene (Entradas / Triggers)
- **Interacción del usuario:** Clic táctil o con mouse sobre cualquier botón `.pwa-nav-btn` dentro del contenedor `#bottomPwaBar`.
- **Navegación por software:** Llamadas emitidas desde el bus global `window.CrmBus.emit('switchView', vista)` o atajos de teclado.

---

## 2. A dónde va (Salidas e Impacto)
- **Manipulación de clases DOM:** Alterna la clase `.active` en los botones `.pwa-nav-btn` y en los contenedores de vista `.view#view-[reporte|ventas|caja|cartera|pedidos]`.
- **Despacho asíncrono:** Emite el evento `switchView` a través de `CrmBus` en el siguiente ciclo de animación (`setTimeout 0ms`) para que el renderizado de datos pesados no congele la respuesta táctil.

---

## 3. Qué función cumple cada archivo

| Archivo | Función técnica principal |
| :--- | :--- |
| **`armar.js`** | Genera la botonera inferior si no fue pre-renderizada por el servidor y homologa la estructura entre vistas. |
| **`toque.js`** | Listener central de eventos de clic/toque en `#bottomPwaBar`. Detecta la vista pedida, aplica `.active` y emite `switchView`. Si se vuelve a tocar la vista activa (ej. `Reporte`), resetea a la subvista principal (*Alertas del día*). |
| **`ventas.js`** | Paginación y visualización del historial de tickets. Se coordina con `pos_historial.py` y `cargarSiguientePaginaTickets()` para carga progresiva de a 400 tickets. |
| **`cobros.js`** | Submódulo de historial de cobros transaccionales y conciliación de caja. |
| **`caja.js`** | Arqueo de medios de pago del día (Efectivo, QR MercadoPago, Fiado, Tarjeta) con porcentajes sobre el total recaudado. |
| **`cartera.js`** | Panel general de cuentas corrientes: métricas de saldo en la calle, clientes en riesgo, cobros del mes y búsqueda de clientes. |
| **`cartera-libro.js`** | Libro mayor detallado por cliente: historial de compras, pagos, saldo acumulado y cálculo en tiempo real de interés/CFR formateado en pesos argentinos (`es-AR`). Incorpora `AbortController` para cancelación preventiva de consultas desfasadas. |
| **`pedidos.js`** | Gestión de reposición de mercadería, cálculo de kilos sugeridos por producto con stock negativo y filtrado por proveedor. |

---

## 4. Cómo trabaja internamente
1. El usuario toca un botón (por ejemplo, `Cartera`).
2. `toque.js` intercepta el evento `click`, valida que `dataset.pwaView` sea válido.
3. Se actualiza visualmente la clase `.active` de inmediato (0ms de latencia percibida).
4. Se agenda la llamada a `CrmBus.emit('switchView', pedido)` para el siguiente ciclo.
5. El controlador correspondiente carga los datos desde la memoria local o la API (`/api/pos/...`).

---

## 5. Qué NO romper (Invariantes)
1. **Cero bloqueo en UI:** Nunca colocar llamadas síncronas o renders masivos bloqueantes dentro del evento de clic.
2. **Uso de `AbortController` en Cartera:** Las llamadas a `/api/pos/historial` deben abortarse si el usuario abre otro cliente antes de que la anterior finalice.
3. **Formato regional estándar:** Todos los importes monetarios deben formatearse con `es-AR` (coma para decimales y punto para miles: `$1.000,00`).
