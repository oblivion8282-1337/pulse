"""Tests for the mod-queue endpoints.

Endpoints under test:
  * GET  /guilds/{gid}/mod-queue
  * POST /guilds/{gid}/mod-queue/{rid}/resolve
"""

from __future__ import annotations

import random

import pytest

from dcc_chat_gateway.models import Report


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _uid() -> int:
    return random.randint(1, 1_000_000)


async def _token(signer, *, is_admin: bool = False) -> tuple[str, int]:
    uid = _uid()
    if is_admin:
        return signer.issue_access(uid, f"admin{uid}", is_admin=True), uid
    return signer.issue_access(uid, f"user{uid}"), uid


# ---------------------------------------------------------------------------
# Setup helpers
# ---------------------------------------------------------------------------


async def _make_guild(client, owner_token: str) -> dict:
    r = await client.post("/guilds", json={"name": "testguild"}, headers=auth(owner_token))
    assert r.status_code == 201, r.text
    return r.json()


async def _add_member(client, guild_id: str, uid: int, owner_token: str) -> None:
    r = await client.post(
        f"/guilds/{guild_id}/members",
        json={"user_id": str(uid)},
        headers=auth(owner_token),
    )
    assert r.status_code in (200, 201), r.text


async def _grant_role_with_perms(client, guild_id: str, uid: int, perms: int, owner_token: str):
    role = (
        await client.post(
            f"/guilds/{guild_id}/roles",
            json={"name": "mod", "permissions": str(perms)},
            headers=auth(owner_token),
        )
    ).json()
    await client.put(
        f"/guilds/{guild_id}/members/{uid}/roles/{role['id']}",
        headers=auth(owner_token),
    )
    return role


async def _seed_report(session_factory, reporter_id: int, *, channel_id: int | None = None,
                       user_id: int | None = None, message_id: int | None = None) -> int:
    """Directly insert a Report row bypassing the HTTP rate-limit."""
    from dcc_chat_gateway.snowflake import next_id as _nid

    rid = _nid()
    async with session_factory() as s:
        s.add(Report(
            id=rid,
            reporter_user_id=reporter_id,
            target_channel_id=channel_id,
            target_user_id=user_id,
            target_message_id=message_id,
            reason_code="spam",
            body="Direct seed for mod-queue test — bypasses HTTP path.",
            status="new",
        ))
        await s.commit()
    return rid


# ---------------------------------------------------------------------------
# Permission gate — non-mod gets 403
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_non_mod_cannot_see_queue(client, _auth_signer):
    t_owner, _ = await _token(_auth_signer)
    t_user, _ = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    r = await client.get(f"/guilds/{g['id']}/mod-queue", headers=auth(t_user))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_non_member_cannot_see_queue(client, _auth_signer):
    t_owner, _ = await _token(_auth_signer)
    t_stranger, _ = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    r = await client.get(f"/guilds/{g['id']}/mod-queue", headers=auth(t_stranger))
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# MANAGE_MESSAGES holder can see queue
# ---------------------------------------------------------------------------

_MANAGE_MESSAGES = 1 << 23


@pytest.mark.asyncio
async def test_manage_messages_mod_can_see_queue(client, _auth_signer):
    t_owner, uid_owner = await _token(_auth_signer)
    t_mod, uid_mod = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    await _add_member(client, g["id"], uid_mod, t_owner)
    await _grant_role_with_perms(client, g["id"], uid_mod, _MANAGE_MESSAGES, t_owner)

    r = await client.get(f"/guilds/{g['id']}/mod-queue", headers=auth(t_mod))
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ---------------------------------------------------------------------------
# Scoped listing — cross-guild leak must NOT happen
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mod_queue_channel_scope(client, _auth_signer, session_factory):
    """Reports targeting channels IN this guild appear; others do not."""
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    # Create a channel in our guild.
    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    ch_id = int(ch["id"])

    reporter_uid = _uid()

    # Report targeting OUR channel
    own_rid = await _seed_report(session_factory, reporter_uid, channel_id=ch_id)
    # Report targeting an unrelated channel (random id, not in any guild)
    await _seed_report(session_factory, reporter_uid, channel_id=999_999_888_777)

    r = await client.get(f"/guilds/{g['id']}/mod-queue", headers=auth(t_owner))
    assert r.status_code == 200
    ids = {item["id"] for item in r.json()}
    assert str(own_rid) in ids
    # The unrelated-channel report must not appear
    assert len(ids) == 1


