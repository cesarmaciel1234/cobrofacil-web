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

### `perfil_comercio.py`
- `leer_perfil(empresa_id)` consulta la ficha pública y reseñas de esa empresa.
- `guardar_perfil(empresa_id, datos)` valida la ficha y la guarda en la base
  compartida; una dirección cambiada descarta las coordenadas anteriores salvo
  que se confirme explícitamente el punto en el mapa.
  No utiliza ni expone la configuración privada de informes y correo.

### `pos_base.py`
- `filas_de(tabla, sucursal_id=None, desde=None, hasta=None)`: Lee el libro. Con fechas, baja solo esos días. Sin fechas, una bajada alcanza para Todas y para cada sucursal. A los 5 segundos pregunta el sello; si no cambió, no vuelve a traer las filas.
- `preparar_vista(...)`: El reporte del día entra en una lectura (ese día y los catálogos). Si hoy no tiene ventas, queda el día más nuevo. Un trozo que llegó sin sello de día igual cuenta: se mira la fecha de cada venta. Ese recorte no reemplaza el libro entero: Ventas lee el mismo rango. Si Todas ya está en memoria, una sucursal sale de ahí y no vuelve vacía.
- `indice_espejo()` / `tabla_espejo(tabla)`: El teléfono, la PC y la tablet guardan el libro. Bajan la tabla cuyo sello cambió.
- `enlaces_de_persona(buscado)`: Vincula registros de un cliente en múltiples sucursales por DNI o nombre.
- `unir_clientes(columnas, filas)`: Agrupa clientes evitando duplicar saldos copiados.
- `listar_sucursales()`: Descubre sucursales activas en el sistema (`id`, `nombre`). Si ese número ya tiene un solo nombre, el siguiente envío no abre otro.

### `pos_historial.py`
- `historial_ventas(...)`: Genera el listado de tickets paginado progresivamente (400 tickets iniciales, cargando bloques sucesivos al hacer scroll). Retorna `tickets`, `hay_mas`, `offset`, `limite`, `total_filtrado` y `total_monto`.

### `pos_interes.py`
- `calcular_interes_cliente(...)`: Aplica la fórmula de interés devengado sobre saldos deudores de cuenta corriente por mora o plazo acordado (CFR diario).
- `sumar_intereses_a_cartera(...)`: Enriquece el balance de cartera con el interés acumulado para coincidir con la Maestra del POS.

### `nodo.py`
- `leer(pieza, ...)`: Devuelve reporte, caja, ventas o cartera ya armados. Si el sello del libro no cambió, no vuelve a calcular.
- `alimentar()`: En segundo plano arma primero el reporte del día que ya está en el libro y después caja, ventas del mes y cartera.
- `estado()`: Solo el sello y qué piezas están listas. La PWA lo consulta para saber si hay datos nuevos.
- `anotar_carga()` / `leer_carga()`: Guardan cuántos tickets del enlace ya llegaron, para la barra de arriba.

### `pos_jefe.py`
- `obtener_panel_jefe(panel, sucursal_id)`: Genera los diccionarios con KPIs para las vistas ejecutivas (`reporte`, `jefe`, `contabilidad`, `cartera`, `digitales`, `pedidos`).
- `_pedidos_abastecimiento(sucursal_id)`: Calcula los faltantes de stock y genera el texto para WhatsApp de pedidos a proveedores.

### `pos_vitrina.py`
- `calcular_vitrina(...)`: Las 12 tarjetas. El inventario no multiplica el millón de stock que el mostrador deja para no cortar la venta. El margen sale solo de los artículos con costo; el resto se marca aparte.

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
