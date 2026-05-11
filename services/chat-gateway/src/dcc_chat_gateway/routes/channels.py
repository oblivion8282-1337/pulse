"""Channel CRUD endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import Channel, Guild
from dcc_chat_gateway.routes._deps import require_member
from dcc_chat_gateway.schemas import ChannelIn, ChannelOut, ChannelPatchIn
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

router = APIRouter()


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
):
    guild = await session.get(Guild, guild_id)
    if guild is None:
        raise HTTPException(404, detail="guild not found")
    if guild.owner_id != current.id:
        raise HTTPException(403, detail="only the owner can create channels")
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
    return channel


@router.get("/guilds/{guild_id}/channels", response_model=list[ChannelOut])
async def list_channels(guild_id: int, session: SessionDep, current: CurrentUser):
    await require_member(session, guild_id, current.id)
    stmt = (
        select(Channel)
        .where(Channel.guild_id == guild_id)
        .order_by(Channel.position, Channel.id)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


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

    Messages cascade-delete via ON DELETE CASCADE in the DB migration.
    Broadcasts op:channel_deleted to any currently-subscribed WS clients.
    """
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    guild = await session.get(Guild, channel.guild_id)
    if guild is None or guild.owner_id != current.id:
        raise HTTPException(403, detail="only the guild owner can delete channels")
    await session.delete(channel)
    await session.commit()
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        await mgr.publish(str(channel_id), {"op": "channel_deleted", "channel_id": str(channel_id)})


@router.patch("/channels/{channel_id}", response_model=ChannelOut)
async def patch_channel(
    channel_id: int,
    payload: ChannelPatchIn,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
):
    """Rename/update a channel. Only the guild owner may do this.

    Broadcasts op:channel_updated to any currently-subscribed WS clients.
    """
    channel = await session.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(404, detail="channel not found")
    guild = await session.get(Guild, channel.guild_id)
    if guild is None or guild.owner_id != current.id:
        raise HTTPException(403, detail="only the guild owner can update channels")
    if payload.name is not None:
        channel.name = payload.name
    if payload.topic is not None:
        channel.topic = payload.topic
    await session.commit()
    await session.refresh(channel)
    mgr = getattr(request.app.state, "connection_manager", None)
    if mgr is not None:
        ch_dict = {
            "id": str(channel.id),
            "guild_id": str(channel.guild_id),
            "name": channel.name,
            "type": channel.type,
            "position": channel.position,
            "topic": channel.topic,
        }
        await mgr.publish(str(channel_id), {"op": "channel_updated", "channel": ch_dict})
    return channel
