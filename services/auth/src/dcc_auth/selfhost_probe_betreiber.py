"""Erreichbarkeitsprüfung, achtes Glied: erkennt der Server dich als Betreiber?

Warum das ein eigenes Glied ist
-------------------------------
Die sieben anderen Glieder prüfen, ob man den Server *erreicht*. Dieses prüft,
ob man auf ihm etwas *darf* — und das ist eine andere Frage mit einer anderen
Ursache. Am 2026-08-27 lief ein Server durch alle sieben Prüfungen grün, und
sein Betreiber konnte trotzdem nichts anlegen: Seine Instanz kannte eine andere
Owner-Kennung als die, unter der er sich anmeldete. Von aussen war das mit
keinem Mittel feststellbar; die Auskunft stand allein in einer Log-Zeile auf
seiner Maschine.

Auf einem Self-Host entsteht Admin an genau einer Stelle (``cert_login.py``):
Betriebsart ``self-host``, gesetzte ``PULSE_INSTANCE_OWNER_ID``, und diese
Kennung muss zur Kennung im vorgelegten Cert passen. Der Server meldet zu allen
dreien ein Ja/Nein; welches davon reisst, bestimmt den Handgriff.

Eigene Datei, weil ``selfhost_probe_dienst.py`` mit 320 Zeilen an der weichen
Grenze der Größen-Policy steht (PLAN.md §12.1).

Wie die Anfrage abgesichert ist
-------------------------------
Die erwartete Kennung reist als Claim in einem von der Cloud signierten Token,
nicht als Parameter. Der Server prüft die Signatur gegen die Cloud-JWKS, die er
ohnehin vorhält. Stünde die Kennung im Aufruf und die Signatur fehlte, wäre der
Endpunkt dort ein Orakel: jeder könnte durchprobieren, welches Konto welchen
Server betreibt. Das Token ist ausserdem an DIESE Instanz gebunden — es taugt
nicht, um dieselbe Frage einem anderen Server zu stellen.
"""

from __future__ import annotations

import asyncio
import time

import httpx
import jwt

from dcc_auth.config import get_settings
from dcc_auth.security import get_signer
from dcc_auth.selfhost_probe import FRIST_S, Schritt
from dcc_auth.selfhost_probe_dienst import Ziel

PFAD = "/.well-known/pulse-owner-check"

#: Muss mit ``routes/owner_check.py::ZWECK`` im chat-gateway übereinstimmen.
#: Zwei Dienste, ein Wort — ein Cloud-Token gilt nur für den Zweck, für den es
#: ausgestellt wurde.
ZWECK = "owner-check"

#: Das Token reist zu einem fremden Server. Läuft es lange, ist es dort ein
#: Nachschlüssel für jeden, der es abgreift. Dieselbe Frist wie beim
#: Update-Anstoss (``routes_suspended_instances.py``).
TOKEN_FRIST_S = 60


def _token(instanz_id: int, erwarteter_owner: int) -> str:
    signer = get_signer()
    jetzt = int(time.time())
    return jwt.encode(
        {
            "purpose": ZWECK,
            "instance_id": str(instanz_id),
            "owner_user_id": str(erwarteter_owner),
            "iat": jetzt,
            "exp": jetzt + TOKEN_FRIST_S,
        },
        signer._private_key,
        algorithm="RS256",
        headers={"kid": get_settings().jwt_key_id},
    )


def _aus_antwort(daten: dict) -> Schritt:
    """Die drei Bits in den Befund übersetzen, der den Handgriff bestimmt.

    Die Reihenfolge ist nicht beliebig: Steht die Betriebsart falsch, wird
    niemand Admin — auch mit der richtigen Kennung. Der Betreiber soll dann den
    Grund lesen, der zuerst greift, nicht einen Folgeschaden.
    """
    if not daten.get("modus_self_host", False):
        return Schritt("betreiber", False, "kein_self_host")
    if not daten.get("owner_konfiguriert", False):
        return Schritt("betreiber", False, "nicht_konfiguriert")
    if not daten.get("stimmt_ueberein", False):
        return Schritt("betreiber", False, "andere_kennung")
    return Schritt("betreiber", True, "erkannt")


async def pruefe_betreiber(
    klient: httpx.AsyncClient, ziel: Ziel, instanz_id: int, erwarteter_owner: int
) -> Schritt:
    """Fragt den Server, ob er ``erwarteter_owner`` als seinen Betreiber kennt."""
    try:
        async with asyncio.timeout(FRIST_S):
            antwort = await klient.get(
                ziel.url(PFAD),
                headers=ziel.kopf(
                    {"Authorization": f"Bearer {_token(instanz_id, erwarteter_owner)}"}
                ),
                extensions=ziel.sni,
            )
    except Exception:
        return Schritt("betreiber", False, "keine_auskunft")

    if antwort.status_code == 401:
        # Der Server hat die Anfrage verstanden und die Signatur abgelehnt.
        # Fast immer: seine Cloud-JWKS sind noch kalt, er hat die Cloud also
        # noch nie erreicht. Ein anderer Handgriff als eine falsche Kennung,
        # deshalb ein eigener Befund.
        return Schritt("betreiber", False, "signatur_abgelehnt")
    if antwort.status_code >= 400:
        # 404 = älterer Server ohne diesen Endpunkt ODER eine fehlende Zeile im
        # Proxy. Beides ist KEIN Konfigurationsfehler des Betreibers, und der
        # Text sagt das ausdrücklich — ein Fehlalarm hier wäre schlimmer als
        # gar kein Schritt.
        return Schritt("betreiber", False, "keine_auskunft")

    try:
        daten = antwort.json()
    except Exception:
        # Status 200 und trotzdem kein JSON: der SPA-Rückfall liefert die
        # Startseite, wenn die Proxy-Zeile fehlt.
        return Schritt("betreiber", False, "keine_auskunft")
    if not isinstance(daten, dict):
        return Schritt("betreiber", False, "keine_auskunft")
    return _aus_antwort(daten)
