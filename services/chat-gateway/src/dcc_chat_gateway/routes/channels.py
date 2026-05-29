"""Channel CRUD endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import delete, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel, Guild, Message, MessageAttachment
from dcc_chat_gateway.permissions import Permissions, check_permission, filter_viewable_channels
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.routes.attachments import hard_delete_attachments
from dcc_chat_gateway.schemas import ChannelIn, ChannelOut, ChannelPatchIn
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id
from dcc_shared.events import (
    ChannelCreatedEvent,
    ChannelDeletedEvent,
    ChannelUpdatedEvent,
    _EventBase,
)

router = APIRouter()


def _channel_dict(channel: Channel) -> dict[str, object]:
    """Wire representation of a channel for guild:events envelopes — snowflake
    IDs as strings, same field names as ChannelOut (minus created_at, which
    lifecycle consumers don't need)."""
    return {
        "id": str(channel.id),
        "guild_id": str(channel.guild_id),
        "name": channel.name,
        "type": channel.type,
        "position": channel.position,
        "topic": channel.topic,
    }


async def _publish_guild_event(
    request: Request, envelope: _EventBase | dict[str, object]
) -> None:
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish_guild_event(envelope)


@router.post(
    "/guilds/{guild_id}/channels",
    response_model=ChannelOut,
    status_code=201,
)
async def create_channel(
    guild_id: int,
    payload: ChannelIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    await check_permission(session, current, guild_id, Permissions.MANAGE_CHANNELS)
    channel = Channel(
        id=next_id(),
        guild_id=guild_id,
        name=payload.name,
        type=payload.type,
        position=payload.position,
        topic=payload.topic,
    )
    session.add(channel)
    await session.commit()
    await session.refresh(channel)
    await _publish_guild_event(
        request, ChannelCreatedEvent(channel=_channel_dict(channel))
    )
    return channel


@router.get("/guilds/{guild_id}/channels", response_model=list[ChannelOut])
async def list_channels(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    limit: int = Query(200, ge=1, le=500),
):
    await require_member(session, guild_id, current.id)
    stmt = (
        select(Channel)
        .where(Channel.guild_id == guild_id)
        .order_by(Channel.position, Channel.id)
        .limit(limit)
    )
    rows = (await session.execute(stmt)).scalars().all()
    # Filter by VIEW_CHANNEL so members who are denied access to a private
    # channel don't learn about its existence via this listing. Batched
    # (one context load + one overwrite query) to avoid an N+1 across channels.
    visible_ids = await filter_viewable_channels(
        session, current, guild_id, [ch.id for ch in rows]
    )
    return [ch for ch in rows if ch.id in visible_ids]


@router.get("/guilds/{guild_id}/voice-state")
async def guild_voice_state(
    guild_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
) -> dict[str, list[dict[str, object]]]:
    """Current voice-presence for every voice channel in the guild.

    Returns ``{"voice_states": [{"channel_id": "<id>", "user_ids": [...]}, ...]}``
    — only channels with at least one participant are listed. Lets a client
    re-sync after a reconnect without waiting for the next push.
    """
    await require_member(session, guild_id, current.id)
    stmt = select(Channel.id).where(
        Channel.guild_id == guild_id, Channel.type == CHANNEL_TYPE_VOICE
    )
    channel_ids = [str(cid) for cid in (await session.execute(stmt)).scalars()]
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is None:
        return {"voice_states": []}
    return {"voice_states": await mgr.voice_states_for(channel_ids)}


@router.get("/channels/{channel_id}", response_model=ChannelOut)
async def get_channel(channel_id: int, session: SessionDep, current: CurrentUser):
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    await require_member(session, channel.guild_id, current.id)
    return channel


@router.delete("/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Delete a channel. Only the guild owner may do this.

    Messages are deleted explicitly here (the messages.channel_id FK was
    dropped in migration 0005 to make Message polymorphic over Channel /
    DirectMessageChannel). MessageReaction cascades on messages.id at the
    DB level, so reactions follow the messages.
    Broadcasts op:channel_deleted on guild:events to every connected client.
    """
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    await check_permission(
        session, current, channel.guild_id, Permissions.MANAGE_CHANNELS
    )
    guild_id = channel.guild_id
    # Collect attachment ids before deleting messages, then hard-delete them
    # (removes the MinIO objects too — Message bulk-delete can't cascade those).
    att_ids_stmt = (
        select(MessageAttachment.id)
        .where(
            MessageAttachment.channel_id == channel_id,
            MessageAttachment.deleted_at.is_(None),
        )
    )
    att_ids = list((await session.execute(att_ids_stmt)).scalars())
    if att_ids:
        await hard_delete_attachments(session, attachment_ids=att_ids)
    await session.execute(delete(Message).where(Message.channel_id == channel_id))
    await session.delete(channel)
    await session.commit()
    await _publish_guild_event(
        request,
        ChannelDeletedEvent(
            guild_id=str(guild_id), channel_id=str(channel_id)
        ),
    )


@router.patch("/channels/{channel_id}", response_model=ChannelOut)
async def patch_channel(
    channel_id: int,
    payload: ChannelPatchIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Rename/update a channel. Only the guild owner may do this.

    Broadcasts op:channel_updated on guild:events to every connected client.
    """
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    await check_permission(
        session, current, channel.guild_id, Permissions.MANAGE_CHANNELS
    )
    if payload.name is not None:
        channel.name = payload.name
    if payload.topic is not None:
        channel.topic = payload.topic
    await session.commit()
    await session.refresh(channel)
    await _publish_guild_event(
        request, ChannelUpdatedEvent(channel=_channel_dict(channel))
    )
    return channel
