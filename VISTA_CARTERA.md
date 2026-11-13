# Vista de Cartera de Clientes

## 📋 Descripción

Nueva vista de gestión de cartera de clientes inspirada en "Cobro Fácil POS", diseñada para trabajar en la web (Render) con un diseño limpio y profesional.

## 🎯 Características

### Métricas en Tiempo Real
- **Cartera en la Calle**: Total de deuda activa de todos los clientes
- **Cuentas Activas**: Cantidad de clientes con saldo > 0
- **Cartera en Riesgo**: Deuda de clientes en estado crítico o atención
- **Cobros del Mes**: Total de cobros en los últimos 30 días

### Filtros Avanzados
- **Todos**: Muestra todos los clientes registrados
- **Con saldo**: Solo clientes con deuda pendiente
- **Al día**: Clientes sin deuda o con saldo a favor
- **Saldo a favor**: Clientes con crédito positivo
- **Express**: Clientes scoring A con deuda baja (< $50,000)
- **Críticos**: Clientes en estado crítico o atención
- **30+ días**: Clientes sin pago hace más de 30 días
- **60+ días**: Clientes sin pago hace más de 60 días
- **90+ días**: Clientes sin pago hace más de 90 días

### Búsqueda
- Búsqueda por nombre o DNI/CUIT en tiempo real

### Tabla de Clientes
Columnas:
- ID
- DNI/CUIT
- Nombre
- Tipo (Regular - por ahora fijo)
- Estado (Al día, Regular, Atención, Crítico)
- Deuda actual (con color verde/rojo según signo)
- Mantenimiento (techo de deuda)
- Días desde último pago
- Tarifa (5% - por ahora fijo)
- Acciones (Abonar, Menú detalle)

## 🚀 Cómo Usar

### Acceder a la Vista

```bash
# Iniciar el servidor
python run.py

# Abrir en el navegador
http://localhost:5005/cartera
```

En producción (Render):
```
https://crm-frigorifico.onrender.com/cartera
```

### Funcionalidades

#### Ver Todos los Clientes
Por defecto, la vista muestra todos los clientes registrados.

#### Filtrar por Categoría
Click en las pestañas de filtros para ver solo clientes que cumplan con el criterio:
- Click en "Con saldo" para ver solo deudores
- Click en "Críticos" para priorizar cobranzas urgentes
- Click en "60+ días" para ver clientes morosos

#### Buscar Cliente
Escribir en el campo de búsqueda para filtrar por nombre o DNI en tiempo real.

#### Abonar Cliente
Click en el botón "Abonar" de un cliente para registrar un pago (funcionalidad placeholder - pendiente de implementar modal).

#### Ver Detalle
Click en el botón "⋮" para ver más opciones del cliente (funcionalidad placeholder - pendiente de implementar drawer/modal).

## 🎨 Diseño

### Colores y Estilos
- **Fondo claro**: `#f8fafc` (azul grisáceo muy claro)
- **Tarjetas blancas**: `#ffffff` con sombra suave
- **Primary**: `#2563eb` (azul corporativo)
- **Success**: `#10b981` (verde para estados positivos)
- **Warning**: `#f59e0b` (amarillo para alertas)
- **Danger**: `#ef4444` (rojo para estados críticos)

### Responsive
- En desktop: 4 columnas de métricas, tabla completa
- En móvil: 1 columna de métricas, tabla adaptada con scroll horizontal

## 🔧 Personalización

### Modificar Colores
Editar las variables CSS en `templates/cartera_clientes.html`:

```css
:root {
    --primary: #2563eb;      /* Color principal */
    --success: #10b981;      /* Estados positivos */
    --warning: #f59e0b;      /* Alertas */
    --danger: #ef4444;       /* Estados críticos */
}
```

### Agregar Nuevos Filtros
Agregar botón en el HTML:

```html
<button class="filter-tab" data-filter="nuevo_filtro">
    Nuevo Filtro <span class="count" id="countNuevoFiltro">0</span>
</button>
```

Agregar lógica en JavaScript:

```javascript
case 'nuevo_filtro':
    matchesCategory = /* tu lógica aquí */;
    break;
```

### Modificar Columnas de Tabla
Editar el `<thead>` en el HTML y el render en JavaScript:

```javascript
tbody.innerHTML = clients.map(client => {
    return `
        <tr>
            <!-- tus columnas aquí -->
        </tr>
    `;
}).join('');
```

## 📊 API Endpoints Utilizados

La vista consume el siguiente endpoint existente:

```
GET /api/clientes
```

Respuesta:
```json
{
  "clientes": [
    {
      "id": 1,
      "nombre": "Juan Pérez",
      "cuit": "20-12345678-9",
      "scoring": "A",
      "techo_deuda": 500000,
      "saldo_actual": 15000,
      "fecha_ultimo_pago": "2026-01-15"
    }
  ]
}
```

## 🔮 Próximas Mejoras (Pendientes)

1. **Modal de Pago**: Implementar modal para registrar pagos desde la vista
2. **Drawer de Detalle**: Implementar panel lateral con historial del cliente
3. **Exportar a Excel**: Botón para exportar tabla a CSV/Excel
4. **Paginación**: Agregar paginación para grandes volúmenes de clientes
5. **Ordenamiento**: Permitir ordenar por columnas (deuda, días, nombre)
6. **Gráficos**: Agregar gráfico de evolución de cartera
7. **Notificaciones**: Alertas de clientes que alcanzan límite de riesgo
8. **Edición rápida**: Editar scoring/techo desde la vista sin abrir detalle

## 🐛 Troubleshooting

### Los clientes no cargan
- Verificar que el servidor esté corriendo
- Revisar consola del navegador (F12) por errores de API
- Verificar endpoint `/api/clientes` funciona

### Los filtros no funcionan
- Verificar que JavaScript esté activo
- Revisar consola por errores en la función `filterClients()`

### Diseño se ve roto
- Verificar que el archivo CSS esté cargando
- Limpiar caché del navegador (Ctrl+F5)

## 📝 Notas Técnicas

- **Framework**: HTML + Vanilla JavaScript (sin frameworks JS)
- **CSS**: Custom CSS sin dependencias externas
- **API**: REST endpoints existentes del CRM
- **Responsive**: CSS Grid y Flexbox
- **Compatibilidad**: Navegadores modernos (Chrome, Firefox, Safari, Edge)

## 🎯 Inspiración

Esta vista está inspirada en la interfaz de "Cobro Fácil POS" pero adaptada al diseño del CRM Frigorífico con estilo más corporativo y limpio.
