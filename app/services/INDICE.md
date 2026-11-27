# Índice: Servicios y Motores de Negocio (app/services/)

**Ubicación:** `app/services/` | **Rol:** Cerebro del CRM (Lógica de negocio, cálculos y persistencia).

---

## 1. Qué hace esta carpeta
- Procesa consultas multi-sucursal y consolida deudas reales unificando clientes por DNI/nombre.
- Calcula CFR, intereses diarios devengados, balances de caja, márgenes y reportes.
- Ejecuta replicación LWW (Last-Write-Wins) idempotente con los TPVs físicos locales.
- Administra el bus de eventos SSE (`signal_bus.py`) en tiempo real aislado por empresa.
- **Regla sagrada:** Devuelve siempre datos puros (dict, list, JSON). Cero HTML/CSS.

---

## 2. De dónde viene su entrada
- Invocado por controladores en `app/routes/` (`api_pos.py`, `api_sync.py`, `api_finanzas.py`).
- Sincronizaciones en segundo plano desde terminales físicas (`/api/sync/push`).
- Cron jobs periódicos para entrega de informes (`report_delivery.py`).

---

## 3. Qué archivos contiene
- `pos_base.py`: Unificación por DNI/nombre, lectura de tablas y caché ágil TTL 5s.
- `pos_jefe.py`: Lógica de paneles ejecutivos (Reporte, Jefe, Caja, Cartera, Pedidos WhatsApp).
- `pos_historial.py`: Paginación progresiva de tickets (bloques de 400) para scroll infinito.
- `pos_vitrina.py`: Motor de control de gestión y cálculo de las 12 tarjetas de KPI.
- `pos_interes.py` & `finanzas.py`: Motor de tasas CFR, cálculo de mora e intereses.
- `sync_hub.py`: Replicación LWW e idempotencia sin duplicados.
- `signal_bus.py`: Bus SSE pub/sub en memoria indexado por `empresa_id`.
- `nodo.py`, `perfil_comercio.py`, `pagos.py`, `remitos.py`, `report_delivery.py`.

---

## 4. Hacia dónde sale
- **A controladores:** Retorna estructuras nativas de datos limpias a `app/routes/`.
- **A persistencia:** Escribe en Neon PostgreSQL (esquema `public`) o SQLite fallback.
- **A clientes:** Notificaciones en vivo emitidas vía SSE a navegadores conectados.
