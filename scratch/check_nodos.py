import sys
import os
sys.path.insert(0, os.path.abspath("."))
from app.database import get_db

def run():
    with get_db(1) as conn:
        print("Nodos en sync_nodos:")
        try:
            nodos = conn.execute("SELECT * FROM sync_nodos").fetchall()
            for n in nodos:
                print(f"  {dict(n)}")
        except Exception as e:
            print(f"  Error sync_nodos: {e}")

        # Si existe algún nodo alfaro, lo limpiamos
        try:
            conn.execute("DELETE FROM sync_nodos WHERE nombre ILIKE '%alfaro%' OR sucursal_id = 1")
            conn.commit()
            print("Limpieza de sync_nodos completada.")
        except Exception as e:
            print(f"  No se pudo borrar o no existe columna: {e}")

if __name__ == '__main__':
    run()
