"""Gate-free moderation DM: deliver a one-way admin→user notice without the
friend-gate.

Used by moderation flows to reach a user who isn't a friend:
  * ban/kick notice from the community admin who acted;
  * complaint outcome from the platform operator (super-admin).

Mirrors the DM-send path in ``routes/ws_op_send.py`` (Message insert +
``last_message_id`` bump + channel publish + ``dm_bump``) but SKIPS the
friendship/block gate — the message is admin-initiated, one-way, and tied to a
real moderation action. The recipient's *reply* stays friend-gated (their DM
list shows the thread as locked), so this can't become a harassment channel.
"""

from __future__ import annotations

import logging
from typing import Any

from dcc_shared.events import DmBumpEvent
from sqlalchemy import update

from dcc_chat_gateway.message_helpers import serialize_message
from dcc_chat_gateway.models import DirectMessageChannel, Message
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)


async def send_moderation_dm(
    session,
    manager: Any,
    *,
    from_user_id: int,
    to_user_id: int,
    content: str,
) -> None:
    """Persist + deliver a one-way admin→user DM, bypassing the friend-gate.

    The message is committed before the best-effort WS fan-out, so a Redis
    hiccup can't lose it. No-op-safe when ``manager`` is None (dev / no-WS).
    """
    # Local import avoids any load-order coupling with the dms route module.
    from dcc_chat_gateway.routes.dms import ensure_dm_channel

    dm = await ensure_dm_channel(session, from_user_id, to_user_id)
    msg = Message(
        id=next_id(),
        channel_id=dm.id,
        author_id=from_user_id,
        content=content,
    )
    session.add(msg)
    await session.execute(
        update(DirectMessageChannel)
        .where(DirectMessageChannel.id == dm.id)
        .values(last_message_id=msg.id)
    )
    await session.commit()
    await session.refresh(msg)

    if manager is None:
        return
    cid = str(dm.id)
    try:
        await manager.publish(cid, serialize_message(msg, mentions=[]))
    except Exception:  # noqa: BLE001 — best-effort; message already persisted
        log.exception("moderation DM publish failed for channel %s", cid)
    try:
        await manager.publish_guild_event(
            DmBumpEvent(
                channel_id=cid,
                user_a_id=str(dm.user_a_id),
                user_b_id=str(dm.user_b_id),
                message_id=str(msg.id),
                author_id=str(from_user_id),
            )
        )
    except Exception:  # noqa: BLE001 — best-effort dm_bump
        log.exception("moderation DM dm_bump failed for channel %s", cid)
