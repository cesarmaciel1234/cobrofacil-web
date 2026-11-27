# Plano General del Proyecto: CRM Frigorífico (Cobro Fácil Cloud Hub)

**Ubicación:** Raíz del proyecto (`C:\Users\cesar\OneDrive\Desktop\crm-frigorifico`)  
**Rol del Proyecto:** Centro de control y dashboard ejecutivo en la nube (Flask + Neon PostgreSQL) para distribuidoras cárnicas y sucursales. Consolida auditoría, contabilidad, cartera de clientes y paneles directivos sincronizados en vivo con los TPVs físicos locales (Cobro Fácil TPV PRO).

---

## 1. De dónde viene cada flujo (Entradas y Disparadores)

```
┌──────────────────────────────────────┐     ┌────────────────────────────────────┐
│      TIENDAS FÍSICAS LOCALES         │     │     NAVEGADORES / PWA MÓVIL        │
│    (Cobro Fácil TPV PRO 2026)        │     │  (Jefes, Gerentes, Contabilidad)   │
│  - Push LWW: /api/sync/push          │     │  - Acceso Web: / /login /terminal  │
│  - Pull Delta: /api/sync/pull        │     │  - Filtro Sucursal: ?sucursal_id=  │
│  - Novedades: /api/pos/nube/novedades│     │  - Acciones: cobros, remitos, caja │
└──────────────────┬───────────────────┘     └─────────────────┬──────────────────┘
                   │                                           │
                   ▼                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          CRM FRIGORÍFICO (Cloud Hub)                            │
│                 Flask Application Factory (`app/__init__.py`)                   │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │
                   ▲                   │                   ▲
                   │                   │                   │
┌──────────────────┴───────────────────┴───────────────────┴──────────────────────┐
│  TIENDA ONLINE REPARTO FÁCIL              BUS DE EVENTOS SSE & CRON JOBS        │
│  (https://repartofacil.onrender.com)      - Eventos en vivo: /api/stream        │
│  - Auth proxy: /api/auth/*                - Reporte semanal: /api/reportes/cron │
│  - Catálogo: /api/cobrofacil/*                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

1. **Sincronización POS (`tpv pro 2026`):**
   - El módulo `crm_salida` de cada tienda envía lotes de ventas, operaciones de caja y clientes (`POST /api/sync/push`).
   - Sincroniza novedades bidireccionales con el protocolo LWW (Last-Write-Wins) vía `app/services/sync_hub.py`.
2. **Navegador Web / PWA Ejecutiva (`terminal.html`):**
   - Ingreso autenticado de directores y cajeros (`GET /login`, `GET /terminal`).
   - Peticiones asíncronas AJAX para cargar paneles ejecutivos: Reporte, Caja, Cartera, Ventas, Pedidos.
   - Conexión persistente Server-Sent Events (`GET /api/stream`) para actualización en tiempo real.
3. **E-Commerce Reparto Fácil (`repartofacil.onrender.com`):**
   - Consume endpoints `/api/cobrofacil/*` para consultar inventario y sincronizar catálogo omnicanal.
4. **Tareas Programadas (Cron):**
   - Generación y despacho de reportes semanales y cálculo de saldos.

---

## 2. Qué hace el sistema (Cerebro y Servicios Internos)

El núcleo del sistema procesa, valida y consolida la información de negocio dividiéndose en capas estrictamente delimitadas:

- **Persistencia y Aislamiento Multi-Tenant (`app/database.py`):**
  - PostgreSQL en Neon DB alojado en el esquema unificado `public`.
  - Aislamiento estricto de empresas y sucursales mediante columnas `empresa_id` y `sucursal_id` con índices compuestos.
  - Pool de conexiones thread-safe (`ThreadedConnectionPool`) con `keepalives` configurados.
  - Fallback automático y transparente a SQLite (`crm.db`) en entornos locales o CI.
- **Rutas y Controladores HTTP/SSE (`app/routes/`):**
  - `views.py`: Enrutamiento web de vistas HTML (login, terminal, panel).
  - `api_pos.py`: Endpoints del POS (Jefe, vitrina de 12 tarjetas, reporte, sucursales).
  - `api_sync.py`: Endpoints de replicación LWW (push y pull delta).
  - `api_finanzas.py`: Endpoints de cálculo de CFR, arqueo y operaciones de caja.
  - `api_clientes.py`: Endpoints de cuenta corriente, deudas e intereses.
- **Motores y Servicios de Negocio (`app/services/`):**
  - `pos_base.py`: Motor unificador de identidad por DNI/nombre, lectura multi-sucursal y caché ágil TTL 5s.
  - `pos_jefe.py`: Lógica ejecutiva de tableros (Reporte, Jefe, Caja, Cartera, Pedidos a proveedores vía WhatsApp).
  - `pos_historial.py`: Motor de historial con paginación progresiva en bloques de 400 tickets.
  - `pos_vitrina.py`: Motor de control de gestión con las 12 tarjetas comerciales.
  - `pos_interes.py` & `finanzas.py`: Motor de tasas CFR e intereses devengados de cuenta corriente.
  - `sync_hub.py`: Motor de replicación LWW con resolución de conflictos e idempotencia.
  - `signal_bus.py`: Bus SSE pub/sub en memoria aislado por empresa.

---

## 3. Hacia dónde va (Salidas, Cara e Impacto)

1. **Cara Web / SPA (`app/static/js/app.js`, `terminal.html`):**
   - Renderiza métricas, rankings de cortes, arqueos y saldos en tiempo real sin recargar la página.
   - Selector multi-sucursal global que recalcula y refresca los paneles en <100ms.
2. **Espejo Local IndexedDB en Cliente (`app/static/js/espejo.js`, `espejo-engine.js`):**
   - Almacena localmente una copia reactiva en el navegador (`crm-espejo`) con delta-sync para navegación instantánea sin locks.
3. **Persistencia Central en la Nube:**
   - Registra transacciones en tablas centrales: `clientes`, `pos_base`, `operaciones_financieras`, `cuenta_corriente`.
4. **Exportaciones y Notificaciones:**
   - Generación de reportes ejecutivos en PDF vía `fpdf2` (`app/services/report_delivery.py`).
   - Envío de pedidos sugeridos de mercadería a proveedores vía enlaces de WhatsApp.

---

## 4. Directorios Clave y sus Índices

- [`app/services/INDICE.md`](file:///C:/Users/cesar/OneDrive/Desktop/crm-frigorifico/app/services/INDICE.md): Índice y plano técnico de los servicios de negocio.
- [`app/services/caja/INDICE.md`](file:///C:/Users/cesar/OneDrive/Desktop/crm-frigorifico/app/services/caja/INDICE.md): Submódulo de arqueo y contabilidad diaria (Cerebro backend).
- [`app/static/js/INDICE.md`](file:///C:/Users/cesar/OneDrive/Desktop/crm-frigorifico/app/static/js/INDICE.md): Índice y plano técnico de los controladores JavaScript de la SPA.
- [`app/static/js/barra/caja/INDICE.md`](file:///C:/Users/cesar/OneDrive/Desktop/crm-frigorifico/app/static/js/barra/caja/INDICE.md): Submódulo de caja y arqueo diario (Cerebro y Cara frontend).
- [`modularizacion.md`](file:///C:/Users/cesar/OneDrive/Desktop/crm-frigorifico/modularizacion.md): Guía de modularización piramidal del repositorio.
- [`AGENTS.md`](file:///C:/Users/cesar/OneDrive/Desktop/crm-frigorifico/AGENTS.md): Reglas permanentes y leyes inviolables para desarrollo y agentes de IA.
