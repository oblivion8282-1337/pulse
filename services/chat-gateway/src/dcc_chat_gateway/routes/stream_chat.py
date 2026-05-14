"""Per-streamer ephemeral live-chat (Twitch-style).

Each live stream (channel × user) has its own short-lived chat — separate from
the channel's regular text chat so viewers can react without bothering members
who aren't watching. "Live" covers both transports:

  * HQ GSR/RTMPS pipeline → ``stream:active:channel-<cid>-<uid>`` (written by
    ``mediamtx-auth-hook`` on publish).
  * Browser screen-share via LiveKit → ``voice:room:channel-<cid>:streaming``
    SET membership (written by ``voice-signaling``'s LiveKit-webhook handler
    on ``track_published`` with a SCREEN_SHARE source).

Either source unlocks the POST gate. Both keys self-heal via TTL so we don't
have to micromanage end-of-stream cleanup.

Storage / fan-out (independent of the source):
  * Redis List ``stream:chat:channel-<cid>-<uid>``, capped at ``MAX_HISTORY``
    entries via ``LTRIM``, ``EXPIRE 6h`` to match the rest of the
    ``stream:*`` keyspace. **No DEL on stream-end** — the MediaMTX poll-list
    lags 1–3s and short publisher drops would otherwise nuke the chat
    mid-stream; let TTL do the cleanup.
  * Pub/sub reuses ``chat:channel:<cid>`` with an
    ``op: "stream_chat_message"`` envelope — gets per-channel filtering via
    ``_subs`` for free (chat is high-frequency, a global fan-out across
    ``_connections`` like ``stream_state`` would be too expensive).

Routes:
  * ``POST /channels/{cid}/streams/{uid}/chat`` — append. Member of the
    channel's guild + channel must be voice + at least one of the two live
    keys above must signal "streamer is live" (else 410 Gone). Shared
    rate-limit bucket with channel-chat (``message``).
  * ``GET /channels/{cid}/streams/{uid}/chat?limit=100`` — backfill on
    player/panel mount. Returns chronological order (oldest first).
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter()

# Mirror of media-svc's ACTIVE_KEY + voice-signaling's VOICE_STREAMING_KEY.
# Duplicated rather than imported because the services share no code on purpose
# (see CLAUDE.md / streamkeys.py note) — keep in sync if either key renames.
_ACTIVE_KEY = "stream:active:channel-{channel_id}-{user_id}"
_VOICE_STREAMING_KEY = "voice:room:channel-{channel_id}:streaming"
_CHAT_KEY = "stream:chat:channel-{channel_id}-{user_id}"

MAX_HISTORY = 200
CHAT_TTL_S = 6 * 3600
MAX_CONTENT_LEN = 4000
DEFAULT_LIMIT = 100
MAX_LIMIT = 200


class StreamChatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: Annotated[str, Field(min_length=1, max_length=MAX_CONTENT_LEN)]


class StreamChatMessage(BaseModel):
    id: str
    author_id: str
    content: str
    created_at: str


class StreamChatPostOut(BaseModel):
    id: str
    created_at: str


async def _require_voice_channel_member(
    session: SessionDep, channel_id: int, user_id: int
) -> Channel:
    channel = await channel_membership(session, channel_id, user_id)
    if channel is None:
        if await session.get(Channel, channel_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not a member of this channel")
    if channel.type != CHANNEL_TYPE_VOICE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="stream chat is only available in voice channels",
        )
    return channel


@router.post(
    "/channels/{channel_id}/streams/{streamer_id}/chat",
    response_model=StreamChatPostOut,
    status_code=201,
)
async def post_stream_chat(
    channel_id: int,
    streamer_id: int,
    payload: StreamChatIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> StreamChatPostOut:
    await _require_voice_channel_member(session, channel_id, current.id)

    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        # No Redis means no fan-out + no auth-hook either → effectively no live
        # stream. Treat as 503 so the client retries instead of giving up.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="storage unavailable")

    # Streamer is "live" if either transport reports them. Pipeline so both
    # round-trips share one RTT (chat is hot-path).
    active_key = _ACTIVE_KEY.format(channel_id=channel_id, user_id=streamer_id)
    voice_streaming_key = _VOICE_STREAMING_KEY.format(channel_id=channel_id)
    pipe = redis.pipeline(transaction=False)
    pipe.exists(active_key)
    pipe.sismember(voice_streaming_key, str(streamer_id))
    hq_live, ss_live = await pipe.execute()
    if not (hq_live or ss_live):
        raise HTTPException(status.HTTP_410_GONE, detail="streamer is not live")

    if not ratelimit.check("message", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )

    msg_id = str(next_id())
    created_at = datetime.now(UTC).isoformat()
    entry = {
        "id": msg_id,
        "author_id": str(current.id),
        "content": payload.content,
        "created_at": created_at,
    }
    chat_key = _CHAT_KEY.format(channel_id=channel_id, user_id=streamer_id)
    pipe = redis.pipeline()
    pipe.lpush(chat_key, json.dumps(entry, separators=(",", ":")))
    pipe.ltrim(chat_key, 0, MAX_HISTORY - 1)
    pipe.expire(chat_key, CHAT_TTL_S)
    await pipe.execute()

    # Fan out via the existing per-channel chat pubsub — `_subs[channel_id]`
    # gives us free per-channel filtering. The listener forwards op-carrying
    # payloads verbatim, so this envelope is what every connected client sees.
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        try:
            await mgr.publish(
                str(channel_id),
                {
                    "op": "stream_chat_message",
                    "channel_id": str(channel_id),
                    "streamer_id": str(streamer_id),
                    "message": entry,
                },
            )
        except Exception:
            log.exception("stream_chat publish failed for channel %s", channel_id)

    return StreamChatPostOut(id=msg_id, created_at=created_at)


@router.get(
    "/channels/{channel_id}/streams/{streamer_id}/chat",
    response_model=list[StreamChatMessage],
)
async def get_stream_chat(
    channel_id: int,
    streamer_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
    limit: int = DEFAULT_LIMIT,
) -> list[StreamChatMessage]:
    await _require_voice_channel_member(session, channel_id, current.id)
    if limit < 1:
        limit = 1
    elif limit > MAX_LIMIT:
        limit = MAX_LIMIT

    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return []

    chat_key = _CHAT_KEY.format(channel_id=channel_id, user_id=streamer_id)
    # LPUSH gives newest-first; client wants oldest-first (chronological).
    raws = await redis.lrange(chat_key, 0, limit - 1)
    out: list[StreamChatMessage] = []
    for raw in reversed(raws):
        try:
            data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        try:
            out.append(
                StreamChatMessage(
                    id=str(data["id"]),
                    author_id=str(data["author_id"]),
                    content=str(data["content"]),
                    created_at=str(data["created_at"]),
                )
            )
        except (KeyError, TypeError):
            continue
    return out


__all__ = ["router"]
