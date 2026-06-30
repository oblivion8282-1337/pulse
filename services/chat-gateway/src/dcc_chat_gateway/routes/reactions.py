"""Add / remove emoji reactions on messages.

We don't validate the emoji string against any allow-list — the frontend's
picker is the only thing that selects them in practice, and storing
arbitrary short UTF-8 is fine. We do cap length (32 bytes via the column)
and reject anything that's empty after trim.

``GET /messages/{id}/reactions`` exposes the per-emoji user list so the
client can render "who reacted" popovers without bloating the regular
message payload (which stays aggregated). User display info (name,
avatar, color) is resolved client-side via ``GET /users?ids=...`` —
kept out of this endpoint to avoid duplicating the profile-cache logic.
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


@router.get("/messages/{message_id}/reactions")
async def list_message_reactions(
    message_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> list[dict]:
    """Per-emoji user-id list for a single message — backs the "who reacted"
    popover in the chat UI. The regular ``MessageOut.reactions`` field stays
    aggregated (``{emoji, count, me}``) so message-sync payloads don't blow
    up; this endpoint is the on-demand look-up the client fires when the
    user actually opens a pill.

    Returns ``[{emoji, user_ids: [str, ...]}, ...]`` ordered by emoji then
    reaction time (first-reactor first, matching Discord convention). User
    display info is resolved client-side via ``GET /users?ids=...`` —
    keeping the endpoint small and reusing the existing profile-cache
    path. Orphaned reactions (e.g. between user-purge and the FK cascade)
    are returned as raw IDs; the client tombstones unknowns via its
    user-cache, same as elsewhere.
    """
    await _load_for_reaction(session, message_id, current.id)
    rows = (
        await session.execute(
            select(MessageReaction.emoji, MessageReaction.user_id)
            .where(MessageReaction.message_id == message_id)
            .order_by(
                MessageReaction.emoji, MessageReaction.created_at, MessageReaction.user_id
            )
        )
    ).all()
    grouped: dict[str, list[str]] = {}
    for emoji, user_id in rows:
        grouped.setdefault(emoji, []).append(str(user_id))
    return [{"emoji": emoji, "user_ids": ids} for emoji, ids in grouped.items()]


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
