import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.pos_jefe import panel

for alcance in ["hoy", "semana", "mes", "todas", "dia"]:
    f = {"alcance": alcance, "metodo": "TODOS", "texto": ""}
    res = panel("ticket", filtro=f)
    tickets = res.get("tickets", [])
    fechas = [t.get("fecha") for t in tickets[:3]]
    print(f"Alcance: {alcance:7} | Count: {len(tickets)} | Total: {res.get('total')} | Fechas: {fechas}")
