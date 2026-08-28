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

from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember


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
    gruppen = {
        g.id: g
        for g in (
            await session.execute(
                select(PrivateGroupChannel).where(PrivateGroupChannel.id.in_(gruppe_ids))
            )
        ).scalars()
    }
    await session.execute(
        sa_delete(PrivateGroupMember).where(PrivateGroupMember.user_id == user_id)
    )
    for gid in gruppe_ids:
        gruppe = gruppen.get(gid)
        if gruppe is None:
            continue
        verbleibend = list(
            (
                await session.execute(
                    select(PrivateGroupMember).where(PrivateGroupMember.gruppe_id == gid)
                )
            ).scalars()
        )
        if not verbleibend:
            await session.delete(gruppe)
            continue
        if gruppe.ersteller_id == user_id:
            erbe = min(verbleibend, key=lambda m: (m.beigetreten_am, m.id))
            gruppe.ersteller_id = erbe.user_id
