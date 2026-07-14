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


class ChannelRevealedEvent(_EventBase):
    """A previously-hidden channel became visible to this one user
    (voice-pull grant). Delivered direct-to-user via ``user:events``;
    carries the full channel dict so the client can insert it into its
    channel list without a refetch. The ``channel: dict`` shape mirrors
    ``ChannelCreatedEvent`` on purpose — same handler logic applies."""

    op: Literal["channel_revealed"] = "channel_revealed"
    channel: dict[str, Any]


class ChannelHiddenEvent(_EventBase):
    """Counterpart to ``ChannelRevealedEvent``: a voice-pull grant was
    revoked (the user left the channel) and the channel must leave this
    user's channel list. Direct-to-user via ``user:events``; mirrors the
    ``ChannelDeletedEvent`` shape."""

    op: Literal["channel_hidden"] = "channel_hidden"
    guild_id: str
    channel_id: str


class ChannelPermissionsUpdatedEvent(_EventBase):
    op: Literal["channel_permissions_updated"] = "channel_permissions_updated"
    channel_id: str
    guild_id: str
    overwrites: list[dict[str, Any]]
    # True when the channel's @everyone overwrite now denies VIEW_CHANNEL —
    # lets clients flip the lock indicator without knowing the @everyone
    # role id themselves.
    restricted: bool = False


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
    # Self-Host-Anzeigename. Damit eine Umbenennung sofort bei ALLEN
    # verbundenen Mitgliedern ankommt (nicht erst beim nächsten ``ready``).
    # ``""`` = zurückgesetzt (Adresse zeigen), ``None`` = Feld unverändert.
    instance_name: str | None = None
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


# ---- Dropbox / Ablage ------------------------------------------------------
#
# Mutationen an Datei-/Ordner-Einträgen. Die ``entry`` dicts sind freiform-
# shaped — die Wahrheit liegt in ``DropboxEntryOut`` (``routes/_dropbox_schemas.py``);
# shared/events kennt SQLAlchemy nicht. Events sind nach Art der Mutation
# getrennt (statt ein ``action: Literal[``...``]``-Sammelevent), weil jeder
# Konsument genau eine Variante verarbeitet — Saves-Round-Trips beim
# Listener-Validator und macht WS-Subscriptions per op lesbar.

class DropboxEntryCreatedEvent(_EventBase):
    """Neuer Eintrag (Datei ODER Ordner) angelegt — inklusive nach erfolgreichem
    Direct-Upload (PUT zu MinIO via Presigned-URL)."""

    op: Literal["dropbox_entry_created"] = "dropbox_entry_created"
    guild_id: str
    entry: dict[str, Any]


class DropboxEntryUpdatedEvent(_EventBase):
    """Eintrag verändert — rename, move (parent_path), pin/unpin, oder
    overwrite (neue Version einer Datei)."""

    op: Literal["dropbox_entry_updated"] = "dropbox_entry_updated"
    guild_id: str
    entry: dict[str, Any]


class DropboxEntryDeletedEvent(_EventBase):
    """Soft-Delete (Papierkorb) — die MinIO-Bytes sind noch da; Storage-Key
    steht weiter auf der DB-Row. Hard-Purge erfolgt später durch den Sweep."""

    op: Literal["dropbox_entry_deleted"] = "dropbox_entry_deleted"
    guild_id: str
    entry: dict[str, Any]


class DropboxEntryRestoredEvent(_EventBase):
    """Aus dem Papierkorb zurückgeholt — deleted_at wird NULL."""

    op: Literal["dropbox_entry_restored"] = "dropbox_entry_restored"
    guild_id: str
    entry: dict[str, Any]


class DropboxEntryPurgedEvent(_EventBase):
    """Hard-Delete durch den Trash-Sweep nach ``trash_retention_days`` —
    MinIO-Objekt ist weg, DB-Row weg. Clients droppen den Eintrag aus der
    Papierkorb-Ansicht ohne Rückfrage."""

    op: Literal["dropbox_entry_purged"] = "dropbox_entry_purged"
    guild_id: str
    # Die nackte ID reicht hier — der Eintrag verschwindet komplett. Client
    # braucht keinen vollen Eintrag, nur den Index zum Entfernen.
    entry_id: str
    kind: int  # 0 = folder, 1 = file


class DropboxQuotaUpdatedEvent(_EventBase):
    """Quota-Snapshot — bei Settings-Änderung (Admin) oder wenn
    ``used_bytes`` merklich wandert (Upload/Delete/Restore-Pfad). Client
    lädt die Sidebar-Anzeige ohne Roundtrip zur API."""

    op: Literal["dropbox_quota_updated"] = "dropbox_quota_updated"
    guild_id: str
    enabled: bool
    total_quota_bytes: int
    per_file_max_bytes: int
    used_bytes: int
    trash_retention_days: int
