"""Smoke tests for the role-related models from migration 0009.

These exercise the SQLAlchemy mappings + constraints. The Alembic
migration itself is not run during the test-suite (tests use
``Base.metadata.create_all`` for speed); this file is the safety net
that catches "the model is broken" separately from "the migration is
broken". Migration is verified manually against a Postgres dev-DB
before deploy — see the Phase-1 review notes.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.models import (
    Guild,
    GuildMember,
    MemberRole,
    PermissionOverwrite,
    Role,
)
from dcc_chat_gateway.snowflake import next_id
from dcc_shared.permissions import DEFAULT_EVERYONE_PERMISSIONS, Permissions


@pytest_asyncio.fixture
async def seeded_guild(session_factory):
    """One guild with one member — minimum surface to attach roles to."""
    async with session_factory() as s:
        g = Guild(id=next_id(), name="g", owner_id=42)
        s.add(g)
        await s.flush()
        s.add(GuildMember(guild_id=g.id, user_id=42))
        await s.commit()
        return g.id


@pytest.mark.asyncio
async def test_can_insert_everyone_role(session_factory, seeded_guild):
    async with session_factory() as s:
        role = Role(
            id=next_id(),
            guild_id=seeded_guild,
            name="@everyone",
            permissions=DEFAULT_EVERYONE_PERMISSIONS,
            position=0,
            is_everyone=True,
        )
        s.add(role)
        await s.commit()
        assert role.id is not None


@pytest.mark.asyncio
async def test_can_assign_member_to_role(session_factory, seeded_guild):
    async with session_factory() as s:
        role = Role(
            id=next_id(),
            guild_id=seeded_guild,
            name="Mods",
            permissions=int(Permissions.MANAGE_MESSAGES),
        )
        s.add(role)
        await s.flush()
        s.add(MemberRole(guild_id=seeded_guild, user_id=42, role_id=role.id))
        await s.commit()


@pytest.mark.asyncio
async def test_role_permissions_round_trip_full_bitfield(
    session_factory, seeded_guild
):
    """Largest bit (ADMINISTRATOR = 1<<51) survives a Postgres BIGINT
    round-trip. The SQLite-backed test still catches Python-side issues
    (e.g. accidental truncation through a 32-bit int)."""
    from sqlalchemy import select

    bf = int(Permissions.ADMINISTRATOR | Permissions.MANAGE_GUILD)
    async with session_factory() as s:
        role = Role(
            id=next_id(), guild_id=seeded_guild, name="r", permissions=bf
        )
        s.add(role)
        await s.commit()
        loaded = (await s.execute(select(Role).where(Role.id == role.id))).scalar_one()
        assert loaded.permissions == bf


@pytest.mark.asyncio
async def test_permission_overwrite_target_type_check(session_factory, seeded_guild):
    """target_type must be 0 (role) or 1 (user). 99 must be rejected.

    Note: SQLite enforces ``CHECK`` constraints by default — Postgres
    does too. Sanity-check the constraint is wired up at all."""
    from dcc_chat_gateway.models import Channel

    async with session_factory() as s:
        channel = Channel(id=next_id(), guild_id=seeded_guild, name="general")
        s.add(channel)
        await s.commit()
        bad = PermissionOverwrite(
            channel_id=channel.id, target_type=99, target_id=1, allow_bf=0, deny_bf=0
        )
        s.add(bad)
        with pytest.raises(IntegrityError):
            await s.commit()
