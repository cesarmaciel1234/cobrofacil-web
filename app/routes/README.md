# Subcarpeta: Rutas del Sistema (app/routes/)

**Ubicación:** `app/routes/`  
**Rol:** Módulo de controladores Blueprint de Flask. Enruta las peticiones entrantes hacia los servicios correspondientes y devuelve respuestas JSON o plantillas HTML.

---

## 1. Qué hace
- Define los Blueprints de Flask: `views_bp`, `api_bp`, `api_pos_bp`, `api_sync_bp`, `api_finanzas_bp`, `api_clientes_bp`, `api_remitos_bp`, `api_reportes_bp`, `api_sistema_bp`.
- Controla el acceso según permisos y estado de sesión.
- Parsea argumentos de query (`request.args`) y cuerpos JSON (`request.get_json()`).

---

## 2. Archivos y Funciones Principales

### `views.py`
- `index()`: Redirige a `/terminal` si está logueado o a `/login`.
- `login()`: Valida credenciales de la empresa y setea `session["empresa_id"]`.
- `terminal()`: Renderiza `terminal.html` pasando el usuario de sesión.
- `cartera()`: Renderiza la vista consolidada de clientes.

### `api_pos.py`
- `pos_jefe_sucursales()`: Llama a `pos_base.listar_sucursales()` y devuelve `{ok: true, sucursales: [...]}`.
- `api_pos_carga()`: Lee el avance que va dejando el enlace y lo muestra en la barra de arriba mientras llega el resto del libro.
- `api_pos_espejo()` y `api_pos_espejo_tabla()`: Entregan el libro para la copia que queda en cada aparato.
- `api_pos_nodo()`: `GET /api/pos/nodo`. Sin pieza, devuelve el sello. Con `pieza=reporte|contabilidad|ticket|cartera`, devuelve esa pantalla ya armada.
- `api_pos_jefe()`: Ventas y el desglose leen el mismo rango (hoy, semana, mes, período). Admite `offset` y `limite` para paginación progresiva y scroll infinito de tickets sin saturar la red ni la memoria móvil.
- `pos_jefe_panel()`: Llama a `pos_jefe.obtener_panel_jefe(panel, sucursal_id)`.
- `pos_jefe_vitrina()`: Llama a `pos_vitrina.calcular_vitrina_12(periodo, sucursal_id)`.

### `api_sync.py`
- `sync_push()`: Llama a `sync_hub.apply_sync_operations(device_id, operations)`.
- `sync_pull()`: Llama a `sync_hub.build_sync_pull_delta(since_cursor)`.

### `api_finanzas.py`
- `crear_operacion()`: Parsea el payload con `utils.parse_operacion_payload()` e inserta en `operaciones_financieras`.
- `eliminar_operacion()`: Requiere clave de confirmación y elimina la operación.

---

## 3. Flujo Interno de Ejecución
1. Llega la petición HTTP a través de Flask / WSGI.
2. Los decoradores de seguridad (`@login_required`) verifican la sesión o API Key.
3. Se extrae `empresa_id` de la sesión y se pasa implícitamente al contexto de base de datos.
4. Se invoca la función del servicio especializado en `app/services/`.
5. Se formatea la respuesta en JSON con `jsonify()` y se devuelve con su código HTTP correspondiente.

---

## 4. De dónde viene y A dónde va
- **Viene de:** Clientes HTTP (navegadores y TPV tienda).
- **Va hacia:** Motores de negocio en `app/services/` y base de datos en `app/database.py`.

---

## 5. Qué NO debe cambiar una mejora futura
- No colocar lógica de cálculo o sentencias SQL complejas dentro de las rutas; delegar siempre en `app/services/`.
