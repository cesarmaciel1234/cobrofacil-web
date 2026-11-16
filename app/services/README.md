# Subcarpeta: Servicios de Negocio (app/services/)

**Ubicación:** `app/services/`  
**Rol:** Módulo de lógica central del CRM. Procesa cálculos financieros, consolida información de sucursales y gestiona la persistencia de datos.

---

## 1. Qué hace
- Procesa consultas multi-sucursal y consolida deudas de clientes.
- Realiza cálculos de Costo Financiero Total (CFR), márgenes de ganancia y balances patrimoniales.
- Controla el almacenamiento de operaciones y sincronización con el TPV físico.
- Gestiona eventos Server-Sent Events (SSE).

---

## 2. Archivos y Funciones Clave

### `pos_base.py`
- `filas_de(tabla, sucursal_id=None)`: Lee el libro. Una bajada alcanza para Todas y para cada sucursal. A los 5 segundos pregunta el sello; si no cambió, no vuelve a traer las filas.
- `enlaces_de_persona(buscado)`: Vincula registros de un cliente en múltiples sucursales por DNI o nombre.
- `unir_clientes(columnas, filas)`: Agrupa clientes evitando duplicar saldos copiados.
- `listar_sucursales()`: Descubre sucursales activas en el sistema (`id`, `nombre`, `tickets_count`).

### `pos_jefe.py`
- `obtener_panel_jefe(panel, sucursal_id)`: Genera los diccionarios con KPIs para las vistas ejecutivas (`reporte`, `jefe`, `contabilidad`, `cartera`, `digitales`, `pedidos`).
- `_pedidos_abastecimiento(sucursal_id)`: Calcula los faltantes de stock y genera el texto para WhatsApp de pedidos a proveedores.

### `pos_vitrina.py`
- `calcular_vitrina_12(periodo_dias, sucursal_id)`: Calcula las 12 métricas clave de control de gestión.

### `sync_hub.py`
- `apply_sync_operations(device_id, operations)`: Aplica lote de operaciones LWW con idempotencia.
- `build_sync_pull_delta(since_cursor)`: Devuelve lista de cambios ocurridos desde un cursor temporal.

### `finanzas.py`
- `calc_cfr(recibido, pagar, meses)`: Calcula la tasa efectiva mensual y anualizada de costo financiero.
- `calcular_antiguedad_deuda()`: Desglosa saldos pendientes por tramos (0-30 días, 31-60 días, etc.).

---

## 3. Cómo funciona (Flujo interno)
1. El servicio recibe parámetros y abre una conexión a base de datos mediante `get_db()`.
2. Resuelve el tenant activo (`session.get("empresa_id")` o default `1`).
3. Ejecuta consultas preparadas (evitando inyecciones SQL).
4. Aplica transformaciones de negocio en memoria y retorna estructuras limpias.

---

## 4. De dónde viene y A dónde va
- **Viene de:** Controladores en `app/routes/`.
- **Va hacia:** Base de datos Neon PostgreSQL / SQLite, o bus `signal_bus`.

---

## 5. Qué NO debe cambiar una mejora futura
- No modificar los nombres de los campos de retorno que alimentan a `app.js` en el frontend (`deuda_clientes`, `tickets_del_dia`, `ganancia_parcial`, etc.).
