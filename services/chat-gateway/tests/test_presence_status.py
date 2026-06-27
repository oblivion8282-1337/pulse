"""Etappe-3 presence-status tests.

Covered:
  A. PUT /me/presence-status sets Redis key + broadcasts correctly.
  B. Invisible: broadcast to others shows "offline"; own sockets see "invisible".
  C. activity WS-op: idle → online + broadcast; dnd → stays dnd; online → no broadcast.
  D. Idle sweeper: online user with stale activity → idle + broadcast; dnd/invisible → skip.
  E. Voice-presence: voice:events broadcast does NOT consult the status filter
     (users are visible in voice regardless of invisible status).
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time

import pytest
import pytest_asyncio
from redis.asyncio import Redis
from starlette.testclient import TestClient
from .conftest import install_friendship_sync, receive_skipping

import dcc_chat_gateway.config as chat_cfg

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def redis_client() -> Redis:
    r = Redis.from_url(_REDIS_URL, decode_responses=False)
    yield r
    await r.aclose()


# ---------------------------------------------------------------------------
# A. REST: PUT /me/presence-status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_put_presence_status_writes_redis(client, _auth_signer, redis_client):
    """PUT /me/presence-status persists the status key in Redis."""
    token, uid = _auth_signer.issue_access(
        random.randint(1, 999_999), "u1"
    ), None
    # Re-mint properly
    uid = random.randint(1_000_000, 9_999_999)
    token = _auth_signer.issue_access(uid, f"u{uid}")

    r = await client.put(
        "/me/presence-status",
        json={"status": "dnd"},
        headers=_auth(token),
    )
    assert r.status_code == 204

    from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY

    raw = await redis_client.get(PRESENCE_STATUS_KEY.format(user_id=uid))
    assert raw is not None
    assert raw.decode() == "dnd"

    # Cleanup
    await redis_client.delete(PRESENCE_STATUS_KEY.format(user_id=uid))


@pytest.mark.asyncio
async def test_put_presence_status_invalid(client, _auth_signer):
    uid = random.randint(1_000_000, 9_999_999)
    token = _auth_signer.issue_access(uid, f"u{uid}")
    r = await client.put(
        "/me/presence-status",
        json={"status": "banana"},
        headers=_auth(token),
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_put_presence_status_broadcasts(app, _auth_signer, redis_client):
    """PUT /me/presence-status calls broadcast_presence_status_changed."""
    uid = random.randint(1_000_000, 9_999_999)
    token = _auth_signer.issue_access(uid, f"u{uid}")
    mgr = app.state.connection_manager

    published: list[tuple] = []

    async def _cap(target_user_id, envelope):
        # publish_*_event now accepts either raw dicts (legacy) or
        # dcc_shared.events Pydantic models — normalise to dict for the
        # spy so assertions stay wire-shape-truthful.
        if hasattr(envelope, "model_dump"):
            envelope = envelope.model_dump(mode="json")
        published.append((str(target_user_id), dict(envelope)))

    import httpx

    transport = httpx.ASGITransport(app=app)
    original_pub = mgr.publish_user_event
    mgr.publish_user_event = _cap
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            r = await c.put(
                "/me/presence-status",
                json={"status": "idle"},
                headers=_auth(token),
            )
        assert r.status_code == 204
        # Own socket gets the event
        assert any(tid == str(uid) for tid, _ in published)
        own_env = next(e for tid, e in published if tid == str(uid))
        assert own_env["op"] == "presence_status_changed"
        assert own_env["data"]["status"] == "idle"
    finally:
        mgr.publish_user_event = original_pub
        from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY

        await redis_client.delete(PRESENCE_STATUS_KEY.format(user_id=uid))


# ---------------------------------------------------------------------------
# B. Invisible masking
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invisible_broadcast_shows_offline_to_others(app, _auth_signer, redis_client):
    """When a user sets status=invisible, the guild:events broadcast carries
    status='offline' (masked), while their own USER_EVENTS delivery carries
    status='invisible'."""
    uid = random.randint(1_000_000, 9_999_999)
    token = _auth_signer.issue_access(uid, f"u{uid}")
    mgr = app.state.connection_manager
    redis = app.state.redis

    user_events: list[tuple] = []
    guild_publishes: list[str] = []

    async def _cap_user(target_user_id, envelope):
        # See note in test_put_presence_status_broadcasts — publish_*_event
        # accepts dict|_EventBase; normalise to dict for the spy.
        if hasattr(envelope, "model_dump"):
            envelope = envelope.model_dump(mode="json")
        user_events.append((str(target_user_id), dict(envelope)))

    import httpx

    original_pub = mgr.publish_user_event
    mgr.publish_user_event = _cap_user

    # Capture what lands on guild:events
    original_redis_pub = redis.publish

    async def _cap_redis(channel, message):
        if channel == "guild:events":
            guild_publishes.append(message)
        return await original_redis_pub(channel, message)

    redis.publish = _cap_redis

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            r = await c.put(
                "/me/presence-status",
                json={"status": "invisible"},
                headers=_auth(token),
            )
        assert r.status_code == 204

        # Own sockets receive the *real* status
        own = next(e for tid, e in user_events if tid == str(uid))
        assert own["data"]["status"] == "invisible"

        # guild:events gets the masked status
        assert guild_publishes, "expected at least one guild:events publish"
        env = json.loads(guild_publishes[-1])
        assert env["op"] == "presence_status_changed"
        assert env["data"]["status"] == "offline"
    finally:
        mgr.publish_user_event = original_pub
        redis.publish = original_redis_pub
        from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY

        await redis_client.delete(PRESENCE_STATUS_KEY.format(user_id=uid))


# ---------------------------------------------------------------------------
# C. WS activity op
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_activity_op_idle_returns_to_online(ws_app, _auth_signer, redis_client):
    """Sending op=activity when status=idle flips the user back to online."""
    from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY, PRESENCE_ACTIVITY_ZSET
    from dcc_chat_gateway.presence_status import STATUS_IDLE

    def _run():
        uid = random.randint(1_000_000, 9_999_999)
        token = _auth_signer.issue_access(uid, f"u{uid}")

        import redis as sync_redis

        r = sync_redis.Redis.from_url(_REDIS_URL)
        key = PRESENCE_STATUS_KEY.replace("{user_id}", str(uid))
        try:
            # Pre-set idle
            r.set(key, STATUS_IDLE)
            with TestClient(ws_app) as tc:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    receive_skipping(ws)  # skip hello + ready
                    ws.send_json({"op": "activity"})
                    # Give the server a moment; no reply expected
                    import time as _time
                    _time.sleep(0.2)
                    # Read back from Redis
                    result = r.get(key)
                    assert result is not None
                    assert result.decode() == "online"
        finally:
            r.delete(key)
            r.delete(PRESENCE_ACTIVITY_ZSET)
            r.close()
        return uid

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_activity_op_dnd_stays_dnd(ws_app, _auth_signer, redis_client):
    """Sending op=activity when status=dnd must NOT change the status."""
    from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY, PRESENCE_ACTIVITY_ZSET
    from dcc_chat_gateway.presence_status import STATUS_DND

    def _run():
        uid = random.randint(1_000_000, 9_999_999)
        token = _auth_signer.issue_access(uid, f"u{uid}")

        import redis as sync_redis

        r = sync_redis.Redis.from_url(_REDIS_URL)
        key = PRESENCE_STATUS_KEY.replace("{user_id}", str(uid))
        try:
            r.set(key, STATUS_DND)
            with TestClient(ws_app) as tc:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    receive_skipping(ws)  # skip hello + ready
                    ws.send_json({"op": "activity"})
                    import time as _time
                    _time.sleep(0.2)
                    result = r.get(key)
                    # Must still be dnd
                    assert result is not None
                    assert result.decode() == "dnd"
        finally:
            r.delete(key)
            r.delete(PRESENCE_ACTIVITY_ZSET)
            r.close()

    await asyncio.to_thread(_run)


# ---------------------------------------------------------------------------
# D. Idle sweeper
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_idle_sweep_demotes_online_user(redis_client, monkeypatch):
    """_run_sweep demotes an online user whose activity is older than IDLE_AFTER_MS."""
    from dcc_chat_gateway.presence_keys import (
        PRESENCE_ACTIVITY_ZSET,
        PRESENCE_STATUS_KEY,
        PRESENCE_STATUS_TTL_SECONDS,
    )
    from dcc_chat_gateway.presence_status import STATUS_IDLE, STATUS_ONLINE, _run_sweep

    uid = random.randint(10_000_000, 99_999_999)
    status_key = PRESENCE_STATUS_KEY.format(user_id=uid)
    old_ms = int(time.time() * 1000) - (15 * 60 * 1000)  # 15 min ago

    await redis_client.set(status_key, STATUS_ONLINE, ex=PRESENCE_STATUS_TTL_SECONDS)
    await redis_client.zadd(PRESENCE_ACTIVITY_ZSET, {str(uid): old_ms})

    try:
        await _run_sweep(redis_client)
        result = await redis_client.get(status_key)
        assert result is not None
        assert result.decode() == STATUS_IDLE
    finally:
        await redis_client.delete(status_key)
        await redis_client.zrem(PRESENCE_ACTIVITY_ZSET, str(uid))


@pytest.mark.asyncio
async def test_idle_sweep_skips_dnd(redis_client):
    """_run_sweep must not change a dnd user's status."""
    from dcc_chat_gateway.presence_keys import (
        PRESENCE_ACTIVITY_ZSET,
        PRESENCE_STATUS_KEY,
        PRESENCE_STATUS_TTL_SECONDS,
    )
    from dcc_chat_gateway.presence_status import STATUS_DND, _run_sweep

    uid = random.randint(10_000_000, 99_999_999)
    status_key = PRESENCE_STATUS_KEY.format(user_id=uid)
    old_ms = int(time.time() * 1000) - (15 * 60 * 1000)

    await redis_client.set(status_key, STATUS_DND, ex=PRESENCE_STATUS_TTL_SECONDS)
    await redis_client.zadd(PRESENCE_ACTIVITY_ZSET, {str(uid): old_ms})

    try:
        await _run_sweep(redis_client)
        result = await redis_client.get(status_key)
        assert result is not None
        assert result.decode() == STATUS_DND
    finally:
        await redis_client.delete(status_key)
        await redis_client.zrem(PRESENCE_ACTIVITY_ZSET, str(uid))


