"""Leave-guild (self-removal) endpoint coverage.

Endpoint: DELETE /guilds/{gid}/members/@me

Covers: any member may leave; the owner may NOT (``owner_cannot_leave``);
a non-member → 404; the ``GuildMember`` row + the user's channel-overwrites are
removed; post-leave the membership gate 403s. Works the same on Cloud and
Self-Host (it's the same chat-gateway route).

The ``@me`` route MUST be matched ahead of the ``{user_id}`` kick route — if the
order regressed, ``@me`` would be parsed as ``user_id`` (an int) and 422; the
204 below guards that.
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
    """Owner + one regular member."""
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_a, uid_a = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "leavetown"}, headers=auth(t_owner))
    ).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_a)},
        headers=auth(t_owner),
    )
    return {"t_owner": t_owner, "uid_owner": uid_owner, "t_a": t_a, "uid_a": uid_a, "g": g}


@pytest.mark.asyncio
async def test_member_can_leave(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    r = await client.delete(
        f"/guilds/{s['g']['id']}/members/@me", headers=auth(s["t_a"])
    )
    assert r.status_code == 204, r.text
    # Owner's member list no longer carries the leaver.
    body = (
        await client.get(f"/guilds/{s['g']['id']}/members", headers=auth(s["t_owner"]))
    ).json()
    assert all(m["user_id"] != str(s["uid_a"]) for m in body)


@pytest.mark.asyncio
async def test_owner_cannot_leave(client, _auth_signer):
    """The owner can't just leave — that would orphan the guild. Ownership
    transfer or delete is the only path."""
    s = await _setup(client, _auth_signer)
    r = await client.delete(
        f"/guilds/{s['g']['id']}/members/@me", headers=auth(s["t_owner"])
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "owner_cannot_leave"


@pytest.mark.asyncio
async def test_leave_as_nonmember_is_404(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    t_outsider, _ = await _register_user(_auth_signer)
    r = await client.delete(
        f"/guilds/{s['g']['id']}/members/@me", headers=auth(t_outsider)
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_leave_removes_member_row(client, _auth_signer, session_factory):
    s = await _setup(client, _auth_signer)
    gid = int(s["g"]["id"])
    r = await client.delete(f"/guilds/{gid}/members/@me", headers=auth(s["t_a"]))
    assert r.status_code == 204
    async with session_factory() as ses:
        rows = (
            await ses.execute(
                select(GuildMember).where(
                    GuildMember.guild_id == gid, GuildMember.user_id == s["uid_a"]
                )
            )
        ).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_leave_wipes_user_channel_overwrites(
    client, _auth_signer, session_factory
):
    s = await _setup(client, _auth_signer)
    gid = int(s["g"]["id"])
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
    r = await client.delete(f"/guilds/{gid}/members/@me", headers=auth(s["t_a"]))
    assert r.status_code == 204
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
async def test_left_user_cannot_access_guild(client, _auth_signer):
    s = await _setup(client, _auth_signer)
    gid = int(s["g"]["id"])
    await client.delete(f"/guilds/{gid}/members/@me", headers=auth(s["t_a"]))
    r = await client.get(f"/guilds/{gid}/members", headers=auth(s["t_a"]))
    assert r.status_code == 403
