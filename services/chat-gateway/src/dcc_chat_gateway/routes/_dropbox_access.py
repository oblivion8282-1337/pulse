"""Wer die Ablage sehen darf — das Sicht-Tor der Dropbox-Routen.

Der Ablage-Kanal ist der Rechteanker der Ablage (wie beim Standplatz-Gerät:
„wer die Werkstatt nicht sehen darf, sieht auch nicht, was darin steht"). Die
Routen prüften bis hierher nur die Mitgliedschaft in der Community — ein
Mitglied ohne ``VIEW_CHANNEL`` auf den Ablage-Kanal kam damit an Dateiliste,
Namen und die signierten GET-Adressen.

Der Ereignisweg prüft schon lange richtig: ``pubsub_channel_guild.py`` filtert
alle ``dropbox_*``-Ereignisse über ``_filter_by_view_channel``. Dieses Modul
zieht die Route auf denselben Stand — die zweite der beiden Stellen, die dieses
Projekt bewusst getrennt prüft. Nur im Ereignisweg wäre die Absicherung
löchrig (REST bleibt offen), nur in der Route wäre sie kosmetisch (DevTools
sieht den rohen Rahmen).

Eigene Datei statt Zuwachs in ``routes/dropbox.py``: die Datei liegt bereits
über der 350-Zeilen-Grenze (PLAN.md §12.1).
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select

from dcc_chat_gateway.models import CHANNEL_TYPE_DROPBOX, Channel
from dcc_chat_gateway.permissions import (
    Permissions,
    has_permission,
    resolve_permissions,
)
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.security import AuthenticatedUser


async def dropbox_channel_id(session, guild_id: int) -> int | None:
    """Kennung des Ablage-Kanals dieser Community, oder ``None``.

    Reiner Lesezugriff — legt nichts an. Die Erzeugung ist eine bauliche
    Entscheidung und hängt an ``MANAGE_CHANNELS``
    (``dropbox.py::ensure_dropbox_channel``)."""

    return (
        await session.execute(
            select(Channel.id).where(
                Channel.guild_id == guild_id,
                Channel.type == CHANNEL_TYPE_DROPBOX,
            )
        )
    ).scalars().first()


async def require_dropbox_view(
    session, current: AuthenticatedUser, guild_id: int
) -> None:
    """Mitgliedschaft **und** ``VIEW_CHANNEL`` auf den Ablage-Kanal.

    Ersetzt ``require_member`` in jeder Ablage-Route, die ein gewöhnliches
    Mitglied benutzt (Auflisten, Kontingent lesen, Ordner anlegen, Umbenennen,
    Papierkorb, Wiederherstellen — und, sobald nachgezogen, Hoch- und
    Herunterladen).

    Antwort bei fehlender Sicht ist **404**, nicht 403: an anderer Stelle
    versteckt das Programm die blosse Existenz eines verbotenen Kanals
    ausdrücklich (siehe ``pubsub_channel_guild.py``), und der Wortlaut ist
    derselbe wie bei einer nie eingerichteten Ablage — sonst verriete das
    Statuspaar, dass es hier etwas zu sehen gäbe.

    Existiert noch kein Ablage-Kanal, bleibt es bei der Mitgliedschaftsprüfung:
    ohne Kanal gibt es keine Kanalrechte, die man prüfen könnte, und die
    aufrufende Route beantwortet den Fall ohnehin mit 404 („dropbox not
    provisioned")."""

    await require_member(session, guild_id, current.id)
    channel_id = await dropbox_channel_id(session, guild_id)
    if channel_id is None:
        return
    perms = await resolve_permissions(session, current, guild_id, channel_id)
    if not has_permission(perms, Permissions.VIEW_CHANNEL):
        raise HTTPException(404, detail="dropbox disabled for this guild")
