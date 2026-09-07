"""Ephemeral stream reactions — quick emojis fired at a live stream.

Front half of "Stream-Reactions" (IDEAS.md §4): viewers fire a quick emoji
at the stream tile and every client of the channel sees it as a floating
burst over the video (Twitch-style). Nothing is stored — the event exists
only to trigger the overlay, so there is no history, no counts and no DB
row. Fan-out reuses the per-channel pubsub, and the permission bar is the
watch-chat bar (voice-channel member + VIEW_CHANNEL): Zuschauer ohne
Chat-Senderecht duerfen reagieren.

Route:
  * ``PUT /channels/{cid}/stream/reactions/{emoji}/@me`` — member + shared
    ``message`` rate limit; broadcasts ``stream_reaction`` to the channel.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request, status

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.routes._deps import channel_membership
from dcc_chat_gateway.routes.watch_chat import _normalize_emoji, _require_voice_channel_member
from dcc_chat_gateway.security import CurrentUser
from dcc_shared.events import StreamReactionData, StreamReactionEvent

log = logging.getLogger(__name__)

router = APIRouter()


@router.put(
    "/channels/{channel_id}/stream/reactions/{emoji}/@me",
    response_model=StreamReactionData,
)
async def fire_stream_reaction(
    channel_id: int,
    emoji: str,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> StreamReactionData:
    """Fire a quick emoji at the live stream.

    Fire-and-forget: broadcast only, no storage — es gibt daher auch keine
    Idempotenz wie bei den Watch-Party-Reaktionen; jeder Aufruf ist genau
    ein Burst."""
    await _require_voice_channel_member(session, channel_id, current)
    emoji_n = _normalize_emoji(emoji)

    if not ratelimit.check("message", current.id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded")

    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        try:
            await mgr.publish(
                str(channel_id),
                StreamReactionEvent(
                    data=StreamReactionData(
                        channel_id=str(channel_id),
                        user_id=str(current.id),
                        emoji=emoji_n,
                    )
                ),
            )
        except Exception:
            log.exception("stream_reaction publish failed for channel %s", channel_id)

    return StreamReactionData(channel_id=str(channel_id), user_id=str(current.id), emoji=emoji_n)


__all__ = ["router"]
