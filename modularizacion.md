# Cómo queda modularizado — Ley de Organización Piramidal (CRM Frigorífico)

Esta es la única nota de arquitectura en la raíz del proyecto. No es la base de un módulo particular ni guarda notas aisladas de una sola pantalla o endpoint.

Cualquier mejora, refactorización, pantalla nueva o ajuste de API que se realice en el CRM debe respetar esta estructura piramidal y actualizar su documentación en el mismo cambio.

---

## 1. La Estructura Piramidal (Los 3 Niveles del CRM)

El árbol de código se organiza en tres niveles bien definidos:

```
app/
├── plano.md                      <-- Plano General del Cloud Hub (Flask + Neon + Multi-Tenant)
├── __init__.py                   <-- Application Factory (create_app)
├── database.py                   <-- Conexión Neon / SQLite y migraciones de esquema
├── config.py                     <-- Configuración y variables de entorno
├── security.py                   <-- Seguridad, hashing y tokens
├── utils.py                      <-- Parsers y validaciones de payloads
│
├── routes/                       <-- NIVEL 2: Rama Controladores / Endpoints (lleva plano.md)
│   ├── plano.md                  <-- Frente (rutas HTTP/SSE) y Fondo (hacia qué servicio va)
│   ├── README.md                 <-- Responsabilidad general de las rutas
│   ├── views.py                  <-- Vistas web (HTML / Jinja2)
│   ├── api_pos.py                <-- Endpoints del POS (Jefe, Reporte, Vitrina, Sucursales)
│   ├── api_sync.py               <-- Endpoints de sincronización LWW (Push/Pull Delta)
│   ├── api_finanzas.py           <-- Endpoints financieros (CFR, tarjetas, cheques, pagos)
│   └── api_clientes.py           <-- Endpoints de cartera y clientes
│
├── services/                     <-- NIVEL 2: Rama Motores de Negocio (lleva plano.md)
│   ├── plano.md                  <-- Arquitectura de motores, cálculo de deuda y persistencia
│   ├── README.md                 <-- Responsabilidad técnica de los servicios
│   ├── pos_base.py               <-- Motor unificador de identidad, lectura multi-sucursal y caché
│   ├── pos_jefe.py               <-- Lógica ejecutiva (Reporte, Contabilidad, Cartera, Pedidos)
│   ├── pos_vitrina.py            <-- Motor de las 12 tarjetas de control de gestión
│   ├── sync_hub.py               <-- Motor de replicación LWW y changelog
│   ├── signal_bus.py             <-- Bus SSE en vivo aislado por tenant
│   └── finanzas.py               <-- Lógica matemática de CFR y deuda real
│
└── static/                       <-- NIVEL 2: Rama Frontend Web & PWA (lleva plano.md)
    ├── plano.md                  <-- Arquitectura de la SPA, eventos, IndexedDB y PWA
    ├── README.md                 <-- Responsabilidad técnica de los assets estáticos
    ├── enterprise.css            <-- Estilos globales y glassmorphism
    ├── sw.js                     <-- Service Worker y caché offline
    └── js/                       <-- NIVEL 3: Subcarpeta de scripts controladores
        ├── README.md             <-- Detalle de controladores JavaScript
        ├── app.js                <-- Orquestador SPA de terminal.html y router de vistas
        ├── modulo-panel.js       <-- Gestor visual de paneles y sucursales
        ├── pos-offline.js        <-- Motor Dexie / IndexedDB local
        └── barra/                <-- Submódulos de paneles de barra lateral
            └── README.md         <-- Documentación de paneles individuales
```

### Reglas de nivel:
1. **NIVEL 1 — Base (`app/`):**
   - Agrupa el núcleo del servidor. Lleva su `plano.md` describiendo la arquitectura general del Cloud Hub.
2. **NIVEL 2 — Ramas (`routes/`, `services/`, `static/`):**
   - Son las columnas vertebrales del sistema (Controladores, Motores y Frontend).
   - **Cada rama lleva obligatoriamente su `plano.md`** detallando Frente (lo expuesto al cliente o UI) y Fondo (el procesamiento interno, tablas y destino de datos).
3. **NIVEL 3 — Subcarpetas funcionales (`static/js/`, `static/js/barra/`, `templates/`):**
   - Agrupan piezas especializadas (scripts SPA, submódulos de barra, plantillas).
   - **Lleva obligatoriamente su `README.md`** con el detalle exacto de funciones y orden de ejecución.

---

## 2. Los 5 Pilares de Todo Documento `.md`

Cualquier desarrollador, colaborador o IA que lea un `plano.md` o un `README.md` debe poder responder estas 5 preguntas sin tener que adivinar el código:

| Pilar | Pregunta clave | Qué debe documentar |
| :--- | :--- | :--- |
| **1. De dónde viene** | ¿Qué lo activa o invoca? | Origen exacto: Petición HTTP (`GET /api/pos/jefe/panel`), llamada AJAX/fetch desde `app.js`, evento SSE (`signal_bus`), webhook de sincronización desde el TPV tienda, o llamada interna de un servicio. |
| **2. A dónde va** | ¿Qué produce y dónde impacta? | Destino de los datos: Esquema PostgreSQL en Neon (`empresa_2`), base local SQLite (`crm.db`), respuesta JSON al navegador, evento broadcast SSE, o archivo PDF descargado. |
| **3. Qué función cumple** | ¿Cuál es su rol específico? | Responsabilidad técnica delimitada. Nombres reales de funciones Python (`obtener_panel_jefe`), clases (`SyncHub`), endpoints (`/api/sync/push`) o funciones JS (`aplicarSucursal`). |
| **4. Cómo trabaja** | ¿Cómo corre internamente? | Flujo secuencial paso a paso: Orden de ejecución, transacciones SQL, validaciones de esquema (`empresa_id`), tiempos de caché TTL, manejo de excepciones y qué códigos de estado HTTP devuelve (`200`, `201`, `400`, `401`, `500`). |
| **5. Qué NO romper** | ¿Cuáles son sus invariantes? | Reglas sagradas: Aislamiento estricto multi-tenant por esquema, compatibilidad offline SQLite / Neon, tolerancia en `sync_mode=True`, caché ágil de 5 segundos, unificación correcta por DNI. |

