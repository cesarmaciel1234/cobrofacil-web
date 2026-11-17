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
├── nodo.py               <-- Nodo maestro: arma reporte y el resto en segundo plano
├── pos_jefe.py           <-- Generador de paneles (Reporte, Jefe, Contabilidad, Cartera, Pedidos)
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