@pytest.mark.asyncio
async def test_idle_sweep_skips_invisible(redis_client):
    """_run_sweep must not change an invisible user's status."""
    from dcc_chat_gateway.presence_keys import (
        PRESENCE_ACTIVITY_ZSET,
        PRESENCE_STATUS_KEY,
        PRESENCE_STATUS_TTL_SECONDS,
    )
    from dcc_chat_gateway.presence_status import STATUS_INVISIBLE, _run_sweep

    uid = random.randint(10_000_000, 99_999_999)
    status_key = PRESENCE_STATUS_KEY.format(user_id=uid)
    old_ms = int(time.time() * 1000) - (15 * 60 * 1000)

    await redis_client.set(status_key, STATUS_INVISIBLE, ex=PRESENCE_STATUS_TTL_SECONDS)
    await redis_client.zadd(PRESENCE_ACTIVITY_ZSET, {str(uid): old_ms})

    try:
        await _run_sweep(redis_client)
        result = await redis_client.get(status_key)
        assert result is not None
        assert result.decode() == STATUS_INVISIBLE
    finally:
        await redis_client.delete(status_key)
        await redis_client.zrem(PRESENCE_ACTIVITY_ZSET, str(uid))


@pytest.mark.asyncio
async def test_idle_sweep_skips_recent_activity(redis_client):
    """Users with recent activity must NOT be demoted to idle."""
    from dcc_chat_gateway.presence_keys import (
        PRESENCE_ACTIVITY_ZSET,
        PRESENCE_STATUS_KEY,
        PRESENCE_STATUS_TTL_SECONDS,
    )
    from dcc_chat_gateway.presence_status import STATUS_ONLINE, _run_sweep

    uid = random.randint(10_000_000, 99_999_999)
    status_key = PRESENCE_STATUS_KEY.format(user_id=uid)
    recent_ms = int(time.time() * 1000) - 30_000  # 30 s ago

    await redis_client.set(status_key, STATUS_ONLINE, ex=PRESENCE_STATUS_TTL_SECONDS)
    await redis_client.zadd(PRESENCE_ACTIVITY_ZSET, {str(uid): recent_ms})

    try:
        await _run_sweep(redis_client)
        result = await redis_client.get(status_key)
        assert result is not None
        assert result.decode() == STATUS_ONLINE
    finally:
        await redis_client.delete(status_key)
        await redis_client.zrem(PRESENCE_ACTIVITY_ZSET, str(uid))


