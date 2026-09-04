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
async def test_webhook_camera_start_stop(webhook_client, redis):
    """track_published/unpublished for a CAMERA track maintains the camera set
    (not the streaming set) and publishes camera_user_ids."""
    from livekit.protocol.models import TrackSource
    from dcc_voice_signaling.webhook import camera_key, streaming_key

    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    pubsub = redis.pubsub(ignore_subscribe_messages=True)
    await pubsub.subscribe(VOICE_EVENTS_CHANNEL)
    try:
        body = _event_body("participant_joined", room, "user-1")
        await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        await _drain_one(pubsub)

        # Camera on → track_published with CAMERA source (= 1)
        body = _event_body("track_published", room, "user-1", track_source=TrackSource.CAMERA)
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        ck = camera_key(room)
        assert {m.decode() for m in await redis.smembers(ck)} == {"1"}
        assert await redis.ttl(ck) > 0
        # Camera must NOT bleed into the screen-share set.
        assert await redis.exists(streaming_key(room)) == 0
        decoded = json.loads((await _drain_one(pubsub))["data"])
        assert decoded["camera_user_ids"] == ["1"]
        assert decoded["streaming_user_ids"] == []

        # Camera off → track_unpublished
        body = _event_body("track_unpublished", room, "user-1", track_source=TrackSource.CAMERA)
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        assert await redis.exists(ck) == 0
        decoded = json.loads((await _drain_one(pubsub))["data"])
        assert decoded["camera_user_ids"] == []
    finally:
        await pubsub.aclose()
        await redis.delete(room_key(room))
        await redis.delete(camera_key(room))


@pytest.mark.asyncio
async def test_webhook_participant_left_clears_camera(webhook_client, redis):
    """participant_left must also remove the user from the camera set
    (missed track_unpublished self-heal)."""
    from livekit.protocol.models import TrackSource
    from dcc_voice_signaling.webhook import camera_key

    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    try:
        body = _event_body("participant_joined", room, "user-5")
        await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        body = _event_body("track_published", room, "user-5", track_source=TrackSource.CAMERA)
        await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert {m.decode() for m in await redis.smembers(camera_key(room))} == {"5"}

        body = _event_body("participant_left", room, "user-5")
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        assert await redis.exists(camera_key(room)) == 0
    finally:
        await redis.delete(room_key(room))
        await redis.delete(camera_key(room))


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


@pytest.mark.asyncio
async def test_is_screen_share_int_source():
    """_is_screen_share must accept raw int source values (3 and 4)."""
    from dcc_voice_signaling.webhook import _is_screen_share

    class FakeTrack:
        def __init__(self, source, track_type=1, name=""):
            self.source = source
            self.type = track_type
            self.name = name

    assert _is_screen_share(FakeTrack(source=3))   # SCREEN_SHARE int
    assert _is_screen_share(FakeTrack(source=4))   # SCREEN_SHARE_AUDIO int
    assert not _is_screen_share(FakeTrack(source=1, track_type=1))  # CAMERA video
    assert not _is_screen_share(FakeTrack(source=2, track_type=0))  # MICROPHONE audio


@pytest.mark.asyncio
async def test_is_screen_share_string_source():
    """_is_screen_share must accept string source values like 'SCREEN_SHARE'."""
    from dcc_voice_signaling.webhook import _is_screen_share

    class FakeTrack:
        def __init__(self, source, track_type=1, name=""):
            self.source = source
            self.type = track_type
            self.name = name

    assert _is_screen_share(FakeTrack(source="SCREEN_SHARE"))
    assert _is_screen_share(FakeTrack(source="SCREEN_SHARE_AUDIO"))
    assert _is_screen_share(FakeTrack(source="screen_share"))  # lowercase
    assert not _is_screen_share(FakeTrack(source="CAMERA", track_type=1))


