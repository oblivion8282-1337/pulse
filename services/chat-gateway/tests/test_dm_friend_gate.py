"""Friend-gate hart-cut on DM endpoints (Etappe 2).

* POST /dm-channels without friendship → 403 ``not_friends``
* POST /dm-channels with block → 403 ``blocked``
* POST /channels/{id}/messages on a DM without friendship → 403 ``not_friends``
* GET  /dm-channels / /dm-channels/{id} → ``can_send`` reflects state
"""

from __future__ import annotations

import random

import pytest

# DM routes are cloud-only — ensure cloud mode for all tests in this file.
pytestmark = pytest.mark.usefixtures("cloud_mode")


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


# ---- create gate -----------------------------------------------------------


@pytest.mark.asyncio
async def test_create_dm_without_friendship_403_not_friends(
    client, _auth_signer
):
    t_a, _ = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    r = await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "not_friends"


@pytest.mark.asyncio
async def test_create_dm_when_blocked_403_blocked(client, _auth_signer):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    # B blocks A — A still tries to create a DM.
    await client.post(
        "/blocks",
        json={"target_user_id": str(uid_a)},
        headers=auth(t_b),
    )
    r = await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "blocked"


@pytest.mark.asyncio
async def test_create_dm_with_friendship_succeeds(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 201
    assert r.json()["can_send"] is True


# ---- send gate -------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_in_dm_after_unfriend_403(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm = (
        await client.post(
            "/dm-channels",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()
    # Send works while friends.
    r0 = await client.post(
        f"/channels/{dm['id']}/messages",
        json={"content": "before"},
        headers=auth(t_a),
    )
    assert r0.status_code == 201
    # A unfriends B.
    rdel = await client.delete(f"/friends/{uid_b}", headers=auth(t_a))
    assert rdel.status_code == 204
    # Send is now hard-cut.
    r1 = await client.post(
        f"/channels/{dm['id']}/messages",
        json={"content": "after"},
        headers=auth(t_a),
    )
    assert r1.status_code == 403
    assert r1.json()["detail"] == "not_friends"


@pytest.mark.asyncio
async def test_send_in_dm_after_block_403(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm = (
        await client.post(
            "/dm-channels",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()
    # B blocks A (this also tears down friendship — block_in_place + cut).
    await client.post(
        "/blocks", json={"target_user_id": str(uid_a)}, headers=auth(t_b)
    )
    r = await client.post(
        f"/channels/{dm['id']}/messages",
        json={"content": "after block"},
        headers=auth(t_a),
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "blocked"


# ---- can_send wire field ---------------------------------------------------


@pytest.mark.asyncio
async def test_list_dm_channels_can_send_true_when_friends(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    r = await client.get("/dm-channels", headers=auth(t_a))
    assert r.status_code == 200
    assert r.json()[0]["can_send"] is True


@pytest.mark.asyncio
async def test_list_dm_channels_can_send_false_after_unfriend(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    await client.delete(f"/friends/{uid_b}", headers=auth(t_a))
    r = await client.get("/dm-channels", headers=auth(t_a))
    assert r.status_code == 200
    # Tombstone DM remains in the list but can_send is false.
    assert len(r.json()) == 1
    assert r.json()[0]["can_send"] is False


@pytest.mark.asyncio
async def test_get_dm_channel_can_send_false_when_blocked(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm = (
        await client.post(
            "/dm-channels",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()
    await client.post(
        "/blocks", json={"target_user_id": str(uid_a)}, headers=auth(t_b)
    )
    r = await client.get(f"/dm-channels/{dm['id']}", headers=auth(t_a))
    assert r.status_code == 200
    assert r.json()["can_send"] is False
