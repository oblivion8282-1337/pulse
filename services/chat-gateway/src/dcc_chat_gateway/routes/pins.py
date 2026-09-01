"""Pinned Messages pro Kanal (Discord-Parität, minimal).

``pinned_at``-Spalte an ``messages`` (siehe models.messages) — keine eigene
Tabelle. Guild-Kanäle verlangen ``MANAGE_MESSAGES`` wie beim Löschen fremder
Nachrichten; DMs dürfen beide Teilnehmer pinnen (Zugriff regelt bereits
``resolve_channel_or_raise``). Limit 50 Pins pro Kanal, serverseitig
erzwungen.

Das Limit zählt per ``COUNT`` beim Pin — zwei gleichzeitige Pins können es
theoretisch um eins überschreiten; bei einer weichen kosmetischen Grenze
kein Sperrenaufwand.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.message_helpers import (
    broadcast as _broadcast,
    reactions_for as _reactions_for,
    serialize_message,
)
from dcc_chat_gateway.mentions import mentions_for
from dcc_chat_gateway.routes.attachments import serialize_attachments
from dcc_chat_gateway.models import Message
from dcc_chat_gateway.permissions import (
    Permissions,
    has_permission,
    resolve_permissions,
)
from dcc_chat_gateway.routes._deps import resolve_channel_or_raise
from dcc_chat_gateway.security import CurrentUser
from dcc_shared.events import PinUpdateData, PinUpdateEvent

log = logging.getLogger(__name__)

router = APIRouter()

# Discord allows 50 pins per channel; we mirror that as a soft server cap.
PIN_LIMIT = 50


async def _load_message(session, message_id: int, current_user_id: int):
    """Nachricht + aufgelöster Kanal — wie ``_load_for_reaction``. Nicht
    angepinnte/gelöschte Nachrichten 404en, damit der Pin-Endpunkt nicht als
    Existenz-Oracle für fremde Kanäle dient."""
    msg = await session.get(Message, message_id)
    if msg is None or msg.deleted_at is not None:
        raise HTTPException(404, detail="message not found")
    kind, ch = await resolve_channel_or_raise(session, msg.channel_id, current_user_id)
    return msg, kind, ch


async def _require_manage_messages(session, current: CurrentUser, kind: str, ch) -> None:
    """MOD-Gate: pinnen ist Moderation (Discord: MANAGE_MESSAGES). Nur für
    Guild-Kanäle — DM-Teilnehmer dürfen in ihrem eigenen Gespräch pinnen."""
    if kind != "guild":
        return
    perms = await resolve_permissions(session, current, ch.guild_id, channel_id=ch.id)
    if not has_permission(perms, Permissions.MANAGE_MESSAGES):
        raise HTTPException(403, detail="missing permission: MANAGE_MESSAGES")


@router.get("/channels/{channel_id}/pins")
async def list_pins(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
) -> list[dict]:
    """Pin-Liste des Kanals, ältester Pin zuerst. Gleiche Lese-Gates wie
    ``list_messages`` (READ_HISTORY bzw. DM-Mitgliedschaft)."""
    kind, ch = await resolve_channel_or_raise(session, channel_id, current.id)
    if kind == "guild":
        perms = await resolve_permissions(session, current, ch.guild_id, channel_id=channel_id)
        if not has_permission(perms, Permissions.READ_HISTORY):
            raise HTTPException(403, detail="missing permission: READ_HISTORY")
    rows = list(
        (
            await session.execute(
                select(Message)
                .where(
                    Message.channel_id == channel_id,
                    Message.deleted_at.is_(None),
                    Message.pinned_at.is_not(None),
                )
                .order_by(Message.pinned_at)
                .limit(PIN_LIMIT)
            )
        ).scalars()
    )
    if not rows:
        return []
    msg_ids = [m.id for m in rows]
    reactions = await _reactions_for(session, msg_ids, current.id)
    attachments = await serialize_attachments(session, msg_ids)
    mentions_map = await mentions_for(session, msg_ids)
    return [
        serialize_message(
            m,
            reactions.get(m.id, []),
            attachments=attachments.get(m.id, []),
            mentions=mentions_map.get(m.id, []),
        )
        for m in rows
    ]


@router.put("/messages/{message_id}/pin", status_code=status.HTTP_204_NO_CONTENT)
async def pin_message(
    message_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    msg, kind, ch = await _load_message(session, message_id, current.id)
    await _require_manage_messages(session, current, kind, ch)
    if msg.pinned_at is not None:
        return None  # idempotent
    count = (
        await session.execute(
            select(func.count())
            .select_from(Message)
            .where(
                Message.channel_id == msg.channel_id,
                Message.deleted_at.is_(None),
                Message.pinned_at.is_not(None),
            )
        )
    ).scalar_one()
    if count >= PIN_LIMIT:
        raise HTTPException(400, detail="pin_limit_reached")
    msg.pinned_at = datetime.now(UTC)
    await session.commit()
    await _broadcast(
        request,
        msg.channel_id,
        PinUpdateEvent(
            data=PinUpdateData(
                message_id=str(msg.id), channel_id=str(msg.channel_id), pinned=True
            )
        ),
    )
    return None


@router.delete("/messages/{message_id}/pin", status_code=status.HTTP_204_NO_CONTENT)
async def unpin_message(
    message_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    msg, kind, ch = await _load_message(session, message_id, current.id)
    await _require_manage_messages(session, current, kind, ch)
    if msg.pinned_at is None:
        return None  # idempotent
    msg.pinned_at = None
    await session.commit()
    await _broadcast(
        request,
        msg.channel_id,
        PinUpdateEvent(
            data=PinUpdateData(
                message_id=str(msg.id), channel_id=str(msg.channel_id), pinned=False
            )
        ),
    )
    return None
