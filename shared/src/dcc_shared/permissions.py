"""Permission bitfield for Pulse guilds + channels.

The bit layout follows Stoatchat's pattern of grouping permissions by
scope with deliberate gaps between groups so new bits can be added later
without renumbering. We stay below bit 52 (JS `Number.MAX_SAFE_INTEGER`
is 2**53 - 1) even though we send bitfields as strings over the wire —
the safety margin makes it impossible to accidentally lose precision
during local arithmetic in a frontend that forgets to ``BigInt(...)``.

Bit budget:
    0-4    server admin
    5-7    reserved
    8-12   member admin
    13-19  reserved
    20-27  channel
    28-29  reserved
    30-36  voice
    37-50  reserved (deep room for growth)
    51     ADMINISTRATOR (bypass)
    52-63  do not use (cross 53-bit JS-safe-int boundary)
"""

from __future__ import annotations

from enum import IntFlag


class Permissions(IntFlag):
    # Server administration
    MANAGE_CHANNELS = 1 << 0
    MANAGE_GUILD = 1 << 1  # rename, icon, settings
    MANAGE_PERMISSIONS = 1 << 2  # edit channel permission overwrites
    MANAGE_ROLES = 1 << 3
    MANAGE_INVITES = 1 << 4  # revoke any invite

    # Member administration
    KICK_MEMBERS = 1 << 8
    BAN_MEMBERS = 1 << 9
    CHANGE_NICKNAME = 1 << 10
    MANAGE_NICKNAMES = 1 << 11

    # Channel
    VIEW_CHANNEL = 1 << 20
    READ_HISTORY = 1 << 21
    SEND_MESSAGES = 1 << 22
    MANAGE_MESSAGES = 1 << 23  # delete others' messages
    ATTACH_FILES = 1 << 24
    ADD_REACTIONS = 1 << 25
    CREATE_INVITES = 1 << 26
    MENTION_EVERYONE = 1 << 27

    # Voice
    CONNECT = 1 << 30
    SPEAK = 1 << 31
    STREAM = 1 << 32  # HQ stream + browser screenshare
    USE_VIDEO = 1 << 33  # camera in voice (future)
    MUTE_MEMBERS = 1 << 34
    DEAFEN_MEMBERS = 1 << 35
    MOVE_MEMBERS = 1 << 36

    # Bypass all checks. Owner is granted this implicitly by the resolver.
    ADMINISTRATOR = 1 << 51


# Owner / ADMINISTRATOR resolve to this mask rather than ``~0`` so that
# unset reserved bits stay zero — if we add a future permission, existing
# admin/owner users do not silently gain it before we have a chance to
# review the default semantics.
GRANT_ALL_SAFE: int = (1 << 52) - 1


# Default @everyone permissions, matching the pre-roles behaviour: every
# guild member could read + write + react + attach + invite, and join +
# speak + stream in voice channels. Used by the data migration that
# seeds an ``@everyone`` row for each existing guild.
DEFAULT_EVERYONE_PERMISSIONS: int = int(
    Permissions.VIEW_CHANNEL
    | Permissions.READ_HISTORY
    | Permissions.SEND_MESSAGES
    | Permissions.ATTACH_FILES
    | Permissions.ADD_REACTIONS
    | Permissions.CREATE_INVITES
    | Permissions.CHANGE_NICKNAME
    | Permissions.CONNECT
    | Permissions.SPEAK
    | Permissions.STREAM
)


__all__ = [
    "DEFAULT_EVERYONE_PERMISSIONS",
    "GRANT_ALL_SAFE",
    "Permissions",
]
