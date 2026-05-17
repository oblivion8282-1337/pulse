"""Reaction add/remove on guild + DM messages.

Regression for the bug where `_load_for_reaction` did a `session.get(Channel, ...)`
which returned `None` for DM messages (DM rows live in a separate table), so
DM reactions always 404'd. Fix is in routes/reactions.py — it now uses
`resolve_channel_or_raise` like messages.py.
"""

from __future__ import annotations

import random

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    uid = uid or random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"user{uid}")
    return token, uid


async def _make_guild_with_channel(client, _auth_signer):
    """Returns (owner_token, owner_uid, member_token, member_uid, channel_id)."""
    t1, uid1 = await _register_user(_auth_signer)
    t2, uid2 = await _register_user(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=auth(t1))).json()
    await client.post(
        f"/guilds/{g['id']}/members", json={"user_id": uid2}, headers=auth(t1)
    )
    c = (await client.post(
        f"/guilds/{g['id']}/channels", json={"name": "general"}, headers=auth(t1)
    )).json()
    return t1, uid1, t2, uid2, c["id"]


async def _make_dm(client, _auth_signer):
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    dm = (
        await client.post(
            "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
        )
    ).json()
    return t_a, uid_a, t_b, uid_b, dm["id"]


@pytest.mark.asyncio
async def test_guild_reaction_add_and_remove(client, _auth_signer):
    t1, _, t2, _, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "hi"}, headers=auth(t1)
        )
    ).json()

    # Member adds + removes a reaction.
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%F0%9F%91%8D/@me", headers=auth(t2)
    )
    assert r.status_code == 204, r.text
    r = await client.delete(
        f"/messages/{msg['id']}/reactions/%F0%9F%91%8D/@me", headers=auth(t2)
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_dm_reaction_add_and_remove(client, _auth_signer):
    """Regression: DM reactions used to always 404 because reactions.py
    looked up the channel in the guild ``Channel`` table only."""
    t_a, _, t_b, _, dm_id = await _make_dm(client, _auth_signer)
    msg = (
        await client.post(
            f"/channels/{dm_id}/messages", json={"content": "dm hi"}, headers=auth(t_a)
        )
    ).json()

    # The other DM member can react.
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%E2%9D%A4/@me", headers=auth(t_b)
    )
    assert r.status_code == 204, r.text
    r = await client.delete(
        f"/messages/{msg['id']}/reactions/%E2%9D%A4/@me", headers=auth(t_b)
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_non_member_cannot_react_to_dm(client, _auth_signer):
    """A third user (not in the DM) gets 404 — same status as listing the DM."""
    t_a, _, _, _, dm_id = await _make_dm(client, _auth_signer)
    msg = (
        await client.post(
            f"/channels/{dm_id}/messages", json={"content": "private"}, headers=auth(t_a)
        )
    ).json()
    t_c, _ = await _register_user(_auth_signer)
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%F0%9F%91%80/@me", headers=auth(t_c)
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_non_member_cannot_react_to_guild_message(client, _auth_signer):
    """Non-member of a guild gets 403 on the guild channel reaction route."""
    t1, _, _, _, cid = await _make_guild_with_channel(client, _auth_signer)
    msg = (
        await client.post(
            f"/channels/{cid}/messages", json={"content": "hi"}, headers=auth(t1)
        )
    ).json()
    t_other, _ = await _register_user(_auth_signer)
    r = await client.put(
        f"/messages/{msg['id']}/reactions/%F0%9F%91%8D/@me", headers=auth(t_other)
    )
    assert r.status_code == 403
