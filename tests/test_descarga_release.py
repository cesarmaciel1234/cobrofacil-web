"""El puente entrega la última publicación sin mostrar la clave."""
from app.services.descarga_release import _elegir


def test_elige_el_zip_de_la_publicacion():
    asset = _elegir({
        "assets": [
            {"name": "otro.txt", "url": "https://api.github.com/otro"},
            {"name": "CobroFacil_POS_Release.zip", "url": "https://api.github.com/zip"},
        ]
    })
    assert asset["url"] == "https://api.github.com/zip"


def test_descarga_redirige_al_enlace_temporal(client, monkeypatch):
    monkeypatch.setattr(
        "app.services.descarga_release.enlace_temporal",
        lambda timeout=20: "https://objects.example/ultima.zip",
    )
    respuesta = client.get("/descarga", follow_redirects=False)
    assert respuesta.status_code == 302
    assert respuesta.headers["Location"] == "https://objects.example/ultima.zip"
    assert "Bearer" not in respuesta.headers["Location"]


def test_la_version_no_incluye_un_enlace(client, monkeypatch):
    monkeypatch.setattr(
        "app.services.descarga_release.ultima_publicacion",
        lambda timeout=20: {
            "tag": "v9",
            "nombre": "CobroFacil POS v9",
            "archivo": "CobroFacil_POS_Release.zip",
            "asset_url": "https://api.github.com/secreto",
        },
    )
    dato = client.get("/descarga/version").get_json()
    assert dato["ok"] is True
    assert dato["tag"] == "v9"
    assert dato["app_version"] == "v9"
    assert dato["descarga"].endswith("/descarga")
    assert "asset_url" not in dato
    assert "secreto" not in respuesta_texto(dato)
    assert "github.com" not in dato["descarga"]


def respuesta_texto(dato) -> str:
    return str(dato)
