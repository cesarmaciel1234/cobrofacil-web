# Subcarpeta: Plantillas HTML / Jinja2 (app/templates/)

**Ubicación:** `app/templates/`  
**Rol:** Vistas HTML del servidor renderizadas por Flask con Jinja2.

---

## 1. Qué hace
- Provee la estructura base del DOM para las diferentes pantallas del CRM.
- Inyecta variables de sesión del servidor (`sessionUser`, `empresa_id`) antes de que JavaScript tome el control.

---

## 2. Plantillas Principales
- `terminal.html`: Plantilla principal del sistema. Aloja la SPA, el contenedor dinámico `#panel-contenido`, la barra de navegación superior y el modal de selección de sucursales.
- `login.html`: Pantalla de inicio de sesión con selección de empresa y credenciales.
- `cartera_clientes.html`: Vista de libro de cuentas corrientes de clientes.
- `pos.html`: Consola de punto de venta web alternativa.
- `venta.html`: Formulario de creación de transacciones financieras y remitos.

---

## 3. Parámetro de Cache-Busting
En `terminal.html`, cada importación de script o estilo debe llevar el query param de versión:
```html
<link rel="stylesheet" href="/static/enterprise.css?v=4.57">
<script src="/static/js/app.js?v=4.57"></script>
```
Esto asegura que los cambios aplicados en producción se carguen de inmediato sin quedar atrapados en la caché del navegador.
