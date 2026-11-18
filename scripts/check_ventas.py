import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.database import get_db
import json

with get_db() as conn:
    rows = conn.execute('SELECT parte, cantidad, dia, columnas, filas FROM pos_base WHERE tabla = %s AND sucursal_id = 2 ORDER BY parte', ('ventas',)).fetchall()
    print('Total partes de ventas para sucursal 2:', len(rows))
    total_filas = 0
    fechas = []
    for r in rows:
        filas = json.loads(r['filas']) if 'filas' in r.keys() and r['filas'] else []
        columnas = json.loads(r['columnas']) if 'columnas' in r.keys() and r['columnas'] else []
        idx_fecha = -1
        for i, c in enumerate(columnas):
            if 'fecha' in str(c).lower():
                idx_fecha = i
                break
        total_filas += len(filas)
        for f in filas:
            if idx_fecha >= 0 and idx_fecha < len(f):
                fechas.append(str(f[idx_fecha]))
    fechas.sort(reverse=True)
    print('Total filas acumuladas:', total_filas)
    print('Top 10 fechas mas recientes:', fechas[:10])
    print('Top 10 fechas mas antiguas:', fechas[-10:])
