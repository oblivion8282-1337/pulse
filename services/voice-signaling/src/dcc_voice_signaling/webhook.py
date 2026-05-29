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

# Atomically remove a member from BOTH the presence set and the streaming set,
# deleting each key if it becomes empty.  Two separate eval calls would leave a
# window where the presence key is updated but the streaming key is not — a
# concurrent _publish_state could then read an invalid state (streaming_user_ids
# contains a user who is absent from user_ids).
# KEYS[1] = presence set key, KEYS[2] = streaming set key, ARGV[1] = member.
_LUA_LEAVE = """
redis.call('SREM', KEYS[1], ARGV[1])
if redis.call('SCARD', KEYS[1]) == 0 then
    redis.call('DEL', KEYS[1])
end
redis.call('SREM', KEYS[2], ARGV[1])
if redis.call('SCARD', KEYS[2]) == 0 then
    redis.call('DEL', KEYS[2])
end
return 0
"""

VOICE_EVENTS_CHANNEL = "voice:events"
VOICE_ROOM_KEY = "voice:room:{room}"
VOICE_STREAMING_KEY = "voice:room:{room}:streaming"
_ROOM_PREFIX = "channel-"
_IDENTITY_PREFIX = "user-"

# Int values for screen-share sources (Protobuf enum — both video+audio tracks).
_SCREEN_SHARE_SOURCES = frozenset({int(TrackSource.SCREEN_SHARE), int(TrackSource.SCREEN_SHARE_AUDIO)})


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
    members_raw, streamers_raw = await pipe.execute()
    user_ids = sorted(m.decode() if isinstance(m, bytes) else m for m in members_raw)
    streaming_user_ids = sorted(m.decode() if isinstance(m, bytes) else m for m in streamers_raw)
    snapshot = VoiceStateSnapshot(
        channel_id=channel_id,
        user_ids=user_ids,
        streaming_user_ids=streaming_user_ids,
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
    # Atomic: remove from BOTH sets in one Lua round-trip.  Using two separate
    # eval calls would leave a window between them where a concurrent
    # _publish_state could read an inconsistent snapshot (streaming_user_ids
    # contains a user absent from user_ids).
    await redis.eval(_LUA_LEAVE, 2, key, sk, user_id)  # type: ignore[arg-type]


async def _apply_room_finished(redis: Redis, room_name: str) -> None:
    await redis.delete(room_key(room_name))
    await redis.delete(streaming_key(room_name))


async def _apply_screen_share_start(redis: Redis, room_name: str, user_id: str) -> None:
    settings = get_settings()
    sk = streaming_key(room_name)
    pipe = redis.pipeline(transaction=False)
    pipe.sadd(sk, user_id)
    # NX: same ghost-prevention logic as _apply_join.
    pipe.expire(sk, settings.voice_state_ttl_seconds, nx=True)
    await pipe.execute()


async def _apply_screen_share_stop(redis: Redis, room_name: str, user_id: str) -> None:
    sk = streaming_key(room_name)
    # Atomic: SREM + conditional DEL via Lua (same TOCTOU fix as _apply_leave).
    await redis.eval(_LUA_SREM_DEL_IF_EMPTY, 1, sk, user_id)  # type: ignore[arg-type]


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
        if not _is_screen_share(event.track):
            return
        user_id = user_id_from_identity(event.participant.identity)
        if user_id is None:
            return
        log.info("screen_share_event", kind=kind, user_id=user_id, room=room_name)
        if kind == "track_published":
            await _apply_screen_share_start(redis, room_name, user_id)
        else:
            await _apply_screen_share_stop(redis, room_name, user_id)
        await _publish_state(redis, room_name, channel_id)
        return
