"""Der Vorschautext einer DM-Liste.

Die Chats-Liste des Handys zeigt unter jedem Namen einen Ausschnitt der
letzten Nachricht (Mobil-Umbau 2026-08-22). Die Kuerzung steht hier als reine
Funktion und nicht in der Route, damit sie ohne Datenbank pruefbar ist.

**Der Dateiname eines Anhangs geht bewusst NICHT mit.** Die DM-Liste ist die
eine Antwort, die ein Klient beim Start ungefragt holt, und sie wandert auf
jedes angemeldete Geraet des Kontos. Ein Dateiname sagt oft mehr ueber eine
Unterhaltung aus als ihr Text; er gehoert in die geoeffnete Unterhaltung, nicht
in eine Uebersicht. Stattdessen zwei feste Marker, die der Klient uebersetzt.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select

from dcc_chat_gateway.models import (
    DirectMessageChannel,
    Message,
    MessageAttachment,
)

#: Laenge des Ausschnitts. 80 Zeichen sind auf einem schmalen Telefon rund
#: zwei Zeilen — mehr zeigt die Liste ohnehin nie an, und alles darueber
#: waere Datenverkehr fuer nichts.
MAX_LAENGE = 80

#: Nachricht ohne Text, aber mit einem Bild-Anhang.
MARKER_BILD = "__image__"
#: Nachricht ohne Text mit einem Anhang, der kein Bild ist.
MARKER_DATEI = "__file__"


def vorschau(content: str | None, anhang_mime: str | None = None) -> str | None:
    """Der Ausschnitt fuer eine Listenzeile.

    ``None`` heisst „keine Vorschau" — die Zeile faellt dann auf ihren
    bisherigen Zustand zurueck (nur Name und Uhrzeit).

    Zeilenumbrueche werden zu Leerzeichen: eine Listenzeile IST eine Zeile,
    und ein eingebetteter Umbruch liesse das Layout je nach Nachricht
    springen.
    """
    text = (content or "").replace("\r\n", "\n").replace("\r", "\n")
    text = " ".join(text.split("\n")).strip()
    if text:
        return text[:MAX_LAENGE]
    if anhang_mime:
        return MARKER_BILD if anhang_mime.startswith("image/") else MARKER_DATEI
    return None


@dataclass(frozen=True)
class Letzte:
    """Die letzte Nachricht eines DM-Kanals, so weit die Liste sie braucht."""

    text: str | None
    author_id: int
    created_at: datetime


async def letzte_nachrichten(
    session, dms: list[DirectMessageChannel]
) -> dict[int, Letzte]:
    """Vorschautexte fuer eine ganze DM-Liste — in ZWEI Abfragen, nicht in N.

    Die Kennungen stehen bereits in den Zeilen (``last_message_id``), es
    braucht also keine Suche je Kanal. Eine Abfrage holt die Nachrichten, eine
    zweite die Anhaenge der textlosen darunter.

    Weggeloeschte Nachrichten (``deleted_at``) fallen heraus und der Kanal
    bekommt gar keine Vorschau: geloescht heisst geloescht, auch in einer
    Uebersicht.
    """
    ids = [d.last_message_id for d in dms if d.last_message_id is not None]
    if not ids:
        return {}
    rows = (
        await session.execute(
            select(Message).where(
                Message.id.in_(ids), Message.deleted_at.is_(None)
            )
        )
    ).scalars().all()
    # Nur fuer textlose Nachrichten ueberhaupt nach Anhaengen fragen.
    ohne_text = [m.id for m in rows if not (m.content or "").strip()]
    mime_je_nachricht: dict[int, str | None] = {}
    if ohne_text:
        anhaenge = (
            await session.execute(
                select(MessageAttachment)
                .where(
                    MessageAttachment.message_id.in_(ohne_text),
                    MessageAttachment.deleted_at.is_(None),
                )
                # Feste Reihenfolge, damit „der erste Anhang" unten wirklich
                # einer ist: ohne ORDER BY darf die Datenbank die Zeilen in
                # beliebiger Folge liefern, und derselbe Kanal zeigte je nach
                # Abfrage mal „Bild", mal „Datei".
                .order_by(MessageAttachment.id)
            )
        ).scalars().all()
        for a in anhaenge:
            # Der erste Anhang bestimmt den Marker — die Liste zeigt ein Wort,
            # keine Aufzaehlung.
            mime_je_nachricht.setdefault(a.message_id, a.mime)
    je_nachricht = {
        m.id: Letzte(
            text=vorschau(m.content, mime_je_nachricht.get(m.id)),
            author_id=m.author_id,
            created_at=m.created_at,
        )
        for m in rows
    }
    return {
        d.id: je_nachricht[d.last_message_id]
        for d in dms
        if d.last_message_id in je_nachricht
    }
