"""Puente de la última publicación. La clave de GitHub no sale del servidor."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

REPO = "cesarmaciel1234/cobrofacil-releases"
ARCHIVO = "CobroFacil_POS_Release.zip"
_API = f"https://api.github.com/repos/{REPO}/releases/latest"


def clave() -> str:
    for nombre in ("GITHUB_TOKEN", "COBROFACIL_GITHUB_TOKEN", "GITHUB_UPDATE_TOKEN"):
        valor = str(os.environ.get(nombre) or "").strip()
        if valor:
            return valor
    return ""


def _cabeceras(acepta: str) -> dict:
    cabecera = {
        "User-Agent": "CobroFacil-Puente",
        "Accept": acepta,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = clave()
    if token:
        cabecera["Authorization"] = f"Bearer {token}"
    return cabecera


def _elegir(publicacion: dict) -> dict | None:
    for asset in publicacion.get("assets") or []:
        if asset.get("name") == ARCHIVO and asset.get("url"):
            return asset
    return None


def ultima_publicacion(timeout: float = 20) -> dict:
    pedido = urllib.request.Request(_API, headers=_cabeceras("application/vnd.github+json"))
    with urllib.request.urlopen(pedido, timeout=timeout) as respuesta:
        dato = json.loads(respuesta.read().decode("utf-8"))
    asset = _elegir(dato) if isinstance(dato, dict) else None
    if not asset:
        raise LookupError("sin archivo")
    return {
        "tag": str(dato.get("tag_name") or ""),
        "nombre": str(dato.get("name") or dato.get("tag_name") or ""),
        "archivo": ARCHIVO,
        "asset_url": str(asset["url"]),
    }


class _SinSeguir(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def enlace_temporal(timeout: float = 20) -> str:
    """Enlace de un solo uso. El zip no pasa por este servidor."""
    publicacion = ultima_publicacion(timeout)
    if not clave():
        return f"https://github.com/{REPO}/releases/latest/download/{ARCHIVO}"
    pedido = urllib.request.Request(
        publicacion["asset_url"],
        headers=_cabeceras("application/octet-stream"),
    )
    abridor = urllib.request.build_opener(_SinSeguir)
    try:
        abridor.open(pedido, timeout=timeout)
    except urllib.error.HTTPError as exc:
        if exc.code in (301, 302, 303, 307, 308):
            destino = exc.headers.get("Location")
            if destino:
                return destino
        raise
    raise LookupError("sin enlace")
