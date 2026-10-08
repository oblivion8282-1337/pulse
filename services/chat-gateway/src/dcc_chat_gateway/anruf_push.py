"""Wann klingelt wessen Telefon — der Push-Teil des Anruf-Wegs (Punkt 40).

Getrennt von :mod:`dcc_chat_gateway.apns_voip`, und die Naht ist inhaltlich:
dort steht, WIE man mit APNs spricht (JWT, Kopfzeilen, Statusdeutung), hier,
WANN wer einen Push bekommt (Frische der WebSocket, Tokens aus der Datenbank,
Klingeln gegen Abbruch). In einer Datei lägen sie zusammen über der
Größen-Policy (350 Zeilen) — getrennt lesen sich beide Hälften für sich.

**Alles fail-open.** Fehlender Schlüssel, toter Token, Störung bei Apple: der
Anruf läuft wie bisher über die WebSocket weiter. Ein Push ist die Zugabe für
den, der gerade keine offene Verbindung hat.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy import delete, select

from dcc_chat_gateway import apns_voip
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.models import VoipToken

log = logging.getLogger("dcc_chat_gateway.anruf_push")

# Wie frisch eine WebSocket sein muss, damit ein Anruf OHNE VoIP-Push
# auskommt.
#
# **Warum nicht die 95 s des Reapers** (``pubsub.SOCKET_STALE_SEKUNDEN``): die
# sind für Nachrichten-Pushs richtig, für einen Anruf aber länger als der
# Anruf selbst — er klingelt 45 s. Ein im Hintergrund suspendiertes Telefon
# gälte damit die ganze Klingelzeit als online, der Push bliebe aus, und der
# Anruf wäre verpasst, ohne dass irgendwo etwas schiefgeht.
#
# 40 s sind gewählt, weil der Klient alle 25 s pingt
# (``WS_PING_INTERVAL_MS``): ein lebendiger Socket hat sich innerhalb von 40 s
# gemeldet, selbst wenn ein Ping ausgefallen ist. Ein fälschlich geschickter
# Push kostet ein doppeltes Klingeln, ein fälschlich unterdrückter den Anruf —
# die Richtung ist bewusst.
ANRUF_FRISCHE_S = 40.0


def offline_empfaenger(empfaenger_ids: set[int], manager: Any | None) -> set[int]:
    """Wer von diesen Konten hat gerade KEINE frische WebSocket?

    Eigene Funktion, weil hier die ganze Feinheit dieses Moduls sitzt und sie
    sonst nicht prüfbar wäre: der Fan-out bricht vorher ab, wenn kein
    APNs-Schlüssel konfiguriert ist (richtig — ohne Schlüssel gibt es nichts
    zu filtern), und damit käme ein Test an die Entscheidung nie heran.

    Ohne ``manager`` (Tests, pfadlose Aufrufe) gilt jeder als offline — wie im
    FCM-Weg: lieber ein Push zu viel als ein verpasster Anruf.
    """
    if manager is None:
        return set(empfaenger_ids)
    return {
        uid for uid in empfaenger_ids if manager.user_socket_count(uid, ANRUF_FRISCHE_S) == 0
    }


async def _an_voip_geraete(
    *, empfaenger_ids: set[int], nutzlast: dict, manager: Any | None
) -> int:
    """Nutzlast an die VoIP-Geräte der angegebenen Konten ausliefern.

    ``manager`` ist der Offline-Filter: mit Manager gehen nur die Konten ohne
    frische WebSocket raus, ohne (``None``) alle. Der Abbruch nutzt bewusst
    ``None`` — Begründung bei :func:`fan_out_abbruch`.

    Löst nie aus: ein fehlender Schlüssel, ein toter Token oder eine Störung
    bei Apple dürfen den Anruf nicht brechen, der sonst über die WebSocket
    zustande käme.
    """
    if not empfaenger_ids:
        return 0

    zugang = apns_voip.zugang_aus_einstellungen(get_settings())
    if zugang is None:
        return 0
    empfaenger_ids = offline_empfaenger(empfaenger_ids, manager)
    if not empfaenger_ids:
        return 0
    try:
        async with SessionLocal() as session:
            treffer = await session.execute(
                select(VoipToken).where(VoipToken.user_id.in_(list(empfaenger_ids)))
            )
            zeilen = treffer.scalars().all()
            if not zeilen:
                return 0
            ergebnisse = await asyncio.gather(
                *(
                    apns_voip.senden(zugang=zugang, geraete_token=z.token, nutzlast=nutzlast)
                    for z in zeilen
                ),
                return_exceptions=True,
            )
            tote = [
                z.token
                for z, ausgang in zip(zeilen, ergebnisse, strict=True)
                if ausgang == "dead"
            ]
            if tote:
                await session.execute(delete(VoipToken).where(VoipToken.token.in_(tote)))
                await session.commit()
            return sum(1 for ausgang in ergebnisse if ausgang == "ok")
    except Exception:  # noqa: BLE001
        log.exception("apns_voip_fanout_fehlgeschlagen")
        return 0


async def fan_out_klingeln(
    *,
    empfaenger_ids: set[int],
    call_id: str,
    art: str,
    channel_id: str,
    einleiter_id: str,
    einleiter_name: str,
    manager: Any | None = None,
) -> int:
    """Einen eingehenden Anruf an die iOS-Geräte offline-Teilnehmer melden.

    **Der Name reist mit, anders als im WS-Ereignis.** Dort steht nur
    ``einleiter_id``, und der Klient löst den Namen aus seinem Zwischenspeicher
    auf — nativer Code hat keinen. Ohne den Namen stünde im CallKit-Bildschirm
    eine Zahl.
    """
    return await _an_voip_geraete(
        empfaenger_ids=empfaenger_ids,
        nutzlast={
            "art": "klingelt",
            "call_id": call_id,
            "anruf_art": art,
            "channel_id": channel_id,
            "einleiter_id": einleiter_id,
            "einleiter_name": einleiter_name or "Pulse",
        },
        manager=manager,
    )


async def fan_out_abbruch(
    *, empfaenger_ids: set[int], call_id: str, manager: Any | None = None
) -> int:
    """Einen beendeten Anruf melden, damit der CallKit-Bildschirm zugeht.

    **Ohne das klingelt das Telefon ins Leere.** Legt der Anrufer auf, bevor
    abgenommen wurde, weiss die Hülle nichts davon — CallKit zeigt weiter
    einen eingehenden Anruf, und wer abnimmt, landet in einem Gespräch, das
    nicht mehr existiert.

    **Hier wird NICHT auf offline geprüft:** wer das Klingeln per Push bekam,
    muss den Abbruch bekommen, auch wenn seine WebSocket in der Zwischenzeit
    aufgewacht ist. Ein überzähliger Abbruch-Push ist harmlos — er beendet
    einen Anruf, den es nicht mehr gibt.

    ``manager`` wird deshalb angenommen und bewusst NICHT weitergereicht: der
    Parameter hält die beiden Fan-outs aufrufgleich, damit ein Aufrufer ihn
    nicht einmal mitgeben und einmal vergessen muss. Dass hier nicht gefiltert
    wird, hält ``test_abbruch_prueft_NICHT_auf_offline`` fest.
    """
    return await _an_voip_geraete(
        empfaenger_ids=empfaenger_ids,
        nutzlast={"art": "abbruch", "call_id": call_id},
        manager=None,
    )


__all__ = [
    "ANRUF_FRISCHE_S",
    "fan_out_abbruch",
    "fan_out_klingeln",
    "offline_empfaenger",
]
