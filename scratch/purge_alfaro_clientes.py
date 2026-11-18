import sys
import os
sys.path.insert(0, os.path.abspath("."))
from app.database import get_db

def run():
    with get_db(1) as conn:
        print("Borrando clientes de alfaro 1954...")
        cur = conn.execute("DELETE FROM clientes WHERE sucursal_id = 1 OR sucursal_nombre ILIKE '%alfaro%'")
        print(f"Borrados de clientes.")
        conn.commit()

    with get_db(1) as conn:
        print("\nVerificación final de tablas en empresa 1 (Maciel):")
        tablas = ['clientes', 'cuenta_corriente', 'pos_base', 'pos_novedad', 'gastos', 'movimientos_caja', 'ventas_pos']
        for t in tablas:
            try:
                r1 = conn.execute(f"SELECT COUNT(1) as c FROM {t} WHERE sucursal_id = 1").fetchone()
                c1 = r1['c'] if r1 else 0
            except Exception as e:
                c1 = f"error: {e}"
            
            try:
                r_tot = conn.execute(f"SELECT COUNT(1) as c FROM {t}").fetchone()
                c_tot = r_tot['c'] if r_tot else 0
            except Exception as e:
                c_tot = f"error: {e}"

            print(f"  - {t}: total={c_tot}, con sucursal_id=1 (alfaro)={c1}")

        # Listar las sucursales restantes en tabla clientes
        res = conn.execute("SELECT sucursal_id, sucursal_nombre, COUNT(1) as c FROM clientes GROUP BY sucursal_id, sucursal_nombre").fetchall()
        print("\nSucursales restantes en tabla clientes (empresa 1):")
        for row in res:
            print(f"   {dict(row)}")

if __name__ == '__main__':
    run()
