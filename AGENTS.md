# Leyes del Proyecto CRM Frigorífico (Cobro Fácil Cloud Hub)

> **OBLIGATORIO PARA TODO AGENTE / CHAT / DESARROLLADOR:**
> Estas reglas son permanentes y de cumplimiento automático en cada tarea. Antes de escribir o modificar código, respetar rigurosamente las 4 reglas de arquitectura y las leyes de dominio.

---

## 🏛️ REGLAS PERMANENTES DE ARQUITECTURA

### 1. Regla de Separación "Cerebro vs. Cara" (Backend / Lógica vs. Frontend / UI)
- **Separación Estricta:** Mantener estrictamente separado el **Cerebro** (lógica de negocio, reglas de cálculo, consultas SQL, validaciones y servicios) de la **Cara** (pantallas, HTML, CSS, plantillas y componentes visuales).
- **En Backend y Servicios (`app/services/`):**
  - Prohibido mezclar HTML, estilos o etiquetas visuales dentro de la lógica de negocio.
  - Los servicios deben devolver siempre **datos puros** (diccionarios Python, listas, tuplas o JSON).
- **En Frontend y Vistas (`app/static/js/`, `templates/`):**
  - Separar la lógica y llamadas a la API (`core/` o `motor/`) de la vista que dibuja botones, tablas y tarjetas (`ui/` o `componentes/`).
  - Prohibido incrustar lógica pesada de cálculo o de negocio dentro de los botones o controladores de eventos (`onclick`).

### 2. Regla de Árbol Modular y Límite de Líneas
- **Límite de Archivos Nuevos:** Ningún archivo nuevo debe superar **~300-400 líneas**. Si un módulo tiende a superar este tamaño, desacoplarlo en submódulos especializados.
- **Desguace Progresivo de Archivos Gigantes Existentes:**
  - Archivos existentes masivos (como `app/static/js/app.js` de +7.000 líneas o `app/services/pos_jefe.py` de +2.000 líneas) no deben seguir creciendo.
  - Cada vez que se modifique o extienda una funcionalidad en un archivo gigante existente, **extraer la parte tocada a su propia subcarpeta** separando su lógica (`motor/` o `service/`) y su vista (`ui/`).
  - Mantener estricta compatibilidad con las firmas y contratos existentes sin romper nada del flujo actual.

### 3. Regla de Documentación Viva por Carpeta (`README.md` o `INDICE.md` corto)
- **En la Raíz del Proyecto:** Mantener siempre actualizado el plano general (`INDICE.md`) explicando *"de dónde viene cada flujo, qué hace el sistema y hacia dónde va"*.
- **En cada Carpeta y Subcarpeta (nueva o modificada):** Crear o actualizar un archivo `.md` breve (**máximo 30-40 líneas**) explicando:
  1. **Qué hace** esa carpeta.
  2. **De dónde viene** su entrada (triggers, rutas o llamadas de origen).
  3. **Qué archivos contiene** y la función de cada uno.
  4. **Hacia dónde sale** (destino de datos, vistas o llamadas subsiguientes).

### 4. Regla de Ahorro de Contexto
- **Lectura Jerárquica Previa:** Antes de leer o volcar archivos largos de código al contexto, el agente debe leer obligatoriamente:
  1. El plano general de la raíz (`INDICE.md`).
  2. El `.md` breve (`INDICE.md` o `README.md`) de la carpeta o subcarpeta correspondiente.
- Solo tras comprender el mapa de flujos e invariantes se inspeccionan las funciones o líneas específicas a intervenir.

---

## ⚖️ LEYES SAGRADAS DE DOMINIO E INTEGRACIÓN

### 1. Proyectos Separados (Inviolable)
- `crm-frigorifico` y `tpv pro 2026` son **proyectos independientes**.
- El CRM es el centro de control en la nube (Render + Neon PostgreSQL) que consolida y visualiza las operaciones de todas las sucursales.
- Cada tienda física corre su propio servidor TPV local (`tpv pro 2026`). El cerebro de cobro, ventas y caja del TPV **no se modifica desde este proyecto**.
- La comunicación se realiza exclusivamente a través de los endpoints de sincronización y réplica (`/api/sync/push`, `/api/sync/pull`, `/api/pos/nube/novedades`, etc.).

### 2. Arquitectura Multi-Tenant Unificada (PostgreSQL en esquema `public`)
- **Esquema Unificado `public`:** Todas las empresas, sucursales y terminales residen en el esquema `public`. Queda terminantemente prohibido crear esquemas dinámicos (`empresa_1`, `empresa_2`, etc.).
- **Discriminador de Tenant e Índices:** El aislamiento multi-tenant se logra mediante las columnas `empresa_id` y `sucursal_id`, con índices compuestos `idx_<tabla>_emp_suc` para máxima velocidad.
- **Backend Único Centralizado:** `cobrofacil` (`crm-frigorifico`) es la única autoridad de backend para los TPVs físicos locales y para la tienda online `Reparto Fácil` (`https://repartofacil.onrender.com`), proveyendo autenticación JWT unificada (`/api/auth/*`), sincronización TPV (`/api/pos/*`) y catálogo omnicanal (`/api/cobrofacil/*`).
- **Conexiones Seguras:** Usar siempre el pool de conexiones thread-safe (`_get_pg_pool()` en `app/database.py`) con `keepalives` configurados.
- **Tolerancia Offline (SQLite):** Si no hay `DATABASE_URL` (en pruebas locales o CI), el sistema recurre de forma transparente a SQLite (`crm.db`). Las migraciones deben mantener compatibilidad dual SQLite / PostgreSQL.

### 3. Caché y Verdad de Datos
- **Caché corta:** `_CACHE_TTL` en `app/services/pos_base.py` se mantiene en **5 segundos**. No aumentarlo a valores altos para evitar que el usuario vea datos desfasados entre sucursales.
- **Identidad de clientes:** La unificación de clientes entre sucursales se rige por DNI/CUIT. Si no hay DNI, se unifica por nombre coincidente entre sucursales reales sin duplicar saldo copiado.

### 4. Pruebas de CI y Calidad
- Todos los tests (`python -m pytest tests/ -v`) deben pasar en su totalidad.
- Las operaciones financieras (`operaciones_financieras`) deben soportar `sync_mode=True` tolerando registros de réplica con campos opcionales sin romper las validaciones estrictas del formulario web manual.
