"""Shared dependencies and membership helpers for chat-gateway routers."""

from __future__ import annotations

from fastapi import HTTPException, status

from dcc_chat_gateway.models import Channel, GuildMember


async def require_member(session, guild_id: int, user_id: int) -> None:
    member = await session.get(GuildMember, (guild_id, user_id))
    if member is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not a member of this guild")


async def channel_membership(session, channel_id: int, user_id: int) -> Channel | None:
    channel = await session.get(Channel, channel_id)
    if channel is None:
        return None
    member = await session.get(GuildMember, (channel.guild_id, user_id))
    if member is None:
        return None
    return channel
