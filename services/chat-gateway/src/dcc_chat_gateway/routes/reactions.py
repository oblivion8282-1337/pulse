"""Add / remove emoji reactions on messages.

We don't validate the emoji string against any allow-list — the frontend's
picker is the only thing that selects them in practice, and storing
arbitrary short UTF-8 is fine. We do cap length (32 bytes via the column)
and reject anything that's empty after trim.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Message, MessageReaction
from dcc_chat_gateway.permissions import (
    Permissions,
    has_permission,
    resolve_permissions,
)
from dcc_chat_gateway.routes._deps import resolve_channel_or_raise
from dcc_chat_gateway.routes.messages import _broadcast
from dcc_chat_gateway.security import CurrentUser
from dcc_shared.events import ReactionAddEvent, ReactionData, ReactionRemoveEvent

log = logging.getLogger(__name__)

router = APIRouter()


def _normalize_emoji(raw: str) -> str:
    s = raw.strip()
    if not s or len(s.encode("utf-8")) > 32:
        raise HTTPException(400, detail="invalid emoji")
    return s


async def _load_for_reaction(
    session, message_id: int, current_user_id: int
) -> Message:
    msg = await session.get(Message, message_id)
    if msg is None or msg.deleted_at is not None:
        raise HTTPException(404, detail="message not found")
    # Polymorphic channel lookup — works for both guild Channel and
    # DirectMessageChannel rows. Raises the right 403/404 itself.
    await resolve_channel_or_raise(session, msg.channel_id, current_user_id)
    return msg


@router.put(
    "/messages/{message_id}/reactions/{emoji}/@me",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def add_reaction(
    message_id: int,
    emoji: str,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    emoji_n = _normalize_emoji(emoji)
    msg = await session.get(Message, message_id)
    if msg is None or msg.deleted_at is not None:
        raise HTTPException(404, detail="message not found")
    # Polymorphic channel lookup + access check (handles guild vs DM).
    kind, ch = await resolve_channel_or_raise(session, msg.channel_id, current.id)
    # ADD_REACTIONS gate (guild channels only — DMs have no overlay).
    if kind == "guild":
        perms = await resolve_permissions(
            session, current, ch.guild_id, channel_id=msg.channel_id
        )
        if not has_permission(perms, Permissions.ADD_REACTIONS):
            raise HTTPException(403, detail="missing permission: ADD_REACTIONS")
    row = MessageReaction(message_id=msg.id, user_id=current.id, emoji=emoji_n)
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        # Already reacted with this emoji — idempotent no-op, no broadcast.
        await session.rollback()
        return None

    await _broadcast(
        request,
        msg.channel_id,
        ReactionAddEvent(
            data=ReactionData(
                message_id=str(msg.id),
                channel_id=str(msg.channel_id),
                user_id=str(current.id),
                emoji=emoji_n,
            )
        ),
    )
    return None


@router.delete(
    "/messages/{message_id}/reactions/{emoji}/@me",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_reaction(
    message_id: int,
    emoji: str,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    emoji_n = _normalize_emoji(emoji)
    msg = await _load_for_reaction(session, message_id, current.id)
    row = (
        await session.execute(
            select(MessageReaction).where(
                MessageReaction.message_id == msg.id,
                MessageReaction.user_id == current.id,
                MessageReaction.emoji == emoji_n,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return None  # idempotent

    await session.delete(row)
    await session.commit()

    await _broadcast(
        request,
        msg.channel_id,
        ReactionRemoveEvent(
            data=ReactionData(
                message_id=str(msg.id),
                channel_id=str(msg.channel_id),
                user_id=str(current.id),
                emoji=emoji_n,
            )
        ),
    )
    return None
