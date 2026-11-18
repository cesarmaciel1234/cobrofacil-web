import os
import psycopg2
from dotenv import load_dotenv

load_dotenv(r'C:\Users\cesar\OneDrive\Desktop\crm-frigorifico\.env')
conn = psycopg2.connect(os.getenv('DATABASE_URL'))
cur = conn.cursor()

# Get all tables in sucursal 1
cur.execute("SELECT DISTINCT tabla FROM pos_base WHERE sucursal_id = 1;")
tables = [r[0] for r in cur.fetchall()]
print(f"Tables remaining in sucursal 1: {len(tables)} -> {tables}")

for tabla in tables:
    cur.execute("SELECT COALESCE(MAX(parte), 0) FROM pos_base WHERE tabla = %s AND sucursal_id = 2;", (tabla,))
    max_s2 = cur.fetchone()[0]
    offset = max_s2 + 10

    cur.execute(
        """
        UPDATE pos_base
        SET sucursal_id = 2,
            sucursal_nombre = 'maciel - DESKTOP-7Q2Q4VD',
            parte = parte + %s
        WHERE tabla = %s AND sucursal_id = 1;
        """,
        (offset, tabla)
    )
    print(f"Table '{tabla}': Moved parts to sucursal 2 with offset +{offset}")

# Verify 0 rows in sucursal 1
cur.execute("SELECT count(*) FROM pos_base WHERE sucursal_id = 1;")
c1 = cur.fetchone()[0]
print(f"Rows remaining in sucursal 1: {c1}")

# Verify sucursales in pos_base
cur.execute("SELECT DISTINCT sucursal_id, sucursal_nombre, count(*) FROM pos_base GROUP BY sucursal_id, sucursal_nombre;")
print("Remaining groups in pos_base:", cur.fetchall())

conn.commit()
conn.close()
print("FAST CONSOLIDATION COMMITTED!")
