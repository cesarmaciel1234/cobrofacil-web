# Plano General: Cloud Hub Multi-Tenant (Flask + Neon PostgreSQL)

**Ubicación:** `app/`  
**Propósito:** Núcleo central del CRM Web. Centraliza la recepción de datos desde las tiendas físicas (TPV PRO), gestiona el aislamiento multi-tenant por esquemas en Neon DB / SQLite, y expone tanto la API REST/SSE como la interfaz SPA ejecutiva (`terminal.html`).

---

## 1. De dónde viene (Entradas / Triggers)
- **Tiendas físicas (TPV PRO 2026):** Envíos automáticos en segundo plano (`POST /api/sync/push`, `POST /api/pos/nube/novedades`) con ventas, clientes y transacciones financieras.
- **Navegadores de Administradores / Jefes:** Acceso web autenticado a `http://127.0.0.1:5005` o dominio en Render (`https://crm-frigorifico.onrender.com`).
- **Tareas programadas (Cron):** Disparo de informe semanal los lunes a las 05:00 (`GET /api/reportes/trigger-cron`).

---

## 2. Frente (Vistas y SPA)
- `GET /`: Redirige al panel ejecutivo `terminal.html` (o a `/login` si no hay sesión).
- `GET /login`: Formulario de acceso con usuario de empresa y contraseña.
- `GET /terminal`: Consola unificada SPA con paneles dinámicos:
  - **Reporte:** Visión general ejecutiva, deuda total de clientes y balance.
  - **Jefe (Sucursales):** Selector de sucursales (`Todas`, `Maciel`, `alfaro 1964`) con métricas en tiempo real.
  - **Vitrina:** Tablero de 12 tarjetas de control de gestión.
  - **Contabilidad, Cartera, Digitales, Pedidos:** Pestañas de análisis profundo.

---

## 3. Fondo (Arquitectura y Servicios)
- **Application Factory:** `app/__init__.py:create_app()` inicializa blueprints, CORS, compresión, extensiones y migraciones.
- **Base de Datos Multi-Tenant:** `app/database.py`:
  - En PostgreSQL (Neon): Cada empresa opera en su propio esquema (`empresa_1`, `empresa_2`, etc.).
  - Pool de conexiones thread-safe (`ThreadedConnectionPool`) con `keepalives=1, keepalives_idle=30, connect_timeout=10` para tolerancia a cortes de red en Windows/Render.
  - En SQLite: Modo fallback para desarrollo y testing aislado (`Config.DB_PATH`).
- **Seguridad y Permisos:** `app/security.py`:
  - Sesiones firmadas con cookies seguras (`HttpOnly`, `SameSite=Lax`).
  - Hashing de contraseñas con PBKDF2/SHA-256.
  - `MASTER_PASSWORD` requerida para eliminaciones críticas.
- **Bus en Tiempo Real (SSE):** `app/services/signal_bus.py`:
  - Transmisión en vivo de eventos (`cliente_actualizado`, `sync_push`, etc.) aislados por `empresa_id`.

---

## 4. A dónde va (Salidas e Impacto)
- **Persistencia en la nube:** Tablas `clientes`, `pos_base`, `operaciones_financieras`, `remitos_carga` en Neon PostgreSQL.
- **Interfaz del usuario:** Respuestas JSON ágiles consumidas por `app/static/js/app.js`.
- **Informes generados:** Documentos PDF estructurados vía `fpdf2` entregados por correo o descargados directamente.

---

## 5. Modo Offline y Resiliencia
- **Desconexión con TPV:** Si el TPV pierde internet, el CRM conserva el último estado registrado sin alterar saldos. Al reconectar el TPV, el motor LWW (`sync_hub.py`) aplica los cambios pendientes sin duplicar datos.
- **Desconexión con Neon:** El pool reintenta automáticamente conexiones caídas y detecta fallos transitorios evitando crasheos del proceso.

---

## 6. Qué NO romper (Invariantes Sagrados)
1. **Aislamiento Multi-Tenant:** Ninguna consulta SQL debe cruzar esquemas o exponer datos de una empresa a otra.
2. **Caché corta (5 segundos):** `_CACHE_TTL` en `pos_base.py` no debe aumentarse para evitar datos desfasados al filtrar sucursales.
3. **Compatibilidad Dual Neon/SQLite:** Las consultas y migraciones deben seguir siendo compatibles tanto con SQLite como con PostgreSQL.
