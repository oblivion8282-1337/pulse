"""Chat-gateway route modules, combined into a single APIRouter."""

from __future__ import annotations

from fastapi import APIRouter

from dcc_chat_gateway.routes import (
    admin,
    admin_backups,
    admin_join_invites,
    admin_members,
    admin_plugins,
    attachments,
    bans,
    blocks,
    capabilities,
    cert_login,
    channels,
    community_invites,
    dms,
    friends,
    guild_icons,
    guild_plugins,
    guilds,
    health,
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
    users,
    watch,
    watch_chat,
    ws,
)

router = APIRouter()
router.include_router(health.router)
router.include_router(guilds.router)
router.include_router(bans.router)
router.include_router(guild_icons.router)
router.include_router(channels.router)
# Friend-system / DM / Block routes are cloud-only (global social layer).
# The ``require_cloud`` dependency (applied inside each router) returns 404
# on self-host at request time. The routers are still registered so the
# module graph stays stable regardless of instance mode — the guard is
# evaluated per-request, which lets the test-suite override the mode via
# fixture without re-importing the module. DB tables (friendships,
# dm_channels, …) are left intact on self-hosts — harmless dead weight;
# the Cloud needs them in its own schema.
router.include_router(dms.router)
router.include_router(friends.router)
router.include_router(community_invites.router)
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
router.include_router(admin_backups.router)
router.include_router(admin_join_invites.router)
router.include_router(admin_members.router)
router.include_router(admin_plugins.router)
router.include_router(guild_plugins.router)
router.include_router(mention_search.router)
router.include_router(users.router)
router.include_router(internal.router)
router.include_router(ws.router)

__all__ = ["router"]
