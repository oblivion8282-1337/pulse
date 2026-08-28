"""Private Gruppenkanaele (Etappe G1).

Task 1 deckt die Modelle (Eindeutigkeit + CASCADE), Task 2 die Routen und die
Mitgliederverwaltung. Task 3 (Nachrichten in einer Gruppe) ist bewusst NICHT
hier — s. Umsetzungsplan.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.exc import IntegrityError

# ---------------------------------------------------------------------------
# Task 1 — Modelle und Migration
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """SQLite ignoriert ``ON DELETE CASCADE`` ohne ``PRAGMA foreign_keys=ON``
    je Verbindung — derselbe Weg wie ``test_schluessel.py``/``test_postfach.py``.
    Die Test-Engine nutzt ``StaticPool`` (eine geteilte In-Memory-Verbindung),
    deshalb genuegt ein einmaliges PRAGMA auf dieser einen Verbindung."""
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


@pytest.mark.asyncio
async def test_dieselbe_person_ist_nur_einmal_mitglied(session_factory):
    """Sonst zaehlt die Gruppe falsch, und beim Verteilen des
    Gruppenschluessels (G2) bekaeme dasselbe Konto zwei Umschlaege."""
    from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember
    from dcc_chat_gateway.snowflake import next_id

    gid = next_id()
    async with session_factory() as s:
        s.add(PrivateGroupChannel(id=gid, ersteller_id=1, name="Testgruppe"))
        s.add(PrivateGroupMember(id=next_id(), gruppe_id=gid, user_id=2))
        await s.commit()

    with pytest.raises(IntegrityError):
        async with session_factory() as s:
            s.add(PrivateGroupMember(id=next_id(), gruppe_id=gid, user_id=2))
            await s.commit()


@pytest.mark.asyncio
async def test_mitglieder_verschwinden_mit_der_gruppe(session_factory):
    """Aufgeloeste Gruppe, verwaiste Mitgliedszeilen — dieselbe CASCADE-
    Pruefung wie beim Schluesselverzeichnis."""
    from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember
    from dcc_chat_gateway.snowflake import next_id
    from sqlalchemy import delete, select

    gid = next_id()
    async with session_factory() as s:
        s.add(PrivateGroupChannel(id=gid, ersteller_id=3, name="Gruppe"))
        s.add(PrivateGroupMember(id=next_id(), gruppe_id=gid, user_id=3))
        s.add(PrivateGroupMember(id=next_id(), gruppe_id=gid, user_id=4))
        await s.commit()

    async with session_factory() as s:
        await s.execute(delete(PrivateGroupChannel).where(PrivateGroupChannel.id == gid))
        await s.commit()

    async with session_factory() as s:
        uebrig = (
            await s.execute(select(PrivateGroupMember).where(PrivateGroupMember.gruppe_id == gid))
        ).scalars().all()
    assert uebrig == []
