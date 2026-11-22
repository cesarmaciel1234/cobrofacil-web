# Plano de Rama: Servicios y Motores de Negocio (app/services/)

**Ubicación:** `app/services/`  
**Propósito:** Contiene los motores autónomos del CRM: unificación multi-sucursal de clientes por DNI/nombre, consolidación de deuda y cartera, motores de cálculo financiero (CFR), sincronización LWW (Last-Write-Wins), bus de eventos en vivo (SSE) y generación de reportes.

---

## 1. De dónde viene (Entradas / Triggers)
- Invocados directamente por las rutas en `app/routes/`.
- Procesamiento en segundo plano desencadenado por sincronizaciones entrantes (`sync_hub.py`).
- Cron jobs y tareas de entrega de informes (`report_delivery.py`).

---

## 2. Frente (Salidas a Controladores)
- Retornan estructuras de datos nativas de Python (`dict`, `list`, `tuple`) serializables a JSON.
- Generan archivos binarios (PDFs de reportes ejecutivos).
- Emiten eventos SSE hacia el bus en memoria.

---

## 3. Fondo (Motores Especializados)

```
app/services/
├── pos_base.py           <-- Motor de identidad, lectura de tablas espejo y caché TTL 5s
├── pos_historial.py      <-- Motor de historial de tickets con paginación progresiva (bloques de 400)
├── pos_interes.py        <-- Motor de cálculo de intereses devengados y mora de cartera
├── nodo.py               <-- Nodo maestro: arma reporte y el resto en segundo plano
├── pos_jefe.py           <-- Generador de paneles (Reporte, Jefe, Caja, Cartera, Pedidos)
├── pos_vitrina.py        <-- Motor de control de gestión (12 tarjetas)
├── sync_hub.py           <-- Motor de replicación LWW, idempotencia y changelog
├── signal_bus.py         <-- Bus pub/sub SSE aislado por empresa_id
├── finanzas.py           <-- Motor de costos financieros (CFR, tarjetas, cheques, márgenes)
├── pagos.py              <-- Aplicación de pagos, cuotas y punitorios
├── remitos.py            <-- Gestión de remitos cárnicos y pesables
└── report_delivery.py    <-- Generación de informes PDF y envíos por correo
```

### Motor de Identidad y Sucursales (`pos_base.py`):
- **Caché ágil:** `_CACHE_TTL = 5.0` segundos. Una lectura llena Todas y cada sucursal. Si el sello del libro no cambió, no se vuelven a bajar las filas. El panel armado se reusa mientras ese sello siga igual.
- **Unificación por DNI:** Un cliente con el mismo DNI en dos sucursales se consolida en una sola persona sumando sus deudas reales.
- **Unificación por Nombre:** Si no hay DNI, clientes con nombres exactamente idénticos en distintas sucursales se unifican sin duplicar la deuda copiada.

### Ficha de comercio (`perfil_comercio.py`):
- Lee y valida la ficha pública por `empresa_id` en la base compartida. Las
  reseñas pertenecen a pedidos entregados y son creadas por la API de la tienda.
  El horario es informativo y no controla el estado abierto/cerrado.

### Motor de Historial Progresivo (`pos_historial.py`):
- **Scroll Infinito y Carga Progresiva:** Retorna los primeros 400 tickets visibles ordenados cronológicamente descendentes (`offset`, `limite`, `hay_mas`). Evita el colapso del DOM y el congelamiento del navegador en dispositivos móviles al manipular más de 1.000 o 2.500 tickets por mes.

### Motor de Interés y Cartera (`pos_interes.py` y `pos_jefe.py`):
- **Alineación con TPV Maestra:** Calcula los intereses devengados de cuenta corriente con la misma fórmula de la tienda física (tasa CFR diaria), integrando el total adeudado en los KPI generales del jefe y en el saldo exigible.
- **Historial de Cargos (`_cargos_cartera`):** Planilla de cargos y fiados sobre `cuenta_corriente` (`tipo = 'CARGO'`), excluyendo conceptos de mantenimiento. Desglosa ventas a crédito por ticket (`#venta_id`), cargos manuales (`MANUAL`) e intereses. Totaliza vivos, cancelados y borrados con soporte multilínea y multi-sucursal.
- **Historial de Cobros (`_cobros_cartera`):** Planilla de cobros y abonos sobre `cuenta_corriente` (`tipo = 'ABONO'`). Identifica recibo `COB-{id}`, medio de pago (`Efectivo`, `Transferencia`, `Tarjeta`, `QR`, `Mixto`), detalle o id digital de cobro (`Caja`, ID Mercado Pago, `F9 MANUAL`), perfil y cajero responsable.
- **Auditoría de Cartera (`_auditoria_cartera`):** Libro de eventos sobre `clientes_auditoria` con formato homólogo a TPV 2026. Registra acciones (`Alta`, `Edición`, `Límite`, `Cargo`, `Abono`, `Anulación`, `Borrado`, `Unido`, `Suspendido`), PC, caja, usuario, llegada y detalle descriptivo. Incorpora control de integridad y cuadre de saldos en tiempo real (cargos vivos - abonos vs deuda exigible).

### Motor de Sincronización LWW (`sync_hub.py`):
- Aplica operaciones usando el algoritmo Last-Write-Wins basado en `updated_at_utc`.
- Es idempotente: si la misma operación llega dos veces con el mismo `op_id` o `uuid`, se confirma (`acked`) sin duplicar registros.
- Soporta `sync_mode=True` en `utils.parse_operacion_payload()` para tolerar cargas históricas u offline sin requerir fechas de vencimiento web obligatorias.

### Bus de Eventos SSE (`signal_bus.py`):
- Mantiene colas independientes en memoria indexadas por `empresa_id`.
- Cada vez que una operación o cliente se actualiza, emite un mensaje al canal del tenant sin cruzar información a otros clientes.

---

## 4. A dónde va (Salidas e Impacto)
- Tablas del esquema `empresa_{id}` en Neon PostgreSQL:
  - `clientes`, `pos_base`, `operaciones_financieras`, `pagos_cuotas`, `remitos_carga`, `compras_bulk`.
- Notificaciones a navegadores abiertos conectados a `/api/stream`.

---

## 5. Resiliencia y Fallos
- **Manejo de desconexiones:** Transacciones encapsuladas con `with get_db() as conn:`. Si una operación falla, se ejecuta `ROLLBACK` automático.
- **Tolerancia a datos incompletos:** Valores nulos o campos faltantes se reemplazan por valores por defecto seguros (`0.0`, `""`, `[]`).

---

## 6. Qué NO romper (Invariantes Sagrados)
1. **TTL de caché:** Mantener `_CACHE_TTL` en 5 segundos.
2. **Cálculo de Deuda Real:** No sumar deudas copiadas de la misma sucursal; solo sumar deudas de sucursales independientes.
3. **Idempotencia:** Ningún push de sincronización debe generar duplicados de ventas u operaciones.
