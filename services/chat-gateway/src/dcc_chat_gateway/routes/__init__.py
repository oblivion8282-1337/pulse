"""Chat-gateway route modules, combined into a single APIRouter."""

from __future__ import annotations

from fastapi import APIRouter

from dcc_chat_gateway.routes import (
    admin,
    attachments,
    bans,
    capabilities,
    channels,
    dms,
    guild_icons,
    guilds,
    internal,
    invites,
    messages,
    notifications,
    permission_overwrites,
    reactions,
    role_members,
    roles,
    stream_chat,
    streaming,
    watch,
    watch_chat,
    ws,
)

router = APIRouter()
router.include_router(guilds.router)
router.include_router(bans.router)
router.include_router(guild_icons.router)
router.include_router(channels.router)
router.include_router(dms.router)
router.include_router(invites.router)
router.include_router(roles.router)
router.include_router(role_members.router)
router.include_router(permission_overwrites.router)
router.include_router(messages.router)
router.include_router(reactions.router)
router.include_router(streaming.router)
router.include_router(stream_chat.router)
router.include_router(watch_chat.router)
router.include_router(watch.router)
router.include_router(attachments.router)
router.include_router(capabilities.router)
router.include_router(notifications.router)
router.include_router(admin.router)
router.include_router(internal.router)
router.include_router(ws.router)

__all__ = ["router"]
