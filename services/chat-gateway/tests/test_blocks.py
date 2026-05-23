"""Block-list tests + block/friendship interactions.

* POST /blocks tears down an existing friendship and any pending
  friend-requests in both directions, atomically.
* A block in either direction blocks friend-requests both ways.
* Idempotent: a second block POST is a no-op (200, not 409).
* DELETE /blocks/{user_id} unblocks; subsequent requests succeed.
"""

from __future__ import annotations

import random

import pytest
from sqlalchemy import select

from dcc_chat_gateway.models import FriendRequest, Friendship, UserBlock


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


# ---------------------------------------------------------------------------
# Block lifecycle


@pytest.mark.asyncio
async def test_create_block_then_list(client, _auth_signer):
    t_a, _ = await register(_auth_signer)
    _, uid_b = await register(_auth_signer)
    r = await client.post(
        "/blocks",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 200, r.text
    assert r.json()["user_id"] == str(uid_b)
    r2 = await client.get("/blocks", headers=auth(t_a))
    assert r2.status_code == 200
    assert [b["user_id"] for b in r2.json()] == [str(uid_b)]


@pytest.mark.asyncio
async def test_block_is_idempotent(client, _auth_signer):
    t_a, _ = await register(_auth_signer)
    _, uid_b = await register(_auth_signer)
    body = {"target_user_id": str(uid_b)}
    r1 = await client.post("/blocks", json=body, headers=auth(t_a))
    r2 = await client.post("/blocks", json=body, headers=auth(t_a))
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["user_id"] == r2.json()["user_id"]


@pytest.mark.asyncio
async def test_block_self_400(client, _auth_signer):
    t, uid = await register(_auth_signer)
    r = await client.post(
        "/blocks",
        json={"target_user_id": str(uid)},
        headers=auth(t),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_unblock(client, _auth_signer):
    t_a, _ = await register(_auth_signer)
    _, uid_b = await register(_auth_signer)
    await client.post(
        "/blocks",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    r = await client.delete(f"/blocks/{uid_b}", headers=auth(t_a))
    assert r.status_code == 204
    # Second delete → 404.
    r2 = await client.delete(f"/blocks/{uid_b}", headers=auth(t_a))
    assert r2.status_code == 404


# ---------------------------------------------------------------------------
# Block ↔ friendship / requests interaction


@pytest.mark.asyncio
async def test_block_tears_down_existing_friendship(
    client, session_factory, _auth_signer
):
    t_a, uid_a = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    req_id = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()["id"]
    await client.post(f"/friend-requests/{req_id}/accept", headers=auth(t_b))
    # A blocks B → friendship row should be gone.
    r = await client.post(
        "/blocks",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 200
    lo, hi = sorted((uid_a, uid_b))
    async with session_factory() as s:
        f = (
            await s.execute(
                select(Friendship).where(
                    Friendship.user_a_id == lo, Friendship.user_b_id == hi
                )
            )
        ).scalar_one_or_none()
    assert f is None


@pytest.mark.asyncio
async def test_block_tears_down_pending_requests_both_ways(
    client, session_factory, _auth_signer
):
    t_a, uid_a = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    # A sent a request to B; before B accepts, A blocks B.
    req_id = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()["id"]
    await client.post(
        "/blocks",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    async with session_factory() as s:
        assert (await s.get(FriendRequest, int(req_id))) is None

    # Also a reverse pending → block clears that too.
    t_c, uid_c = await register(_auth_signer)
    t_d, uid_d = await register(_auth_signer)
    rev_id = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_c)},
            headers=auth(t_d),
        )
    ).json()["id"]
    await client.post(
        "/blocks",
        json={"target_user_id": str(uid_d)},
        headers=auth(t_c),
    )
    async with session_factory() as s:
        assert (await s.get(FriendRequest, int(rev_id))) is None


@pytest.mark.asyncio
async def test_blocked_user_cannot_send_friend_request(client, _auth_signer):
    """Block in either direction stops the friend-request POST with 403."""
    t_a, uid_a = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    # A blocks B; then B tries to send A a request.
    await client.post(
        "/blocks",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    r = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_a)},
        headers=auth(t_b),
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "block_in_place"


@pytest.mark.asyncio
async def test_unblock_then_friend_request_works(
    client, session_factory, _auth_signer
):
    t_a, uid_a = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    await client.post(
        "/blocks",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    await client.delete(f"/blocks/{uid_b}", headers=auth(t_a))
    r = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_a)},
        headers=auth(t_b),
    )
    assert r.status_code == 201, r.text
    async with session_factory() as s:
        rows = (
            (
                await s.execute(
                    select(UserBlock).where(UserBlock.blocker_id == uid_a)
                )
            )
            .scalars()
            .all()
        )
    assert rows == []
