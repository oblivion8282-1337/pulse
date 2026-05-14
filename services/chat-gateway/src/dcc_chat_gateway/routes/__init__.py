"""Chat-gateway route modules, combined into a single APIRouter."""

from __future__ import annotations

from fastapi import APIRouter

from dcc_chat_gateway.routes import (
    channels,
    guild_icons,
    guilds,
    invites,
    messages,
    reactions,
    stream_chat,
    streaming,
    ws,
)

router = APIRouter()
router.include_router(guilds.router)
router.include_router(guild_icons.router)
router.include_router(channels.router)
router.include_router(invites.router)
router.include_router(messages.router)
router.include_router(reactions.router)
router.include_router(streaming.router)
router.include_router(stream_chat.router)
router.include_router(ws.router)

__all__ = ["router"]
