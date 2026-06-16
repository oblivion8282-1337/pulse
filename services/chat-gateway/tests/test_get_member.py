"""GET /guilds/{gid}/members/{uid} — single-member fetch.

Used by voice-signaling's admin mute / move endpoints to confirm the
*target* user is a member of the channel's guild. Before this route
existed the path matched only PATCH/DELETE, so a GET replied 405, which
voice-signaling surfaced to the client as ``membership check
unavailable``. These tests lock the 200 / 404 / 403 contract that path
relies on.
"""

from __future__ import annotations

import random

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


@pytest.mark.asyncio
async def test_get_member_returns_member(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "m"}, headers=auth(t_owner))
    ).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_other)},
        headers=auth(t_owner),
    )
    r = await client.get(
        f"/guilds/{g['id']}/members/{uid_other}", headers=auth(t_owner)
    )
    assert r.status_code == 200, r.text
    assert str(r.json()["user_id"]) == str(uid_other)


@pytest.mark.asyncio
async def test_get_member_non_member_target_404(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "m"}, headers=auth(t_owner))
    ).json()
    r = await client.get(
        f"/guilds/{g['id']}/members/999999", headers=auth(t_owner)
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_member_caller_not_member_403(client, _auth_signer):
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_outsider, _ = await _register_user(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "m"}, headers=auth(t_owner))
    ).json()
    r = await client.get(
        f"/guilds/{g['id']}/members/{uid_owner}", headers=auth(t_outsider)
    )
    assert r.status_code == 403
