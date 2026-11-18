# Cobro Fácil — Cloud Hub & CRM

Dashboard ejecutivo Flask para distribuidoras de carne, sincronizado en vivo con Cobro Fácil TPV.

## Dos proyectos

Cobro Fácil (`C:\Users\cesar\OneDrive\Desktop\tpv pro 2026`) y este CRM son proyectos distintos. Cobro Fácil ya está terminado y funciona. Su cerebro no se toca: la lógica que haga falta se copia y se pega acá.

El envío sí vive en el servidor de Cobro Fácil, como módulo aparte (`crm_salida`). Ese módulo solo manda la base. No forma parte del cerebro.

Este CRM es el proyecto nuevo. Todas las sucursales mandan su libro a Neon (`neondb`). Render es la cara y lo muestra. Neon guarda. Render no es la base.

La web es el negocio para auditar sin ir al local: contabilidad, cartera de clientes y el panel del jefe. Neon es el espejo. Render es la interfaz.

En el plan gratis el libro no sale en cada venta. La tienda hace unos 70 tickets por día y el envío completo tarda cerca de una hora. El módulo mira cada 15 minutos y, si hubo cambios, manda como mucho una vez cada 3 horas. Entre medio Neon y Render se duermen y no gastan el cupo.

Estamos en prueba, en el plan gratis. Más adelante se puede alquilar la base y el dominio.

La casa queda en cinco áreas. La barra de todos los días sigue siendo cuatro botones: **Reporte** (solo el reporte), **Proveedor**, **Promedio** y **Ticket** (el historial).

| Área | Qué mira |
|------|----------|
| Dirección | Panel del jefe, reporte y promedio |
| Comercial | Clientes, cartera y tickets |
| Abastecimiento | Proveedores y compras |
| Tesorería | Cobranzas y pagos |
| Control | Auditoría, antigüedad y márgenes |

## Tres Pilares Ejecutivos y Multi-Sucursal

El CRM cuenta con una arquitectura ejecutiva autónoma multi-sucursal alimentada por el espejo en Neon PostgreSQL:

1. **🏢 Selector Multi-Sucursal Global**:
   - Barra en cabecera que descubre automáticamente las sucursales conectadas (`/api/pos/sucursales`).
   - Permite alternar con un clic entre **Consolidado (Todas)** y cada local específico (`Sucursal 1`, `Sucursal 2`, etc.).

2. **👑 JEFE / DIRECCIÓN**:
   - Tarjetas KPI: Ventas Totales del Día, Tickets Emitidos, Ticket Promedio y Medio de Pago Líder.
   - **Comparativa Multi-Sucursal**: Ventas, tickets, promedio y % de participación de cada local.
   - **Ranking de Cortes de Carne / Productos**: Tabla ordenada por recaudación, kilos/cantidad vendida y operaciones.

3. **💰 CONTABILIDAD / TESORERÍA**:
   - Tarjetas de Caja: Ventas Totales, Cobros Fiado (Cta. Cte.), Gastos del Día y **Resultado Operativo Neto** (`Ventas + Cobros - Gastos`).
   - **Arqueo por Medios de Pago**: Desglose transaccional de Efectivo, QR MercadoPago, Transferencias bancarias y Tarjetas con porcentaje sobre el total.
   - **Detalle de Cobranzas del Día**: Entradas de pagos de clientes.
   - **Detalle de Gastos de Caja**: Registro de salidas con categoría, motivo y monto.

4. **👥 ADMIN / CARTERA & MORA**:
   - Tarjetas de Fiado: Deuda Total en la Calle, Total Saldo a Favor, Cuentas Activas con Deuda y Cuentas al Día.
   - **Top Deudores y Control de Límites**: Tabla de cuentas con saldo deudor, DNI/CUIT, límite acordado, semáforo de estado (`Normal`, `⚠️ AL LÍMITE`, `⛔ EXCEDIDO`) y botón de cobro rápido directo a WhatsApp.
   - Enlace a la Cartera Móvil PWA interactiva con cálculo de intereses.

## Programa principal (tu captura)

```powershell
pip install -r requirements.txt
python seed_demo.py    # opcional
python run.py          # http://127.0.0.1:5005
```

## Publicar en internet (iPhone PWA)

