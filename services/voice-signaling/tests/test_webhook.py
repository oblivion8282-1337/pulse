"""Tests for the LiveKit webhook receiver + Redis voice-presence state."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import uuid

import jwt
import pytest
import pytest_asyncio
from dcc_voice_signaling.webhook import VOICE_EVENTS_CHANNEL, room_key
from redis.asyncio import Redis

# voice-signaling test settings (conftest) use this key/secret pair.
_API_KEY = "testkey"
_API_SECRET = "testsecrettestsecrettestsecrettestsecret"
_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0")


def _sign(body: str) -> str:
    """Build a LiveKit-style webhook JWT for `body`."""
    digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
    now = int(time.time())
    return jwt.encode(
        {"iss": _API_KEY, "exp": now + 60, "nbf": now - 5, "sha256": digest},
        _API_SECRET,
        algorithm="HS256",
    )


def _event_body(
    event: str,
    room: str,
    identity: str | None = None,
    track_source: int | None = None,
) -> str:
    payload: dict = {"event": event, "id": str(uuid.uuid4()), "createdAt": int(time.time())}
    if room:
        payload["room"] = {"name": room, "sid": "RM_" + room}
    if identity is not None:
        payload["participant"] = {"identity": identity, "sid": "PA_" + identity}
    if track_source is not None:
        payload["track"] = {"source": track_source, "sid": "TR_test", "type": 1}
    return json.dumps(payload)


@pytest_asyncio.fixture
async def redis() -> Redis:
    r = Redis.from_url(_REDIS_URL, decode_responses=False)
    # Unique-ish prefix space: tests use unique channel ids, so no clash.
    yield r
    await r.aclose()


@pytest_asyncio.fixture
async def webhook_app(_isolate_voice_settings, redis):
    from dcc_voice_signaling.app import create_app

    app = create_app(skip_redis=True)
    app.state.redis = redis
    return app


@pytest_asyncio.fixture
async def webhook_client(webhook_app):
    import httpx

    transport = httpx.ASGITransport(app=webhook_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_webhook_rejects_missing_signature(webhook_client):
    r = await webhook_client.post("/webhook", content=_event_body("participant_joined", "channel-1", "user-1"))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_webhook_rejects_bad_signature(webhook_client):
    body = _event_body("participant_joined", "channel-1", "user-1")
    # Signature over a *different* body → hash mismatch.
    bad = _sign(_event_body("participant_joined", "channel-1", "user-99"))
    r = await webhook_client.post(
        "/webhook", content=body, headers={"Authorization": bad}
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_webhook_rejects_wrong_secret(webhook_client):
    body = _event_body("participant_joined", "channel-1", "user-1")
    digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
    forged = jwt.encode(
        {"iss": _API_KEY, "exp": int(time.time()) + 60, "sha256": digest},
        "wrong-secret-wrong-secret-wrong-secret",
        algorithm="HS256",
    )
    r = await webhook_client.post(
        "/webhook", content=body, headers={"Authorization": forged}
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_webhook_join_then_leave(webhook_client, redis):
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    pubsub = redis.pubsub(ignore_subscribe_messages=True)
    await pubsub.subscribe(VOICE_EVENTS_CHANNEL)
    try:
        # participant_joined
        body = _event_body("participant_joined", room, "user-42")
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        members = await redis.smembers(room_key(room))
        assert {m.decode() for m in members} == {"42"}
        # TTL must be set (self-heal).
        assert await redis.ttl(room_key(room)) > 0
        # A voice:events message was published with the full state.
        msg = await _drain_one(pubsub)
        assert msg is not None
        decoded = json.loads(msg["data"])
        assert decoded["channel_id"] == cid
        assert decoded["user_ids"] == ["42"]
        assert decoded["streaming_user_ids"] == []

        # participant_left → set empties → key deleted
        body = _event_body("participant_left", room, "user-42")
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        assert await redis.exists(room_key(room)) == 0
        msg = await _drain_one(pubsub)
        decoded = json.loads(msg["data"])
        assert decoded["channel_id"] == cid
        assert decoded["user_ids"] == []
        assert decoded["streaming_user_ids"] == []
    finally:
        await pubsub.aclose()
        await redis.delete(room_key(room))


@pytest.mark.asyncio
async def test_webhook_room_finished_clears(webhook_client, redis):
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    try:
        for ident in ("user-1", "user-2"):
            body = _event_body("participant_joined", room, ident)
            await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert await redis.scard(room_key(room)) == 2
        body = _event_body("room_finished", room)
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        assert await redis.exists(room_key(room)) == 0
    finally:
        await redis.delete(room_key(room))


@pytest.mark.asyncio
async def test_webhook_ignores_non_channel_room(webhook_client, redis):
    body = _event_body("participant_joined", "egress-something", "user-1")
    r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
    assert r.status_code == 204
    assert await redis.exists("voice:room:egress-something") == 0


@pytest.mark.asyncio
async def test_webhook_ignores_unknown_event(webhook_client, redis):
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    body = _event_body("some_unknown_event", room, "user-1")
    r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
    assert r.status_code == 204
    assert await redis.exists(room_key(room)) == 0


@pytest.mark.asyncio
async def test_webhook_track_published_camera_ignored(webhook_client, redis):
    """track_published for camera/mic tracks must not touch the streaming set."""
    from livekit.protocol.models import TrackSource
    from dcc_voice_signaling.webhook import streaming_key

    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    # Camera = source 1
    body = _event_body("track_published", room, "user-1", track_source=TrackSource.CAMERA)
    r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
    assert r.status_code == 204
    assert await redis.exists(streaming_key(room)) == 0


@pytest.mark.asyncio
async def test_webhook_screen_share_start_stop(webhook_client, redis):
    from livekit.protocol.models import TrackSource
    from dcc_voice_signaling.webhook import streaming_key

    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    pubsub = redis.pubsub(ignore_subscribe_messages=True)
    await pubsub.subscribe(VOICE_EVENTS_CHANNEL)
    try:
        # First join the room
        body = _event_body("participant_joined", room, "user-10")
        await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        await _drain_one(pubsub)

        # Start screen share → track_published with SCREEN_SHARE source
        body = _event_body("track_published", room, "user-10", track_source=TrackSource.SCREEN_SHARE)
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        sk = streaming_key(room)
        members = await redis.smembers(sk)
        assert {m.decode() for m in members} == {"10"}
        assert await redis.ttl(sk) > 0
        msg = await _drain_one(pubsub)
        assert msg is not None
        decoded = json.loads(msg["data"])
        assert decoded["channel_id"] == cid
        assert decoded["streaming_user_ids"] == ["10"]

        # Stop screen share → track_unpublished
        body = _event_body("track_unpublished", room, "user-10", track_source=TrackSource.SCREEN_SHARE)
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        assert await redis.exists(sk) == 0
        msg = await _drain_one(pubsub)
        decoded = json.loads(msg["data"])
        assert decoded["streaming_user_ids"] == []
    finally:
        await pubsub.aclose()
        await redis.delete(room_key(room))
        await redis.delete(streaming_key(room))


@pytest.mark.asyncio
async def test_webhook_participant_left_clears_streaming(webhook_client, redis):
    """participant_left must also remove user from the streaming set (missed track_unpublished)."""
    from livekit.protocol.models import TrackSource
    from dcc_voice_signaling.webhook import streaming_key

    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    try:
        # Join + start screenshare
        body = _event_body("participant_joined", room, "user-5")
        await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        body = _event_body("track_published", room, "user-5", track_source=TrackSource.SCREEN_SHARE)
        await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert {m.decode() for m in await redis.smembers(streaming_key(room))} == {"5"}

        # Participant leaves without unpublishing track
        body = _event_body("participant_left", room, "user-5")
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        assert await redis.exists(streaming_key(room)) == 0
    finally:
        await redis.delete(room_key(room))
        await redis.delete(streaming_key(room))


@pytest.mark.asyncio
async def test_webhook_room_finished_clears_streaming(webhook_client, redis):
    """room_finished must delete the streaming set as well."""
    from livekit.protocol.models import TrackSource
    from dcc_voice_signaling.webhook import streaming_key

    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    try:
        body = _event_body("participant_joined", room, "user-7")
        await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        body = _event_body("track_published", room, "user-7", track_source=TrackSource.SCREEN_SHARE)
        await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})

        body = _event_body("room_finished", room)
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        assert await redis.exists(room_key(room)) == 0
        assert await redis.exists(streaming_key(room)) == 0
    finally:
        await redis.delete(room_key(room))
        await redis.delete(streaming_key(room))


async def _drain_one(pubsub, attempts: int = 50):
    """Poll the pubsub for one message (subscribe confirmation already skipped)."""
    import asyncio

    for _ in range(attempts):
        msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
        if msg is not None and msg.get("type") == "message":
            return msg
        await asyncio.sleep(0.01)
    return None
