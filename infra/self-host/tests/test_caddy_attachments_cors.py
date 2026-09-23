"""CORS am Garage-Prefix /pulse-attachments — der Spiegel-Bildversand-Fall.

Der Vorfall (2026-09-23, pulse.atrium-sinsheim.de): die App läuft auf dem
Cloud-Origin (howispulse.com) und zeigt Spiegel-Kanäle einer Self-Host-
Instanz. Vorschau-GETs und der Anhang-PUT gehen cross-origin direkt auf
<self-host>/pulse-attachments/… — Garage antwortet aber ohne CORS-Header
(anders als die FastAPI-Services bedient der Storage kein eigenes CORS),
und ein Preflight-OPTIONS würde von Garage mit 403/404 quittiert. Der
Browser bricht den Upload deshalb ab, BEVOR irgendein Byte fließt.

Dieser Test sichert die drei Bestandteile des Fixes gegen stillen Verfall:

1. Preflight wird am Proxy beantwortet (`respond … 204`), nicht an Garage
   weitergereicht — Garage kennt kein unsigniertes OPTIONS.
2. Die Allow-Header stehen IM handle-Block (nur dort — global würden sie
   den FastAPI-Services ihre eigenen CORS-Header verdoppeln, s. Vorlagen-
   Kommentar „CORS: NICHT hier setzen").
3. Garage-eigene Access-Control-Header werden gelöscht (`header_down -…`),
   damit eine evtl. Bucket-CORS-Regel des Betreibers keine DOPPELTEN
   Allow-Origin-Werte produziert — zwei Werte verwirft der Browser komplett.

Geprüft wird die Vorlage selbst, nicht ein Renderprodukt: Der Block ist
reines Static-Text-Konfigurat, enthält keine Platzhalter, und die sed-
Ersetzungen aus 09-init-caddy.sh (Hostname/Zertifikat) tangieren ihn
nicht. Ein Versehen beim Editieren der Vorlage fällt hier sofort auf.
"""

from __future__ import annotations

import pathlib
import re

TEMPLATE = (
    pathlib.Path(__file__).resolve().parents[1] / "s6" / "etc" / "caddy" / "Caddyfile.template"
)


def _attachments_handle() -> str:
    """Der Text des `handle /pulse-attachments/*`-Blocks (geschweifte Klammern gezählt)."""
    zeilen = TEMPLATE.read_text(encoding="utf-8").split("\n")
    start = next(i for i, z in enumerate(zeilen) if "handle /pulse-attachments/* {" in z)
    tiefe = 0
    for i in range(start, len(zeilen)):
        tiefe += zeilen[i].count("{") - zeilen[i].count("}")
        if tiefe == 0:
            return "\n".join(zeilen[start : i + 1])
    raise AssertionError("handle-Block nicht geschlossen?")


def test_preflight_wird_am_proxy_beantwortet() -> None:
    handle = _attachments_handle()
    # respond muss VOR reverse_proxy im Block stehen — danach wäre es
    # unerreichbar (reverse_proxy schließt die Anfrage ab).
    assert "@preflight method OPTIONS" in handle
    assert re.search(r"respond @preflight 204", handle)
    assert handle.index("respond @preflight") < handle.index("reverse_proxy")


def test_cors_header_nur_im_attachments_handle() -> None:
    handle = _attachments_handle()
    for kopf in (
        "Access-Control-Allow-Origin",
        "Access-Control-Allow-Methods",
        "Access-Control-Allow-Headers",
    ):
        assert kopf in handle, f"{kopf} fehlt im /pulse-attachments-Handle"
    # Global (außerhalb des Handles) dürfen sie NICHT stehen — sonst
    # verdoppeln sie das CORS der FastAPI-Services. Kommentarzeilen zählen
    # nicht (der Vorspann oben erklärt die Regel und nennt die Kopfnamen).
    gesamt = TEMPLATE.read_text(encoding="utf-8")
    außerhalb = "\n".join(
        z for z in gesamt.replace(handle, "").split("\n") if not z.lstrip().startswith("#")
    )
    assert "Access-Control-Allow-Origin" not in außerhalb


def test_garage_eigene_cors_header_werden_geloescht() -> None:
    handle = _attachments_handle()
    assert "header_down -Access-Control-Allow-Origin" in handle
    assert "header_down -Access-Control-Allow-Methods" in handle
    assert "header_down -Access-Control-Allow-Headers" in handle