# ---------------------------------------------------------------------------
# E. Ready frame carries presence fields
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ready_carries_presence_status(ws_app, _auth_signer, redis_client):
    """The ready frame must include presence_status (own, real) and
    user_presence_statuses (map of visible peers, masked)."""
    from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY, PRESENCE_STATUS_TTL_SECONDS
    from dcc_chat_gateway.presence_status import STATUS_DND

    def _run():
        uid = random.randint(1_000_000, 9_999_999)
        token = _auth_signer.issue_access(uid, f"u{uid}")

        import redis as sync_redis

        r = sync_redis.Redis.from_url(_REDIS_URL)
        key = PRESENCE_STATUS_KEY.replace("{user_id}", str(uid))
        try:
            r.set(key, STATUS_DND, ex=PRESENCE_STATUS_TTL_SECONDS)
            with TestClient(ws_app) as tc:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    ws.receive_json()  # hello
                    payload = ws.receive_json()  # ready
                    assert payload["op"] == "ready"
                    # Own status is real (dnd, not masked)
                    assert payload["presence_status"] == "dnd"
                    # Map exists (may be empty for a lone user)
                    assert isinstance(payload["user_presence_statuses"], dict)
        finally:
            r.delete(key)
            r.close()

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_presence_status_survives_redis_ttl(ws_app, _auth_signer, redis_client):
    """A manually-set status is mirrored durably into ``user_preferences``.

    After the live Redis key expires (simulated by deleting it), the next
    ready frame restores the status from the durable mirror and reseeds Redis,
    so e.g. ``invisible`` persists across the 24 h TTL / a Redis restart.
    """
    from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY

    def _run():
        uid = random.randint(1_000_000, 9_999_999)
        token = _auth_signer.issue_access(uid, f"u{uid}")

        import redis as sync_redis

        r = sync_redis.Redis.from_url(_REDIS_URL)
        key = PRESENCE_STATUS_KEY.replace("{user_id}", str(uid))
        try:
            with TestClient(ws_app) as tc:
                # Explicit user choice → Redis (live) + durable DB mirror.
                resp = tc.put(
                    "/me/presence-status",
                    json={"status": "invisible"},
                    headers=_auth(token),
                )
                assert resp.status_code == 204

                # Simulate the 24 h Redis TTL expiring; the durable row stays.
                r.delete(key)
                assert r.get(key) is None

                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    ws.receive_json()  # hello
                    payload = ws.receive_json()  # ready
                    assert payload["op"] == "ready"
                    # Restored from the durable mirror, not defaulted to online.
                    assert payload["presence_status"] == "invisible"

                # Ready reseeded the live Redis key with the restored status.
                restored = r.get(key)
                assert restored is not None and restored.decode() == "invisible"
        finally:
            r.delete(key)
            r.close()

    await asyncio.to_thread(_run)


