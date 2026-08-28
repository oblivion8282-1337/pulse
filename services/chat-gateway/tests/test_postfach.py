"""Das Postfach: Nutzlast und Zustellung getrennt."""

import pytest
import pytest_asyncio


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """SQLite ignoriert ``ON DELETE CASCADE`` ohne ``PRAGMA foreign_keys=ON``
    je Verbindung — derselbe Weg wie in ``test_schluessel.py``. Die
    Test-Engine nutzt ``StaticPool`` (eine geteilte In-Memory-Verbindung),
    deshalb genuegt ein einmaliges PRAGMA auf dieser einen Verbindung.
    """
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


@pytest.mark.asyncio
async def test_eine_nutzlast_traegt_mehrere_zustellungen(session_factory):
    """Der Gruppenfall. Megolm verschluesselt EINMAL fuer alle — ohne diese
    Trennung muesste derselbe Umschlag je Geraet kopiert werden, und bei
    zwanzig Mitgliedern mit je zwei Geraeten waeren das vierzig Kopien
    derselben Bytes.
    """
    from sqlalchemy import select

    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.snowflake import next_id

    nid = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid, channel_id=1, absender_device_pubkey="A",
            art=1, daten="umschlag", groesse=8,
        ))
        for pubkey in ("G1", "G2", "G3"):
            s.add(DmZustellung(
                id=next_id(), nutzlast_id=nid,
                empfaenger_device_pubkey=pubkey, empfaenger_user_id=2,
            ))
        await s.commit()

    async with session_factory() as s:
        zustellungen = (await s.execute(
            select(DmZustellung).where(DmZustellung.nutzlast_id == nid)
        )).scalars().all()
        assert len(zustellungen) == 3


@pytest.mark.asyncio
async def test_zustellungen_verschwinden_mit_ihrer_nutzlast(session_factory):
    """Eine Zustellung ohne Nutzlast ist ein Zeiger ins Leere."""
    from sqlalchemy import delete, select

    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.snowflake import next_id

    nid = next_id()
    async with session_factory() as s:
        s.add(DmNutzlast(
            id=nid, channel_id=1, absender_device_pubkey="A",
            art=1, daten="x", groesse=1,
        ))
        s.add(DmZustellung(
            id=next_id(), nutzlast_id=nid,
            empfaenger_device_pubkey="G1", empfaenger_user_id=2,
        ))
        await s.commit()

    async with session_factory() as s:
        await s.execute(delete(DmNutzlast).where(DmNutzlast.id == nid))
        await s.commit()

    async with session_factory() as s:
        rest = (await s.execute(
            select(DmZustellung).where(DmZustellung.nutzlast_id == nid)
        )).scalars().all()
        assert rest == []
