# Submódulo: Caja y Contabilidad Diaria (app/services/caja/)

### 1. Qué hace esta carpeta
Consolida el arqueo diario y la contabilidad de caja por sucursal:
- Ventas por medio de pago (Efectivo, Débito, Crédito, QR, etc.).
- Cobros de fiado ingresados en cuenta corriente clasificados por medio.
- Gastos operativos y movimientos directos de caja.
- Retorna exclusivamente datos puros (Cerebro: dict, list, float, int). Cero HTML/CSS.

### 2. De dónde viene su entrada
- Controlador HTTP `api_pos_jefe` (`/api/pos/jefe?panel=contabilidad`).
- Hidratador en background `api_pos_nodo` (`/api/pos/nodo?pieza=contabilidad`).
- Parámetros de consulta: `sucursal_id`, `periodo`, `desde`, `hasta`, `filtro`.

### 3. Archivos y funciones
- `__init__.py`: Expone `obtener_contabilidad_caja`, `armar_panel_caja`, `etiqueta_caja`.
- `service_caja.py`: Cerebro de caja. Consolida medios de pago, deudas cobradas y gastos.

### 4. Hacia dónde sale
- A `app/services/pos_jefe.py` para responder al panel unificado de control.
- Retorna JSON a la SPA (`app/static/js/barra/caja/caja-motor.js` y `app.js`).
