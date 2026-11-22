# Subcarpeta: Frontend y Recursos Estáticos (app/static/)

**Ubicación:** `app/static/`  
**Rol:** Recursos estáticos del CRM: hojas de estilo CSS, scripts JavaScript, manifiesto de PWA e iconos.

---

## 1. Qué hace
- Provee la interfaz visual moderna para la aplicación web.
- Soporta funcionamiento como Progressive Web App (instalable en Android, iOS, Windows).
- Permite la interacción en tiempo real y filtrado dinámico de datos.

---

## 2. Archivos Principales
- `enterprise.css`: Hoja de estilos principal, compatible con temas oscuro y claro, grids responsivos y tipografía.
- `manifest.json`: Manifiesto para instalación como aplicación web independiente.
- `sw.js`: Service worker para gestión de caché y soporte offline.
- `js/`: Scripts JavaScript de control del frontend.
- `css/perfil-empresa.css` y `vendor/leaflet.*`: interfaz y mapa del perfil.
  El mapa carga mosaicos de OpenStreetMap solo al abrirlo; el GPS se solicita
  únicamente al tocar «Usar mi ubicación» y no se envía la dirección a buscadores.

---

## 3. Control de Versiones de Caché
Para evitar que los usuarios trabajen con scripts desfasados en el navegador:
1. `sw.js`: La constante `CACHE_VERSION` debe incrementarse ante cambios significativos.
2. `terminal.html`: La etiqueta `<script src="/static/js/app.js?v=...">` debe llevar la versión actualizada.
