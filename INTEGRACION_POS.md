# Integración con Servidor POS (TPV Pro 2026)

## 📋 Resumen

Este documento describe cómo el CRM Frigorífico se integra con el servidor POS TPV Pro 2026 para funcionar como un sistema secundario de alto nivel para gestión financiera, clientes y proveedores.

## 🎯 Objetivo

El CRM funciona como una capa superior al POS:
- **POS**: Gestión diaria de ventas, cobros, inventario
- **CRM**: Análisis financiero, gestión de deudas, remitos, reportes ejecutivos

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│                   TPV Pro 2026 (Servidor)              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Clientes │  │Ventas   │  │Inventario│              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       │            │            │                         │
│       └────────────┴────────────┘                         │
│                    │ HTTP API                             │
└────────────────────┼─────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────┐
│               CRM Frigorífico (Este Proyecto)            │
│  ┌─────────────────────────────────────────────────┐    │
│  │         Módulo de Integración POS                │    │
│  │  ┌──────────────┐  ┌──────────────┐              │    │
│  │  │Transformación│  │Sincronización│              │    │
│  │  │  POS → CRM   │  │ Bidireccional│              │    │
│  │  └──────────────┘  └──────────────┘              │    │
│  └─────────────────────────────────────────────────┘    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Finanzas │  │ Remitos  │  │ Reportes │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────┘
```

## 📊 Flujo de Datos

### Clientes

1. **POS → CRM**: El POS envía clientes a través de API
2. **Transformación**: El CRM calcula scoring automático basado en deuda/límite
3. **Persistencia**: Clientes se guardan en tabla `clientes` del CRM
4. **CRM → POS**: El CRM puede exportar clientes actualizados al POS

### Proveedores

1. **POS → CRM**: El POS envía proveedores
2. **Transformación**: Se guardan como `entidades_bancarias` en el CRM
3. **CRM → POS**: Exportación en formato compatible con POS

## 🔧 Configuración

### A través de la API

```python
import requests

# Configurar conexión
response = requests.put(
    "http://localhost:5005/api/pos/config",
    json={
        "server_url": "http://192.168.1.100:5000",
        "api_key": "tu_clave_api_segura",
        "sync_interval_minutes": 30,
        "auto_sync": True
    }
)
print(response.json())
```

### Variables de Configuración

| Variable | Tipo | Default | Descripción |
|----------|------|---------|-------------|
| `server_url` | string | "" | URL del servidor POS |
| `api_key` | string | "" | Clave API para autenticación |
| `sync_interval_minutes` | int | 30 | Intervalo de sincronización automática |
| `auto_sync` | bool | false | Activar sincronización automática |

## 📡 Endpoints API

### Sincronización de Clientes

#### Individual

```http
POST /api/pos/clientes
Content-Type: application/json

{
  "nombre": "Juan Pérez",
  "telefono": "11-1234-5678",
  "direccion": "Calle Falsa 123",
  "cuit": "20-12345678-9",
  "email": "juan@email.com",
  "saldo": 15000.50,
  "limite_credito": 500000.0
}
```

**Respuesta exitosa:**
```json
{
  "ok": true,
  "accion": "creado",
  "cliente_id": 123,
  "nombre": "Juan Pérez"
}
```

#### Lote

```http
POST /api/pos/clientes/lote
Content-Type: application/json

{
  "clientes": [
    { "nombre": "Juan Pérez", ... },
    { "nombre": "María López", ... }
  ]
}
```

**Respuesta:**
```json
{
  "ok": true,
  "total": 2,
  "creados": 1,
  "actualizados": 1,
  "errores": []
}
```

### Sincronización de Proveedores

#### Individual

```http
POST /api/pos/proveedores
Content-Type: application/json

{
  "nombre": "Frigorífico XYZ",
  "cuit": "30-98765432-1",
  "telefono": "11-9876-5432",
  "limite_credito": 1000000.0
}
```

#### Lote

```http
POST /api/pos/proveedores/lote
Content-Type: application/json

