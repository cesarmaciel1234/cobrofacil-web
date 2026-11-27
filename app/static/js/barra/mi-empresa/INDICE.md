# Submódulo: Mi Empresa (Cobro Fácil)

### 1. Qué hace esta carpeta
Gestiona la ficha de marca comercial (Empresa) y su estructura operativa:
Sucursales (locales físicos con geocodificación), Terminales (cajas TPV) y Colaboradores (roles).

### 2. De dónde viene su entrada
- Menú lateral y barra de navegación (`BarraModulos.mi-empresa`).
- Eventos de usuario en la vista de Perfil y modales (`terminal.html`).
- Sesión del usuario autenticado vía `CrmBus.emit('getSessionUser')`.

### 3. Archivos y funciones
- `mi-empresa-perfil.js`: Manejo de datos de marca (`nombre`, `rubro`, `descripcion`, `logo_url`).
- `mi-empresa-sucursales.js`: Sucursales operativas con geocodificación Nominatim y mini-mapa Leaflet.
- `mi-empresa-terminales.js`: Cajas y PCs conectadas a la red, asignación y estado de sync.
- `mi-empresa-colaboradores.js`: Equipo de trabajo y asignación por sucursal o toda la red.

### 4. Hacia dónde sale
- Backend de Cobro Fácil (`/api/repartofacil/mi-empresa`, `/api/sucursales`, `/api/terminales`, `/api/usuarios`).
- Base de datos PostgreSQL compartida con Reparto Fácil Web.
