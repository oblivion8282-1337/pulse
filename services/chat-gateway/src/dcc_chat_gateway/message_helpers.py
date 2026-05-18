"""Shared helpers for the message routes + the WS fast-path.

Pulled out of ``routes/messages.py`` to keep that file inside the
350-line soft cap from PLAN.md §12.1 once mention-handling landed.

Three exports here:

* ``serialize_message`` — wire shape for ``MessageOut`` consumers
  (REST broadcasts + WS publishes). The serializer is intentionally
  synchronous: callers pre-load reactions / attachments / mentions
  (relationship lazy-loads would raise ``MissingGreenlet`` from the
  async session).
* ``reactions_for`` — one round-trip batched reaction aggregation,
  folding rows by (message_id, emoji) and computing the ``me`` flag
  for the caller.
* ``broadcast`` — best-effort publish to the channel's WS subscribers
  via the ``ConnectionManager`` from ``request.app.state``. Never raises
  (a Redis hiccup must not turn a successful message persist into a 500).
"""

from __future__ import annotations

import logging

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_chat_gateway.models import Message, MessageReaction

log = logging.getLogger(__name__)


async def reactions_for(
    session: AsyncSession, message_ids: list[int], current_user_id: int
) -> dict[int, list[dict]]:
    """Return ``{message_id: [{emoji, count, me}, ...]}`` for ``message_ids``.

    One round-trip; we fold the rows by (message_id, emoji) in Python so we
    can compute ``me`` without a second query.
    """
    if not message_ids:
        return {}
    rows = (
        await session.execute(
            select(
                MessageReaction.message_id,
                MessageReaction.emoji,
                MessageReaction.user_id,
            )
            .where(MessageReaction.message_id.in_(message_ids))
            .order_by(
                MessageReaction.message_id,
                MessageReaction.emoji,
                MessageReaction.created_at,
            )
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


def serialize_message(
    msg: Message,
    reactions: list[dict] | None = None,
    attachments: list[dict] | None = None,
    mentions: list[dict] | None = None,
) -> dict:
    """Wire shape for ``MessageOut``. Callers pass pre-loaded lists.

    Lazy-load is intentionally not attempted from here — async-SQLAlchemy
    raises ``MissingGreenlet`` on sync access of an unloaded relationship,
    and the WS fast-path uses this helper from outside the session lifetime
    of the row.
    """
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
        "attachments": attachments or [],
        "mentions": mentions or [],
    }


async def broadcast(request: Request, channel_id: int, payload: dict) -> None:
    """Best-effort publish to the channel's WS subscribers — never raises."""
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return
    try:
        await mgr.publish(str(channel_id), payload)
    except Exception:
        log.exception("publish failed for channel %s", channel_id)


__all__ = ["broadcast", "reactions_for", "serialize_message"]