---

## 3. Plantilla Oficial: `plano.md` (Inicio de Rama)

El archivo `plano.md` se ubica en la raíz de cada rama (`app/routes/plano.md`, `app/services/plano.md`, `app/static/plano.md`):

```markdown
# Plano de Rama: [Nombre de la Rama]

**Ubicación:** `app/[rama]/`  
**Propósito:** Breve resumen de 2-3 renglones sobre qué resuelve esta rama en el CRM.

---

## 1. De dónde viene (Entradas / Triggers)
- **Disparador:** Petición HTTP, evento del navegador, llamada interna de servicio, o sincronización desde el TPV.
- **Ruta / Módulo de entrada:** Archivo y función de origen.
- **Parámetros recibidos:** Query params, headers (`X-API-Key`, sesión cookie), payload JSON.

---

## 2. Frente (Lo expuesto hacia afuera)
- **Endpoints expuestos:** Rutas REST, métodos (`GET`, `POST`, `DELETE`) y códigos de retorno.
- **Formato de respuesta:** Estructura JSON, headers SSE o HTML renderizado.
- **Seguridad:** Nivel de autenticación requerido (`@login_required`, `@api_key_required`, `@master_password_required`).

---

## 3. Fondo (Procesamiento Interno)
- **Servicios coordinadores:** Qué archivos en `app/services/` ejecutan la lógica.
- **Tablas afectadas:** Tablas en el esquema del tenant (`clientes`, `pos_base`, `operaciones_financieras`, `remitos_carga`).
- **Flujo secuencial:**
  1. Paso 1: Validación y resolución de tenant (`empresa_id`).
  2. Paso 2: Lectura o mutación transaccional en Neon / SQLite.
  3. Paso 3: Broadcast a clientes conectados via SSE y retorno JSON.

---

## 4. A dónde va (Salidas e Impacto)
- **Destino inmediato:** Respuesta al navegador o confirmación al TPV tienda.
- **Persistencia:** Base de datos Neon PostgreSQL (`empresa_{id}`) o SQLite local.
- **Propagación:** Eventos en tiempo real emitidos a través de `signal_bus`.

---

## 5. Resiliencia, Fallos y Modo Offline
- **Qué hace si falla Neon:** Comportamiento ante desconexión o timeout.
- **Qué devuelve ante error:** Formato estructurado de error `{"ok": false, "error": "mensaje"}` con status HTTP apropiado.
- **Manejo de concurrencia:** Conexiones thread-safe del pool `_get_pg_pool()`.

---

## 6. Qué NO romper (Invariantes Sagrados)
- Reglas inviolables (ej. no mezclar datos de diferentes `empresa_id`, respetar `_CACHE_TTL = 5.0`, no bloquear endpoints con operaciones sincrónicas lentas).
```

---

## 4. Plantilla Oficial: `README.md` (En cada Subcarpeta)

```markdown
# Subcarpeta: [Nombre de la subcarpeta]

**Ubicación:** `app/[rama]/[subcarpeta]/`  
**Rol:** Propósito técnico de este corte funcional específico.

---

## 1. Qué hace
Descripción concisa y técnica de las tareas que realiza el código dentro de esta carpeta.

---

## 2. Funciones, Clases y Archivos Principales
Listado con nombres reales:
- `archivo.py` / `script.js`:
  - `funcion_a(params) -> dict`: Qué hace y qué retorna.
  - `funcion_b(...)`: Qué excepciones captura y cómo maneja errores.

---

## 3. Cómo funciona (Flujo interno)
Orden secuencial en que se ejecutan los métodos:
1. `validar()`: Verificación de entrada.
2. `ejecutar()`: Operación principal.
3. `responder()`: Formateo y retorno.

---

## 4. De dónde viene y A dónde va
- **Viene de:** Quién invoca a este módulo.
- **Va hacia:** Quién consume o persiste los resultados.

---

## 5. Qué NO debe cambiar una mejora futura
Invariantes locales del módulo.
```

---

## 5. Protocolo de Modificación de Código (Checklist Obligatorio)

Al recibir una tarea o planificar una mejora en el CRM:

1. [ ] **Lectura previa:** Leer `AGENTS.md`, `modularizacion.md`, el `plano.md` de la rama afectada y el `README.md` de la subcarpeta.
2. [ ] **Ubicación piramidal:**
   - La lógica de negocio vive en `app/services/`.
   - Los endpoints HTTP viven en `app/routes/`.
   - La interfaz visual y scripts SPA viven en `app/static/` y `app/templates/`.
3. [ ] **Actualización de documentación:**
   - Si se añade o modifica un endpoint, actualizar `app/routes/plano.md`.
   - Si se añade o modifica un motor o servicio, actualizar `app/services/plano.md`.
   - Si se tocan funciones de subcarpeta, actualizar su `README.md`.
4. [ ] **Verificación de calidad:** Correr `python -m pytest tests/ -v` y asegurar que los 117 tests pasen al 100%.
5. [ ] **Informar en la respuesta:** Indicar explícitamente en qué carpeta y archivo quedó documentado el cambio.
