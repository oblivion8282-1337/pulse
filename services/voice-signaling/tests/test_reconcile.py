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
    gast_stumm_key,
    room_key,
    streaming_key,
)
from redis.asyncio import Redis

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0")

# Track sources (mirror livekit.protocol.models.TrackSource ints).
_SRC_CAMERA = 1
_SRC_MICROPHONE = 2
_SRC_SCREEN_SHARE = 3
_TYPE_VIDEO = 1


# --- LiveKit API fakes -----------------------------------------------------
class _FakeTrack:
    def __init__(
        self,
        source: int,
        type_: int = _TYPE_VIDEO,
        name: str = "",
        muted: bool = False,
    ):
        self.source = source
        self.type = type_
        self.name = name
        self.muted = muted


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
        self.removed: list[tuple[str, str]] = []

    async def list_rooms(self, _req):  # noqa: ANN001
        return type("Resp", (), {"rooms": [_FakeRoom(n) for n in self._layout]})()

    async def list_participants(self, req):  # noqa: ANN001
        parts = self._layout.get(req.room, [])
        return type("Resp", (), {"participants": parts})()

    async def remove_participant(self, req):  # noqa: ANN001
        self.removed.append((req.room, req.identity))


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


class _RaceRoomService(_FakeRoomService):
    """First ``list_rooms`` (the pass snapshot) is empty; a later name-scoped
    ``list_rooms`` reports ``late_room`` — simulating a room that LiveKit
    created (and a ``participant_joined`` webhook populated) in the window
    between the snapshot and the ghost-clear re-check."""

    def __init__(self, late_room: str):
        super().__init__({})
        self._late_room = late_room
        self._calls = 0

    async def list_rooms(self, req):  # noqa: ANN001
        self._calls += 1
        names = list(getattr(req, "names", []) or [])
        if self._calls == 1:
            return type("Resp", (), {"rooms": []})()
        rooms = [_FakeRoom(self._late_room)] if self._late_room in names else []
        return type("Resp", (), {"rooms": rooms})()


@pytest.mark.asyncio
async def test_reconcile_spares_room_created_during_pass(redis):
    """TOCTOU guard: a room whose presence key appeared *after* the snapshot
    (racing webhook) must NOT be ghost-cleared — the name-scoped re-check sees
    LiveKit now has it, so its freshly-joined member survives."""
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    # Webhook already wrote the new participant's presence key.
    await redis.sadd(room_key(room), "42")
    lk = _FakeLiveKitAPI({})
    lk.room = _RaceRoomService(room)
    try:
        summary = await reconcile_once(redis, lk, ttl_seconds=3600)
        assert summary["stale_cleared"] == 0
        # The racing participant's presence survived.
        assert _members(await redis.smembers(room_key(room))) == {"42"}
    finally:
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


# --- server-side LiveKit API host selection --------------------------------
class _Cfg:
    def __init__(self, livekit_url, livekit_api_url=None):
        self.livekit_url = livekit_url
        self.livekit_api_url = livekit_api_url


def test_api_host_prefers_internal_url():
    from dcc_voice_signaling.app import _livekit_api_host

    cfg = _Cfg("wss://howispulse.com/livekit", "http://host.docker.internal:7880")
    assert _livekit_api_host(cfg) == "http://host.docker.internal:7880"


def test_api_host_falls_back_to_public_and_normalises_scheme():
    from dcc_voice_signaling.app import _livekit_api_host

    # Unset internal → public URL, ws(s):// normalised to http(s)://.
    assert _livekit_api_host(_Cfg("wss://howispulse.com/livekit")) == (
        "https://howispulse.com/livekit"
    )
    assert _livekit_api_host(_Cfg("ws://localhost:7880")) == "http://localhost:7880"


