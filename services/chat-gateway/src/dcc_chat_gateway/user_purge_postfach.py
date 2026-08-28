"""Konto-Purge: E2E-Postfach (Geraete-Buendel, Einmalschluessel, Zustellungen).

Abgetrennt von ``user_purge.py`` — derselbe Grund wie bei
``user_purge_gruppen.py``: die Datei laeuft sonst ueber die Groessen-Policy
(PLAN.md §12.1), sie war schon vor dieser Ergaenzung nahe an der Grenze.

Vier Tabellen, drei verschiedene Eigentumsverhaeltnisse:

- ``DeviceKeyBundle`` gehoert dem Konto ueber ``user_id`` — jedes eigene
  Buendel wird geloescht. ``DeviceOneTimeKey`` haengt per FK an einem
  Buendel und wird explizit mitgeraeumt statt ueber die DB-Kaskade zu
  laufen: Tests fahren SQLite ohne ``PRAGMA foreign_keys=ON`` innerhalb
  dieser Transaktion (s. ``test_postfach.py::_enable_sqlite_foreign_keys``,
  das nur die eigene Verbindung des Tests betrifft), eine Kaskade waere dort
  ein Kein-Op, das nur in Produktion griffe.
- ``DmZustellung`` gehoert dem EMPFAENGER (``empfaenger_user_id``) — eine
  Zustellung an ein Geraet dieses Kontos wird niemand mehr abholen, das
  Konto existiert nicht mehr.
- ``DmNutzlast`` gehoert niemandem direkt (kein ``user_id`` auf der Zeile);
  sie faellt weg, sobald ihre letzte Zustellung weg ist — dieselbe Abfrage
  wie ``postfach_pflege.py::sweep_verwaiste_nutzlasten``. Eine Nutzlast, die
  dieses Konto an noch existierende Empfaenger geschickt hat, bleibt
  stehen: deren Zustellungen sind von diesem Purge nicht betroffen.

**Dieselbe Faehrte wie bei ``community_invite_notifications`` nach Migration
0063** — dort raeumte der Purge bis heute nicht mit (s. Docstring von
``user_purge_gruppen.py::purge_private_group_memberships``). Diese Etappe
wiederholt sie nicht: der Test dafuer heisst
``test_purge_raeumt_e2e_postfach`` (``tests/test_user_purge.py``).

Kein Commit hier — laeuft innerhalb derselben Transaktion wie der Rest von
``user_purge.py::_purge_db`` (dessen Modul-Docstring: „a half-purge can't
leave dangling rows").
"""

from __future__ import annotations

from sqlalchemy import delete as sa_delete
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey, DmNutzlast, DmZustellung


async def purge_postfach(session: AsyncSession, user_id: int) -> None:
    """Raeumt Geraete-Buendel + Postfach-Zeilen des geloeschten Kontos."""
    bundle_ids = list(
        (
            await session.execute(
                select(DeviceKeyBundle.id).where(DeviceKeyBundle.user_id == user_id)
            )
        ).scalars()
    )
    if bundle_ids:
        await session.execute(
            sa_delete(DeviceOneTimeKey).where(DeviceOneTimeKey.bundle_id.in_(bundle_ids))
        )
        await session.execute(
            sa_delete(DeviceKeyBundle).where(DeviceKeyBundle.id.in_(bundle_ids))
        )

    await session.execute(
        sa_delete(DmZustellung).where(DmZustellung.empfaenger_user_id == user_id)
    )
    # Verwaiste Nutzlasten nachziehen — dieselbe Abfrage wie der reguläre
    # Verfallslauf, damit hier keine zweite, potenziell abweichende
    # Definition von „verwaist" entsteht.
    await session.execute(
        sa_delete(DmNutzlast).where(
            ~exists(
                select(DmZustellung.id).where(DmZustellung.nutzlast_id == DmNutzlast.id)
            )
        )
    )


__all__ = ["purge_postfach"]
