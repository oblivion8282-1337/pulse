"""Tests für das WS-Op-Gate bei Plugin-Ops.

Direkter Unit-Test gegen ``check_plugin_op_gate`` — das deckt die drei
Gate-Stufen (Allowlist / Membership / Guild-Toggle) präziser ab als
ein voller WS-Round-Trip-Test, ohne Test-DB-Schema-Overhead.

Der Cache wird vor jedem Test geleert, damit der TTL-Pfad nicht zwei
Tests miteinander koppelt.
"""

from __future__ import annotations

import pytest
from dcc_chat_gateway.models import Guild, GuildMember, GuildPlugin
from dcc_chat_gateway.plugins.ws_op_gate import (
    _clear_cache,
    check_plugin_op_gate,
    parse_plugin_op,
)


@pytest.fixture(autouse=True)
def _reset_cache():
    _clear_cache()
    yield
    _clear_cache()


def test_parse_plugin_op_recognises_colon():
    assert parse_plugin_op("tamagotchi:feed") == ("tamagotchi", "feed")
    assert parse_plugin_op("hello:ping") == ("hello", "ping")


def test_parse_plugin_op_rejects_built_ins():
    assert parse_plugin_op("send") is None
    assert parse_plugin_op("subscribe") is None


def test_parse_plugin_op_rejects_empty_halves():
    assert parse_plugin_op(":feed") is None
    assert parse_plugin_op("tama:") is None


@pytest.mark.asyncio
async def test_gate_allows_non_plugin_op(session_factory):
    """Built-in-Ops dürfen das Gate gar nicht anfassen."""
    async with session_factory() as s:
        decision = await check_plugin_op_gate(
            session=s,
            op="send",
            payload={},
            user_id=1,
            allowlist=frozenset(),
        )
    assert decision.allowed is True


@pytest.mark.asyncio
async def test_gate_blocks_plugin_not_in_allowlist(session_factory):
    async with session_factory() as s:
        decision = await check_plugin_op_gate(
            session=s,
            op="tamagotchi:feed",
            payload={"guild_id": "1"},
            user_id=1,
            allowlist=frozenset(),
        )
    assert decision.allowed is False
    assert decision.error_code == 4013


@pytest.mark.asyncio
async def test_gate_blocks_missing_guild_id(session_factory):
    async with session_factory() as s:
        decision = await check_plugin_op_gate(
            session=s,
            op="tamagotchi:feed",
            payload={},  # no guild_id
            user_id=1,
            allowlist=frozenset({"tamagotchi"}),
        )
    assert decision.allowed is False
    assert decision.error_code == 4014


@pytest.mark.asyncio
async def test_gate_blocks_non_member(session_factory):
    async with session_factory() as s:
        # Eine Guild ohne den Aufrufer als Mitglied.
        s.add(Guild(id=100, name="test", owner_id=999))
        await s.commit()
        decision = await check_plugin_op_gate(
            session=s,
            op="tamagotchi:feed",
            payload={"guild_id": "100"},
            user_id=1,
            allowlist=frozenset({"tamagotchi"}),
        )
    assert decision.allowed is False
    assert decision.error_code == 4015


@pytest.mark.asyncio
async def test_gate_blocks_plugin_disabled_for_guild(session_factory):
    async with session_factory() as s:
        s.add(Guild(id=101, name="t", owner_id=1))
        s.add(GuildMember(guild_id=101, user_id=1))
        # KEIN GuildPlugin-Row → default disabled.
        await s.commit()
        decision = await check_plugin_op_gate(
            session=s,
            op="tamagotchi:feed",
            payload={"guild_id": "101"},
            user_id=1,
            allowlist=frozenset({"tamagotchi"}),
        )
    assert decision.allowed is False
    assert decision.error_code == 4016


@pytest.mark.asyncio
async def test_gate_blocks_plugin_explicit_disabled(session_factory):
    async with session_factory() as s:
        s.add(Guild(id=102, name="t", owner_id=1))
        s.add(GuildMember(guild_id=102, user_id=1))
        s.add(
            GuildPlugin(
                guild_id=102,
                plugin_name="tamagotchi",
                enabled=False,
                enabled_by_user_id=1,
            )
        )
        await s.commit()
        decision = await check_plugin_op_gate(
            session=s,
            op="tamagotchi:feed",
            payload={"guild_id": "102"},
            user_id=1,
            allowlist=frozenset({"tamagotchi"}),
        )
    assert decision.allowed is False


@pytest.mark.asyncio
async def test_gate_allows_enabled_plugin_for_member(session_factory):
    """Happy-Path: Allowlist + Membership + enabled=true → pass."""
    async with session_factory() as s:
        s.add(Guild(id=103, name="t", owner_id=1))
        s.add(GuildMember(guild_id=103, user_id=1))
        s.add(
            GuildPlugin(
                guild_id=103,
                plugin_name="tamagotchi",
                enabled=True,
                enabled_by_user_id=1,
            )
        )
        await s.commit()
        decision = await check_plugin_op_gate(
            session=s,
            op="tamagotchi:feed",
            payload={"guild_id": "103"},
            user_id=1,
            allowlist=frozenset({"tamagotchi"}),
        )
    assert decision.allowed is True


@pytest.mark.asyncio
async def test_gate_hello_bypasses_guild_checks(session_factory):
    """``hello`` ist instanzweit aktiv — kein guild_id-Check, keine
    Membership, kein Toggle-Lookup. Nur Allowlist greift.
    """
    async with session_factory() as s:
        decision = await check_plugin_op_gate(
            session=s,
            op="hello:ping",
            payload={},
            user_id=1,
            allowlist=frozenset({"hello"}),
        )
    assert decision.allowed is True


@pytest.mark.asyncio
async def test_gate_hello_still_needs_allowlist(session_factory):
    """``hello`` darf das Gate nur passieren, wenn es in der Allowlist
    steht (auch wenn das im Prod-Lifecycle immer der Fall ist)."""
    async with session_factory() as s:
        decision = await check_plugin_op_gate(
            session=s,
            op="hello:ping",
            payload={},
            user_id=1,
            allowlist=frozenset(),
        )
    assert decision.allowed is False
    assert decision.error_code == 4013


@pytest.mark.asyncio
async def test_gate_accepts_guild_id_as_int(session_factory):
    """guild_id darf als int kommen (Python-internal), nicht nur als
    String (JS-Wire-Format)."""
    async with session_factory() as s:
        s.add(Guild(id=104, name="t", owner_id=1))
        s.add(GuildMember(guild_id=104, user_id=1))
        s.add(
            GuildPlugin(
                guild_id=104,
                plugin_name="tamagotchi",
                enabled=True,
                enabled_by_user_id=1,
            )
        )
        await s.commit()
        decision = await check_plugin_op_gate(
            session=s,
            op="tamagotchi:feed",
            payload={"guild_id": 104},  # int statt str
            user_id=1,
            allowlist=frozenset({"tamagotchi"}),
        )
    assert decision.allowed is True
