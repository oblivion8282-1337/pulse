"""Tests for the Cloud-only Community-Invite-Broker (Stufe 2 / B-lite).

Covers ``routes/community_invites.py``:
  * create → row + ``community_invite_received`` push to the invitee only
  * friend-gate: only confirmed friends may be invited; blocks (either way) deny
  * list → pending invites for the current user (invitee)
  * delete (accept/decline, B-lite) → row gone + ``community_invite_removed``
  * rate-limit per inviter
  * TTL: expired rows are swept on GET; an expired row grants nothing
  * CloudOnly gate: self-host returns 404 on every route

The WS fan-out is asserted by spying on ``manager.publish_user_event`` (same
pattern as ``test_friend_ws_events.py``).

Product model: "erst befreundet, DANN einladen" → every success-path test wires
a confirmed friendship between inviter and invitee first (via the ``friend_pair``
conftest fixture, which writes a ``friendships`` row directly).
"""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

# Broker is cloud-only — ensure cloud mode for all tests here.
pytestmark = pytest.mark.usefixtures("cloud_mode")


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _install_block(session_factory, blocker_id: int, blocked_id: int) -> None:
    """Install a directional block row (blocker → blocked)."""
    from dcc_chat_gateway.models import UserBlock

    async with session_factory() as s:
        s.add(UserBlock(blocker_id=blocker_id, blocked_id=blocked_id))
        await s.commit()


def _payload(invitee_id: int, **over) -> dict:
    base = {
        "invitee_id": str(invitee_id),
        "target_host": "pulse.firma.de",
        "target_instance_id": "100",
        "target_guild_id": "42",
        "target_guild_name": "Cool Community",
        "code": "ABCD1234",
    }
    base.update(over)
    return base


@pytest.fixture
def captured_events(app, monkeypatch):
    captured: list[tuple[str, dict]] = []
    mgr = app.state.connection_manager

    async def _cap(target_user_id, envelope):
        captured.append((str(target_user_id), dict(envelope)))

    monkeypatch.setattr(mgr, "publish_user_event", _cap)
    return captured


def _ops_for(captured, target_uid: int) -> list[str]:
    return [e["op"] for (tid, e) in captured if tid == str(target_uid)]


# ---- create + friend-gate --------------------------------------------------


