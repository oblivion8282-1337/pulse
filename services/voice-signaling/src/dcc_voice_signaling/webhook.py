"""LiveKit webhook receiver — keeps the voice-presence state in Redis.

LiveKit (running in a container) POSTs `participant_joined` / `participant_left`
/ `room_finished` / `track_published` / `track_unpublished` events here. We
verify the signature with the same API key/secret pair the token endpoint uses,
then maintain per-channel Redis sets and publish the full new state on the
`voice:events` pub/sub channel so chat-gateway can fan it out to WebSocket
clients.

Key layout (shared with chat-gateway, which only reads):
  - ``voice:room:channel-<channel_id>``           → Redis SET of user-id strings
  - ``voice:room:channel-<channel_id>:streaming`` → Redis SET of user-id strings
                                                     (users currently sharing screen)
  - publish on ``voice:events`` →
      ``{"channel_id": "<id>", "user_ids": [...], "streaming_user_ids": [...]}``

Room name / participant identity mapping mirrors ``routes.py``:
  - room   = ``channel-<channel_id>``           (``_room_for_channel``)
  - identity = ``user-<user_id>``               (``issue_token``)
"""

from __future__ import annotations

import json

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from livekit.api import TokenVerifier, WebhookReceiver
from livekit.protocol.models import TrackSource, TrackType
from redis.asyncio import Redis

from dcc_voice_signaling.config import get_settings

log = structlog.get_logger(__name__)

router = APIRouter()

# Atomically remove a member from a set and delete the key if it becomes empty.
# KEYS[1] = set key, ARGV[1] = member to remove.
# Returns 1 if the key was deleted (set became empty), 0 otherwise.
_LUA_SREM_DEL_IF_EMPTY = """
redis.call('SREM', KEYS[1], ARGV[1])
if redis.call('SCARD', KEYS[1]) == 0 then
    redis.call('DEL', KEYS[1])
    return 1
end
return 0
"""

# Atomically remove a member from the presence, streaming AND camera sets,
# deleting each key if it becomes empty.  Doing this in one round-trip avoids a
# window where a concurrent _publish_state reads an inconsistent snapshot
# (e.g. streaming_user_ids/camera_user_ids containing a user absent from
# user_ids).
# KEYS[1] = presence set, KEYS[2] = streaming set, KEYS[3] = camera set,
# ARGV[1] = member.
_LUA_LEAVE = """
redis.call('SREM', KEYS[1], ARGV[1])
if redis.call('SCARD', KEYS[1]) == 0 then
    redis.call('DEL', KEYS[1])
end
redis.call('SREM', KEYS[2], ARGV[1])
if redis.call('SCARD', KEYS[2]) == 0 then
    redis.call('DEL', KEYS[2])
end
redis.call('SREM', KEYS[3], ARGV[1])
if redis.call('SCARD', KEYS[3]) == 0 then
    redis.call('DEL', KEYS[3])
end
return 0
"""

VOICE_EVENTS_CHANNEL = "voice:events"
VOICE_ROOM_KEY = "voice:room:{room}"
VOICE_STREAMING_KEY = "voice:room:{room}:streaming"
VOICE_CAMERA_KEY = "voice:room:{room}:camera"
_ROOM_PREFIX = "channel-"
_IDENTITY_PREFIX = "user-"

# Int values for screen-share sources (Protobuf enum — both video+audio tracks).
_SCREEN_SHARE_SOURCES = frozenset({int(TrackSource.SCREEN_SHARE), int(TrackSource.SCREEN_SHARE_AUDIO)})
# Int value for the camera source (Protobuf enum).
_CAMERA_SOURCE = int(TrackSource.CAMERA)


def _as_str(m: bytes | str) -> str:
    """Decode a Redis set member to str (members may be bytes or str)."""
    return m.decode() if isinstance(m, bytes) else m


def _is_camera(track) -> bool:  # noqa: ANN001
    """Return True if this TrackInfo represents a webcam (CAMERA source).

    Unlike ``_is_screen_share`` there is no UNKNOWN-source fallback: a camera
    track is only counted when LiveKit explicitly tags it ``CAMERA`` (which it
    does for ``setCameraEnabled``). The screen-share check runs first in the
    handler and owns the UNKNOWN-video fallback, so the two never collide.
    """
    try:
        if int(track.source) == _CAMERA_SOURCE:
            return True
    except (TypeError, ValueError):
        pass
    return False


