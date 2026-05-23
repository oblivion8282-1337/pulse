"""Tests for the friend-request lifecycle (send / accept / decline /
cancel / list / auto-accept on reverse-pending).

The block-tear-down + privacy-mirror behaviour live in their own
files (``test_blocks.py`` / ``test_privacy.py``) to keep each test
module short.
"""

from __future__ import annotations

import random

import pytest
from sqlalchemy import select

from dcc_chat_gateway.models import FriendRequest, Friendship


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


# ---------------------------------------------------------------------------
# Happy path


@pytest.mark.asyncio
async def test_send_friend_request_returns_201(client, _auth_signer):
    t_a, _ = await register(_auth_signer)
    _, uid_b = await register(_auth_signer)
    r = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert isinstance(body["id"], str)  # snowflake → string
    assert body["receiver_id"] == str(uid_b)


@pytest.mark.asyncio
async def test_accept_friend_request_creates_friendship(
    client, session_factory, _auth_signer
):
    t_a, uid_a = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    r = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    req_id = r.json()["id"]
    r2 = await client.post(
        f"/friend-requests/{req_id}/accept", headers=auth(t_b)
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["user_id"] == str(uid_a)
    # Friendship row exists; request row is gone.
    lo, hi = sorted((uid_a, uid_b))
    async with session_factory() as s:
        f = (
            await s.execute(
                select(Friendship).where(
                    Friendship.user_a_id == lo, Friendship.user_b_id == hi
                )
            )
        ).scalar_one_or_none()
        req = await s.get(FriendRequest, int(req_id))
    assert f is not None
    assert req is None


@pytest.mark.asyncio
async def test_decline_deletes_request(
    client, session_factory, _auth_signer
):
    t_a, _ = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    req_id = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()["id"]
    r = await client.post(
        f"/friend-requests/{req_id}/decline", headers=auth(t_b)
    )
    assert r.status_code == 204
    async with session_factory() as s:
        assert (await s.get(FriendRequest, int(req_id))) is None


@pytest.mark.asyncio
async def test_cancel_sender_deletes_request(
    client, session_factory, _auth_signer
):
    t_a, _ = await register(_auth_signer)
    _, uid_b = await register(_auth_signer)
    req_id = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()["id"]
    r = await client.delete(
        f"/friend-requests/{req_id}", headers=auth(t_a)
    )
    assert r.status_code == 204
    async with session_factory() as s:
        assert (await s.get(FriendRequest, int(req_id))) is None


# ---------------------------------------------------------------------------
# Edge cases


@pytest.mark.asyncio
async def test_send_to_self_400(client, _auth_signer):
    t, uid = await register(_auth_signer)
    r = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid)},
        headers=auth(t),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "cannot_friend_yourself"


@pytest.mark.asyncio
async def test_duplicate_request_409(client, _auth_signer):
    t_a, _ = await register(_auth_signer)
    _, uid_b = await register(_auth_signer)
    body = {"target_user_id": str(uid_b)}
    r1 = await client.post("/friend-requests", json=body, headers=auth(t_a))
    assert r1.status_code == 201
    r2 = await client.post("/friend-requests", json=body, headers=auth(t_a))
    assert r2.status_code == 409
    assert r2.json()["detail"] == "request_already_pending"


@pytest.mark.asyncio
async def test_already_friends_409(client, _auth_signer):
    t_a, _ = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    req_id = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()["id"]
    r = await client.post(
        f"/friend-requests/{req_id}/accept", headers=auth(t_b)
    )
    assert r.status_code == 200
    # Try to send again now that they're friends.
    r2 = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r2.status_code == 409
    assert r2.json()["detail"] == "already_friends"


@pytest.mark.asyncio
async def test_accept_by_non_receiver_404(client, _auth_signer):
    """A third party hitting /accept on someone else's request gets a
    404 (not 403) — same don't-leak-existence policy as DM channels."""
    t_a, _ = await register(_auth_signer)
    _, uid_b = await register(_auth_signer)
    t_c, _ = await register(_auth_signer)
    req_id = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()["id"]
    r = await client.post(
        f"/friend-requests/{req_id}/accept", headers=auth(t_c)
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_cancel_by_non_sender_404(client, _auth_signer):
    t_a, _ = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    req_id = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()["id"]
    # Receiver tries to "cancel" → 404 (cancel is sender-only).
    r = await client.delete(
        f"/friend-requests/{req_id}", headers=auth(t_b)
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Auto-accept on reverse pending


@pytest.mark.asyncio
async def test_reverse_pending_auto_accepts(
    client, session_factory, _auth_signer
):
    """B sent A a request; A POSTs back → auto-accept (atomic). Both
    requests are gone, friendship exists. Response carries
    ``auto_accepted: true``."""
    t_a, uid_a = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    req_id = (
        await client.post(
            "/friend-requests",
            json={"target_user_id": str(uid_a)},
            headers=auth(t_b),
        )
    ).json()["id"]
    # A POSTs back.
    r = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 201
    body = r.json()
    assert body.get("auto_accepted") is True
    assert body["friendship"]["user_id"] == str(uid_b)

    lo, hi = sorted((uid_a, uid_b))
    async with session_factory() as s:
        f = (
            await s.execute(
                select(Friendship).where(
                    Friendship.user_a_id == lo, Friendship.user_b_id == hi
                )
            )
        ).scalar_one_or_none()
        req = await s.get(FriendRequest, int(req_id))
    assert f is not None
    assert req is None


# ---------------------------------------------------------------------------
# List + unfriend


@pytest.mark.asyncio
async def test_list_requests_split_inbox_outbox(client, _auth_signer):
    t_a, uid_a = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    t_c, uid_c = await register(_auth_signer)
    # A sends to B → outgoing for A, incoming for B.
    await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    # C sends to A → incoming for A.
    await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_a)},
        headers=auth(t_c),
    )
    r = await client.get("/friend-requests", headers=auth(t_a))
    assert r.status_code == 200
    body = r.json()
    in_senders = sorted(req["sender_id"] for req in body["incoming"])
    out_recvs = sorted(req["receiver_id"] for req in body["outgoing"])
    assert in_senders == [str(uid_c)]
    assert out_recvs == [str(uid_b)]


@pytest.mark.asyncio
async def test_unfriend_removes_row(
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
    # A unfriends B.
    r = await client.delete(f"/friends/{uid_b}", headers=auth(t_a))
    assert r.status_code == 204
    # Second delete → 404 (already gone).
    r2 = await client.delete(f"/friends/{uid_b}", headers=auth(t_a))
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_friends_list_shows_other_user(client, _auth_signer):
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
    # From A's perspective.
    r = await client.get("/friends", headers=auth(t_a))
    assert r.status_code == 200
    assert [f["user_id"] for f in r.json()] == [str(uid_b)]
    # From B's perspective.
    r2 = await client.get("/friends", headers=auth(t_b))
    assert [f["user_id"] for f in r2.json()] == [str(uid_a)]
