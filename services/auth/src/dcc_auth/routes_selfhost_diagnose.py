"""``POST /selfhost/diagnose/{instance_id}`` — die Prüfung von aussen.

Bis 2026-08 sah niemand je von aussen auf einen Self-Host: der Client meldete
jeden Fehlschlag als „nicht erreichbar", und die Cloud kannte den Hostnamen,
schaute ihn aber nie an. Diese Route geht die Kette ab und liefert je Glied
einen eigenen Befund.

Wer darf fragen
---------------
* der **Besitzer** der Instanz (Sitzungs-Cookie) — der Weg für „Verbindung
  prüfen" in der App;
* die **Instanz selbst** (``client_id`` + ``client_secret``) — der Weg für den
  Installer, der am Ende seines Laufs wissen will, ob der Server von draussen
  ankommt. Fremde bekommen 404 statt 403: die blosse Existenz einer Instanz
  ist nichts, was ein Unbeteiligter erfahren muss (Muster Bootstrap-Mint).

Kein Umleiten, kein Tunnel
--------------------------
Die Prüfung sagt, was zu tun ist, und tut es nicht selbst. Ein Self-Host bleibt
isoliert — das ist die Zusage und nicht ein technischer Zufall.
"""

from __future__ import annotations

import asyncio
import hmac
from typing import Annotated
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.diagnose_texte import SCHRITTE, container_name, erklaerung, sprache_aus_header, titel
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.routes import _check_rate
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.security import verify_password
from dcc_auth.selfhost_probe import Schritt, pruefe_dns, pruefe_tcp, pruefe_tls
from dcc_auth.selfhost_probe_dienst import (
    Ziel,
    pruefe_cors,
    pruefe_health,
    pruefe_identitaet,
    pruefe_stun,
    pruefe_websocket,
)

router = APIRouter(tags=["self-host"], dependencies=[Depends(_require_cloud)])

# Deckel über die ganze Prüfung. Die Einzelschritte haben eigene Fristen; hier
# steht, wie lange ein Aufrufer insgesamt wartet — ein hängender Schritt darf
# den Aufruf nicht offen lassen.
GESAMTFRIST_S = 40.0

#: RTMPS-Ingest des HQ-Streamings — TCP, geht am HTTP-Proxy vorbei.
RTMPS_PORT = 1936


class SchrittAus(BaseModel):
    schritt: str
    ok: bool
    befund: str
    einzelheit: str | None = None
    #: Überschrift in Alltagssprache — „Verschlüsselung" statt „tls".
    titel: str = ""
    #: Was gemessen wurde, als Satz.
    was_ist: str = ""
    #: Der nächste Handgriff. Leer, wenn der Schritt sitzt.
    was_tun: str = ""


class DiagnoseAus(BaseModel):
    hostname: str
    #: ``ok`` nur, wenn jeder Schritt sitzt. Sonst der Name des ersten, der nicht.
    gesamt: str
    schritte: list[SchrittAus]
    #: Überschriften der Glieder, die wegen eines früheren Fehlschlags gar nicht
    #: erst geprüft wurden. Ohne diese Liste läse sich eine abgebrochene Kette
    #: wie eine vollständige — der Betreiber hielte Ungeprüftes für heil.
    nicht_geprueft: list[str] = []


