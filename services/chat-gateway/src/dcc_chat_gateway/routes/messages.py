"""Message history + send/edit/delete endpoints.

Reactions live in routes/reactions.py — both modules share the
`serialize_message` helper here, including the reaction aggregation
that's needed for `reply` quote previews and the initial list payload.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

import logging

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_TEXT,
    Channel,
    DirectMessageChannel,
    Message,
    MessageReaction,
)
from dcc_chat_gateway.routes._deps import resolve_channel_or_raise
from dcc_chat_gateway.schemas import MessageEditIn, MessageIn, MessageOut
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)

router = APIRouter()


async def _reactions_for(
    session: AsyncSession, message_ids: list[int], current_user_id: int
) -> dict[int, list[dict]]:
    """Return `{message_id: [{emoji, count, me}, ...]}` for the given ids.

    One round-trip; we fold the rows by (message_id, emoji) in Python so we
    can compute `me` without a second query."""
    if not message_ids:
        return {}
    rows = (
        await session.execute(
            select(MessageReaction.message_id, MessageReaction.emoji, MessageReaction.user_id)
            .where(MessageReaction.message_id.in_(message_ids))
            .order_by(MessageReaction.message_id, MessageReaction.emoji, MessageReaction.created_at)
        )
    ).all()
    out: dict[int, dict[str, dict]] = {}
    for mid, emoji, uid in rows:
        per_msg = out.setdefault(mid, {})
        agg = per_msg.setdefault(emoji, {"emoji": emoji, "count": 0, "me": False})
        agg["count"] += 1
        if uid == current_user_id:
            agg["me"] = True
    return {mid: list(emojis.values()) for mid, emojis in out.items()}


def serialize_message(msg: Message, reactions: list[dict] | None = None) -> dict:
    return {
        "id": str(msg.id),
        "channel_id": str(msg.channel_id),
        "author_id": str(msg.author_id),
        "content": msg.content,
        "nonce": msg.nonce,
        "reply_to_id": str(msg.reply_to_id) if msg.reply_to_id is not None else None,
        "created_at": msg.created_at.isoformat(),
        "edited_at": msg.edited_at.isoformat() if msg.edited_at else None,
        "deleted_at": msg.deleted_at.isoformat() if msg.deleted_at else None,
        "reactions": reactions or [],
    }


async def _broadcast(request: Request, channel_id: int, payload: dict) -> None:
    """Best-effort publish to the channel's WS subscribers — never raises."""
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return
    try:
        await mgr.publish(str(channel_id), payload)
    except Exception:
        log.exception("publish failed for channel %s", channel_id)


