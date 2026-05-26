"""Chat-gateway route modules, combined into a single APIRouter."""

from __future__ import annotations

from fastapi import APIRouter

from dcc_chat_gateway.routes import (
    admin,
    admin_plugins,
    attachments,
    bans,
    blocks,
    capabilities,
    cert_login,
    channels,
    dms,
    friends,
    guild_icons,
    guild_plugins,
    guilds,
    internal,
    invites,
    mention_search,
    messages,
    mod_queue,
    notifications,
    permission_overwrites,
    preferences,
    presence,
    privacy,
    reactions,
    reports,
    role_members,
    roles,
    server_info,
    sounds,
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
router.include_router(friends.router)
router.include_router(blocks.router)
router.include_router(privacy.router)
router.include_router(preferences.router)
router.include_router(invites.router)
router.include_router(roles.router)
router.include_router(role_members.router)
router.include_router(server_info.router)
router.include_router(sounds.router)
router.include_router(permission_overwrites.router)
router.include_router(messages.router)
router.include_router(reactions.router)
router.include_router(streaming.router)
router.include_router(stream_chat.router)
router.include_router(watch_chat.router)
router.include_router(watch.router)
router.include_router(attachments.router)
router.include_router(capabilities.router)
router.include_router(cert_login.router)
router.include_router(notifications.router)
router.include_router(presence.router)
router.include_router(reports.router)
router.include_router(mod_queue.router)
router.include_router(admin.router)
router.include_router(admin_plugins.router)
router.include_router(guild_plugins.router)
router.include_router(mention_search.router)
router.include_router(internal.router)
router.include_router(ws.router)

__all__ = ["router"]