# ---------------------------------------------------------------------------
# E. Voice-presence: invisible user still visible in voice
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_voice_state_not_filtered_by_invisible(ws_app, _auth_signer, redis_client):
    """Invisible status must NOT suppress voice_state broadcasts.

    voice:events does not go through _filter_presence_visibility — the
    chat-gateway listener forwards it to VIEW_CHANNEL-filtered targets
    unchanged.  We verify that a connected client receives the voice_state
    event even when the speaking user has status=invisible.
    """
    from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY, PRESENCE_STATUS_TTL_SECONDS
    from dcc_chat_gateway.presence_status import STATUS_INVISIBLE

    def _run():
        uid = random.randint(1_000_000, 9_999_999)
        speaker_uid = random.randint(10_000_000, 99_999_999)
        token = _auth_signer.issue_access(uid, f"u{uid}")

        import redis as sync_redis

        r = sync_redis.Redis.from_url(_REDIS_URL)
        inv_key = PRESENCE_STATUS_KEY.replace("{user_id}", str(speaker_uid))
        try:
            r.set(inv_key, STATUS_INVISIBLE, ex=PRESENCE_STATUS_TTL_SECONDS)

            with TestClient(ws_app) as tc:
                with tc.websocket_connect(f"/ws?token={token}") as ws:
                    receive_skipping(ws)  # skip hello + ready
                    g = tc.post(
                        "/guilds", json={"name": "g"}, headers=_auth(token)
                    ).json()
                    vc = tc.post(
                        f"/guilds/{g['id']}/channels",
                        json={"name": "Voice", "type": 1},
                        headers=_auth(token),
                    ).json()
                    cid = vc["id"]
                    # Simulate voice-signaling publishing a join event for the
                    # invisible speaker
                    r.publish(
                        "voice:events",
                        json.dumps({
                            "channel_id": cid,
                            "user_ids": [str(speaker_uid)],
                            "streaming_user_ids": [],
                        }),
                    )
                    # Drain guild_member_added + channel_created events
                    while True:
                        got = ws.receive_json()
                        if got.get("op") == "voice_state":
                            break
                    assert got["op"] == "voice_state"
                    assert str(speaker_uid) in got["user_ids"]
        finally:
            r.delete(inv_key)
            r.close()

    await asyncio.to_thread(_run)