@pytest.mark.asyncio
async def test_reconcile_traegt_stumme_gaeste_ein(redis):
    """Der Mute-Zustand eines Gastes kommt NUR aus dieser Abfrage — LiveKit
    sendet keine track_muted-Webhooks. Ein Gast mit stummem Mikrofon landet im
    ``:gast-stumm``-Set und im Schnappschuss; ein entmutedeter nicht, ein
    MITGLIED (Selbstmeldung) niemals."""
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    lk = _FakeLiveKitAPI(
        {
            room: [
                # Gast, stumm (Mikrofon gemutet).
                _FakeParticipant(
                    "gast-10", [_FakeTrack(_SRC_MICROPHONE, muted=True)]
                ),
                # Gast, tätig (Mikrofon offen).
                _FakeParticipant("gast-11", [_FakeTrack(_SRC_MICROPHONE)]),
                # Mitglied, stumm — bewusst NICHT hier tracked.
                _FakeParticipant(
                    "user-20", [_FakeTrack(_SRC_MICROPHONE, muted=True)]
                ),
            ]
        }
    )
    pubsub = redis.pubsub(ignore_subscribe_messages=True)
    await pubsub.subscribe(VOICE_EVENTS_CHANNEL)
    try:
        await reconcile_once(redis, lk, ttl_seconds=3600)
        assert _members(await redis.smembers(gast_stumm_key(room))) == {"gast-10"}
        msg = await _drain_one(pubsub)
        assert msg is not None
        decoded = json.loads(msg["data"])
        assert decoded["gast_stumm"] == ["gast-10"]
        # Mitglieder stehen ohne Praefix im Set, Gaeste mit.
        assert decoded["user_ids"] == ["20", "gast-10", "gast-11"]
    finally:
        await pubsub.aclose()
        await redis.delete(
            room_key(room), streaming_key(room), camera_key(room), gast_stumm_key(room)
        )


@pytest.mark.asyncio
async def test_reconcile_raeumt_stumm_set_beinem_abbau(redis):
    """Muted der Gast und geht dann, ist der Eintrag im nächsten Durchlauf weg —
    ein Wiedereintritt gilt als nicht stumm, bis er selbst wieder mutet. Der
    verbleibende Gast trägt ein OFFENES Mikrofon (Gäste ohne Mikrofon-Track
    gelten seit 2026-09 als stumm und würden sonst den Assert verwässern)."""
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    await redis.sadd(gast_stumm_key(room), "gast-10")
    lk = _FakeLiveKitAPI(
        {room: [_FakeParticipant("gast-11", [_FakeTrack(_SRC_MICROPHONE)])]}
    )
    try:
        await reconcile_once(redis, lk, ttl_seconds=3600)
        assert await redis.exists(gast_stumm_key(room)) == 0
    finally:
        await redis.delete(
            room_key(room), streaming_key(room), camera_key(room), gast_stumm_key(room)
        )


@pytest.mark.asyncio
async def test_reconcile_gast_ohne_mikrofon_track_gilt_als_stumm(redis):
    """Ein Gast, dessen Mikrofon-Track FEHLT (Drittclient, Publish-Fehler),
    ist serverseitig stumm — vorher führte ihn die Kachel als „laut“,
    obwohl nichts zu hören ist."""
    from dcc_voice_signaling.webhook import gast_stumm_key

    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    # Gast mit nur Kamera-Track (kein Mikrofon) + Gast ohne jeden Track.
    lk = _FakeLiveKitAPI(
        {
            room: [
                _FakeParticipant("gast-60", [_FakeTrack(_SRC_CAMERA)]),
                _FakeParticipant("gast-61"),
            ]
        }
    )
    try:
        await reconcile_once(redis, lk, ttl_seconds=3600)
        stumm = _members(await redis.smembers(gast_stumm_key(room)))
        assert stumm == {"gast-60", "gast-61"}
    finally:
        await redis.delete(
            room_key(room), streaming_key(room), camera_key(room), gast_stumm_key(room)
        )


@pytest.mark.asyncio
async def test_reconcile_wirft_gesperrten_gast_aus_dem_raum(redis):
    """LiveKit hat keine Sperrliste: ein gesperrter Gast, der mit seinem
    noch gültigen JWT neu joint, wird vom Sweep entfernt und taucht in
    KEINEM Set auf."""
    from dcc_shared import gaeste
    from dcc_voice_signaling.reconcile import reconcile_once
    from dcc_voice_signaling.webhook import camera_key, gast_stumm_key, room_key, streaming_key

    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    await gaeste.sperren(redis, "gast-70", ttl_s=600)
    lk = _FakeLiveKitAPI({room: [_FakeParticipant("gast-70"), _FakeParticipant("user-9")]})
    try:
        await reconcile_once(redis, lk, ttl_seconds=3600)
        # Aus der Präsenz raus …
        assert "gast-70" not in _members(await redis.smembers(room_key(room)))
        assert "9" in _members(await redis.smembers(room_key(room)))
        # … und aus LiveKit ebenfalls.
        assert lk.room.removed == [("channel-" + cid, "gast-70")]
    finally:
        await redis.delete(
            room_key(room), streaming_key(room), camera_key(room), gast_stumm_key(room),
            gaeste.GAST_SPERRE_KEY.format(gast_id="gast-70"),
        )