@pytest.mark.asyncio
async def test_create_emits_received_to_invitee_only(
    client, _auth_signer, captured_events, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["inviter_id"] == str(uid_a)
    assert body["invitee_id"] == str(uid_b)
    assert body["target_host"] == "pulse.firma.de"
    assert body["target_guild_name"] == "Cool Community"
    assert body["code"] == "ABCD1234"
    # Only the invitee gets the card; the inviter has the REST response.
    assert _ops_for(captured_events, uid_b) == ["community_invite_received"]
    assert _ops_for(captured_events, uid_a) == []
    env = next(e for (tid, e) in captured_events if tid == str(uid_b))
    assert env["data"]["inviter_id"] == str(uid_a)
    assert env["data"]["code"] == "ABCD1234"


@pytest.mark.asyncio
async def test_create_to_non_friend_rejected(client, _auth_signer):
    """No friendship → 403 (product model "erst befreundet, DANN einladen")."""
    t_a, _ = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    r = await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "not_friends"


@pytest.mark.asyncio
async def test_create_to_blocked_rejected_outgoing(
    client, _auth_signer, friend_pair, session_factory
):
    """Inviter blocked the invitee → 403 even if they were friends before."""
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await _install_block(session_factory, blocker_id=uid_a, blocked_id=uid_b)
    r = await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "block_in_place"


@pytest.mark.asyncio
async def test_create_to_blocked_rejected_incoming(
    client, _auth_signer, friend_pair, session_factory
):
    """Invitee blocked the inviter → 403 (block wins in either direction)."""
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await _install_block(session_factory, blocker_id=uid_b, blocked_id=uid_a)
    r = await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "block_in_place"


@pytest.mark.asyncio
async def test_create_self_invite_rejected(client, _auth_signer):
    t_a, uid_a = await _register(_auth_signer)
    r = await client.post(
        "/community-invites", json=_payload(uid_a), headers=auth(t_a)
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "cannot_invite_yourself"


@pytest.mark.asyncio
async def test_create_requires_auth(client, _auth_signer):
    _, uid_b = await _register(_auth_signer)
    r = await client.post("/community-invites", json=_payload(uid_b))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_create_dedupes_same_inviter_invitee_guild(
    client, _auth_signer, captured_events, friend_pair
):
    """A repeat invite (same inviter→invitee→guild) collapses to one row, with
    the newest code winning."""
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await client.post(
        "/community-invites",
        json=_payload(uid_b, code="OLD00000"),
        headers=auth(t_a),
    )
    await client.post(
        "/community-invites",
        json=_payload(uid_b, code="NEW00000"),
        headers=auth(t_a),
    )
    listing = (
        await client.get("/community-invites", headers=auth(t_b))
    ).json()
    assert len(listing) == 1
    assert listing[0]["code"] == "NEW00000"


# ---- list ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_returns_pending_for_invitee(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    # Two different guilds → two rows.
    await client.post(
        "/community-invites",
        json=_payload(uid_b, target_guild_id="1", code="C1AAAAAA"),
        headers=auth(t_a),
    )
    await client.post(
        "/community-invites",
        json=_payload(uid_b, target_guild_id="2", code="C2AAAAAA"),
        headers=auth(t_a),
    )
    listing = (await client.get("/community-invites", headers=auth(t_b))).json()
    assert len(listing) == 2
    assert {row["code"] for row in listing} == {"C1AAAAAA", "C2AAAAAA"}


@pytest.mark.asyncio
async def test_list_only_own_invites(client, _auth_signer, friend_pair):
    """An invitee never sees invites addressed to a different user."""
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    t_c, _ = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    # uid_c lists — sees nothing (the invite is for uid_b).
    listing = (await client.get("/community-invites", headers=auth(t_c))).json()
    assert listing == []


# ---- delete (B-lite accept/decline) ---------------------------------------


@pytest.mark.asyncio
async def test_delete_by_invitee_removes_row_and_emits(
    client, _auth_signer, captured_events, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    created = (
        await client.post(
            "/community-invites", json=_payload(uid_b), headers=auth(t_a)
        )
    ).json()
    captured_events.clear()
    r = await client.delete(
        f"/community-invites/{created['id']}", headers=auth(t_b)
    )
    assert r.status_code == 204
    # B-lite: row is gone.
    listing = (await client.get("/community-invites", headers=auth(t_b))).json()
    assert listing == []
    # Invitee's other tabs get the removal.
    assert _ops_for(captured_events, uid_b) == ["community_invite_removed"]
    env = next(e for (tid, e) in captured_events if tid == str(uid_b))
    # ``publish_friend_event`` validates the data against the typed
    # CommunityInviteRemovedEvent → ``data`` is the pydantic submodel, not a
    # plain dict (same as the friend_request_declined path). Read its field.
    assert env["data"].invite_id == created["id"]


@pytest.mark.asyncio
async def test_delete_by_inviter_allowed(client, _auth_signer, friend_pair):
    """The inviter may rescind their own pending invite."""
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    created = (
        await client.post(
            "/community-invites", json=_payload(uid_b), headers=auth(t_a)
        )
    ).json()
    r = await client.delete(
        f"/community-invites/{created['id']}", headers=auth(t_a)
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_delete_by_stranger_404(client, _auth_signer, friend_pair):
    """A third party cannot delete (nor learn the row exists)."""
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    t_c, _ = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    created = (
        await client.post(
            "/community-invites", json=_payload(uid_b), headers=auth(t_a)
        )
    ).json()
    r = await client.delete(
        f"/community-invites/{created['id']}", headers=auth(t_c)
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_unknown_404(client, _auth_signer):
    t, _ = await _register(_auth_signer)
    r = await client.delete("/community-invites/999999", headers=auth(t))
    assert r.status_code == 404


# ---- rate limit ------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_rate_limited_per_inviter(
    client, _auth_signer, friend_pair
):
    import dcc_chat_gateway.ratelimit as rl

    t_a, uid_a = await _register(_auth_signer)
    limit, _ = rl._RULES["community_invite"]
    # Burn the whole budget with distinct (friended) invitees.
    for _ in range(limit):
        _, uid_x = await _register(_auth_signer)
        await friend_pair(uid_a, uid_x)
        r = await client.post(
            "/community-invites", json=_payload(uid_x), headers=auth(t_a)
        )
        assert r.status_code == 201, r.text
    _, uid_last = await _register(_auth_signer)
    await friend_pair(uid_a, uid_last)
    r = await client.post(
        "/community-invites", json=_payload(uid_last), headers=auth(t_a)
    )
    assert r.status_code == 429


# ---- TTL -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_expired_invite_swept_on_list(
    client, _auth_signer, session_factory, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    created = (
        await client.post(
            "/community-invites",
            json=_payload(uid_b, expires_in_seconds=3600),
            headers=auth(t_a),
        )
    ).json()
    # Force the row into the past.
    from dcc_chat_gateway.models import CommunityInvite

    async with session_factory() as s:
        await s.execute(
            update(CommunityInvite)
            .where(CommunityInvite.id == int(created["id"]))
            .values(expires_at=datetime.now(tz=UTC) - timedelta(seconds=1))
            .execution_options(synchronize_session=False)
        )
        await s.commit()
    # GET sweeps it; the pending list is empty and the row is deleted.
    listing = (await client.get("/community-invites", headers=auth(t_b))).json()
    assert listing == []
    async with session_factory() as s:
        assert await s.get(CommunityInvite, int(created["id"])) is None


# ---- CloudOnly gate --------------------------------------------------------


@pytest.mark.asyncio
async def test_self_host_returns_404(client, _auth_signer, _isolate_chat_settings):
    """On a self-host instance every broker route 404s (CloudOnly guard)."""
    _isolate_chat_settings.pulse_instance_mode = "self-host"
    t_a, _ = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    r_post = await client.post(
        "/community-invites", json=_payload(uid_b), headers=auth(t_a)
    )
    r_get = await client.get("/community-invites", headers=auth(t_a))
    r_del = await client.delete("/community-invites/1", headers=auth(t_a))
    assert r_post.status_code == 404
    assert r_get.status_code == 404
    assert r_del.status_code == 404
