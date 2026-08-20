"""Auflösung der Dauerfreigaben eines Geräts.

**Warum das hier steht und nicht im WS-Handler:** die Frage „darf dieser Mensch
diesen Rechner ohne Rückfrage übernehmen" ist eine reine Rechnung über Zeilen,
Zeit und Rollen. Als Funktion ist sie ohne Datenbank prüfbar; im Handler wäre
sie es nur mit einer offenen WebSocket.

**Die Rechteprüfung ist NICHT Teil dieser Funktion.** Sie hat schon
stattgefunden, bevor jemand hierher kommt: ``handle_request`` prüft
``VIEW_CHANNEL`` und ``REMOTE_CONTROL`` am genannten Kanal und lässt ein
genanntes Gerät nur zu, wenn es in genau diesem Kanal steht
(``standplatz_stimmt``). Eine Freigabe ersetzt diese Prüfung nie — sie verzichtet
nur auf die zusätzliche Rückfrage.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime

from sqlalchemy import delete, select

from dcc_chat_gateway.models import (
    SUBJECT_EVERYONE,
    SUBJECT_ROLE,
    SUBJECT_USER,
    DeviceGrant,
)


def gedeckt(
    zeilen: Iterable[DeviceGrant], *, anfragender_id: int, rollen: set[int]
) -> bool:
    """Deckt eine der Freigaben diesen Anfragenden gerade ab?"""
    jetzt = datetime.now(UTC)
    for z in zeilen:
        if z.expires_at is not None and z.expires_at <= jetzt:
            continue
        if z.subject_type == SUBJECT_EVERYONE:
            return True
        if z.subject_type == SUBJECT_USER and z.subject_id == anfragender_id:
            return True
        if z.subject_type == SUBJECT_ROLE and z.subject_id in rollen:
            return True
    return False


async def freigaben_lesen(session, device_id: int) -> list[DeviceGrant]:
    treffer = await session.execute(
        select(DeviceGrant).where(DeviceGrant.device_id == device_id)
    )
    return list(treffer.scalars())


async def rollen_freigaben_loeschen(session, device_id: int) -> int:
    """Rollen-Freigaben eines Geräts entfernen und ihre Zahl melden.

    Gerufen beim Community-Wechsel: eine Rolle gehört einer Community, nach dem
    Wechsel zeigen diese Zeilen ins Leere. Sie still weitergelten zu lassen wäre
    die gefährliche Variante — eine Rollenkennung kann in der Zielcommunity
    existieren und dort etwas völlig anderes bedeuten.
    """
    ergebnis = await session.execute(
        delete(DeviceGrant).where(
            DeviceGrant.device_id == device_id,
            DeviceGrant.subject_type == SUBJECT_ROLE,
        )
    )
    return ergebnis.rowcount or 0
