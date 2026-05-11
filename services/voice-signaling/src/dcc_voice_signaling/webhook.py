"""LiveKit webhook receiver — keeps the voice-presence state in Redis.

LiveKit (running in a container) POSTs `participant_joined` / `participant_left`
/ `room_finished` events here. We verify the signature with the same API
key/secret pair the token endpoint uses, then maintain a per-channel Redis set
of user-ids and publish the full new state on the `voice:events` pub/sub
channel so chat-gateway can fan it out to WebSocket clients.

Key layout (shared with chat-gateway, which only reads):
  - ``voice:room:channel-<channel_id>`` → Redis SET of user-id strings
  - publish on ``voice:events`` → ``{"channel_id": "<id>", "user_ids": [...]}``

Room name / participant identity mapping mirrors ``routes.py``:
  - room   = ``channel-<channel_id>``           (``_room_for_channel``)
  - identity = ``user-<user_id>``               (``issue_token``)
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, Request, status
from livekit.api import TokenVerifier, WebhookReceiver
from redis.asyncio import Redis

from dcc_voice_signaling.config import get_settings

log = logging.getLogger(__name__)

router = APIRouter()

VOICE_EVENTS_CHANNEL = "voice:events"
VOICE_ROOM_KEY = "voice:room:{room}"
_ROOM_PREFIX = "channel-"
_IDENTITY_PREFIX = "user-"


def room_key(room_name: str) -> str:
    return VOICE_ROOM_KEY.format(room=room_name)


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


def _receiver() -> WebhookReceiver:
    settings = get_settings()
    return WebhookReceiver(
        TokenVerifier(settings.livekit_api_key, settings.livekit_api_secret)
    )


async def _publish_state(redis: Redis, room_name: str, channel_id: str) -> None:
    members = await redis.smembers(room_key(room_name))
    user_ids = sorted(m.decode() if isinstance(m, bytes) else m for m in members)
    await redis.publish(
        VOICE_EVENTS_CHANNEL,
        json.dumps(
            {"channel_id": channel_id, "user_ids": user_ids},
            separators=(",", ":"),
        ),
    )


async def _apply_join(redis: Redis, room_name: str, user_id: str) -> None:
    settings = get_settings()
    key = room_key(room_name)
    await redis.sadd(key, user_id)
    await redis.expire(key, settings.voice_state_ttl_seconds)


async def _apply_leave(redis: Redis, room_name: str, user_id: str) -> None:
    key = room_key(room_name)
    await redis.srem(key, user_id)
    if await redis.scard(key) == 0:
        await redis.delete(key)


async def _apply_room_finished(redis: Redis, room_name: str) -> None:
    await redis.delete(room_key(room_name))


@router.post("/webhook", status_code=status.HTTP_204_NO_CONTENT)
async def livekit_webhook(request: Request) -> None:
    auth_header = request.headers.get("authorization") or request.headers.get(
        "Authorization"
    )
    if not auth_header:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing signature")
    body = (await request.body()).decode("utf-8", errors="replace")
    try:
        event = _receiver().receive(body, auth_header)
    except Exception as exc:  # noqa: BLE001 — any verify error is a 401
        log.warning("rejected webhook: %s", exc)
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

    # Other events (track_published, etc.) don't change presence.
