import sys
import os
sys.path.insert(0, os.path.abspath("."))
from app.database import get_db

def check_crm_ventas():
    with get_db(1) as conn:
        print("Ventas en CRM para fechas de septiembre:")
        try:
            res = conn.execute("""
                SELECT DATE(fecha) as dia, count(*) as c, sum(total) as tot
                FROM ventas_pos
                WHERE fecha >= '2026-08-30' AND fecha <= '2026-09-15'
                GROUP BY DATE(fecha)
                ORDER BY dia
            """).fetchall()
            for r in res:
                print("  ventas_pos:", dict(r))
        except Exception as e:
            print("  ventas_pos error:", e)

if __name__ == '__main__':
    check_crm_ventas()
