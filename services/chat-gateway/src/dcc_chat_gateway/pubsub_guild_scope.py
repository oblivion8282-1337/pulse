"""Which ``guild:events`` ops are member-only, and how to find their guild.

Split out of ``pubsub_perm_filter`` so the *policy* (which ops must not leave
the guild) sits apart from the *mechanism* (the socket filter that applies it)
— the list is the security-relevant half and is easier to audit on its own.
Consumed by ``_PermFilterMixin._filter_targets_by_guild``.
"""

from __future__ import annotations

# ops on guild:events whose visibility must be scoped to guild members.
# Anything NOT listed here fans out to every connected socket, so a
# guild-scoped op missing from this set is a metadata leak — the frontend's own
# membership filter is cosmetic (DevTools sees the raw frame). ``channel_bump``
# is scoped so the (cold-cache) VIEW_CHANNEL resolve in the filter only runs for
# the guild's own members, not for every globally-connected socket.
#
# Deliberately NOT scoped:
#   * ``presence_update`` — cross-guild by design (see the block-aware filter in
#     pubsub_channel_guild.handle_guild_events).
#   * ``permissions_updated`` — instance-wide admin toggles, carries no guild_id.
# Direct-to-user ops (``channel_revealed``/``channel_hidden``,
# ``guild_membership_revoked``, ``guild_ban_lifted``, ``complaint_new``) ride
# user:events, never this channel, so they aren't listed either — several of
# them intentionally target ex-members a guild filter would drop.
GUILD_MEMBER_SCOPED_OPS = frozenset(
    {
        "guild_member_added",
        "guild_member_removed",
        "guild_member_updated",
        "guild_ban_added",
        "guild_ban_removed",
        "channel_bump",
        # Channel + role + guild metadata: names/topics, role permission
        # bitfields, guild name/owner — and ``channel_permissions_updated``
        # carries the channel's full overwrite list, i.e. exactly which users
        # and roles may see a private channel.
        "channel_created",
        "channel_updated",
        "channel_deleted",
        "channel_permissions_updated",
        "guild_updated",
        "guild_deleted",
        "role_created",
        "role_updated",
        "role_deleted",
        "member_roles_updated",
        "guild_sound_updated",
        # Plugin-Toggle-Push (per-guild): nur Member sollen ihren
        # ``guild-activation``-Cache invalidieren; Outsider haben gar keinen
        # Slot für die Guild.
        "guild_plugins_changed",
        # Standplatz-Geraete: Name und Standplatz eines fremden Rechners gehen
        # nur an Mitglieder — und darunter nur an die, die den Standplatz sehen
        # duerfen (die zweite Schranke sitzt in ``pubsub_channel_guild``).
        "device_changed",
        "device_state",
        # Dropbox / Ablage events carry entry metadata + presigned GET URLs
        # (for files). The bandwidth cost is negligible but the privacy cost
        # matters — a member with ``@everyone`` ``VIEW_CHANNEL`` denied on the
        # dropbox channel must not receive presigned URLs for files they can't
        # see in the sidebar. Same channel-scope as ``channel_bump`` (see the
        # gate in pubsub_channel_guild.handle_guild_events).
        "dropbox_entry_created",
        "dropbox_entry_updated",
        "dropbox_entry_deleted",
        "dropbox_entry_restored",
        "dropbox_entry_purged",
        "dropbox_quota_updated",
        # New moderation report: pre-narrow to guild members here (cheap), then
        # ``_filter_by_moderator`` narrows further to the guild's moderators.
        "report_new",
    }
)

# Where each envelope shape keeps the guild id. Most ops carry a top-level
# ``guild_id``; the dict-carrying ones nest it — ``channel``/``role`` hold
# ``guild_id`` inside the dict, ``guild`` holds it as ``id`` (it *is* the guild).
_NESTED_GUILD_ID_FIELDS = (("channel", "guild_id"), ("role", "guild_id"), ("guild", "id"))


def event_guild_id(payload: dict) -> int | None:
    """Resolve a guild:events payload's guild id, whichever shape it uses.

    Reading only the top-level key would silently yield nothing for the nested
    shapes and — before the caller started failing closed — hand back an
    unfiltered broadcast.
    """
    raw = payload.get("guild_id")
    if raw is None:
        for key, field in _NESTED_GUILD_ID_FIELDS:
            nested = payload.get(key)
            if isinstance(nested, dict) and (raw := nested.get(field)) is not None:
                break
    try:
        return int(raw) or None
    except (TypeError, ValueError):
        return None
