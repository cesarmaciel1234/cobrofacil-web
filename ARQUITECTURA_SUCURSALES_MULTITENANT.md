# 🏛️ ARQUITECTURA PIRAMIDAL UNIFICADA: MULTI-TENANT, MULTI-SUCURSAL Y OMNICANALIDAD

> **ESTRUCTURA DE PRODUCCIÓN VIGENTE (2 WEBS + 1 BACKEND + 1 BASE EN `public`):**
> - 🌐 **Reparto Fácil (E-Commerce / Delivery / Retiro):** `https://repartofacil.onrender.com/` (Repo: `RepartoFacil-web`)
> - 🏢 **Cobro Fácil (ERP / TPV en la nube & Backend Único):** `https://cobrofacil.onrender.com/` (Repo: `crm-frigorifico`)
> - 🗄️ **Base de Datos Unificada:** PostgreSQL `crm_libro_local` en Render (**100% en esquema `public`**).
> - ❌ **Backend legado eliminado:** `repartofacil-backend` (FastAPI) ha sido deprecado y eliminado de Render y del código. Todas las rutas `/api/auth/*`, `/api/db/*`, `/api/cobrofacil/*` son atendidas por `cobrofacil`.

---

## 1. 📐 VISIÓN Y JERARQUÍA PIRAMIDAL

```
                  ┌──────────────────────────────────────────────┐
                  │              NIVEL 1: EMPRESA                │
                  │   (Tenant raíz / Marca / CUIT / Razón Social)│
                  │         Ej: "Carnicería Maciel" (id: 1)       │
                  └───────────────────────┬──────────────────────┘
                                          │
                  ┌───────────────────────┴──────────────────────┐
                  ▼                                              ▼
    ┌───────────────────────────┐                  ┌───────────────────────────┐
    │   NIVEL 2: SUCURSAL #1    │                  │   NIVEL 2: SUCURSAL #2    │
    │  "Casa Central - Alfaro"  │                  │  "Centro de Distribución" │
    │   (Local Físico / Venta)  │                  │    (Logística / Stock)    │
    └─────────────┬─────────────┘                  └─────────────┬─────────────┘
                  │                                              │
         ┌────────┴────────┐                            ┌────────┴────────┐
         ▼                 ▼                            ▼                 ▼
 ┌───────────────┐ ┌───────────────┐            ┌───────────────┐ ┌───────────────┐
 │   NIVEL 3:    │ │   NIVEL 3:    │            │   NIVEL 3:    │ │   NIVEL 3:    │
 │  TERMINAL 1   │ │  TERMINAL 2   │            │  TERMINAL 3   │ │  TERMINAL 4   │
 │   Caja Most.  │ │  Caja Balanza │            │  PC Despacho  │ │  PC Depósito  │
 │(DESKTOP-7Q2Q) │ │ (DESKTOP-XYZ) │            │ (DESKTOP-CD1) │ │ (DESKTOP-CD2) │
 └───────────────┘ └───────────────┘            └───────────────┘ └───────────────┘

                                          ▲
                                          │ Omnicanalidad en Vivo (Sync 0ms)
                                          │
                  ┌───────────────────────┴──────────────────────┐
                  │             CANAL ONLINE: TIENDA WEB         │
                  │       (Reparto Fácil / Pedidos Digitales)     │
                  │   Delivery a Domicilio  |  Retiro en Tienda  │
                  └──────────────────────────────────────────────┘
```

---

## 2. ⚡ REGLAS CRÍTICAS DE ARQUITECTURA

### A. 2 Webs, 1 Backend Único
1. **Cobro Fácil (`crm-frigorifico`)** es la única autoridad de backend para ambos productos:
   - Resuelve autenticación JWT (`/api/auth/*`), sincronización TPV (`/api/pos/*`), sucursales (`/api/sucursales/*`) y catálogo de inventario (`/api/cobrofacil/*`).
2. **Reparto Fácil (`RepartoFacil-web`)** es la aplicación Next.js cliente orientada al comprador y repartidor:
   - Consume sus APIs a través de su proxy unificado que delega hacia `https://cobrofacil.onrender.com`.
   - Comparte el mismo secreto de validación de tokens:
     - En `cobrofacil`: `JWT_SECRET_KEY`
     - En `repartofacil`: `JWT_SECRET` (idéntico valor)
   - Accede directamente a PostgreSQL mediante `DATABASE_URL` solo para consultas de persistencia directa y lecturas optimizadas.

### B. 100% de la Base de Datos en Esquema `public`
- **Prohibido el uso de esquemas dinámicos (`empresa_2`, `empresa_3`, etc.)**: Todo el modelo multi-tenant se maneja en el esquema `public` con "una sola bolsa y etiqueta de tenant".
- Cada tabla multi-tenant posee:
  - `empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id)`
  - `sucursal_id INTEGER REFERENCES sucursales(id)` (cuando aplica a nivel local)
  - Índice compuesto: `CREATE INDEX idx_<tabla>_emp_suc ON public.<tabla> (empresa_id, sucursal_id);`
- En cada conexión entrante, el backend ejecuta automáticamente `SET search_path TO public`.

