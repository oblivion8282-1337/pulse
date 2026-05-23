"""Privacy + friend-request policy tests, plus the chat→auth
``discoverable`` mirror.

GET /me/privacy returns defaults for users with no row.
PUT /me/privacy upserts. When ``show_in_search`` flips, the route
fires an HTTP push at auth-svc — monkeypatched at the function level
in ``dcc_chat_gateway.auth_mirror`` (same pattern as ``voice_evict``
gets tested in voice-signaling).
"""

from __future__ import annotations

import random

import pytest
from sqlalchemy import select

from dcc_chat_gateway.friend_privacy import (
    DM_POLICY_NOBODY,
    FRIEND_REQ_POLICY_NOBODY,
    FRIEND_REQ_POLICY_SERVER_MEMBERS,
)
from dcc_chat_gateway.models import FriendRequest, GuildMember, UserPrivacy


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


# ---------------------------------------------------------------------------
# GET / PUT


@pytest.mark.asyncio
async def test_get_privacy_returns_defaults(client, _auth_signer):
    t, _ = await register(_auth_signer)
    r = await client.get("/me/privacy", headers=auth(t))
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "dm_policy": 0,
        "friend_request_policy": 0,
        "show_in_search": True,
    }


@pytest.mark.asyncio
async def test_put_privacy_upserts(
    client, session_factory, _auth_signer, monkeypatch
):
    """First PUT inserts; second PUT updates. Defaults survive
    fields the body doesn't touch."""
    # Stub the auth mirror so this test doesn't try to hit a real
    # auth-svc port.
    from dcc_chat_gateway.routes import privacy as privacy_mod

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(privacy_mod, "push_discoverable", _noop)

    t, uid = await register(_auth_signer)
    r = await client.put(
        "/me/privacy",
        json={"dm_policy": DM_POLICY_NOBODY},
        headers=auth(t),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dm_policy"] == DM_POLICY_NOBODY
    assert body["friend_request_policy"] == 0  # unchanged default
    assert body["show_in_search"] is True

    # Second PUT touches only show_in_search.
    r2 = await client.put(
        "/me/privacy", json={"show_in_search": False}, headers=auth(t)
    )
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["dm_policy"] == DM_POLICY_NOBODY  # preserved
    assert body2["show_in_search"] is False

    async with session_factory() as s:
        row = await s.get(UserPrivacy, uid)
    assert row is not None
    assert row.dm_policy == DM_POLICY_NOBODY
    assert row.show_in_search is False


@pytest.mark.asyncio
async def test_put_privacy_invalid_policy_422(
    client, _auth_signer, monkeypatch
):
    from dcc_chat_gateway.routes import privacy as privacy_mod

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(privacy_mod, "push_discoverable", _noop)

    t, _ = await register(_auth_signer)
    r = await client.put(
        "/me/privacy", json={"dm_policy": 99}, headers=auth(t)
    )
    assert r.status_code == 422
    r2 = await client.put(
        "/me/privacy",
        json={"friend_request_policy": 99},
        headers=auth(t),
    )
    assert r2.status_code == 422


# ---------------------------------------------------------------------------
# Mirror to auth


@pytest.mark.asyncio
async def test_show_in_search_flip_pushes_to_auth(
    client, _auth_signer, monkeypatch
):
    """A real flip of ``show_in_search`` (true→false here) must fire
    ``push_discoverable`` exactly once with the new value."""
    captured: list[tuple[int, bool]] = []

    async def _capture(user_id: int, discoverable: bool):
        captured.append((user_id, discoverable))

    from dcc_chat_gateway.routes import privacy as privacy_mod

    monkeypatch.setattr(privacy_mod, "push_discoverable", _capture)

    t, uid = await register(_auth_signer)
    r = await client.put(
        "/me/privacy",
        json={"show_in_search": False},
        headers=auth(t),
    )
    assert r.status_code == 200
    assert captured == [(uid, False)]


@pytest.mark.asyncio
async def test_show_in_search_no_flip_no_push(
    client, _auth_signer, monkeypatch
):
    """Setting ``show_in_search`` to its existing value (default True)
    must NOT fire the push — we don't want to spam auth-svc on every
    privacy save."""
    captured: list[tuple[int, bool]] = []

    async def _capture(user_id: int, discoverable: bool):
        captured.append((user_id, discoverable))

    from dcc_chat_gateway.routes import privacy as privacy_mod

    monkeypatch.setattr(privacy_mod, "push_discoverable", _capture)

    t, _ = await register(_auth_signer)
    r = await client.put(
        "/me/privacy",
        json={"show_in_search": True},
        headers=auth(t),
    )
    assert r.status_code == 200
    assert captured == []


# ---------------------------------------------------------------------------
# Receiver friend_request_policy interaction


@pytest.mark.asyncio
async def test_request_blocked_by_nobody_policy(
    client, _auth_signer, monkeypatch
):
    from dcc_chat_gateway.routes import privacy as privacy_mod

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(privacy_mod, "push_discoverable", _noop)

    t_a, _ = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    # B sets NOBODY.
    await client.put(
        "/me/privacy",
        json={"friend_request_policy": FRIEND_REQ_POLICY_NOBODY},
        headers=auth(t_b),
    )
    r = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "receiver_not_accepting_requests"


@pytest.mark.asyncio
async def test_server_members_policy_requires_shared_guild(
    client, session_factory, _auth_signer, monkeypatch
):
    from dcc_chat_gateway.routes import privacy as privacy_mod

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(privacy_mod, "push_discoverable", _noop)

    t_a, uid_a = await register(_auth_signer)
    t_b, uid_b = await register(_auth_signer)
    await client.put(
        "/me/privacy",
        json={"friend_request_policy": FRIEND_REQ_POLICY_SERVER_MEMBERS},
        headers=auth(t_b),
    )
    # No shared guild yet → 403.
    r = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "receiver_requires_shared_guild"

    # Put both into a common guild → request succeeds.
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=auth(t_b))
    ).json()
    r2 = await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_a)},
        headers=auth(t_b),
    )
    assert r2.status_code in (200, 201, 204)
    async with session_factory() as s:
        member = await s.get(GuildMember, (int(g["id"]), uid_a))
    assert member is not None

    r3 = await client.post(
        "/friend-requests",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r3.status_code == 201, r3.text
    # And clean up: drop the request so subsequent tests aren't surprised.
    rid = r3.json()["id"]
    async with session_factory() as s:
        assert (await s.get(FriendRequest, int(rid))) is not None
