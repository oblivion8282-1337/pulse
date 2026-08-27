"""Das Geraete-Schluesselverzeichnis."""

import pytest
import pytest_asyncio


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """SQLite ignoriert ``ON DELETE CASCADE`` ohne ``PRAGMA foreign_keys=ON``
    je Verbindung. Postgres (Prod) erzwingt das ohnehin — dieselbe Falle wie
    in ``services/auth/tests/test_account_delete.py``. Die Test-Engine nutzt
    ``StaticPool`` (eine geteilte In-Memory-Verbindung), deshalb genuegt ein
    einmaliges PRAGMA auf dieser einen Verbindung, ohne Dispose+Neuanlage.
    """
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


@pytest.mark.asyncio
async def test_ein_geraet_hat_hoechstens_ein_buendel(session_factory):
    """Zweimal dasselbe Geraet darf keine zweite Zeile anlegen.

    Sonst hielte das Verzeichnis zwei Identitaeten fuer dasselbe Geraet, und
    welche ein Absender bekaeme, entschiede die Zeilenreihenfolge.
    """
    from sqlalchemy.exc import IntegrityError

    from dcc_chat_gateway.models import DeviceKeyBundle
    from dcc_chat_gateway.snowflake import next_id

    async with session_factory() as s:
        s.add(DeviceKeyBundle(
            id=next_id(), user_id=1, device_pubkey="AAA", curve25519="BBB",
            signatur="CCC", cert_id="c1",
        ))
        await s.commit()

    with pytest.raises(IntegrityError):
        async with session_factory() as s:
            s.add(DeviceKeyBundle(
                id=next_id(), user_id=1, device_pubkey="AAA", curve25519="XXX",
                signatur="YYY", cert_id="c2",
            ))
            await s.commit()


@pytest.mark.asyncio
async def test_einmalschluessel_verschwinden_mit_ihrem_buendel(session_factory):
    """Ein Geraet abmelden heisst: sein Vorrat ist weg, nicht verwaist."""
    from sqlalchemy import delete, select

    from dcc_chat_gateway.models import DeviceKeyBundle, DeviceOneTimeKey
    from dcc_chat_gateway.snowflake import next_id

    bid = next_id()
    async with session_factory() as s:
        s.add(DeviceKeyBundle(
            id=bid, user_id=2, device_pubkey="DDD", curve25519="EEE",
            signatur="FFF", cert_id="c3",
        ))
        s.add(DeviceOneTimeKey(id=next_id(), bundle_id=bid, schluessel="k1"))
        await s.commit()

    async with session_factory() as s:
        await s.execute(delete(DeviceKeyBundle).where(DeviceKeyBundle.id == bid))
        await s.commit()

    async with session_factory() as s:
        uebrig = (await s.execute(
            select(DeviceOneTimeKey).where(DeviceOneTimeKey.bundle_id == bid)
        )).scalars().all()
        assert uebrig == []
