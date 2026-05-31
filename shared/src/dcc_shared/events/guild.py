"""Guild-lifecycle events.

Published on the ``guild:events`` Redis channel and forwarded to every
connected WebSocket (filtered by guild-membership inside the listener).

All snowflake-ish identifiers are strings on the wire. The nested
``channel`` / ``guild`` / ``role`` sub-shapes are intentionally typed as
free-form dicts here — their full shapes live in chat-gateway schemas
(``ChannelOut``, ``GuildOut``, ``RoleOut``); duplicating them into shared
would invert the dependency direction (shared can't know about
SQLAlchemy models).
"""

from __future__ import annotations

from typing import Any, Literal

from dcc_shared.events._base import _EventBase


# ---- Channels --------------------------------------------------------------


class ChannelCreatedEvent(_EventBase):
    op: Literal["channel_created"] = "channel_created"
    channel: dict[str, Any]


class ChannelUpdatedEvent(_EventBase):
    op: Literal["channel_updated"] = "channel_updated"
    channel: dict[str, Any]


class ChannelDeletedEvent(_EventBase):
    op: Literal["channel_deleted"] = "channel_deleted"
    guild_id: str
    channel_id: str


class ChannelPermissionsUpdatedEvent(_EventBase):
    op: Literal["channel_permissions_updated"] = "channel_permissions_updated"
    channel_id: str
    guild_id: str
    overwrites: list[dict[str, Any]]


# ---- Guild metadata + lifecycle --------------------------------------------


class GuildUpdatedEvent(_EventBase):
    op: Literal["guild_updated"] = "guild_updated"
    guild: dict[str, Any]


class GuildDeletedEvent(_EventBase):
    op: Literal["guild_deleted"] = "guild_deleted"
    guild_id: str


# ---- Members ---------------------------------------------------------------


class GuildMemberAddedEvent(_EventBase):
    op: Literal["guild_member_added"] = "guild_member_added"
    guild_id: str
    user_id: str


class GuildMemberUpdatedEvent(_EventBase):
    op: Literal["guild_member_updated"] = "guild_member_updated"
    guild_id: str
    user_id: str
    nickname: str | None = None


class GuildMemberRemovedEvent(_EventBase):
    op: Literal["guild_member_removed"] = "guild_member_removed"
    guild_id: str
    user_id: str


# ---- Bans ------------------------------------------------------------------


class GuildBanAddedEvent(_EventBase):
    op: Literal["guild_ban_added"] = "guild_ban_added"
    guild_id: str
    user_id: str
    # Reason is optional on the wire (publisher only sets it when non-null).
    reason: str | None = None


class GuildBanRemovedEvent(_EventBase):
    op: Literal["guild_ban_removed"] = "guild_ban_removed"
    guild_id: str
    user_id: str


# ---- Roles + role-member assignments ---------------------------------------


class RoleCreatedEvent(_EventBase):
    op: Literal["role_created"] = "role_created"
    role: dict[str, Any]


class RoleUpdatedEvent(_EventBase):
    op: Literal["role_updated"] = "role_updated"
    role: dict[str, Any]


class RoleDeletedEvent(_EventBase):
    op: Literal["role_deleted"] = "role_deleted"
    guild_id: str
    role_id: str


class RolePositionsUpdatedEvent(_EventBase):
    op: Literal["role_positions_updated"] = "role_positions_updated"
    roles: list[dict[str, Any]]


class MemberRolesUpdatedEvent(_EventBase):
    """Hint event (no payload body) — receiver re-fetches the affected
    member's role list. Keeps the publish path tiny + side-steps the
    "what role(s) changed" diff problem on the wire."""

    op: Literal["member_roles_updated"] = "member_roles_updated"
    guild_id: str
    user_id: str


# ---- Admin / settings ------------------------------------------------------


class PermissionsUpdatedEvent(_EventBase):
    """Pulse-admin-level toggles. Fired when ``chat_settings`` changes
    so clients can re-gate UI (create-guild / create-invite buttons,
    sound upload size). Bool fields can be omitted in publish (publisher
    only sets fields it actually changed) — defaults reflect "field
    absent" on the wire."""

    op: Literal["permissions_updated"] = "permissions_updated"
    allow_guild_creation: bool | None = None
    allow_member_invites: bool | None = None
    guild_sound_max_size_bytes: int | None = None
    # Global HQ-stream limits (best-effort, client-enforced).
    hq_bitrate_min_kbps: int | None = None
    hq_bitrate_max_kbps: int | None = None
    hq_fps_min: int | None = None
    hq_fps_max: int | None = None
    hq_resolution_max: str | None = None
    # Global normal-stream (browser screen-share) limits — separate set.
    ns_bitrate_min_kbps: int | None = None
    ns_bitrate_max_kbps: int | None = None
    ns_fps_min: int | None = None
    ns_fps_max: int | None = None
    ns_resolution_max: str | None = None
    # Global webcam capture limits.
    cam_resolution_max: str | None = None
    cam_fps_max: int | None = None


class GuildSoundUpdatedEvent(_EventBase):
    op: Literal["guild_sound_updated"] = "guild_sound_updated"
    guild_id: str
    sound_id: str
    removed: bool


# ---- Plugin-System (Pro-Guild-Toggle) --------------------------------------


class GuildPluginsChangedEvent(_EventBase):
    """Guild-Admin hat ein Plugin auf der Guild ein-/ausgeschaltet.

    Wird vom PUT/DELETE-Pfad (``routes/guild_plugins.py`` +
    ``routes/admin_plugins.py``) publisht, damit alle Guild-Member ihren
    ``guild-activation``-Cache live invalidieren können — ohne F5.

    Op ist **nicht** colon-namespaced: das ist ein Core-Event über einen
    Plugin-Effekt, kein Plugin-eigener Op-Code. Der Listener-Validator
    behandelt es normal (kein ``:``-Bypass).
    """

    op: Literal["guild_plugins_changed"] = "guild_plugins_changed"
    guild_id: str
    plugin_name: str
    enabled: bool
