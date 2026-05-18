"""Owner-Transfer endpoint coverage.

Endpoint: POST /guilds/{guild_id}/transfer-ownership

Covers the happy path, the confirm_name gate, the "must be a member"
constraint, and the non-owner-forbidden case. The post-transfer
behaviour (ex-owner loses owner privileges) is asserted by attempting a
guild rename right after.
"""

from __future__ import annotations

import random

import pytest


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"user{uid}"), uid


async def _setup_guild_with_second_member(client, _auth_signer):
    t_owner, uid_owner = await _register_user(_auth_signer)
    t_other, uid_other = await _register_user(_auth_signer)
    g = (
        await client.post(
            "/guilds", json={"name": "transferable"}, headers=auth(t_owner)
        )
    ).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_other)},
        headers=auth(t_owner),
    )
    return t_owner, uid_owner, t_other, uid_other, g


@pytest.mark.asyncio
async def test_owner_can_transfer(client, _auth_signer):
    t_owner, _, t_other, uid_other, g = await _setup_guild_with_second_member(
        client, _auth_signer
    )

    r = await client.post(
        f"/guilds/{g['id']}/transfer-ownership",
        json={"new_owner_id": str(uid_other), "confirm_name": g["name"]},
        headers=auth(t_owner),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["owner_id"] == str(uid_other)

    # New owner can now rename the guild...
    r2 = await client.post(
        f"/guilds/{g['id']}/transfer-ownership",
        json={"new_owner_id": str(uid_other), "confirm_name": body["name"]},
        headers=auth(t_other),
    )
    # ...and a second self-transfer should fail with "cannot transfer to self"
    assert r2.status_code == 400


@pytest.mark.asyncio
async def test_transfer_loses_owner_privileges(client, _auth_signer):
    """Ex-owner cannot rename the guild after handing it over."""
    t_owner, _, _, uid_other, g = await _setup_guild_with_second_member(
        client, _auth_signer
    )
    await client.post(
        f"/guilds/{g['id']}/transfer-ownership",
        json={"new_owner_id": str(uid_other), "confirm_name": g["name"]},
        headers=auth(t_owner),
    )
    # Try renaming as the previous owner — must 403 now.
    r = await client.patch(
        f"/guilds/{g['id']}", json={"name": "x"}, headers=auth(t_owner)
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_transfer_wrong_confirm_name_is_400(client, _auth_signer):
    t_owner, _, _, uid_other, g = await _setup_guild_with_second_member(
        client, _auth_signer
    )
    r = await client.post(
        f"/guilds/{g['id']}/transfer-ownership",
        json={"new_owner_id": str(uid_other), "confirm_name": "wrong-name"},
        headers=auth(t_owner),
    )
    assert r.status_code == 400
    assert "confirm_name" in r.json()["detail"]


@pytest.mark.asyncio
async def test_transfer_to_non_member_is_400(client, _auth_signer):
    t_owner, _, _, _, g = await _setup_guild_with_second_member(client, _auth_signer)
    _, uid_stranger = await _register_user(_auth_signer)
    r = await client.post(
        f"/guilds/{g['id']}/transfer-ownership",
        json={"new_owner_id": str(uid_stranger), "confirm_name": g["name"]},
        headers=auth(t_owner),
    )
    assert r.status_code == 400
    assert "not a member" in r.json()["detail"]


@pytest.mark.asyncio
async def test_transfer_to_self_is_400(client, _auth_signer):
    t_owner, uid_owner, _, _, g = await _setup_guild_with_second_member(
        client, _auth_signer
    )
    r = await client.post(
        f"/guilds/{g['id']}/transfer-ownership",
        json={"new_owner_id": str(uid_owner), "confirm_name": g["name"]},
        headers=auth(t_owner),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_transfer_by_non_owner_is_403(client, _auth_signer):
    _, _, t_other, _, g = await _setup_guild_with_second_member(
        client, _auth_signer
    )
    _, uid_third = await _register_user(_auth_signer)
    r = await client.post(
        f"/guilds/{g['id']}/transfer-ownership",
        json={"new_owner_id": str(uid_third), "confirm_name": g["name"]},
        headers=auth(t_other),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_transfer_nonexistent_guild_is_404(client, _auth_signer):
    t_owner, _ = await _register_user(_auth_signer)
    r = await client.post(
        "/guilds/999999/transfer-ownership",
        json={"new_owner_id": "1", "confirm_name": "x"},
        headers=auth(t_owner),
    )
    assert r.status_code == 404
