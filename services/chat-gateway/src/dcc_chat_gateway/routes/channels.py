"""Channel CRUD endpoints."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import delete, select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel, Guild, Message, MessageAttachment
from dcc_chat_gateway.permissions import (
    Permissions,
    check_permission,
    filter_viewable_channels,
    has_permission,
    resolve_permissions,
    restricted_channel_ids,
)
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.routes.attachments import hard_delete_attachments, purge_s3_keys
from dcc_chat_gateway.schemas import (
    ChannelIn,
    ChannelOut,
    ChannelPatchIn,
    ChannelPositionsIn,
)
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
        # Stamped onto the instance by routes that computed it; freshly
        # created channels have no overwrites yet → False.
        "restricted": getattr(channel, "restricted", False),
        "name_color": channel.name_color,
        "name_color_secondary": channel.name_color_secondary,
        "name_gradient_angle": channel.name_gradient_angle,
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
    visible = [ch for ch in rows if ch.id in visible_ids]
    # Lock indicator: mark channels whose @everyone overwrite denies
    # VIEW_CHANNEL. One extra batched query; ChannelOut picks the stamped
    # attribute up via from_attributes.
    restricted = await restricted_channel_ids(
        session, guild_id, [ch.id for ch in visible]
    )
    for ch in visible:
        ch.restricted = ch.id in restricted  # type: ignore[attr-defined]
    return visible


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
    raw_ids = list((await session.execute(stmt)).scalars())
    # Filter to only channels the requesting user may VIEW_CHANNEL so that
    # voice-presence in private channels is not disclosed to denied members.
    visible_ids = await filter_viewable_channels(session, current, guild_id, raw_ids)
    channel_ids = [str(cid) for cid in raw_ids if cid in visible_ids]
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
    # Enforce VIEW_CHANNEL so that private channels (denied via role/user
    # overwrite) are not disclosed by direct ID lookup. Return 404 rather than
    # 403 to avoid confirming the channel's existence to non-permitted members.
    perms = await resolve_permissions(
        session, current, channel.guild_id, channel_id=channel_id
    )
    if not has_permission(perms, Permissions.VIEW_CHANNEL):
        raise HTTPException(404, detail="channel not found")
    restricted = await restricted_channel_ids(
        session, channel.guild_id, [channel_id]
    )
    channel.restricted = channel_id in restricted  # type: ignore[attr-defined]
    return channel


@router.delete("/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel(
    channel_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Delete a channel. Requires MANAGE_CHANNELS permission.

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
    # Tombstone attachment rows now but purge MinIO objects only after a
    # successful commit — a commit failure must not leave the bytes gone while
    # the rows still reference them (invisible to the reaper).
    s3_keys_to_purge: list[str] = []
    if att_ids:
        await hard_delete_attachments(
            session, attachment_ids=att_ids, defer_s3=s3_keys_to_purge
        )
    await session.execute(delete(Message).where(Message.channel_id == channel_id))
    await session.delete(channel)
    await session.commit()
    await purge_s3_keys(s3_keys_to_purge)
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
    """Rename/update a channel. Requires MANAGE_CHANNELS permission.

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
    # Styling uses the default=... sentinel: an omitted field is left untouched,
    # an explicit null clears it.
    fields_set = payload.model_fields_set
    if "name_color" in fields_set:
        channel.name_color = payload.name_color
    if "name_color_secondary" in fields_set:
        channel.name_color_secondary = payload.name_color_secondary
    if "name_gradient_angle" in fields_set:
        channel.name_gradient_angle = payload.name_gradient_angle
    await session.commit()
    await session.refresh(channel)
    restricted = await restricted_channel_ids(
        session, channel.guild_id, [channel_id]
    )
    channel.restricted = channel_id in restricted  # type: ignore[attr-defined]
    await _publish_guild_event(
        request, ChannelUpdatedEvent(channel=_channel_dict(channel))
    )
    return channel


@router.patch(
    "/guilds/{guild_id}/channels-positions",
    response_model=list[ChannelOut],
)
async def update_channel_positions(
    guild_id: int,
    payload: ChannelPositionsIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Bulk-set channel positions — the drag-and-drop reorder in the sidebar.

    Requires ``MANAGE_CHANNELS``. Text and voice channels share the position
    space, but the client filters by type and only sends the reordered group,
    so the two never need to agree on a global order. Duplicate positions are
    allowed (stable by id), matching the role-reorder endpoint. Broadcasts a
    ``channel_updated`` per channel so every connected member re-sorts — the
    frontend already handles that op, so no new event type is introduced.
    """
    await check_permission(session, current, guild_id, Permissions.MANAGE_CHANNELS)

    channel_ids = [p.id for p in payload.positions]
    stmt = select(Channel).where(
        Channel.guild_id == guild_id, Channel.id.in_(channel_ids)
    )
    rows = {c.id: c for c in (await session.execute(stmt)).scalars()}
    if len(rows) != len(channel_ids):
        raise HTTPException(400, detail="one or more channels not in this guild")

    for entry in payload.positions:
        rows[entry.id].position = entry.position
    await session.commit()

    # Stamp the lock indicator (restricted) for both the broadcast dicts and
    # the response model, same as the other channel routes.
    restricted = await restricted_channel_ids(session, guild_id, list(rows.keys()))
    for cid, ch in rows.items():
        ch.restricted = cid in restricted  # type: ignore[attr-defined]

    await asyncio.gather(
        *[
            _publish_guild_event(
                request, ChannelUpdatedEvent(channel=_channel_dict(ch))
            )
            for ch in rows.values()
        ]
    )
    return list(rows.values())
