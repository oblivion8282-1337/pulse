"""Ephemeral live-chat for an active Watch Party (one chat per party).

Storage / fan-out mirrors stream_chat.py:
  * Redis List ``watch:chat:channel-<cid>-<pid>``, capped at WATCH_CHAT_MAX
    entries via LTRIM, EXPIRE 6h. No DEL on party-end — let TTL clean up.
  * Fan-out reuses ``chat:channel:<cid>`` pub/sub with op ``watch_chat_message``
    (the ``party_id`` field routes it to the right party's chat client-side).

Routes (a channel can host several concurrent parties, so the chat is scoped
to the party, not the channel):
  * ``POST /channels/{cid}/watch-party/{pid}/chat`` — member + active party
    required. Rate-limited in the shared ``message`` bucket.
  * ``GET  /channels/{cid}/watch-party/{pid}/chat?limit=100`` — member required,
    chronological order (oldest first).
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from dcc_chat_gateway import ratelimit, watchkeys
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id
from dcc_shared.events import (
    StreamChatMessagePayload,
    WatchChatMessageEvent,
    WatchChatReactionData,
    WatchChatReactionEvent,
)

log = logging.getLogger(__name__)

router = APIRouter()

MAX_CONTENT_LEN = 4000
DEFAULT_LIMIT = 100
MAX_LIMIT = 200


class WatchChatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: Annotated[str, Field(min_length=1, max_length=MAX_CONTENT_LEN)]


class WatchChatReaction(BaseModel):
    emoji: str
    count: int
    me: bool


class WatchChatMessage(BaseModel):
    id: str
    author_id: str
    content: str
    created_at: str
    reactions: list[WatchChatReaction] = []


class WatchChatPostOut(BaseModel):
    id: str
    created_at: str


class WatchChatReactionOut(BaseModel):
    emoji: str
    count: int
    me: bool


def _normalize_emoji(raw: str) -> str:
    s = raw.strip()
    if not s or len(s.encode("utf-8")) > 32:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="invalid emoji")
    return s


async def _require_voice_channel_member(
    session: SessionDep, channel_id: int, user_id: int
) -> Channel:
    channel = await channel_membership(session, channel_id, user_id)
    if channel is None:
        if await session.get(Channel, channel_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="channel not found")
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not a member")
    if channel.type != CHANNEL_TYPE_VOICE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="watch chat is only available in voice channels",
        )
    return channel


@router.post(
    "/channels/{channel_id}/watch-party/{party_id}/chat",
    response_model=WatchChatPostOut,
    status_code=201,
)
async def post_watch_chat(
    channel_id: int,
    party_id: str,
    payload: WatchChatIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> WatchChatPostOut:
    await _require_voice_channel_member(session, channel_id, current.id)

    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="storage unavailable")

    state = await watchkeys.read_party(redis, str(channel_id), party_id)
    if state is None:
        raise HTTPException(status.HTTP_410_GONE, detail="no active watch party")

    if not ratelimit.check("message", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded")

    msg_id = str(next_id())
    created_at = datetime.now(UTC).isoformat()
    entry = {
        "id": msg_id,
        "author_id": str(current.id),
        "content": payload.content,
        "created_at": created_at,
    }
    chat_key = watchkeys.WATCH_CHAT_KEY.format(channel_id=channel_id, party_id=party_id)
    pipe = redis.pipeline()
    pipe.lpush(chat_key, json.dumps(entry, separators=(",", ":")))
    pipe.ltrim(chat_key, 0, watchkeys.WATCH_CHAT_MAX - 1)
    pipe.expire(chat_key, watchkeys.WATCH_CHAT_TTL_S)
    await pipe.execute()

    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        try:
            await mgr.publish(
                str(channel_id),
                WatchChatMessageEvent(
                    channel_id=str(channel_id),
                    party_id=party_id,
                    message=StreamChatMessagePayload(**entry),
                ),
            )
        except Exception:
            log.exception("watch_chat publish failed for channel %s", channel_id)

    return WatchChatPostOut(id=msg_id, created_at=created_at)


@router.get(
    "/channels/{channel_id}/watch-party/{party_id}/chat",
    response_model=list[WatchChatMessage],
)
async def get_watch_chat(
    channel_id: int,
    party_id: str,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> list[WatchChatMessage]:
    await _require_voice_channel_member(session, channel_id, current.id)

    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return []

    chat_key = watchkeys.WATCH_CHAT_KEY.format(channel_id=channel_id, party_id=party_id)
    raws = await redis.lrange(chat_key, 0, limit - 1)
    # Reaktionen einmal laden und pro Nachricht zum Aggregat falten.
    reactions_by_msg = await watchkeys.read_chat_reactions(redis, str(channel_id), party_id)
    me = str(current.id)
    out: list[WatchChatMessage] = []
    for raw in reversed(raws):
        try:
            data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        try:
            msg_id = str(data["id"])
            out.append(
                WatchChatMessage(
                    id=msg_id,
                    author_id=str(data["author_id"]),
                    content=str(data["content"]),
                    created_at=str(data["created_at"]),
                    reactions=_aggregate_reactions(reactions_by_msg.get(msg_id, {}), me),
                )
            )
        except (KeyError, TypeError):
            continue
    return out


def _aggregate_reactions(
    by_emoji: dict[str, list[str]], me: str
) -> list[WatchChatReaction]:
    """``{emoji: [uid, ...]}`` → sorted aggregate list with ``me`` flag."""
    return [
        WatchChatReaction(emoji=emoji, count=len(uids), me=me in uids)
        for emoji, uids in sorted(by_emoji.items())
        if uids
    ]


@router.put(
    "/channels/{channel_id}/watch-party/{party_id}/chat/{message_id}/reactions/{emoji}/@me",
    response_model=WatchChatReactionOut,
)
async def toggle_watch_chat_reaction(
    channel_id: int,
    party_id: str,
    message_id: str,
    emoji: str,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> WatchChatReactionOut:
    """Toggle the caller's emoji reaction on a watch-party chat message.

    Ephemeral — stored in Redis (6h TTL), no DB. Idempotent per call: a
    second PUT with the same emoji removes the reaction again."""
    await _require_voice_channel_member(session, channel_id, current.id)
    emoji_n = _normalize_emoji(emoji)

    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="storage unavailable")

    state = await watchkeys.read_party(redis, str(channel_id), party_id)
    if state is None:
        raise HTTPException(status.HTTP_410_GONE, detail="no active watch party")

    if not ratelimit.check("message", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded")

    added, count = await watchkeys.toggle_chat_reaction(
        redis, str(channel_id), party_id, message_id, emoji_n, str(current.id)
    )

    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        try:
            await mgr.publish(
                str(channel_id),
                WatchChatReactionEvent(
                    data=WatchChatReactionData(
                        message_id=message_id,
                        channel_id=str(channel_id),
                        party_id=party_id,
                        user_id=str(current.id),
                        emoji=emoji_n,
                        added=added,
                    )
                ),
            )
        except Exception:
            log.exception("watch_chat_reaction publish failed for channel %s", channel_id)

    return WatchChatReactionOut(emoji=emoji_n, count=count, me=added)


__all__ = ["router"]