### C. Resolución de Terminales y Cajas TPV
- Cada computadora local TPV tiene su `identificador_pc` (ej. `DESKTOP-7Q2Q4VD`).
- Al sincronizar con la nube (`/api/pos/base/tabla`), el backend resuelve automáticamente:
  `PC/Terminal` ➔ `Sucursal ID` ➔ `Empresa ID`.
- Si la máquina no estuviera registrada previamente, el servidor la auto-detecta y la vincula a la sucursal activa sin interrumpir las ventas físicas.

### D. Detección Inteligente: Negocio Único vs. Red Multi-Sucursal
1. **Negocio Único (`COUNT(sucursales) <= 1`)**:
   - `es_negocio_unico = true`.
   - En Reparto Fácil: Cero fricción, el cliente accede directo al catálogo y checkout sin modales de selección de sucursal.
   - En Cobro Fácil: Se visualiza como `⭐ Local Único`.
2. **Red Multi-Sucursal (`COUNT(sucursales) > 1`)**:
   - `es_negocio_unico = false`.
   - En Reparto Fácil: Permite al cliente elegir sucursal de retiro o auto-asigna por proximidad GPS (Haversine).
   - En Cobro Fácil: Selector superior en topbar con 3 niveles:
     - `🏢 — Todas las Sucursales — (Consolidado Master)`
     - `🏪 [Nombre de Sucursal]` (ej: `Casa Central - Alfaro 1964`)
     - `🌐 Tienda Web` (Ventas online de Reparto Fácil)

---

## 3. 🗄️ MODELO DE BASE DE DATOS (PostgreSQL Render)

### Tabla: `public.sucursales`
```sql
CREATE TABLE IF NOT EXISTS public.sucursales (
    id SERIAL PRIMARY KEY,
    empresa_id INTEGER NOT NULL REFERENCES public.empresas(id),
    nombre VARCHAR(120) NOT NULL,
    codigo VARCHAR(50),
    direccion VARCHAR(255),
    latitud NUMERIC(10, 7),
    longitud NUMERIC(10, 7),
    telefono VARCHAR(30),
    whatsapp VARCHAR(30),
    horario VARCHAR(250),
    es_centro_distribucion BOOLEAN DEFAULT FALSE,
    activo SMALLINT DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sucursales_emp ON public.sucursales(empresa_id);
```

### Tabla: `public.terminales`
```sql
CREATE TABLE IF NOT EXISTS public.terminales (
    id SERIAL PRIMARY KEY,
    sucursal_id INTEGER REFERENCES public.sucursales(id),
    empresa_id INTEGER NOT NULL REFERENCES public.empresas(id),
    nombre VARCHAR(100) NOT NULL,
    identificador_pc VARCHAR(100) NOT NULL,
    descripcion VARCHAR(200),
    ip_local VARCHAR(50),
    activo SMALLINT DEFAULT 1,
    ultimo_sync TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_terminales_empresa_pc 
ON public.terminales(empresa_id, identificador_pc);
```

---

## 4. 🔌 ENDPOINTS API REST (Centralizados en Cobro Fácil)

| Método | Endpoint | Rol / Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/sucursales` | Sesión activa | Lista las sucursales y sus terminales con flag `es_negocio_unico`. |
| `POST` | `/api/sucursales` | Admin / Operador | Crea o actualiza datos de una sucursal física o CD. |
| `DELETE` | `/api/sucursales/<id>` | Admin | Desactiva una sucursal (impide borrar si es la única). |
| `POST` | `/api/sucursales/<id>/vincular-terminal` | Admin | Asigna o reasigna una PC TPV a una sucursal. |
| `GET` | `/api/sucursales/publicas/<empresa_id>` | Público | Endpoint consumido por Reparto Fácil para conocer sucursales activas. |
| `GET` | `/api/pos/sucursales` | Sesión / Token | Devuelve la lista unificada para el filtro superior del TPV. |
| `POST` | `/api/pos/base/tabla` | TPV Sync | Recibe datos de la PC local y resuelve su sucursal automáticamente. |
| `POST` | `/api/auth/login` | Público | Autenticación unificada de usuarios (Web y Móvil). |
| `GET` | `/api/auth/me` | Bearer Token / Cookie | Retorna la sesión y perfil del usuario autenticado. |
| `GET` | `/api/cobrofacil/products` | Público | Retorna el catálogo omnicanal para Reparto Fácil. |

---

## 5. 🚀 GUÍA RÁPIDA PARA AGENTES Y DESARROLLADORES

1. **NO crear nuevos servicios de backend:** Cobro Fácil es el único backend de la arquitectura.
2. **NO crear esquemas en PostgreSQL:** Toda tabla nueva va en `public` con `empresa_id` y `sucursal_id`.
3. **Ventas físicas y pedidos web:** Toda venta física debe llevar su `sucursal_id` resuelta. Todo pedido web respetará `tipo_entrega` (`'pickup'` o `'delivery'`) y su `sucursal_id` de despacho.
4. **Cajas locales:** Para registrar o mover una terminal, utilizar la función de resolución automática o `/api/sucursales/<id>/vincular-terminal`.