async def _instanz_oder_404(
    db: SessionDep,
    instance_id: str,
    request: Request,
    client_id: str | None,
    client_secret: str | None,
) -> RegisteredInstance:
    """Holt die Instanz und prüft die Berechtigung. Wirft 404, nie 403."""
    try:
        iid = int(instance_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found") from exc
    inst = await db.get(RegisteredInstance, iid)
    if inst is None or inst.status != "active":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")

    # Weg 1: die Instanz weist sich selbst aus (Installer).
    if client_id and client_secret:
        # Der ID-Vergleich zuerst und in konstanter Zeit; das Argon2 darunter
        # kostet Rechenzeit, die ein Fremder sonst gratis auslösen könnte.
        if not hmac.compare_digest(client_id, inst.client_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
        if not await asyncio.to_thread(verify_password, client_secret, inst.client_secret):
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
        return inst

    # Weg 2: der Besitzer fragt aus der App.
    from dcc_auth.routes_instance_applications import _require_user

    user = await _require_user(request, db)
    if inst.registered_by != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
    return inst


async def _fuehre_pruefung(hostname: str, instanz_id: str, cloud_origin: str) -> list[Schritt]:
    """Geht die Kette ab und bricht ab, wo ein weiterer Schritt nur dieselbe
    Ursache ein zweites Mal meldete.

    Ohne Namensauflösung gibt es keine Adresse, ohne offenen Port keinen
    Handschlag, und ohne gültiges Zertifikat scheitert jeder HTTP-Schritt am
    selben Zertifikat. Die UDP- und RTMPS-Prüfungen hängen an keinem davon und
    laufen deshalb auch dann noch — sie betreffen Ton und Bild, und die sind
    ein eigenes Thema mit einer eigenen Firewall-Regel.
    """
    schritte: list[Schritt] = []

    dns = await pruefe_dns(hostname)
    schritte.append(dns)
    if not dns.ok:
        return schritte
    adresse = dns.adressen[0]

    tcp = await pruefe_tcp(adresse, 443, "tcp443")
    schritte.append(tcp)
    if not tcp.ok:
        # Ohne 443 hat eine Medienprüfung keinen Aussagewert für den Nutzer —
        # er kommt ohnehin nicht hinein.
        return schritte

    tls = await pruefe_tls(hostname, adresse, 443)
    schritte.append(tls)

    if tls.ok:
        # Ein eigener Klient je Prüfung wäre Verschwendung. Umleitungen bleiben
        # aus, und `Ziel` nagelt jede Anfrage auf die oben geprüfte Adresse
        # fest — sonst löste jeder Aufruf den Namen erneut auf und die Prüfung
        # aus `pruefe_dns` wäre eine Momentaufnahme ohne Wirkung.
        ziel = Ziel(hostname, adresse)
        async with httpx.AsyncClient(follow_redirects=False, verify=True) as klient:
            schritte.append(await pruefe_health(klient, ziel))
            schritte.append(await pruefe_identitaet(klient, ziel, instanz_id))
            schritte.append(await pruefe_cors(klient, ziel, cloud_origin))
        schritte.append(await pruefe_websocket(hostname, adresse, 443))

    # Ton und Bild: eigene Ports, eigene Firewall-Regel, eigener Befund.
    schritte.append(await pruefe_stun(adresse))
    schritte.append(await pruefe_tcp(adresse, RTMPS_PORT, "rtmps"))
    return schritte


@router.post("/selfhost/diagnose/{instance_id}", response_model=DiagnoseAus)
async def diagnose(
    instance_id: str,
    request: Request,
    db: SessionDep,
    x_pulse_client_id: Annotated[str | None, Header()] = None,
    x_pulse_client_secret: Annotated[str | None, Header()] = None,
    x_pulse_container_name: Annotated[str | None, Header()] = None,
    accept_language: Annotated[str | None, Header()] = None,
) -> DiagnoseAus:
    settings = get_settings()
    await _check_rate(request, "selfhost_diagnose", settings.rate_limit_selfhost_diagnose)
    inst = await _instanz_oder_404(
        db, instance_id, request, x_pulse_client_id, x_pulse_client_secret
    )

    # Der gespeicherte Hostname ist ein blosser Name (bei der Genehmigung
    # geprüft); ein Schema davor wäre ein Fehler in den Daten, kein Eingabewert.
    host = urlsplit(f"//{inst.hostname}").hostname or inst.hostname

    try:
        async with asyncio.timeout(GESAMTFRIST_S):
            schritte = await _fuehre_pruefung(host, str(inst.id), settings.pulse_oidc_issuer)
    except TimeoutError:
        schritte = [Schritt("gesamt", False, "zeitueberschreitung")]

    erster_fehler = next((s.schritt for s in schritte if not s.ok), None)
    sprache = sprache_aus_header(accept_language)

    # Nur Weg 2 (die Instanz weist sich per client_id/client_secret selbst
    # aus — der Installer) kennt den tatsächlichen Containernamen und schickt
    # ihn mit. Weg 1 (der Besitzer per Sitzung, „Verbindung prüfen" in der
    # App) hat keinen Zugriff auf die Maschine und damit keinen Namen —
    # ``container_name(None)`` liefert dort die Vorgabe ``pulse``.
    # Das ist eine bewusste Grenze dieses Tasks: wer den Container umbenannt
    # hat und die Diagnose später aus der App heraus startet, sieht in den
    # Handgriffen weiterhin „pulse" statt seines echten Namens. Den Namen
    # dauerhaft an der Instanz zu hinterlegen (eine eigene Spalte) wäre ein
    # eigener Task.
    container = container_name(x_pulse_container_name)

    # Was die Kette ausgelassen hat. `_fuehre_pruefung` bricht bewusst ab, wo
    # ein weiterer Schritt nur dieselbe Ursache wiederholte — das darf sich
    # aber nicht wie ein bestandener Rest lesen.
    gelaufen = {s.schritt for s in schritte}
    nicht_geprueft = [titel(name, sprache) for name in SCHRITTE if name not in gelaufen]

    ausgaben: list[SchrittAus] = []
    for s in schritte:
        was_ist, was_tun = erklaerung(s.schritt, s.befund, s.ok, sprache, container=container)
        ausgaben.append(
            SchrittAus(
                schritt=s.schritt,
                ok=s.ok,
                befund=s.befund,
                einzelheit=s.einzelheit,
                titel=titel(s.schritt, sprache),
                was_ist=was_ist,
                was_tun=was_tun,
            )
        )

    return DiagnoseAus(
        hostname=host,
        gesamt=erster_fehler or "ok",
        schritte=ausgaben,
        nicht_geprueft=nicht_geprueft,
    )
