"""Konto-Purge: private-Gruppen-Mitgliedschaften.

Abgetrennt von ``user_purge.py``, weil die Datei sonst über die Größen-Policy
läuft (PLAN.md §12.1) — derselbe Grund wie bei ``user_purge_nachlauf.py``.
Anders als dort laeuft diese Funktion INNERHALB der Purge-Transaktion (kein
eigener Commit): sie raeumt DB-Zeilen, kein externes System.
"""

from __future__ import annotations

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import PrivateGroupMember
from dcc_chat_gateway.private_gruppen_atomar import (
    ersteller_erbe_uebertragen,
    gruppe_loeschen_wenn_leer,
)


async def purge_private_group_memberships(session: AsyncSession, user_id: int) -> None:
    """Mitgliedschaften in privaten Gruppen raeumen — UND die Festlegung aus
    ``routes/private_gruppen.py`` beantworten, wenn der Geloeschte Ersteller
    einer Gruppe war (dienstaeltestes verbleibendes Mitglied erbt; ohne
    verbleibendes Mitglied wird die Gruppe geloescht).

    **Genau diese Stelle wurde bei Migration 0063 uebersehen** — die
    Einladungs-Inbox (``community_invite_notifications``) raeumt beim Purge
    bis heute nicht mit, die Zeilen blieben nach dem Loeschen stehen. Diese
    Etappe wiederholt die Faehrte nicht: der Test dafuer heisst
    ``test_purge_raeumt_gruppenmitgliedschaften_und_vererbt_ersteller``
    (``tests/test_private_gruppen.py``).

    **Loeschen/Erben laufen ueber ``private_gruppen_atomar.py``**, nicht
    mehr ueber eine hier gelesene ``verbleibend``-Liste: die fruehere
    Fassung berechnete Loeschen/Erben in Python aus einem SELECT-Schnappschuss
    und schrieb ihn bedingungslos zurueck. Laeuft eine zweite Purge- oder
    Austritts-Transaktion auf derselben Gruppe drueber (zwei Mitglieder eines
    Zweier-Kreises werden im selben Moment geloescht/verlassen die Gruppe),
    konnte dieser Schnappschuss veraltet sein — mit der schlimmeren Folge als
    beim Austritt: ``ersteller_id`` zeigte danach auf ein LAENGST GELOESCHTES
    Konto, ein Widerspruch zum eigenen Versprechen dieses Purge-Moduls
    („keine haengenden Zeilen"). Die atomaren Bausteine pruefen ihre
    Bedingung (leer? noch Ersteller?) beim Ausfuehren frisch gegen die DB,
    nicht gegen diesen Schnappschuss.

    Kein Commit hier — laeuft innerhalb derselben Transaktion wie der Rest
    von ``user_purge.py::_purge_db`` (dessen Modul-Docstring: „a half-purge
    can't leave dangling rows")."""
    gruppe_ids = list(
        (
            await session.execute(
                select(PrivateGroupMember.gruppe_id).where(
                    PrivateGroupMember.user_id == user_id
                )
            )
        ).scalars()
    )
    if not gruppe_ids:
        return
    await session.execute(
        sa_delete(PrivateGroupMember).where(PrivateGroupMember.user_id == user_id)
    )
    for gid in gruppe_ids:
        if await gruppe_loeschen_wenn_leer(session, gid):
            continue
        await ersteller_erbe_uebertragen(session, gid, user_id)
