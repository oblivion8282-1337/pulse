"""Wer einen Weckruf aus einer privaten Gruppe zugestellt bekommt (Etappe G).

Eigene Datei, weil ``pubsub_perm_filter.py`` mit dieser Pruefung die harte
Groessen-Grenze (PLAN.md §12.1) gerissen haette. Freie Funktion statt einer
weiteren Mixin-Methode: sie braucht vom Manager nur zwei Dinge — die
Sitzungs-Fabrik und die Zuordnung Socket -> Konto —, und beide werden
uebergeben.
"""

from __future__ import annotations

from collections.abc import Mapping

from fastapi import WebSocket

from dcc_chat_gateway.private_gruppen_zugriff import gruppen_mitglieder
from dcc_chat_gateway.security import AuthenticatedUser


async def gruppen_ziele_filtern(
    session_factory,
    ws_user: Mapping[WebSocket, AuthenticatedUser],
    targets: list[WebSocket],
    gruppe_id: int,
) -> list[WebSocket]:
    """Aus ``targets`` die Sockets behalten, deren Konto Mitglied von
    ``gruppe_id`` ist.

    Die zweite der beiden Pruefstellen — die erste ist die ``subscribe``-Op
    (``routes/ws_ops_handlers.py``). Dieselbe Doppelung wie bei den
    Standplatz-Geraeten: die Route entscheidet, wer abonnieren darf, dieser
    Filter, wer es zugestellt bekommt. Ohne ihn liest ein entferntes Mitglied
    weiter mit, solange sein Socket offen ist — und genau so lange dauert
    eine Sitzung.

    **Kein Admin-Umweg.** ``_filter_by_view_channel`` laesst globale Admins
    ueberall durch, hier ausdruecklich nicht: eine private Gruppe ist
    Ende-zu-Ende verschluesselt, es gibt keinen Betreiber-Einblick, den ein
    Weckruf ergaenzen wuerde — er verriete nur, dass und wann dort
    geschrieben wird.

    **Frisch je Ereignis, kein Cache** — wie ``_filter_by_moderator``. Ein
    Cache brauchte einen Ungueltig-Macher an jeder Mitgliedschaftsaenderung
    (``routes/private_gruppen.py`` kennt heute keinen Ereignisweg), und ein
    verpasster Aufruf hiesse: ein Entfernter liest weiter mit. Teuer ist es
    nicht: ``gruppen_mitglieder`` holt die Gruppe ueber ihren
    Primaerschluessel und die Mitglieder ueber den Index
    ``ix_private_group_members_gruppe``.

    ``gruppen_mitglieder`` liefert ``None``, wenn der Schalter
    ``private_groups_enabled`` aus ist — dann wird nichts zugestellt, auch
    nicht an einen Bestand aus eingeschalteter Zeit.
    """
    async with session_factory() as session:
        mitglieder = await gruppen_mitglieder(session, gruppe_id)
    if not mitglieder:
        return []
    out: list[WebSocket] = []
    for ws in targets:
        user = ws_user.get(ws)
        if user is not None and user.id in mitglieder:
            out.append(ws)
    return out