@router.get(
    "/channels/{channel_id}/messages",
    response_model=list[MessageOut],
)
async def list_messages(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    before: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    # Resolve the channel as guild-or-DM and enforce access in one go.
    # The Message query below is identical regardless of channel kind.
    await resolve_channel_or_raise(session, channel_id, current.id)

    stmt = select(Message).where(
        Message.channel_id == channel_id,
        Message.deleted_at.is_(None),
    )
    if before is not None:
        stmt = stmt.where(Message.id < before)
    stmt = stmt.order_by(Message.id.desc()).limit(limit)
    rows = list((await session.execute(stmt)).scalars().all())
    reactions = await _reactions_for(session, [m.id for m in rows], current.id)
    # MessageOut reads `from_attributes`; we attach reactions onto the ORM
    # instance attribute so Pydantic picks it up alongside the columns.
    for m in rows:
        m.reactions = reactions.get(m.id, [])  # type: ignore[attr-defined]
    return rows


@router.post(
    "/channels/{channel_id}/messages",
    response_model=MessageOut,
    status_code=201,
)
async def post_message(
    channel_id: int,
    payload: MessageIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    kind, ch = await resolve_channel_or_raise(session, channel_id, current.id)
    if kind == "guild" and ch.type != CHANNEL_TYPE_TEXT:
        # Voice channels reject text posts. DM channels are always text-only.
        raise HTTPException(404, detail="text channel not found")
    if not ratelimit.check("message", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )

    if payload.reply_to_id is not None:
        parent = await session.get(Message, payload.reply_to_id)
        if parent is None or parent.channel_id != channel_id or parent.deleted_at is not None:
            raise HTTPException(400, detail="reply target not found in this channel")

    msg = Message(
        id=next_id(),
        channel_id=channel_id,
        author_id=current.id,
        content=payload.content,
        nonce=payload.nonce,
        reply_to_id=payload.reply_to_id,
    )
    session.add(msg)
    if kind == "dm":
        # Bump last_message_id so the DM list can sort by recency.
        ch.last_message_id = msg.id
        session.add(ch)
    await session.commit()
    await session.refresh(msg)

    # Bare payload — the pubsub listener auto-wraps as {"op": "message", "data": ...}.
    await _broadcast(request, channel_id, serialize_message(msg))
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        if kind == "guild":
            # Global "channel had activity" envelope on guild:events so
            # clients NOT subscribed to this channel (i.e. everyone except
            # whoever is currently viewing it) can flag the channel as
            # unread in the sidebar. Payload is intentionally minimal —
            # no content.
            await mgr.publish_guild_event(
                {
                    "op": "channel_bump",
                    "guild_id": str(ch.guild_id),
                    "channel_id": str(channel_id),
                    "message_id": str(msg.id),
                    "author_id": str(current.id),
                }
            )
        else:
            # DM equivalent. ``user_a_id``/``user_b_id`` are carried in the
            # envelope so each receiving client can decide locally whether
            # it's a member (no server-side per-user routing in Phase 1 —
            # this fans to every connected socket). MVP-acceptable for
            # low user counts; tighten later if it matters.
            await mgr.publish_guild_event(
                {
                    "op": "dm_bump",
                    "channel_id": str(channel_id),
                    "user_a_id": str(ch.user_a_id),
                    "user_b_id": str(ch.user_b_id),
                    "message_id": str(msg.id),
                    "author_id": str(current.id),
                }
            )
    msg.reactions = []  # type: ignore[attr-defined]
    return msg


@router.patch(
    "/messages/{message_id}",
    response_model=MessageOut,
)
async def edit_message(
    message_id: int,
    payload: MessageEditIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    msg = await session.get(Message, message_id)
    if msg is None or msg.deleted_at is not None:
        raise HTTPException(404, detail="message not found")
    if msg.author_id != current.id:
        raise HTTPException(403, detail="only the author can edit")
    # Caller must still have access to the channel (guild kick → can't edit
    # old messages; DM author trivially passes since DM membership is fixed).
    await resolve_channel_or_raise(session, msg.channel_id, current.id)

    msg.content = payload.content
    msg.edited_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(msg)

    reactions = (await _reactions_for(session, [msg.id], current.id)).get(msg.id, [])
    payload_out = serialize_message(msg, reactions)
    await _broadcast(request, msg.channel_id, {"op": "message_update", "data": payload_out})
    msg.reactions = reactions  # type: ignore[attr-defined]
    return msg


@router.delete(
    "/messages/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_message(
    message_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    msg = await session.get(Message, message_id)
    if msg is None or msg.deleted_at is not None:
        raise HTTPException(404, detail="message not found")
    # Resolve channel: also enforces caller still has access (a kicked
    # author can't keep deleting their old messages in a guild).
    kind, ch = await resolve_channel_or_raise(session, msg.channel_id, current.id)
    # Author may delete their own. In a guild, the guild owner may also
    # delete anything. DM channels have no owner-override.
    if msg.author_id != current.id:
        if kind == "dm":
            raise HTTPException(403, detail="not allowed to delete this message")
        from dcc_chat_gateway.models import Guild  # local to avoid top-level cycle
        guild = await session.get(Guild, ch.guild_id)
        if guild is None or guild.owner_id != current.id:
            raise HTTPException(403, detail="not allowed to delete this message")

    msg.deleted_at = datetime.now(timezone.utc)
    # Reactions are no longer meaningful once the message is gone.
    await session.execute(
        delete(MessageReaction).where(MessageReaction.message_id == msg.id)
    )
    await session.commit()

    await _broadcast(
        request,
        msg.channel_id,
        {"op": "message_delete", "data": {"id": str(msg.id), "channel_id": str(msg.channel_id)}},
    )
    return None


__all__ = ["router", "serialize_message", "_reactions_for", "_broadcast"]