@pytest.mark.asyncio
async def test_mod_queue_user_scope(client, _auth_signer, session_factory):
    """User-only reports only appear when the target user is a member."""
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    t_member, uid_member = await _token(_auth_signer)
    await _add_member(client, g["id"], uid_member, t_owner)

    reporter_uid = _uid()
    uid_outsider = _uid()

    # Report targeting our member
    member_rid = await _seed_report(session_factory, reporter_uid, user_id=uid_member)
    # Report targeting a user who is NOT in this guild
    await _seed_report(session_factory, reporter_uid, user_id=uid_outsider)

    r = await client.get(f"/guilds/{g['id']}/mod-queue", headers=auth(t_owner))
    assert r.status_code == 200
    ids = {item["id"] for item in r.json()}
    assert str(member_rid) in ids
    # Outsider report must not leak into this guild's queue
    assert len(ids) == 1


@pytest.mark.asyncio
async def test_mod_queue_cross_guild_leak_prevented(client, _auth_signer, session_factory):
    """Guild A's mod cannot see reports scoped to Guild B's channels."""
    t_owner_a, _ = await _token(_auth_signer)
    t_owner_b, _ = await _token(_auth_signer)
    g_a = await _make_guild(client, t_owner_a)
    g_b = await _make_guild(client, t_owner_b)

    ch_b = (
        await client.post(
            f"/guilds/{g_b['id']}/channels",
            json={"name": "b-general", "type": 0},
            headers=auth(t_owner_b),
        )
    ).json()

    reporter_uid = _uid()
    await _seed_report(session_factory, reporter_uid, channel_id=int(ch_b["id"]))

    # Guild A's owner queries their own mod queue
    r = await client.get(f"/guilds/{g_a['id']}/mod-queue", headers=auth(t_owner_a))
    assert r.status_code == 200
    assert r.json() == []


# ---------------------------------------------------------------------------
# Resolve + audit-log
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_report_writes_audit_log(client, _auth_signer, session_factory):
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    rid = await _seed_report(session_factory, uid_owner, channel_id=int(ch["id"]))

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json={"resolution": "resolved", "action_type": "message_delete", "resolution_note": "Removed."},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "resolved"
    assert body["resolver_user_id"] == str(uid_owner)

    # Audit log must contain the entry
    log_r = await client.get(f"/guilds/{g['id']}/mod-audit-log", headers=auth(t_owner))
    assert log_r.status_code == 200
    entries = log_r.json()
    assert len(entries) >= 1
    entry = entries[0]
    assert entry["action_type"] == "report_resolved"
    assert entry["actor_user_id"] == str(uid_owner)


@pytest.mark.asyncio
async def test_resolve_already_resolved_409(client, _auth_signer, session_factory):
    t_owner, uid_owner = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)

    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "main", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    rid = await _seed_report(session_factory, uid_owner, channel_id=int(ch["id"]))

    resolve_payload = {"resolution": "dismissed"}
    await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json=resolve_payload,
        headers=auth(t_owner),
    )
    r2 = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json=resolve_payload,
        headers=auth(t_owner),
    )
    assert r2.status_code == 409


@pytest.mark.asyncio
async def test_resolve_non_mod_403(client, _auth_signer, session_factory):
    t_owner, uid_owner = await _token(_auth_signer)
    t_user, uid_user = await _token(_auth_signer)
    g = await _make_guild(client, t_owner)
    await _add_member(client, g["id"], uid_user, t_owner)

    ch = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general", "type": 0},
            headers=auth(t_owner),
        )
    ).json()
    rid = await _seed_report(session_factory, uid_owner, channel_id=int(ch["id"]))

    r = await client.post(
        f"/guilds/{g['id']}/mod-queue/{rid}/resolve",
        json={"resolution": "resolved"},
        headers=auth(t_user),
    )
    assert r.status_code == 403
