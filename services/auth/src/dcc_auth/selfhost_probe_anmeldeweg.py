"""Neuntes Glied: Spricht dieser Server schon den Ticket-Weg?

Es ist **kein Erreichbarkeitsglied**. Ein Server kann tadellos laufen und
trotzdem noch den Zertifikats-Weg fahren; das ist während der Übergangszeit
völlig in Ordnung. Der Schritt beantwortet die Frage, die sonst niemand ohne
Anmeldung beantworten kann — und liefert die Zahl, an der das Tor zwischen
Phase 2 und Phase 3 des Umbaus hängt: Solange auch nur eine Instanz noch auf
dem alten Weg anmeldet, wird nichts gelöscht.

Warum ``POST /session`` und nicht der ``hello``-Rahmen
------------------------------------------------------
Die Fähigkeitsliste steht im ``hello``, das es erst **nach** einer gültigen
Anmeldung gibt — also ausgerechnet nach dem, was womöglich klemmt. Diese Prüfung
darf keine Anmeldung voraussetzen. Also fragt sie die Route selbst: Ein alter
Server kennt sie nicht (404), ein neuer weist ein unbrauchbares Ticket ab (403
mit einem ``ticket_*``-Code). Beides eindeutig, und es reist kein Geheimnis mit.

Der Pfad braucht **keine** eigene Zeile im Proxy: ``/api/chat/*`` ist bereits
durchgeleitet. Fehlt sie trotzdem, greift der SPA-Rückfall und liefert HTML
statt JSON — das fällt hier als ``keine_auskunft`` an, nicht als Fehlalarm.
"""

from __future__ import annotations

import asyncio

import httpx

from dcc_auth.selfhost_probe import FRIST_S, Schritt
from dcc_auth.selfhost_probe_dienst import Ziel

PFAD = "/api/chat/session"

#: Vorsätzlich unbrauchbar. Der Probe prüft einen FREMDEN Server, dessen
#: Betreiber nicht zwingend vertrauenswürdig ist — ein echter Ausweis hätte hier
#: nichts zu suchen.
_UNBRAUCHBAR = {"ticket": "keins"}


async def pruefe_anmeldeweg(klient: httpx.AsyncClient, ziel: Ziel) -> Schritt:
    """Fragt, welchen Anmeldeweg dieser Server kann."""
    try:
        async with asyncio.timeout(FRIST_S):
            antwort = await klient.post(
                ziel.url(PFAD),
                json=_UNBRAUCHBAR,
                headers=ziel.kopf({}),
                extensions=ziel.sni,
            )
    except Exception:  # noqa: BLE001
        return Schritt("anmeldeweg", False, "keine_auskunft")

    if antwort.status_code == 404:
        # Route unbekannt: Der Server läuft noch auf dem Zertifikats-Weg. Das
        # ist während der Übergangszeit KEIN Mangel, deshalb ``ok=True``. Ein
        # Fehlalarm hier triebe Betreiber dazu, an einem Server herumzuschrauben,
        # an dem nichts fehlt.
        return Schritt("anmeldeweg", True, "zertifikats_weg")

    if antwort.status_code == 403:
        try:
            detail = antwort.json().get("detail", "")
        except Exception:  # noqa: BLE001
            detail = ""
        if isinstance(detail, str) and detail.startswith("ticket_"):
            return Schritt("anmeldeweg", True, "ticket_weg")

    # Alles andere (502 vom Proxy, 200 mit HTML aus dem SPA-Rückfall, ein 403
    # aus einem anderen Grund) sagt nichts über den Anmeldeweg.
    return Schritt("anmeldeweg", False, "keine_auskunft")