@pytest.mark.asyncio
async def test_is_screen_share_name_fallback():
    """_is_screen_share must detect screen-share by track name if source is UNKNOWN."""
    from dcc_voice_signaling.webhook import _is_screen_share

    class FakeTrack:
        def __init__(self, source, track_type=1, name=""):
            self.source = source
            self.type = track_type
            self.name = name

    assert _is_screen_share(FakeTrack(source=0, track_type=1, name="screenshare"))
    assert _is_screen_share(FakeTrack(source=0, track_type=1, name="screen_share_v0"))
    assert not _is_screen_share(FakeTrack(source=0, track_type=0, name="mic"))


@pytest.mark.asyncio
async def test_is_screen_share_video_fallback():
    """VIDEO track with unknown/0 source but not CAMERA → fallback screen-share."""
    from dcc_voice_signaling.webhook import _is_screen_share

    class FakeTrack:
        def __init__(self, source, track_type, name=""):
            self.source = source
            self.type = track_type
            self.name = name

    # source=0 (UNKNOWN), type=1 (VIDEO) → screen-share
    assert _is_screen_share(FakeTrack(source=0, track_type=1))
    # source=1 (CAMERA), type=1 (VIDEO) → NOT screen-share
    assert not _is_screen_share(FakeTrack(source=1, track_type=1))


@pytest.mark.asyncio
async def test_webhook_screen_share_audio_track(webhook_client, redis):
    """track_published with SCREEN_SHARE_AUDIO source must also set the streaming badge."""
    from dcc_voice_signaling.webhook import streaming_key

    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    try:
        body = _event_body("participant_joined", room, "user-20")
        await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})

        # SCREEN_SHARE_AUDIO = source 4
        body = _event_body("track_published", room, "user-20", track_source=4)
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        members = await redis.smembers(streaming_key(room))
        assert {m.decode() for m in members} == {"20"}
    finally:
        await redis.delete(room_key(room))
        await redis.delete(streaming_key(room))


@pytest.mark.asyncio
async def test_webhook_screen_share_int_source(webhook_client, redis):
    """track_published with raw int source=3 (SCREEN_SHARE) must set the streaming badge."""
    from dcc_voice_signaling.webhook import streaming_key

    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    try:
        body = _event_body("participant_joined", room, "user-30")
        await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})

        body = _event_body("track_published", room, "user-30", track_source=3)
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        members = await redis.smembers(streaming_key(room))
        assert {m.decode() for m in members} == {"30"}
    finally:
        await redis.delete(room_key(room))
        await redis.delete(streaming_key(room))


@pytest.mark.asyncio
async def test_webhook_join_does_not_extend_ttl_for_existing_member(webhook_client, redis):
    """Fix 3: repeated joins must not refresh the TTL — ghost presence self-heals."""
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    try:
        # First join sets TTL.
        body = _event_body("participant_joined", room, "user-99")
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        ttl_after_first = await redis.ttl(room_key(room))
        assert ttl_after_first > 0

        # Manually trim the TTL to a small value to simulate near-expiry.
        await redis.expire(room_key(room), 30)
        ttl_trimmed = await redis.ttl(room_key(room))
        assert ttl_trimmed <= 30

        # Second join of the same user — TTL must NOT be extended (NX semantics).
        body = _event_body("participant_joined", room, "user-99")
        r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
        assert r.status_code == 204
        ttl_after_second = await redis.ttl(room_key(room))
        assert ttl_after_second <= 30, (
            f"TTL was extended on re-join ({ttl_after_second}s) — ghost-presence bug still present"
        )
    finally:
        await redis.delete(room_key(room))


# ---- voice-pull revoke trigger on participant_left -----------------------


@pytest.mark.asyncio
async def test_webhook_fires_revoke_on_participant_left(webhook_client, monkeypatch):
    """participant_left für einen Voice-Channel → _maybe_revoke_voice_pull
    wird (mit channel_id + user_id) aufgerufen."""
    import dcc_voice_signaling.routes.chat_gateway as cg

    calls: list[tuple[str, str]] = []

    async def _spy(_redis, cid, uid):
        calls.append((cid, uid))

    monkeypatch.setattr(cg, "_maybe_revoke_voice_pull", _spy)
    body = _event_body("participant_left", "channel-77", "user-88")
    r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
    assert r.status_code == 204
    assert calls == [("77", "88")]


