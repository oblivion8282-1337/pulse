"""Kick-member endpoint coverage.

Endpoint: DELETE /guilds/{gid}/members/{uid}

Covers KICK_MEMBERS gate, the owner / self protections, member-role
CASCADE side effect, and the channel-overwrite cleanup.
"""

from __future__ import annotations

import random

import pytest
from sqlalchemy import select

from dcc_chat_gateway.models import GuildMember, PermissionOverwrite


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _setup(client, _auth_signer) -> dict:
    """Owner + two regular members. Returns tokens + ids + the guild dict."""
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "kicktown"}, headers=auth(t_owner))
    ).json()
    for uid in (uid_a, uid_b):
        await client.post(
            f"/guilds/{g['id']}/members",
            json={"user_id": str(uid)},
            headers=auth(t_owner),
        )
    return {
        "t_owner": t_owner,
        "uid_owner": uid_owner,
        "t_a": t_a,
        "uid_a": uid_a,
        "t_b": t_b,
        "uid_b": uid_b,
        "g": g,
    }


@pytest.mark.asyncio
async def test_owner_can_kick_member(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    r = await client.delete(
        f"/guilds/{s['g']['id']}/members/{s['uid_a']}",
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 204
    # Member list no longer carries the kicked user.
    r2 = await client.get(
        f"/guilds/{s['g']['id']}/members", headers=auth(s["t_owner"])
    )
    body = r2.json()
    assert all(m["user_id"] != str(s["uid_a"]) for m in body)


@pytest.mark.asyncio
async def test_cannot_kick_self(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    r = await client.delete(
        f"/guilds/{s['g']['id']}/members/{s['uid_owner']}",
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_cannot_kick_owner(client, _auth_signer):
    """Even a global admin can't kick the guild owner — ownership
    transfer is the only path off the owner-id slot."""
    s = await _setup(client, _auth_signer)
    admin_token = _auth_signer.issue_access(
        random.randint(1, 1_000_000), "globaladmin", is_admin=True
    )
    r = await client.delete(
        f"/guilds/{s['g']['id']}/members/{s['uid_owner']}",
        headers=auth(admin_token),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_non_permitted_member_is_403(client, _auth_signer):
    """Regular member (no KICK_MEMBERS) trying to kick another member."""
    s = await _setup(client, _auth_signer)
    r = await client.delete(
        f"/guilds/{s['g']['id']}/members/{s['uid_b']}",
        headers=auth(s["t_a"]),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_kick_nonexistent_member_is_404(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    r = await client.delete(
        f"/guilds/{s['g']['id']}/members/9999999",
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_kick_removes_guild_member_row(client, _auth_signer, session_factory):
    """The GuildMember row is hard-deleted. The composite FK from
    ``member_roles`` to ``guild_members(guild_id, user_id)`` cascades the
    role-assignments in production (Postgres); SQLite under test doesn't
    enforce FKs by default so we don't assert on the role rows here."""
    s = await _setup(client, _auth_signer)
    gid = int(s["g"]["id"])
    r = await client.delete(
        f"/guilds/{gid}/members/{s['uid_a']}",
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 204
    async with session_factory() as ses:
        rows = (
            await ses.execute(
                select(GuildMember).where(
                    GuildMember.guild_id == gid,
                    GuildMember.user_id == s["uid_a"],
                )
            )
        ).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_kick_wipes_user_channel_overwrites(
    client, _auth_signer, session_factory
):
    """User-target overwrites on every guild channel get cleaned up."""
    s = await _setup(client, _auth_signer)
    gid = int(s["g"]["id"])
    # Create a channel, then a user-overwrite for user A on it.
    channel = (
        await client.post(
            f"/guilds/{gid}/channels",
            json={"name": "general", "type": 0},
            headers=auth(s["t_owner"]),
        )
    ).json()
    pr = await client.put(
        f"/channels/{channel['id']}/permissions/1/{s['uid_a']}",  # 1 = user target_type
        json={"allow": "0", "deny": "1048576"},  # deny VIEW_CHANNEL
        headers=auth(s["t_owner"]),
    )
    assert pr.status_code == 200, pr.text  # overwrite must actually exist first
    # Kick A.
    r = await client.delete(
        f"/guilds/{gid}/members/{s['uid_a']}",
        headers=auth(s["t_owner"]),
    )
    assert r.status_code == 204
    # User-target overwrite for A is gone.
    async with session_factory() as ses:
        rows = (
            await ses.execute(
                select(PermissionOverwrite).where(
                    PermissionOverwrite.channel_id == int(channel["id"]),
                    PermissionOverwrite.target_type == 1,
                    PermissionOverwrite.target_id == s["uid_a"],
                )
            )
        ).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_kicked_user_cannot_access_guild(client, _auth_signer):
    """Post-kick, the user's bearer can no longer GET guild members
    — exercise the existing membership gate."""
    s = await _setup(client, _auth_signer)
    gid = int(s["g"]["id"])
    await client.delete(
        f"/guilds/{gid}/members/{s['uid_a']}",
        headers=auth(s["t_owner"]),
    )
    r = await client.get(f"/guilds/{gid}/members", headers=auth(s["t_a"]))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_mod_can_kick_peer_mod_no_hierarchy(client, _auth_signer):
    """No position-hierarchy in v1 — a mod with KICK_MEMBERS can kick
    a peer mod. Self-host MVP trust model; flip if Discord-style
    position-based hierarchy lands later."""
    s = await _setup(client, _auth_signer)
    mod_role = (
        await client.post(
            f"/guilds/{s['g']['id']}/roles",
            json={
                "name": "mod",
                "permissions": str(1 << 8),  # KICK_MEMBERS
            },
            headers=auth(s["t_owner"]),
        )
    ).json()
    for uid in (s["uid_a"], s["uid_b"]):
        await client.put(
            f"/guilds/{s['g']['id']}/members/{uid}/roles/{mod_role['id']}",
            headers=auth(s["t_owner"]),
        )
    r = await client.delete(
        f"/guilds/{s['g']['id']}/members/{s['uid_b']}",
        headers=auth(s["t_a"]),
    )
    assert r.status_code == 204
