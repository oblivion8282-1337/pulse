"""Chat-gateway route modules, combined into a single APIRouter."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from dcc_chat_gateway.routes import (
    ablage_guild_laufwerk,
    ablage_kanal,
    ablage_pruefen,
    ablage_zwischenlager,
    admin,
    admin_backups,
    admin_members,
    admin_plugins,
    attachments,
    audio_diagnostic,
    bans,
    blocks,
    capabilities,
    session_ticket,
    channels,
    community_invites,
    device_grants,
    devices,
    dms,
    dropbox,
    dropbox_admin,
    dropbox_downloads,
    dropbox_uploads,
    friends,
    geraete,
    guild_icons,
    guild_limits,
    guild_plugins,
    guilds,
    health,
    instance_membership,
    internal,
    invites,
    kopplung,
    kopplung_umzug,
    member_invites,
    mention_search,
    messages,
    mod_queue,
    notifications,
    owner,
    owner_check,
    permission_overwrites,
    postfach,
    postfach_abholen,
    postfach_anhaenge,
    preferences,
    presence,
    privacy,
    private_gruppen,
    public_community,
    reactions,
    reports,
    role_members,
    roles,
    schluessel,
    schluessel_abholen,
    schluessel_auskunft,
    server_info,
    sounds,
    stream_chat,
    streaming,
    users,
    voice_pull,
    watch,
    watch_chat,
    ws,
)
from dcc_chat_gateway.routes._dropbox_policy import (
    require_dropbox_available,
    require_guild_dropbox_allowed,
)

router = APIRouter()
router.include_router(health.router)
router.include_router(instance_membership.router)
router.include_router(guilds.router)
router.include_router(bans.router)
router.include_router(guild_icons.router)
router.include_router(channels.router)
router.include_router(ablage_kanal.router)
router.include_router(ablage_pruefen.router)
router.include_router(ablage_guild_laufwerk.router)
router.include_router(ablage_zwischenlager.router)
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
router.include_router(member_invites.router)
router.include_router(blocks.router)
router.include_router(privacy.router)
router.include_router(preferences.router)
router.include_router(audio_diagnostic.router)
router.include_router(invites.router)
router.include_router(public_community.router)
router.include_router(roles.router)
router.include_router(role_members.router)
router.include_router(server_info.router)
router.include_router(owner_check.router)
router.include_router(sounds.router)
router.include_router(permission_overwrites.router)
router.include_router(voice_pull.router)
router.include_router(messages.router)
router.include_router(reactions.router)
router.include_router(streaming.router)
router.include_router(stream_chat.router)
router.include_router(watch_chat.router)
router.include_router(watch.router)
router.include_router(attachments.router)
router.include_router(capabilities.router)
router.include_router(schluessel.router)
router.include_router(schluessel_abholen.router)
router.include_router(schluessel_auskunft.router)
router.include_router(geraete.router)
router.include_router(kopplung.router)
router.include_router(kopplung_umzug.router)
router.include_router(postfach.router)
router.include_router(private_gruppen.router)
router.include_router(postfach_abholen.router)
router.include_router(postfach_anhaenge.router)
router.include_router(session_ticket.router)
# Dropbox / Ablage — split across three files to stay under the
# 350-line soft cap. dropbox.py exposes ``admin_router`` so callers
# don't need a separate include for the PATCH /settings endpoint.
#
# The Cloud switches the whole feature off (``CLOUD_DROPBOX_ENABLED=false``,
# the default): the Ablage accepts arbitrary file types, which hash-matching
# cannot inspect — it would be the unscanned side door next to the
# image-only message attachments. Gating every dropbox route from this one
# place is deliberate; a gate on the mint route alone would still leave
# listing/download of existing files reachable. Self-hosts are unaffected.
# See docs/medien-speicher-und-scanning.md.
#
# Second gate, per community: the operator unlocks the Ablage for a community
# in /owner/communities/{id}/limits (``guilds.dropbox_allowed``, default off).
# Every route below lives under /guilds/{guild_id}/dropbox/..., so the
# dependency can read the id straight from the path. Both gates 404 so a
# locked feature looks the same as one that was never there. Routes that need
# the guild row itself take ``DropboxGuild`` and get the one the gate loaded.
_dropbox_gate = [
    Depends(require_dropbox_available),
    Depends(require_guild_dropbox_allowed),
]
router.include_router(dropbox.router, dependencies=_dropbox_gate)
router.include_router(dropbox_uploads.router, dependencies=_dropbox_gate)
router.include_router(dropbox_downloads.router, dependencies=_dropbox_gate)
router.include_router(dropbox_admin.admin_router, dependencies=_dropbox_gate)
router.include_router(notifications.router)
router.include_router(presence.router)
router.include_router(reports.router)
router.include_router(mod_queue.router)
router.include_router(admin.router)
router.include_router(owner.router)
router.include_router(admin_backups.router)
router.include_router(admin_members.router)
router.include_router(admin_plugins.router)
router.include_router(guild_plugins.router)
router.include_router(devices.router)
router.include_router(device_grants.router)
router.include_router(guild_limits.router)
router.include_router(mention_search.router)
router.include_router(users.router)
router.include_router(internal.router)
router.include_router(ws.router)

__all__ = ["router"]