def _is_screen_share(track) -> bool:  # noqa: ANN001
    """Return True if this TrackInfo represents a screen-share (or its audio companion).

    LiveKit delivers `track.source` as a Protobuf-int-enum.  We defend against
    every representation the wire may carry: raw int, enum member, upper/lower-case
    string name.  The final fallback covers the case where source is missing or
    UNKNOWN (0): any VIDEO track that is NOT a camera is treated as a screen-share,
    because this app never publishes camera video into voice channels.
    """
    source_str = str(track.source).upper()

    # Int-based check first (covers Protobuf int-enum, Python int, "3"/"4" strings).
    try:
        source_int = int(track.source)
        if source_int in _SCREEN_SHARE_SOURCES:
            return True
    except (TypeError, ValueError):
        source_int = None

    # String name check ("SCREEN_SHARE" or "SCREEN_SHARE_AUDIO").
    if "SCREEN_SHARE" in source_str:
        return True

    # Track-name fallback + VIDEO-type fallback: only active when source is
    # explicitly 0/UNKNOWN (not a string like "CAMERA").  Gating on source_int==0
    # prevents a camera track with a misleading name like "screenshare" (from a
    # third-party LiveKit client) from being misidentified as a screen-share.
    if source_int == 0:
        name = (track.name or "").lower()
        if name in ("screen", "screenshare", "screen_share"):
            return True
        # Final pragmatic fallback: any VIDEO track with UNKNOWN source →
        # screen-share, because camera video is never published in this app's
        # voice channels.
        try:
            is_video = int(track.type) == int(TrackType.VIDEO)
            if is_video:
                return True
        except (TypeError, ValueError):
            pass

    return False


def room_key(room_name: str) -> str:
    return VOICE_ROOM_KEY.format(room=room_name)


def streaming_key(room_name: str) -> str:
    return VOICE_STREAMING_KEY.format(room=room_name)


def camera_key(room_name: str) -> str:
    return VOICE_CAMERA_KEY.format(room=room_name)


def channel_id_from_room(room_name: str) -> str | None:
    if not room_name.startswith(_ROOM_PREFIX):
        return None
    cid = room_name[len(_ROOM_PREFIX) :]
    return cid or None


def user_id_from_identity(identity: str) -> str | None:
    if not identity.startswith(_IDENTITY_PREFIX):
        return None
    uid = identity[len(_IDENTITY_PREFIX) :]
    return uid or None


def _get_redis(request: Request) -> Redis:
    redis: Redis | None = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="redis unavailable"
        )
    return redis


_receiver_singleton: WebhookReceiver | None = None


def _receiver() -> WebhookReceiver:
    """Return a cached WebhookReceiver singleton.

    The API key and secret never change at runtime, so constructing a new
    TokenVerifier (and its HMAC signing-key setup) on every webhook POST is
    pure waste.  The singleton is initialised on the first call and reused
    for all subsequent requests.
    """
    global _receiver_singleton
    if _receiver_singleton is None:
        settings = get_settings()
        _receiver_singleton = WebhookReceiver(
            TokenVerifier(settings.livekit_api_key, settings.livekit_api_secret)
        )
    return _receiver_singleton


async def _publish_state(redis: Redis, room_name: str, channel_id: str) -> None:
    from dcc_shared.events import VoiceStateSnapshot

    pipe = redis.pipeline(transaction=False)
    pipe.smembers(room_key(room_name))
    pipe.smembers(streaming_key(room_name))
    pipe.smembers(camera_key(room_name))
    members_raw, streamers_raw, camera_raw = await pipe.execute()
    user_ids = sorted(_as_str(m) for m in members_raw)
    streaming_user_ids = sorted(_as_str(m) for m in streamers_raw)
    camera_user_ids = sorted(_as_str(m) for m in camera_raw)
    snapshot = VoiceStateSnapshot(
        channel_id=channel_id,
        user_ids=user_ids,
        streaming_user_ids=streaming_user_ids,
        camera_user_ids=camera_user_ids,
    )
    await redis.publish(
        VOICE_EVENTS_CHANNEL,
        json.dumps(snapshot.model_dump(mode="json"), separators=(",", ":")),
    )


async def _apply_join(redis: Redis, room_name: str, user_id: str) -> None:
    settings = get_settings()
    key = room_key(room_name)
    pipe = redis.pipeline(transaction=False)
    pipe.sadd(key, user_id)
    # NX: only set TTL when the key is new (sadd=1 first time). This prevents
    # a ghost presence (missed participant_left) from having its TTL refreshed
    # on every subsequent join, keeping the self-heal window intact.
    pipe.expire(key, settings.voice_state_ttl_seconds, nx=True)
    await pipe.execute()


async def _apply_leave(redis: Redis, room_name: str, user_id: str) -> None:
    key = room_key(room_name)
    sk = streaming_key(room_name)
    ck = camera_key(room_name)
    # Atomic: remove from ALL three sets in one Lua round-trip.  Separate eval
    # calls would leave a window where a concurrent _publish_state reads an
    # inconsistent snapshot (streaming_/camera_user_ids containing a user absent
    # from user_ids).
    await redis.eval(_LUA_LEAVE, 3, key, sk, ck, user_id)  # type: ignore[arg-type]


async def _apply_room_finished(redis: Redis, room_name: str) -> None:
    await redis.delete(
        room_key(room_name), streaming_key(room_name), camera_key(room_name)
    )


