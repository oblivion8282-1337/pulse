"""``ablage_kanal_zugriff.py`` — Schluesselabruf ueber einen gemeinsamen
Ablage-Kanal, ohne dass eine gemeinsame Community allein reicht.

Baut Guild/Channel/Rollen direkt ueber die Modelle auf (wie
``test_dropbox_races.py``), statt ueber die Routen — die Zugriffsregel
selbst kennt keine Route.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
import pytest_asyncio

from dcc_chat_gateway.ablage_kanal_zugriff import teilen_ablage_kanal
from dcc_chat_gateway.models import (
    Channel,
    Guild,
    GuildMember,
    MemberRole,
    PermissionOverwrite,
    Role,
)
from dcc_chat_gateway.permissions import Permissions
from dcc_chat_gateway.schluessel_zugriff import darf_schluessel_holen
from dcc_chat_gateway.snowflake import next_id


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


async def _install_block(session_factory, blocker_id: int, blocked_id: int) -> None:
    from dcc_chat_gateway.models import UserBlock

    async with session_factory() as s:
        s.add(UserBlock(blocker_id=blocker_id, blocked_id=blocked_id))
        await s.commit()


async def _guild_mit_kanal(
    session_factory,
    *,
    owner_id: int,
    mitglieder: tuple[int, ...],
    ablage: bool,
    everyone_view: bool = True,
) -> tuple[int, int]:
    """Legt eine Community mit genau einem Kanal (Ablage oder gewoehnlich) an,
    einer @everyone-Rolle und den angegebenen Mitgliedern. Gibt
    ``(guild_id, channel_id)`` zurueck."""
    gid = next_id()
    everyone_id = next_id()
    channel_id = next_id()
    everyone_perms = int(Permissions.VIEW_CHANNEL) if everyone_view else 0
    async with session_factory() as s:
        s.add(Guild(id=gid, name="g", owner_id=owner_id))
        # Flush vor den abhaengigen Zeilen: sonst versucht SQLite, Rolle/Kanal
        # vor der Community selbst einzufuegen (dieselbe Reihenfolge wie
        # ``test_ablage_kanal_postfach_ereignisweg.py::_seed_guild_mit_ablage_kanal``).
        await s.flush()
        s.add(
            Role(
                id=everyone_id,
                guild_id=gid,
                name="@everyone",
                permissions=everyone_perms,
                position=0,
                is_everyone=True,
            )
        )
        s.add(Channel(id=channel_id, guild_id=gid, name="k", type=0, ablage=ablage))
        for uid in mitglieder:
            s.add(
                GuildMember(
                    guild_id=gid, user_id=uid, joined_at=datetime.now(timezone.utc)
                )
            )
        await s.commit()
    return gid, channel_id


@pytest.mark.asyncio
async def test_gemeinsamer_ablage_kanal_erlaubt_den_schluesselabruf(session_factory):
    """Der Kernfall: zwei nicht befreundete Mitglieder eines gemeinsamen
    Ablage-Kanals duerfen die Geraeteschluessel des jeweils anderen holen."""
    _gid, _cid = await _guild_mit_kanal(
        session_factory, owner_id=100, mitglieder=(100, 101), ablage=True
    )
    async with session_factory() as s:
        assert await teilen_ablage_kanal(s, 100, 101) is True
        assert await teilen_ablage_kanal(s, 101, 100) is True
        assert await darf_schluessel_holen(s, 100, 101) is True


@pytest.mark.asyncio
async def test_gemeinsame_community_ohne_ablage_kanal_reicht_nicht(session_factory):
    """Eine gemeinsame Community allein darf NICHT genuegen — sonst koennte
    jedes Mitglied einer grossen Community die Schluessel jedes anderen
    abholen. Bezugspunkt ist der Kanal, nicht die Community."""
    _gid, _cid = await _guild_mit_kanal(
        session_factory, owner_id=110, mitglieder=(110, 111), ablage=False
    )
    async with session_factory() as s:
        assert await teilen_ablage_kanal(s, 110, 111) is False
        assert await darf_schluessel_holen(s, 110, 111) is False


@pytest.mark.asyncio
async def test_gewoehnlicher_textkanal_zaehlt_nicht_als_ablage(session_factory):
    """``ablage=false`` ist der Regelfall jeder Community — ein gemeinsamer
    normaler Kanal darf den Schluesselabruf nicht oeffnen."""
    gid = next_id()
    everyone_id = next_id()
    channel_id = next_id()
    async with session_factory() as s:
        s.add(Guild(id=gid, name="g", owner_id=120))
        await s.flush()
        s.add(
            Role(
                id=everyone_id,
                guild_id=gid,
                name="@everyone",
                permissions=int(Permissions.VIEW_CHANNEL),
                position=0,
                is_everyone=True,
            )
        )
        s.add(Channel(id=channel_id, guild_id=gid, name="allgemein", type=0, ablage=False))
        for uid in (120, 121):
            s.add(GuildMember(guild_id=gid, user_id=uid, joined_at=datetime.now(timezone.utc)))
        await s.commit()

    async with session_factory() as s:
        assert await teilen_ablage_kanal(s, 120, 121) is False


@pytest.mark.asyncio
async def test_ablage_kanal_ohne_view_channel_reicht_nicht(session_factory):
    """Ein Ablage-Kanal alleine genuegt nicht — beide muessen ihn auch
    tatsaechlich sehen duerfen (VIEW_CHANNEL), nicht nur Mitglied der
    Community sein. Hier verweigert die @everyone-Rolle selbst die Sicht."""
    _gid, _cid = await _guild_mit_kanal(
        session_factory,
        owner_id=130,
        mitglieder=(130, 131),
        ablage=True,
        everyone_view=False,
    )
    async with session_factory() as s:
        assert await teilen_ablage_kanal(s, 130, 131) is False


@pytest.mark.asyncio
async def test_user_overwrite_verweigert_einem_einzelnen_die_sicht(session_factory):
    """@everyone erlaubt VIEW_CHANNEL, aber ein User-Overwrite verbietet es
    genau einem der beiden — auch dann darf kein gemeinsamer Ablage-Kanal
    zustande kommen."""
    gid, cid = await _guild_mit_kanal(
        session_factory, owner_id=140, mitglieder=(140, 141), ablage=True
    )
    async with session_factory() as s:
        s.add(
            PermissionOverwrite(
                channel_id=cid,
                target_type=1,  # Nutzer
                target_id=141,
                allow_bf=0,
                deny_bf=int(Permissions.VIEW_CHANNEL),
            )
        )
        await s.commit()

    async with session_factory() as s:
        assert await teilen_ablage_kanal(s, 140, 141) is False
        assert await darf_schluessel_holen(s, 140, 141) is False


@pytest.mark.asyncio
async def test_rollen_overwrite_kann_die_sicht_wieder_freigeben(session_factory):
    """Gegenprobe zum vorigen Test: eine Rolle mit explizitem Allow holt
    VIEW_CHANNEL zurueck, obwohl @everyone es verweigert — der Resolver
    entscheidet, nicht ein Kurzschluss auf Community-Ebene."""
    gid, cid = await _guild_mit_kanal(
        session_factory,
        owner_id=150,
        mitglieder=(150, 151),
        ablage=True,
        everyone_view=False,
    )
    role_id = next_id()
    async with session_factory() as s:
        s.add(
            Role(
                id=role_id,
                guild_id=gid,
                name="sichtbar",
                permissions=0,
                position=1,
                is_everyone=False,
            )
        )
        await s.flush()
        s.add(MemberRole(guild_id=gid, user_id=151, role_id=role_id))
        s.add(
            PermissionOverwrite(
                channel_id=cid,
                target_type=0,  # Rolle
                target_id=role_id,
                allow_bf=int(Permissions.VIEW_CHANNEL),
                deny_bf=0,
            )
        )
        await s.commit()

    async with session_factory() as s:
        # 150 (Owner) sieht ohnehin alles; 151 haengt an der Rolle.
        assert await teilen_ablage_kanal(s, 150, 151) is True


@pytest.mark.asyncio
async def test_blockierung_geht_dem_ablage_kanal_beim_schluesselabruf_vor(
    session_factory,
):
    """Dieselbe Gewichtung wie bei der privaten Gruppe: Blockierung schlaegt
    einen gemeinsamen Ablage-Kanal."""
    _gid, _cid = await _guild_mit_kanal(
        session_factory, owner_id=160, mitglieder=(160, 161), ablage=True
    )
    await _install_block(session_factory, 161, 160)  # 161 blockiert 160.
    async with session_factory() as s:
        # Der Kanalzugriff selbst bleibt unberuehrt vom Block ...
        assert await teilen_ablage_kanal(s, 160, 161) is True
        # ... aber die Gesamtregel weist trotzdem ab.
        assert await darf_schluessel_holen(s, 160, 161) is False


@pytest.mark.asyncio
async def test_eigenes_konto_ohne_kandidaten_bleibt_erlaubt(session_factory):
    """Randfall: dieselbe ID zweimal darf nicht in die Kandidatensuche
    hineinlaufen (Self-Join-Falle wie bei ``teilen_private_gruppe``)."""
    async with session_factory() as s:
        assert await teilen_ablage_kanal(s, 170, 170) is False
        # Der eigentliche Kurzschluss fuer das eigene Konto passiert eine
        # Ebene hoeher, in ``darf_schluessel_holen`` — dort bereits durch
        # bestehende Tests abgedeckt.
