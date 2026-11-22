# Plano de Rama: Rutas y Controladores HTTP / SSE

**Ubicación:** `app/routes/`  
**Propósito:** Definir los puntos de entrada HTTP, REST y Server-Sent Events (SSE) del CRM, orquestar la autenticación, validar los parámetros y delegar la ejecución a los motores de negocio en `app/services/`.

---

## 1. De dónde viene (Entradas / Triggers)
- **Navegadores:** Peticiones `GET /`, `/login`, `/terminal` y llamadas fetch/XHR hacia `/api/...`.
- **Servidores de tienda (TPV PRO 2026):** Llamadas API desde `crm_salida/vigilante.py` o `subida.py` hacia `/api/sync/...` y `/api/pos/...`.
- **Canales SSE:** Clientes web conectados a `/api/stream` para recibir actualizaciones en tiempo real.

---

## 2. Frente (Endpoints Expuestos)

### Vistas Web (`views.py`):
- `GET /` -> Redirección a `/terminal` o `/login`.
- `GET /login`, `POST /login` -> Autenticación y creación de sesión de tenant.
- `GET /terminal` -> SPA del Panel Ejecutivo (Reporte, Jefe, Vitrina).
- `GET /cartera` -> Libro consolidado de cuentas corrientes.

### Endpoints POS y Sucursales (`api_pos.py`):
- `GET /api/pos/sucursales` -> Lista las sucursales detectadas (`Todas`, `maciel - DESKTOP-7Q2Q4VD`, etc.) aisladas por tenant.
- `GET /api/pos/jefe?panel=<nombre>&sucursal_id=<id>` -> Datos de los paneles `reporte`, `jefe`, `caja`, `cartera`, `digitales`, `pedidos`.
- `GET /api/pos/jefe?panel=ticket&offset=<num>&limite=<num>` -> Historial de tickets con paginación progresiva en lotes de a 400 (`hay_mas`, `offset`, `limite`) sin congelamiento de UI.
- `GET /api/pos/nodo` -> Sello del libro. `GET /api/pos/nodo?pieza=reporte` -> Esa pantalla ya armada, para que la PWA no la calcule en la cara.
- `GET /api/pos/jefe/vitrina?periodo=<dias>` -> Métricas de las 12 tarjetas de control de gestión.

### Sincronización LWW (`api_sync.py`):
- `POST /api/sync/push` -> Recepción de cambios de TPV (clientes, operaciones, remitos).
- `GET /api/sync/pull` -> Envío de deltas desde un cursor de tiempo.

### Operaciones Financieras y Clientes (`api_finanzas.py`, `api_clientes.py`):
- `POST /api/operaciones`, `GET /api/operaciones`, `DELETE /api/operaciones/<id>`.
- `GET /api/clientes`, `POST /api/clientes`, `PUT /api/clientes/<id>`.

### Chat de Reparto Fácil (`api_repartofacil.py`):
- Las rutas de lista, ticket, chat, aceptación, rechazo, embalaje y liberación manual exigen sesión real y empresa del pedido; `visor` solo puede leer. El historial sigue disponible al comercio después de la entrega.
- Las acciones bloquean el pedido en PostgreSQL y comprueban su estado: no reabren entregas o cancelaciones, ni liberan pedidos retirados. Pedidos antiguos sin `empresa_id` quedan inaccesibles hasta atribuir su empresa de forma segura. Las pruebas aisladas cubren aceptación concurrente y cambio de empresa durante el envío.

### Ficha pública (`api_perfil_comercio.py`):
- `GET /api/repartofacil/mi-empresa` exige sesión y devuelve solo datos públicos
  de la empresa y sus reseñas. `PUT` requiere administrador y comprueba que la
  empresa esperada coincide con la sesión antes de guardar.

---

## 3. Fondo (Procesamiento Interno)
1. **Decoradores de seguridad:**
   - `@login_required`: Exige cookie de sesión con `empresa_id` válido.
   - `@api_key_required`: Valida token para llamadas máquina a máquina (TPV).
   - `@master_password_required`: Exige clave maestra para operaciones de borrado.
2. **Delegación a Servicios:**
   - Las rutas nunca ejecutan lógica compleja de cálculo: delegan en `pos_base`, `pos_jefe`, `sync_hub`, `finanzas`, etc.

---

## 4. A dónde va (Salidas e Impacto)
- Respuestas HTTP JSON formateadas (`{"ok": true, ...}`).
- Headers de streaming `text/event-stream` en `/api/stream`.
- Códigos HTTP estándar: `200` OK, `201` Created, `400` Bad Request, `401` Unauthorized, `404` Not Found, `500` Error.

---

## 5. Resiliencia y Fallos
- Captura de `ValueError` retornando `400` con mensaje claro de validación.
- Manejo de desconexiones de red con códigos `503` o retry headers.

---

## 6. Qué NO romper
- Mantener nombres de endpoints existentes para no romper la compatibilidad con el TPV en tiendas físicas.