{
  "proveedores": [
    { "nombre": "Frigorífico XYZ", ... },
    { "nombre": "Carnes ABC", ... }
  ]
}
```

### Exportación

```http
GET /api/pos/clientes
GET /api/pos/proveedores
```

### Monitoreo

```http
GET /api/pos/sync/logs?limit=50&offset=0
GET /api/pos/sync/status
```

## 🔄 Transformación de Datos

### Cliente POS → Cliente CRM

| Campo POS | Campo CRM | Transformación |
|-----------|-----------|----------------|
| `nombre` | `nombre` | Directo |
| `telefono` | `telefono` | Normalización |
| `direccion` | `direccion` | Normalización |
| `cuit` | `cuit` | Directo |
| `email` | `email` | Directo |
| `saldo` | `saldo_actual` | Directo |
| `limite_credito` | `techo_deuda` | Directo |
| - | `scoring` | Calculado: A/B/C/D según ratio deuda/límite |
| - | `saldo_inicial` | 0.0 (default) |

### Proveedor POS → Entidad Bancaria CRM

| Campo POS | Campo CRM | Transformación |
|-----------|-----------|----------------|
| `nombre` | `nombre` | Directo |
| `limite_credito` | `limite` | Directo |

## 📝 Logging

Todas las sincronizaciones se registran en `pos_sync_log`:

```sql
SELECT * FROM pos_sync_log ORDER BY id DESC LIMIT 10;
```

Campos:
- `sync_type`: Tipo de sincronización (clientes, proveedores, ventas, full)
- `direction`: Dirección (push, pull)
- `status`: Estado (success, error, partial)
- `records_processed`: Total de registros procesados
- `records_success`: Registros exitosos
- `records_error`: Registros con error
- `error_message`: Mensaje de error (si aplica)
- `started_at`: Fecha/hora de inicio
- `completed_at`: Fecha/hora de finalización

## 🚀 Despliegue como Ejecutable

### Pasos

1. **Instalar PyInstaller:**
   ```bash
   pip install pyinstaller
   ```

2. **Construir ejecutable:**
   ```bash
   python build_exe.py
   ```

3. **Distribuir:**
   - El ejecutable se genera en `dist/CRM-Frigorifico.exe`
   - Copiar junto con la carpeta de base de datos
   - Ejecutar en la máquina destino

### Configuración en Ejecutable

Crear archivo `.env` junto al ejecutable:

```env
SECRET_KEY=tu_clave_secreta_aqui
MT_API_KEY=tu_clave_api_aqui
DATABASE_URL=sqlite:///master_total_empresa_1.db
```

## ⚠️ Consideraciones Importantes

1. **No modificar el servidor POS**: Esta integración es solo en el lado CRM
2. **IDempotencia**: La sincronización es idempotente - se puede ejecutar múltiples veces
3. **Conflictos**: En caso de conflictos, se usa LWW (Last Write Wins) por timestamp
4. **Offline**: El CRM funciona offline y sincroniza cuando hay conexión
5. **Seguridad**: Usar HTTPS en producción y proteger la API key

## 🔍 Troubleshooting

### Errores Comunes

**Error: "cliente sin nombre"**
- Verificar que el payload incluye el campo `nombre`

**Error: "techo_deuda debe ser mayor o igual a 0"**
- Verificar que `limite_credito` no sea negativo

**Error: "Ya existe otro cliente con este nombre"**
- El CRM usa nombre como único. Verificar duplicados.

**Sincronización parcial**
- Revisar logs: `GET /api/pos/sync/logs`
- Ver errores específicos en la respuesta

### Debug Mode

Activar logging detallado en `.env`:

```env
FLASK_DEBUG=1
LOG_LEVEL=DEBUG
```

## 📞 Soporte

Para preguntas o problemas:
- Revisar logs en `pos_sync_log`
- Consultar `README.md` para configuración general
- Verificar conectividad con servidor POS
