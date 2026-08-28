"""Neuntes Glied: Spricht dieser Server schon den Ticket-Weg?

Es ist **kein Erreichbarkeitsglied**. Ein Server kann tadellos laufen und
trotzdem noch den Zertifikats-Weg fahren; das ist während der Übergangszeit
völlig in Ordnung. Der Schritt beantwortet die Frage, die sonst niemand ohne
Anmeldung beantworten kann — und liefert die Zahl, an der das Tor zwischen
Phase 2 und Phase 3 des Umbaus hängt: Solange auch nur eine Instanz noch auf
dem alten Weg anmeldet, wird nichts gelöscht.

Warum die öffentliche Auskunft und nicht der ``hello``-Rahmen
-------------------------------------------------------------
Die Fähigkeitsliste steht auch im ``hello``, das es aber erst **nach** einer
gültigen Anmeldung gibt — also ausgerechnet nach dem, was womöglich klemmt.
``/.well-known/pulse-server-info`` beantwortet dieselbe Frage ohne Anmeldung; es
trägt das ``capabilities``-Feld seit Phase 3.3.

Der erste Anlauf dieser Prüfung stellte stattdessen eine Anfrage an
``POST /session`` und schloss aus 404 gegen 403 auf den Weg. Das funktionierte,
war aber ein **schreibender** Zugriff auf einen fremden Server, um eine reine
Auskunft zu bekommen — und es prüfte den Anmeldeweg über die Anmeldung selbst.
Die Auskunft direkt zu lesen ist beides nicht.
"""

from __future__ import annotations

import asyncio

import httpx

from dcc_auth.selfhost_probe import FRIST_S, Schritt
from dcc_auth.selfhost_probe_dienst import Ziel

PFAD = "/.well-known/pulse-server-info"

#: Muss mit ``dcc_chat_gateway.faehigkeiten.SERVER_FAEHIGKEITEN`` übereinstimmen.
FAEHIGKEIT_TICKET = "server-ticket"


async def pruefe_anmeldeweg(klient: httpx.AsyncClient, ziel: Ziel) -> Schritt:
    """Fragt, welchen Anmeldeweg dieser Server kann."""
    try:
        async with asyncio.timeout(FRIST_S):
            antwort = await klient.get(
                ziel.url(PFAD),
                headers=ziel.kopf({}),
                extensions=ziel.sni,
            )
    except Exception:  # noqa: BLE001
        return Schritt("anmeldeweg", False, "keine_auskunft")

    if antwort.status_code >= 400:
        return Schritt("anmeldeweg", False, "keine_auskunft")

    try:
        daten = antwort.json()
    except Exception:  # noqa: BLE001
        # Der häufigste Fall dahinter: Der Proxy liefert die SPA-Startseite
        # statt der JSON-Antwort. Siehe ``pruefe_identitaet``, das an derselben
        # Auskunft hängt und denselben Fall kennt.
        return Schritt("anmeldeweg", False, "keine_auskunft")

    if not isinstance(daten, dict):
        return Schritt("anmeldeweg", False, "keine_auskunft")

    faehigkeiten = daten.get("capabilities")
    if not isinstance(faehigkeiten, list):
        return Schritt("anmeldeweg", False, "keine_auskunft")

    if FAEHIGKEIT_TICKET in faehigkeiten:
        return Schritt("anmeldeweg", True, "ticket_weg")

    # Ein älterer Server nennt die Fähigkeit nicht (das Feld war bis zum
    # 2026-08-28 immer leer). Während der Übergangszeit ist das KEIN Mangel,
    # deshalb ``ok=True`` — ein Fehlalarm triebe Betreiber dazu, an einem Server
    # herumzuschrauben, an dem nichts fehlt.
    return Schritt("anmeldeweg", True, "zertifikats_weg")
