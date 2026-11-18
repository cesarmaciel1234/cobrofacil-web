import os
import psycopg2
from dotenv import load_dotenv

load_dotenv(r'C:\Users\cesar\OneDrive\Desktop\crm-frigorifico\.env')
conn = psycopg2.connect(os.getenv('DATABASE_URL'))
cur = conn.cursor()

cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'pos_base' AND column_name = 'empresa_id'")
if not cur.fetchone():
    cur.execute('ALTER TABLE pos_base ADD COLUMN empresa_id INTEGER NOT NULL DEFAULT 1')
    print('Added empresa_id to pos_base')
else:
    print('empresa_id already exists in pos_base')

cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'pos_novedad' AND column_name = 'empresa_id'")
if not cur.fetchone():
    cur.execute('ALTER TABLE pos_novedad ADD COLUMN empresa_id INTEGER NOT NULL DEFAULT 1')
    print('Added empresa_id to pos_novedad')
else:
    print('empresa_id already exists in pos_novedad')

cur.execute('DROP INDEX IF EXISTS idx_pos_base_parte')
cur.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_base_parte ON pos_base(empresa_id, COALESCE(sucursal_id, 0), tabla, parte)')
cur.execute('CREATE INDEX IF NOT EXISTS idx_pos_base_empresa_tabla ON pos_base(empresa_id, tabla, sucursal_id)')
cur.execute('CREATE INDEX IF NOT EXISTS idx_pos_base_empresa_dia ON pos_base(empresa_id, tabla, dia)')
cur.execute('CREATE INDEX IF NOT EXISTS idx_pos_novedad_empresa ON pos_novedad(empresa_id, tabla, actualizado_en)')

conn.commit()
print('Migration successful!')

cur.execute('SELECT empresa_id, count(*) FROM pos_base GROUP BY empresa_id')
print('POS_BASE POR EMPRESA:', cur.fetchall())

conn.close()