@pytest.mark.asyncio
async def test_webhook_does_not_fire_revoke_on_join(webhook_client, monkeypatch):
    """participant_joined darf den Revoke-Trigger NICHT feuern."""
    import dcc_voice_signaling.routes.chat_gateway as cg

    calls: list[tuple[str, str]] = []

    async def _spy(_redis, cid, uid):
        calls.append((cid, uid))

    monkeypatch.setattr(cg, "_maybe_revoke_voice_pull", _spy)
    body = _event_body("participant_joined", "channel-77", "user-88")
    await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
    assert calls == []


async def _drain_one(pubsub, attempts: int = 50):
    """Poll the pubsub for one message (subscribe confirmation already skipped)."""
    import asyncio

    for _ in range(attempts):
        msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
        if msg is not None and msg.get("type") == "message":
            return msg
        await asyncio.sleep(0.01)
    return None


@pytest.mark.asyncio
async def test_webhook_gast_kommt_mit_namen_in_die_praesenz(webhook_client, redis):
    """Ein Gast steht in denselben Sets — mit Präfix und mit Namen.

    Beides ist nötig und beides aus einem Grund: die Mitglieder-Oberfläche kann
    für eine Gast-Kennung nirgendwo ein Profil nachschlagen. Ohne das Präfix
    wäre sie von einer Nutzer-ID nicht zu unterscheiden (und die Oberfläche
    liefe in einen Profil-Abruf, den es nicht gibt); ohne den Namen im Ereignis
    stünde bei den Mitgliedern „gast-77" statt „Frau Meier".
    """
    from dcc_shared import gaeste

    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    await redis.hset(gaeste.GAST_KEY.format(gast_id="gast-77"), mapping={"name": "Frau Meier"})
    pubsub = redis.pubsub(ignore_subscribe_messages=True)
    await pubsub.subscribe(VOICE_EVENTS_CHANNEL)
    try:
        body = _event_body("participant_joined", room, "gast-77")
        r = await webhook_client.post(
            "/webhook", content=body, headers={"Authorization": _sign(body)}
        )
        assert r.status_code == 204
        assert {m.decode() for m in await redis.smembers(room_key(room))} == {"gast-77"}
        decoded = json.loads((await _drain_one(pubsub))["data"])
        assert decoded["user_ids"] == ["gast-77"]
        assert decoded["gast_namen"] == {"gast-77": "Frau Meier"}
    finally:
        await pubsub.aclose()
        await redis.delete(room_key(room))
        await redis.delete(gaeste.GAST_KEY.format(gast_id="gast-77"))


@pytest.mark.asyncio
async def test_webhook_gast_ohne_namenseintrag_faellt_nicht_um(webhook_client, redis):
    """Ein fehlender Name ist ein Schönheitsfehler, kein Fehler.

    Er kommt vor: Redis war beim Beitritt gestört, oder das Ticket lief
    zwischen Beitritt und Ereignis ab. Der Gast SITZT dann trotzdem im Kanal —
    eine Präsenz, die ihn deshalb verschwiege, wäre falsch.
    """
    cid = str(abs(hash(uuid.uuid4())) & ((1 << 31) - 1))
    room = f"channel-{cid}"
    pubsub = redis.pubsub(ignore_subscribe_messages=True)
    await pubsub.subscribe(VOICE_EVENTS_CHANNEL)
    try:
        body = _event_body("participant_joined", room, "gast-999")
        await webhook_client.post(
            "/webhook", content=body, headers={"Authorization": _sign(body)}
        )
        decoded = json.loads((await _drain_one(pubsub))["data"])
        assert decoded["user_ids"] == ["gast-999"]
        assert decoded["gast_namen"] == {}
    finally:
        await pubsub.aclose()
        await redis.delete(room_key(room))
