# Leyes del Proyecto CRM Frigorífico (Instrucciones para IA y Desarrolladores)

La forma de modularizar y documentar el proyecto está en `modularizacion.md`, en la raíz.

Al mejorar o editar un módulo, aplicar la regla piramidal en el mismo cambio: la rama en su carpeta, `plano.md` donde arranca la rama (Frente y Fondo, de dónde viene y a dónde va), y `README.md` en cada subcarpeta con qué hace, qué función cumple y cómo funciona.

No crear `regla_*.md` ni notas sueltas en la raíz. Antes de editar cualquier archivo, leer el `plano.md` de la rama y el `README.md` de la subcarpeta.

---

## 1. Proyectos Separados (Inviolable)
- `crm-frigorifico` y `tpv pro 2026` son **proyectos independientes**.
- El CRM es el centro de control en la nube (Render + Neon PostgreSQL) que consolida y visualiza las operaciones de todas las sucursales.
- Cada tienda física corre su propio servidor TPV local (`tpv pro 2026`). El cerebro de cobro, ventas y caja del TPV **no se modifica desde este proyecto**.
- La comunicación se realiza exclusivamente a través de los endpoints de sincronización y réplica (`/api/sync/push`, `/api/sync/pull`, `/api/pos/nube/novedades`, etc.).

---

## 2. Arquitectura Multi-Tenant (Neon PostgreSQL)
- **Aislamiento por Esquema:** Cada empresa tiene su propio esquema en PostgreSQL (`empresa_1`, `empresa_2`, etc.). La empresa por defecto en sesión activa suele ser `empresa_id = 2` ("Maciel").
- **Conexiones Seguras:** Usar siempre el pool de conexiones thread-safe (`_get_pg_pool()` en `app/database.py`) con `keepalives` configurados.
- **Tolerancia Offline (SQLite):** Si no hay `DATABASE_URL` (en pruebas locales o CI), el sistema recurre de forma transparente a SQLite (`crm.db`). Las migraciones deben mantener compatibilidad dual SQLite / PostgreSQL.

---

## 3. Caché y Verdad de Datos
- **Caché corta:** `_CACHE_TTL` en `app/services/pos_base.py` se mantiene en **5 segundos**. No aumentarlo a valores altos para evitar que el usuario vea datos desfasados entre sucursales.
- **Identidad de clientes:** La unificación de clientes entre sucursales se rige por DNI/CUIT. Si no hay DNI, se unifica por nombre coincidente entre sucursales reales sin duplicar saldo copiado.

---

## 4. Pruebas de CI y Calidad
- Todos los tests (`python -m pytest tests/ -v`) deben pasar en su totalidad (117 tests).
- Las operaciones financieras (`operaciones_financieras`) deben soportar `sync_mode=True` tolerando registros de réplica con campos opcionales sin romper las validaciones estrictas del formulario web manual.
