# 🏛️ ARQUITECTURA PIRAMIDAL: MULTI-TENANT, MULTI-SUCURSAL Y TERMINALES TPV

> **Sistemas Integrados:**
> - **Cobro Fácil (ERP / TPV en la nube):** `https://cobrofacil.onrender.com/` (Repo: `crm-frigorifico`)
> - **Reparto Fácil (E-Commerce / Delivery / Retiro):** `https://repartofacil.onrender.com/` (Repo: `RepartoFacil-web`)
> - **Base de Datos Unificada:** PostgreSQL `crm_libro_local` en Render.

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
                                          │ Omnicanalidad en Vivo
                                          │
                  ┌───────────────────────┴──────────────────────┐
                  │             CANAL ONLINE: TIENDA WEB         │
                  │       (Reparto Fácil / Pedidos Digitales)     │
                  │   Delivery a Domicilio  |  Retiro en Tienda  │
                  └──────────────────────────────────────────────┘
```

---

## 2. ⚡ REGLAS CRÍTICAS DE NEGOCIO

### A. Las PCs se conectan a Sucursales, NO a la Empresa en abstracto
- Cada computadora local TPV tiene su `identificador_pc` (ej. `DESKTOP-7Q2Q4VD`).
- Al sincronizar con la nube (`/api/pos/base/tabla`), el backend resuelve automáticamente:
  `PC/Terminal` ➔ `Sucursal ID` ➔ `Empresa ID`.
- Si la máquina no estuviera registrada previamente, el servidor la auto-detecta y la vincula a la sucursal activa o predeterminada sin interrumpir las ventas físicas.

### B. Detección Inteligente: Negocio Único vs. Red Multi-Sucursal
1. **Negocio Único (`COUNT(sucursales) <= 1`)**:
   - **En Servidor:** `es_negocio_unico = true`.
   - **En Reparto Fácil (Tienda Web):** El cliente accede directamente al catálogo y checkout sin modales de selección de sucursal (cero fricción).
   - **En Cobro Fácil:** Se visualiza la sucursal como `⭐ Local Único`.
2. **Red Multi-Sucursal (`COUNT(sucursales) > 1`)**:
   - **En Servidor:** `es_negocio_unico = false`.
   - **En Reparto Fácil (Tienda Web):** Permite al comprador elegir la sucursal más cercana o para retiro en mostrador, o auto-selecciona por coordenadas GPS.
   - **En Cobro Fácil:** El panel superior permite filtrar por cada sucursal individual o ver el `— Todas las Sucursales — (Consolidado Master)`.

### C. Omnicanalidad y Filtro Topbar en Cobro Fácil
El selector del encabezado (`topbar`) ofrece tres niveles de consulta reactiva en memoria e IndexedDB (0ms):
1. `🏢 — Todas las Sucursales — (Consolidado Master)`:
   - Suma total de efectivo, tarjetas, transferencias, fiados, cartera de clientes y ventas físicas de todas las cajas + ventas online.
   - Ideal para el dueño o el Centro de Distribución.
2. `🏪 [Nombre de Sucursal]` (ej: `Casa Central - Alfaro 1964`):
   - Muestra exclusivamente las ventas, caja chica, arqueo y fiados de ese local físico y sus terminales.
3. `🌐 Tienda Web`:
   - Aísla únicamente las ventas provenientes de la tienda online Reparto Fácil.

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
```

### Tabla: `public.terminales`
```sql
CREATE TABLE IF NOT EXISTS public.terminales (
    id SERIAL PRIMARY KEY,
    sucursal_id INTEGER NOT NULL REFERENCES public.sucursales(id),
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

## 4. 🔌 ENDPOINTS API REST (Modularizados)

| Método | Endpoint | Rol / Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/sucursales` | Sesión activa | Lista las sucursales y sus terminales con flag `es_negocio_unico`. |
| `POST` | `/api/sucursales` | Admin / Operador | Crea o actualiza datos de una sucursal física o CD. |
| `DELETE` | `/api/sucursales/<id>` | Admin | Desactiva una sucursal (impide borrar si es la única). |
| `POST` | `/api/sucursales/<id>/vincular-terminal` | Admin | Asigna o reasigna una PC TPV a una sucursal. |
| `GET` | `/api/sucursales/publicas/<empresa_id>` | Público | Endpoint consumido por Reparto Fácil para conocer sucursales activas. |
| `GET` | `/api/pos/sucursales` | Sesión / Token | Devuelve la lista unificada para el filtro superior del TPV. |
| `POST` | `/api/pos/base/tabla` | TPV Sync | Recibe datos de la PC local y resuelve su sucursal automáticamente. |

---

## 5. 🚀 GUÍA RÁPIDA PARA AGENTES Y DESARROLLADORES

1. **Si vas a tocar ventas físicas:** Asegurate de que cualquier operación lleve `sucursal_id`.
2. **Si vas a tocar pedidos web:** Comprobá si `tipo_entrega == 'pickup'` (Retiro en mostrador) o `'delivery'` y respetá `sucursal_id` de origen.
3. **Si agregás una nueva caja o terminal:** No toques la base a mano; usá `sucursales_service.vincular_terminal` o dejá que el sync auto-resuelva mediante `resolver_sucursal_terminal`.
