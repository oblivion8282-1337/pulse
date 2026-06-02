"""Tests for the periodic LiveKit→Redis presence reconciliation."""

from __future__ import annotations

import asyncio
import json
import os
import uuid

import pytest
import pytest_asyncio
from dcc_voice_signaling.reconcile import reconcile_once
from dcc_voice_signaling.webhook import (
    VOICE_EVENTS_CHANNEL,
    camera_key,
    room_key,
    streaming_key,
)
from redis.asyncio import Redis

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0")

# Track sources (mirror livekit.protocol.models.TrackSource ints).
_SRC_CAMERA = 1
_SRC_SCREEN_SHARE = 3
_TYPE_VIDEO = 1


# --- LiveKit API fakes -----------------------------------------------------
class _FakeTrack:
    def __init__(self, source: int, type_: int = _TYPE_VIDEO, name: str = ""):
        self.source = source
        self.type = type_
        self.name = name


class _FakeParticipant:
    def __init__(self, identity: str, tracks: list[_FakeTrack] | None = None):
        self.identity = identity
        self.tracks = tracks or []


class _FakeRoom:
    def __init__(self, name: str):
        self.name = name


class _FakeRoomService:
    def __init__(self, layout: dict[str, list[_FakeParticipant]]):
        # room_name -> participants
        self._layout = layout

    async def list_rooms(self, _req):  # noqa: ANN001
        return type("Resp", (), {"rooms": [_FakeRoom(n) for n in self._layout]})()

    async def list_participants(self, req):  # noqa: ANN001
        parts = self._layout.get(req.room, [])
        return type("Resp", (), {"participants": parts})()


class _FakeLiveKitAPI:
    def __init__(self, layout: dict[str, list[_FakeParticipant]]):
        self.room = _FakeRoomService(layout)


@pytest_asyncio.fixture
async def redis() -> Redis:
    r = Redis.from_url(_REDIS_URL, decode_responses=False)
    yield r
    await r.aclose()


def _members(redis_set) -> set[str]:
    return {m.decode() if isinstance(m, bytes) else m for m in redis_set}


async def _drain_one(pubsub, attempts: int = 50):
    for _ in range(attempts):
        msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
        if msg is not None and msg.get("type") == "message":
            return msg
        await asyncio.sleep(0.01)
    return None


@pytest.mark.asyncio
async def test_reconcile_populates_from_livekit(redis):
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    lk = _FakeLiveKitAPI(
        {
            room: [
                _FakeParticipant("user-1"),  # mic only
                _FakeParticipant("user-2", [_FakeTrack(_SRC_SCREEN_SHARE)]),
                _FakeParticipant("user-3", [_FakeTrack(_SRC_CAMERA)]),
            ]
        }
    )
    try:
        summary = await reconcile_once(redis, lk, ttl_seconds=3600)
        assert summary["rooms"] == 1
        assert _members(await redis.smembers(room_key(room))) == {"1", "2", "3"}
        assert _members(await redis.smembers(streaming_key(room))) == {"2"}
        assert _members(await redis.smembers(camera_key(room))) == {"3"}
        # Fresh TTL applied (backstop if reconcile stops running).
        assert await redis.ttl(room_key(room)) > 0
    finally:
        await redis.delete(room_key(room), streaming_key(room), camera_key(room))


@pytest.mark.asyncio
async def test_reconcile_removes_ghost_members(redis):
    """A stale member left over from a missed participant_left is corrected to
    match LiveKit's actual participant list."""
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    # Pre-seed Redis with a ghost (user-99) + a real user.
    await redis.sadd(room_key(room), "99", "1")
    lk = _FakeLiveKitAPI({room: [_FakeParticipant("user-1")]})
    try:
        await reconcile_once(redis, lk, ttl_seconds=3600)
        assert _members(await redis.smembers(room_key(room))) == {"1"}
    finally:
        await redis.delete(room_key(room), streaming_key(room), camera_key(room))


@pytest.mark.asyncio
async def test_reconcile_clears_stale_channel(redis):
    """A voice:room set for a room LiveKit no longer has is deleted and an
    empty snapshot is published so clients clear it."""
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    await redis.sadd(room_key(room), "7")
    await redis.sadd(streaming_key(room), "7")
    pubsub = redis.pubsub(ignore_subscribe_messages=True)
    await pubsub.subscribe(VOICE_EVENTS_CHANNEL)
    try:
        # LiveKit reports NO rooms → the seeded channel is stale.
        summary = await reconcile_once(redis, _FakeLiveKitAPI({}), ttl_seconds=3600)
        assert summary["stale_cleared"] >= 1
        assert await redis.exists(room_key(room)) == 0
        assert await redis.exists(streaming_key(room)) == 0
        # The empty snapshot for this channel was published.
        seen = []
        for _ in range(10):
            msg = await _drain_one(pubsub)
            if msg is None:
                break
            seen.append(json.loads(msg["data"]))
        empty = [m for m in seen if m["channel_id"] == cid]
        assert empty and empty[-1]["user_ids"] == []
    finally:
        await pubsub.aclose()
        await redis.delete(room_key(room), streaming_key(room), camera_key(room))


@pytest.mark.asyncio
async def test_reconcile_publishes_snapshot(redis):
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    lk = _FakeLiveKitAPI({room: [_FakeParticipant("user-5")]})
    pubsub = redis.pubsub(ignore_subscribe_messages=True)
    await pubsub.subscribe(VOICE_EVENTS_CHANNEL)
    try:
        await reconcile_once(redis, lk, ttl_seconds=3600)
        msg = await _drain_one(pubsub)
        assert msg is not None
        decoded = json.loads(msg["data"])
        assert decoded["channel_id"] == cid
        assert decoded["user_ids"] == ["5"]
    finally:
        await pubsub.aclose()
        await redis.delete(room_key(room), streaming_key(room), camera_key(room))


@pytest.mark.asyncio
async def test_reconcile_ignores_non_channel_rooms(redis):
    """Rooms that aren't ``channel-<id>`` are skipped, not crashed on."""
    lk = _FakeLiveKitAPI({"some-other-room": [_FakeParticipant("user-1")]})
    summary = await reconcile_once(redis, lk, ttl_seconds=3600)
    assert summary["rooms"] == 0
