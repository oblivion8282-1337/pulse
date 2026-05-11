"""Message history + posting endpoints."""

from __future__ import annotations

from typing import Annotated

import logging

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

log = logging.getLogger(__name__)

from dcc_chat_gateway import ratelimit
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CHANNEL_TYPE_TEXT, Channel, Message
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.schemas import MessageIn, MessageOut
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter()


def serialize_message(msg: Message) -> dict:
    return {
        "id": str(msg.id),
        "channel_id": str(msg.channel_id),
        "author_id": str(msg.author_id),
        "content": msg.content,
        "nonce": msg.nonce,
        "created_at": msg.created_at.isoformat(),
    }


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
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    await require_member(session, channel.guild_id, current.id)

    stmt = select(Message).where(
        Message.channel_id == channel_id,
        Message.deleted_at.is_(None),
    )
    if before is not None:
        stmt = stmt.where(Message.id < before)
    stmt = stmt.order_by(Message.id.desc()).limit(limit)
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


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
    channel = await session.get(Channel, channel_id)
    if channel is None or channel.type != CHANNEL_TYPE_TEXT:
        raise HTTPException(404, detail="text channel not found")
    await require_member(session, channel.guild_id, current.id)
    if not ratelimit.check("message", current.id):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail="rate limit exceeded"
        )
    msg = Message(
        id=next_id(),
        channel_id=channel_id,
        author_id=current.id,
        content=payload.content,
        nonce=payload.nonce,
    )
    session.add(msg)
    await session.commit()
    await session.refresh(msg)
    # Fan out via the connection manager (if present in app state).
    # Publish is best-effort: the message is already committed, so a Redis
    # failure here must not turn a 201 into a 500.
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        try:
            await mgr.publish(str(channel_id), serialize_message(msg))
        except Exception:
            log.exception("publish failed for channel %s (message persisted)", channel_id)
    return msg
