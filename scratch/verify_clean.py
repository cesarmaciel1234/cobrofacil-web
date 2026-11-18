import sys
import os
sys.path.insert(0, os.path.abspath("."))
from app.database import get_db

def run():
    with get_db(1) as conn:
        print("Tablas en el schema:")
        res = conn.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()").fetchall()
        for r in res:
            print(f"  - {r['table_name']}")

        print("\nSucursales en tabla clientes:")
        res_cli = conn.execute("SELECT sucursal_id, sucursal_nombre, COUNT(1) as c FROM clientes GROUP BY sucursal_id, sucursal_nombre").fetchall()
        for r in res_cli:
            print(f"  {dict(r)}")

        print("\nRegistros en pos_base por sucursal_id:")
        res_pb = conn.execute("SELECT sucursal_id, COUNT(1) as c FROM pos_base GROUP BY sucursal_id").fetchall()
        for r in res_pb:
            print(f"  {dict(r)}")

        print("\nRegistros en pos_novedad por sucursal_id:")
        res_pn = conn.execute("SELECT sucursal_id, COUNT(1) as c FROM pos_novedad GROUP BY sucursal_id").fetchall()
        for r in res_pn:
            print(f"  {dict(r)}")

if __name__ == '__main__':
    run()