# ---------------------------------------------------------------------------
# F. Ready frame peer-status filter: only online peers with explicit status
# ---------------------------------------------------------------------------


# Cloud-only: friend presence is a Social-layer concept (self-host has no
# ``friends`` rows), so the regression guard only runs in cloud mode.
pytestmark_peer_filter = pytest.mark.usefixtures("cloud_mode")


@pytest.mark.asyncio
@pytestmark_peer_filter
async def test_ready_excludes_offline_friends_from_presence_statuses(
    ws_app, _auth_signer, redis_client
):
    """A friend who has neither an open socket nor a Redis status key must
    NOT appear in ``user_presence_statuses`` — the frontend treats absent
    keys as offline (via the ``?? 'offline'`` fallback in ``displayStatus``).

    Regression guard for the 2026-06-27 bug where every friend was reported
    as online because ``get_presence_statuses_bulk`` defaulted missing
    Redis keys to ``STATUS_ONLINE``.
    """
    from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY

    def _run():
        viewer_uid = random.randint(1_000_000, 9_999_999)
        friend_uid = random.randint(1_000_000, 9_999_999)
        # Sanity: the two must be distinct rows in ``friendships``.
        while friend_uid == viewer_uid:
            friend_uid = random.randint(1_000_000, 9_999_999)
        viewer_tok = _auth_signer.issue_access(viewer_uid, f"u{viewer_uid}")

        db = chat_cfg.get_settings().database_url
        install_friendship_sync(db, viewer_uid, friend_uid)

        # Friend has NO open socket (never connected) and NO Redis status.
        # Pre-condition sanity: the key is absent.
        import redis as sync_redis

        r = sync_redis.Redis.from_url(_REDIS_URL)
        friend_key = PRESENCE_STATUS_KEY.format(user_id=friend_uid)
        try:
            r.delete(friend_key)
            with TestClient(ws_app) as tc:
                with tc.websocket_connect(f"/ws?token={viewer_tok}") as ws:
                    ws.receive_json()  # hello
                    payload = ws.receive_json()  # ready
                    assert payload["op"] == "ready"
                    # Viewer sees the friend in ``friends`` (proves the
                    # friendship row was loaded)…
                    assert any(
                        str(f["user_id"]) == str(friend_uid) for f in payload["friends"]
                    )
                    # …but NOT in the presence-status map. The frontend's
                    # ``?? 'offline'`` fallback then drives the Online filter.
                    assert str(friend_uid) not in payload["user_presence_statuses"]
        finally:
            r.delete(friend_key)
            r.close()

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
@pytestmark_peer_filter
async def test_ready_includes_online_friend_with_explicit_status(
    ws_app, _auth_signer, redis_client
):
    """A friend with both an open socket AND an explicit Redis status (dnd)
    must appear in ``user_presence_statuses`` with that exact status."""
    from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY
    from dcc_chat_gateway.presence_status import STATUS_DND

    def _run():
        viewer_uid = random.randint(1_000_000, 9_999_999)
        friend_uid = random.randint(1_000_000, 9_999_999)
        while friend_uid == viewer_uid:
            friend_uid = random.randint(1_000_000, 9_999_999)
        viewer_tok = _auth_signer.issue_access(viewer_uid, f"u{viewer_uid}")
        friend_tok = _auth_signer.issue_access(friend_uid, f"u{friend_uid}")

        db = chat_cfg.get_settings().database_url
        install_friendship_sync(db, viewer_uid, friend_uid)

        import redis as sync_redis

        r = sync_redis.Redis.from_url(_REDIS_URL)
        friend_key = PRESENCE_STATUS_KEY.format(user_id=friend_uid)
        try:
            r.set(friend_key, STATUS_DND)
            with TestClient(ws_app) as tc:
                # Friend connects first → has an open socket in the manager.
                with tc.websocket_connect(f"/ws?token={friend_tok}") as friend_ws:
                    friend_ws.receive_json()  # hello
                    friend_ws.receive_json()  # friend_ready
                    # Now viewer connects and reads the ready frame.
                    with tc.websocket_connect(f"/ws?token={viewer_tok}") as ws:
                        ws.receive_json()  # hello
                        payload = ws.receive_json()  # ready
                        assert payload["op"] == "ready"
                        # The online friend with dnd status is present.
                        assert (
                            payload["user_presence_statuses"].get(str(friend_uid))
                            == "dnd"
                        )
        finally:
            r.delete(friend_key)
            r.close()

    await asyncio.to_thread(_run)
