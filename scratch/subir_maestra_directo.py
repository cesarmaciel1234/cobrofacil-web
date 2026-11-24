"""
Sube la base de datos Maestra (MariaDB en 192.168.0.8 con 8.367 tickets)
directamente a Render PostgreSQL pos_base para Sucursal 1 (Alfaro 1964).
"""
import os
import sys
import json
import decimal
from datetime import datetime, date, timezone
import psycopg2
from dotenv import load_dotenv

# Conexión local a la Maestra
sys.path.append('c:/Users/cesar/OneDrive/Desktop/tpv pro 2026')
from database import db_manager

# Conexión a Render PostgreSQL
load_dotenv('c:/Users/cesar/OneDrive/Desktop/crm-frigorifico/.env')
render_url = os.environ.get('DATABASE_URL')
if not render_url:
    print("ERROR: DATABASE_URL no encontrada en .env")
    sys.exit(1)

print("Conectando a MariaDB Maestra (192.168.0.8)...")
conn_maria = db_manager.get_connection()
cur_m = conn_maria.cursor()

print("Conectando a Render PostgreSQL...")
conn_pg = psycopg2.connect(render_url)
cur_pg = conn_pg.cursor()

EMPRESA_ID = 1
SUCURSAL_ID = 1
SUCURSAL_NOMBRE = "Alfaro 1964"
CHUNK_SIZE = 500

SECRETOS = {"password", "passwd", "token", "secret", "api_key", "access_token", "refresh_token"}

def limpiar_valor(col, val):
    if col.lower() in SECRETOS:
        return None
    if val is None:
        return None
    if isinstance(val, (datetime, date)):
        return val.strftime("%Y-%m-%d %H:%M:%S") if isinstance(val, datetime) else val.strftime("%Y-%m-%d")
    if isinstance(val, decimal.Decimal):
        return float(val)
    if isinstance(val, bytes):
        return val.decode("utf-8", errors="ignore")
    return val

tables = [
    'ventas',
    'detalles_ventas',
    'productos',
    'clientes',
    'cuenta_corriente',
    'movimientos_caja',
    'categorias',
    'departamentos',
    'gastos',
    'mp_pagos',
    'carteleria_global'
]

print("\n--- LIMPIANDO pos_base y pos_novedad PARA SUCURSAL 1 Y RESTOS VIEJOS ---")
cur_pg.execute("DELETE FROM pos_base WHERE empresa_id = %s", (EMPRESA_ID,))
cur_pg.execute("DELETE FROM pos_novedad WHERE empresa_id = %s", (EMPRESA_ID,))
conn_pg.commit()
print("✓ pos_base y pos_novedad reseteadas limpias para comenzar carga maestra.")

ahora_utc = datetime.now(timezone.utc).isoformat()
hoy_str = datetime.now().strftime("%Y-%m-%d")

total_filas_global = 0

for tabla in tables:
    print(f"\nLeyendo tabla '{tabla}' desde MariaDB Maestra...")
    cur_m.execute(f"SHOW COLUMNS FROM {tabla}")
    raw_cols = cur_m.fetchall()
    columnas = [r['Field'] if isinstance(r, dict) else r[0] for r in raw_cols]
    
    cur_m.execute(f"SELECT * FROM {tabla}")
    filas_raw = cur_m.fetchall()
    
    filas_limpias = []
    for r in filas_raw:
        if isinstance(r, dict):
            fila = [limpiar_valor(col, r.get(col)) for col in columnas]
        else:
            fila = [limpiar_valor(columnas[i], r[i]) for i in range(len(columnas))]
        filas_limpias.append(fila)
        
    num_filas = len(filas_limpias)
    total_filas_global += num_filas
    print(f"  Filas leídas: {num_filas} filas")
    
    if num_filas == 0:
        # Insertar 1 parte vacía para que la tabla exista en pos_base
        cur_pg.execute(
            """
            INSERT INTO pos_base
            (empresa_id, sucursal_id, sucursal_nombre, tabla, parte, columnas, filas, cantidad, actualizado_en, dia)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                EMPRESA_ID, SUCURSAL_ID, SUCURSAL_NOMBRE, tabla, 1,
                json.dumps(columnas), json.dumps([]), 0, ahora_utc, hoy_str
            )
        )
        continue
        
    # Dividir en chunks de CHUNK_SIZE
    partes = (num_filas + CHUNK_SIZE - 1) // CHUNK_SIZE
    for p_idx in range(partes):
        chunk = filas_limpias[p_idx * CHUNK_SIZE : (p_idx + 1) * CHUNK_SIZE]
        cur_pg.execute(
            """
            INSERT INTO pos_base
            (empresa_id, sucursal_id, sucursal_nombre, tabla, parte, columnas, filas, cantidad, actualizado_en, dia)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                EMPRESA_ID, SUCURSAL_ID, SUCURSAL_NOMBRE, tabla, p_idx + 1,
                json.dumps(columnas), json.dumps(chunk), len(chunk), ahora_utc, hoy_str
            )
        )
    print(f"  ✓ Subida en {partes} partes a Render PostgreSQL.")

conn_pg.commit()

# Verificar estado final
cur_pg.execute("SELECT tabla, count(*), sum(cantidad) FROM pos_base WHERE empresa_id = %s GROUP BY tabla", (EMPRESA_ID,))
print("\n=== RESUMEN EN RENDER POSTGRESQL ===")
for r in cur_pg.fetchall():
    print(f"Tabla: {r[0]:<20} Partes: {r[1]:<5} Filas: {r[2]}")

print(f"\n✓ TOTAL FILAS SUBIDAS: {total_filas_global}")
print("✓ ¡Subida Maestra completada con éxito directo a la Nube!")

cur_pg.close()
conn_pg.close()
conn_maria.close()