1. Entrá a [render.com](https://render.com) → **New Web Service**
2. Conectá el repo `cesarmaciel1234/crm-frigorifico`
3. Render lee `render.yaml` automáticamente → **Deploy**
4. URL del programa: **https://crm-frigorifico.onrender.com**
5. iPhone: Safari → esa URL → Compartir → **Agregar a inicio**

## GitHub Pages

`https://cesarmaciel1234.github.io/crm-frigorifico/` redirige a Render (no es el programa, solo enlace).

## Módulos incluidos

| Ruta | Qué es |
|------|--------|
| `/` | Dashboard ejecutivo |
| `/pos` | POS offline (integrado, sincroniza al mismo servidor) |
| `/cartera` | Vista de cartera de clientes estilo Cobro Fácil POS |

## Integración con Servidor POS (TPV Pro 2026)

Este CRM está preparado para integrarse con el servidor POS TPV Pro 2026, permitiendo:

- **Sincronización de clientes**: Recibir clientes del POS y mantenerlos actualizados
- **Sincronización de proveedores**: Recibir proveedores del POS como entidades bancarias
- **Sincronización bidireccional**: Exportar datos del CRM al POS
- **Sistema secundario de alto nivel**: Trabajar datos financieros, remitos y cobranzas por encima del POS

### Configuración

La configuración de integración se maneja a través de la API:

```powershell
# Obtener configuración actual
GET /api/pos/config

# Actualizar configuración
PUT /api/pos/config
{
  "server_url": "http://192.168.1.100:5000",
  "api_key": "tu_clave_api",
  "sync_interval_minutes": 30,
  "auto_sync": true
}
```

### Endpoints de Integración

#### Recibir datos del POS

```powershell
# Sincronizar un cliente individual
POST /api/pos/clientes
{
  "nombre": "Juan Pérez",
  "telefono": "11-1234-5678",
  "direccion": "Calle Falsa 123",
  "cuit": "20-12345678-9",
  "email": "juan@email.com",
  "saldo": 15000.50,
  "limite_credito": 500000.0
}

# Sincronizar lote de clientes
POST /api/pos/clientes/lote
{
  "clientes": [
    { "nombre": "Juan Pérez", ... },
    { "nombre": "María López", ... }
  ]
}

# Sincronizar un proveedor individual
POST /api/pos/proveedores
{
  "nombre": "Frigorífico XYZ",
  "cuit": "30-98765432-1",
  "telefono": "11-9876-5432",
  "limite_credito": 1000000.0
}

# Sincronizar lote de proveedores
POST /api/pos/proveedores/lote
{
  "proveedores": [
    { "nombre": "Frigorífico XYZ", ... },
    { "nombre": "Carnes ABC", ... }
  ]
}
```

#### Exportar datos al POS

```powershell
# Exportar clientes en formato POS
GET /api/pos/clientes

# Exportar proveedores en formato POS
GET /api/pos/proveedores
```

#### Monitoreo de Sincronización

```powershell
# Obtener historial de sincronizaciones
GET /api/pos/sync/logs?limit=50&offset=0

# Obtener estado de última sincronización
GET /api/pos/sync/status
```

### Convertir a Ejecutable

Para distribuir el CRM como un ejecutable standalone:

```powershell
# Instalar PyInstaller
pip install pyinstaller

# Construir ejecutable
python build_exe.py

# El ejecutable se genera en dist/CRM-Frigorifico.exe
```

El ejecutable incluye:
- Servidor Flask integrado
- Templates y static files
- Base de datos SQLite local (opcional)
- Módulos de integración POS

### Arquitectura

```
┌─────────────────┐
│  Servidor POS    │ (TPV Pro 2026)
│  (Base de datos) │
└────────┬────────┘
         │ HTTP API
         ↓
┌─────────────────┐
│  CRM Frigorífico │ (Este proyecto)
│  ┌───────────┐  │
│  │ Dashboard │  │ - Gestión financiera
│  │ Clientes  │  │ - Remitos y cobranzas
│  │ Reportes  │  │ - Análisis de deudas
│  └───────────┘  │
│  ┌───────────┐  │
│  │Integración│  │ - Transformación POS→CRM
│  │    POS    │  │ - Sincronización bidireccional
│  └───────────┘  │
└─────────────────┘
```

### Archivos Nuevos

- `app/services/pos_integration.py` - Servicio de transformación y sincronización POS
- `app/services/pos_config.py` - Gestión de configuración y logs de sincronización
- `app/routes/api_pos.py` - Endpoints API para integración POS
- `build_exe.py` - Script para construir ejecutable
- `config_pos.example.ini` - Plantilla de configuración (opcional)

### Envío desde Cobro Fácil

El login `https://crm-frigorifico.onrender.com/login` no recibe datos. El servidor local pega a la API con la clave del CRM (`MT_API_KEY`), header `X-API-Key`:

```powershell
POST https://crm-frigorifico.onrender.com/api/pos/clientes/lote
```

En la carpeta del TPV, `enviar_cartera_crm.py` lee `punpro.db` y arma ese lote. Sin `--enviar` solo cuenta. La deuda del mostrador se guarda en `deuda_pos` y no pisa `saldo_actual` (ese saldo lo calculan los remitos). El cliente se reconoce por `uid`, después por el id del POS y por el DNI.

### Notas Importantes

1. **La clave no viaja de vuelta**: `GET /api/pos/config` no devuelve la API key.
2. **Scoring**: un cliente nuevo entra con scoring A. Un sync posterior no lo cambia.
3. **Logging**: las sincronizaciones quedan en `pos_sync_log`.

## Seguridad (producción)

Copiá `.env.example` a `.env` y definí:

| Variable | Uso |
|----------|-----|
| `SECRET_KEY` | Sesiones Flask (obligatoria en producción) |
| `MT_API_KEY` | Clave de acceso al panel y API |
| `MASTER_PASSWORD` | Clave para borrar datos y acciones destructivas |
| `AUDIT_DELETE_PASSWORD` | Alias retrocompatible de `MASTER_PASSWORD` |
| `ADMIN_INITIAL_PASSWORD` | Contraseña del usuario `admin` al primer arranque |
| `DATABASE_URL` | PostgreSQL (Render lo genera automáticamente) |
| `REDIS_URL` | Rate limiting distribuido (opcional) |

En Render, `render.yaml` provisiona PostgreSQL y genera las claves. Recuperá `MT_API_KEY` desde el dashboard de Render → Environment.

Acceso: visitá `/login` con usuario/contraseña o clave API. La sesión se mantiene 7 días.

La API está disponible en `/api/...` y `/api/v1/...` (mismos endpoints, versión estable).

## Backup

```powershell
python scripts/backup_db.py -o backups
```

En PostgreSQL requiere `pg_dump` instalado. Programá este comando diariamente (cron o Task Scheduler).

## Tests

```powershell
python -m pytest tests -v
```