async def _sadd_subkey_coupled(
    redis: Redis, sub_key: str, room_name: str, user_id: str
) -> None:
    """SADD into a streaming/camera sub-key and bound its TTL to the presence
    key's *current* expiry.

    The sub-key must never outlive the presence key (voice:room:channel-<id>),
    otherwise _publish_state could broadcast streaming_/camera_user_ids that are
    absent from user_ids (invariant: streaming/camera ⊆ presence). A separate
    independent TTL (the old bug) could do exactly that when a share starts hours
    after the join. Coupling to the presence key's remaining TTL on every call
    keeps the sub-key's expiry ≤ the presence expiry, while still leaving a
    safety-net TTL (the test/self-heal both rely on the sub-key being volatile).
    Falls back to the full TTL only if the presence key has no expiry (-1) or is
    already gone (-2) — a bounded net, not an unbounded leak.
    """
    settings = get_settings()
    room_ttl = await redis.ttl(room_key(room_name))
    ttl = room_ttl if room_ttl and room_ttl > 0 else settings.voice_state_ttl_seconds
    pipe = redis.pipeline(transaction=False)
    pipe.sadd(sub_key, user_id)
    pipe.expire(sub_key, ttl)
    await pipe.execute()


async def _apply_screen_share_start(redis: Redis, room_name: str, user_id: str) -> None:
    await _sadd_subkey_coupled(redis, streaming_key(room_name), room_name, user_id)


async def _apply_screen_share_stop(redis: Redis, room_name: str, user_id: str) -> None:
    sk = streaming_key(room_name)
    # Atomic: SREM + conditional DEL via Lua (same TOCTOU fix as _apply_leave).
    await redis.eval(_LUA_SREM_DEL_IF_EMPTY, 1, sk, user_id)  # type: ignore[arg-type]


async def _apply_camera_start(redis: Redis, room_name: str, user_id: str) -> None:
    await _sadd_subkey_coupled(redis, camera_key(room_name), room_name, user_id)


async def _apply_camera_stop(redis: Redis, room_name: str, user_id: str) -> None:
    ck = camera_key(room_name)
    # Atomic: SREM + conditional DEL via Lua (same TOCTOU fix as _apply_leave).
    await redis.eval(_LUA_SREM_DEL_IF_EMPTY, 1, ck, user_id)  # type: ignore[arg-type]


@router.post("/webhook", status_code=status.HTTP_204_NO_CONTENT)
async def livekit_webhook(request: Request) -> None:
    auth_header = request.headers.get("authorization") or request.headers.get(
        "Authorization"
    )
    if not auth_header:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing signature")
    raw_body = await request.body()
    try:
        body = raw_body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="invalid request body encoding") from exc
    try:
        event = _receiver().receive(body, auth_header)
    except Exception as exc:  # noqa: BLE001 — any verify error is a 401
        log.warning("webhook_rejected", error=str(exc))
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="bad signature") from exc

    room_name = event.room.name if event.HasField("room") else ""
    if not room_name:
        return
    channel_id = channel_id_from_room(room_name)
    if channel_id is None:
        # Not one of our voice-channel rooms — ignore.
        return

    redis = _get_redis(request)
    kind = event.event

    log.info("webhook_event", kind=kind, room=room_name, channel_id=channel_id)

    if kind == "room_finished":
        await _apply_room_finished(redis, room_name)
        await _publish_state(redis, room_name, channel_id)
        return

    if kind in ("participant_joined", "participant_left"):
        if not event.HasField("participant"):
            return
        user_id = user_id_from_identity(event.participant.identity)
        if user_id is None:
            return
        if kind == "participant_joined":
            await _apply_join(redis, room_name, user_id)
        else:
            await _apply_leave(redis, room_name, user_id)
        await _publish_state(redis, room_name, channel_id)
        if kind == "participant_left":
            # Late import dodges the routes ↔ webhook load cycle.
            from dcc_voice_signaling.routes.chat_gateway import _maybe_revoke_voice_pull

            await _maybe_revoke_voice_pull(redis, channel_id, user_id)
        return

    if kind in ("track_published", "track_unpublished"):
        has_track = event.HasField("track")
        has_participant = event.HasField("participant")
        log.info(
            "track_event",
            kind=kind,
            has_track=has_track,
            has_participant=has_participant,
            track_source=int(event.track.source) if has_track else None,
            track_type=int(event.track.type) if has_track else None,
            track_name=event.track.name if has_track else None,
            track_sid=event.track.sid if has_track else None,
        )
        if not has_participant or not has_track:
            return
        user_id = user_id_from_identity(event.participant.identity)
        if user_id is None:
            return
        # Screen-share check runs first (it owns the UNKNOWN-source video
        # fallback); camera is only the explicit CAMERA source.
        if _is_screen_share(event.track):
            log.info("screen_share_event", kind=kind, user_id=user_id, room=room_name)
            if kind == "track_published":
                await _apply_screen_share_start(redis, room_name, user_id)
            else:
                await _apply_screen_share_stop(redis, room_name, user_id)
            await _publish_state(redis, room_name, channel_id)
            return
        if _is_camera(event.track):
            log.info("camera_event", kind=kind, user_id=user_id, room=room_name)
            if kind == "track_published":
                await _apply_camera_start(redis, room_name, user_id)
            else:
                await _apply_camera_stop(redis, room_name, user_id)
            await _publish_state(redis, room_name, channel_id)
            return
        return
