"""Pydantic schemas for REST endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_serializer


def _id_str(value: int) -> str:
    return str(value)


def _coerce_id(value: object) -> int:
    """Accept snowflake IDs as int or string.

    JavaScript clients must pass IDs as strings because Number can't
    represent >2^53 without precision loss. We accept both forms so the
    Python tests stay ergonomic.
    """
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value)
    raise TypeError(f"expected int or string id, got {type(value).__name__}")


SnowflakeId = Annotated[int, BeforeValidator(_coerce_id)]


class GuildIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    icon_url: Annotated[str | None, Field(default=None, max_length=512)] = None


class GuildOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    icon_url: str | None
    owner_id: int
    created_at: datetime

    @field_serializer("id", "owner_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


class GuildPatchIn(BaseModel):
    name: Annotated[str | None, Field(default=None, min_length=1, max_length=64)] = None
    icon_url: Annotated[str | None, Field(default=None, max_length=512)] = None


class TransferOwnershipIn(BaseModel):
    """Transfer guild ownership to another member.

    ``confirm_name`` must match the guild's current name verbatim — the
    "type the project name to confirm" pattern, here to prevent
    fat-fingered transfers (no undo in v1 — the ex-owner becomes a
    regular member and would need the new owner to transfer back)."""

    new_owner_id: SnowflakeId
    confirm_name: Annotated[str, Field(min_length=1, max_length=64)]


class ChannelIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=64)]
    type: Annotated[int, Field(ge=0, le=1)] = 0
    topic: Annotated[str | None, Field(default=None, max_length=1024)] = None
    position: int = 0


class ChannelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    guild_id: int
    name: str
    type: int
    position: int
    topic: str | None
    created_at: datetime

    @field_serializer("id", "guild_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


class ChannelPatchIn(BaseModel):
    name: Annotated[str | None, Field(default=None, min_length=1, max_length=64)] = None
    topic: Annotated[str | None, Field(default=None, max_length=1024)] = None


class MessageIn(BaseModel):
    # ``content`` was min_length=1; with attachments a message can carry an
    # image and zero text. Still empty-string-vs-None-friendly. The route
    # validates that *either* text or attachments are present.
    content: Annotated[str, Field(min_length=0, max_length=4000)] = ""
    nonce: Annotated[str | None, Field(default=None, max_length=64)] = None
    reply_to_id: SnowflakeId | None = None
    attachment_ids: Annotated[list[SnowflakeId], Field(default_factory=list, max_length=64)]


class MessageEditIn(BaseModel):
    """Edit can change text AND attachments — author may add / remove /
    replace per the design (see PLAN.md and the user-facing spec)."""

    content: Annotated[str, Field(min_length=0, max_length=4000)] = ""
    attachment_ids: Annotated[list[SnowflakeId], Field(default_factory=list, max_length=64)]


class ReactionAggregate(BaseModel):
    """One row per (message, emoji); `count` aggregates users, `me` is whether
    the current caller is one of them."""

    emoji: str
    count: int
    me: bool


class AttachmentOut(BaseModel):
    """Wire representation of an attachment. ``url`` / ``thumb_url`` carry
    presigned MinIO GET URLs; both are short-lived (30 min default) and the
    client auto-refreshes on 403 via /attachments/{id}/download-url."""

    model_config = ConfigDict(from_attributes=True)
    id: int
    filename: str | None
    mime: str | None
    size: int
    width: int | None = None
    height: int | None = None
    thumb_width: int | None = None
    thumb_height: int | None = None
    url: str
    thumb_url: str | None = None

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    channel_id: int
    author_id: int
    content: str
    nonce: str | None
    reply_to_id: int | None = None
    created_at: datetime
    edited_at: datetime | None = None
    deleted_at: datetime | None = None
    reactions: list[ReactionAggregate] = []
    attachments: list[AttachmentOut] = []

    @field_serializer("id", "channel_id", "author_id", "reply_to_id")
    def _ser_ids(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None


class AttachmentUploadIn(BaseModel):
    """Client → server: 'please give me an upload-URL for this file'."""

    filename: Annotated[str, Field(min_length=1, max_length=255)]
    mime: Annotated[str, Field(min_length=1, max_length=128)]
    size: Annotated[int, Field(ge=1, le=4 * 1024**4)]  # 4 TiB ceiling
    # Optional dimensions for image/video — used by the renderer to set
    # the placeholder aspect-ratio before the URL resolves.
    width: int | None = None
    height: int | None = None
    # If true, the client will also PUT a thumbnail; server returns
    # ``thumb_upload_url`` and ``thumb_storage_key`` alongside.
    has_thumb: bool = False
    thumb_size: int | None = None
    thumb_width: int | None = None
    thumb_height: int | None = None


class AttachmentUploadOut(BaseModel):
    """Server → client: upload directly here, then POST /messages with this id."""

    id: int
    upload_url: str
    thumb_upload_url: str | None = None
    # Caller doesn't need the storage_keys — they live on the row server-side
    # — but they're handy for debugging in the dev tools.

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)


class AttachmentDownloadOut(BaseModel):
    """Re-signed GET URL — used by the client when an existing URL hits 403."""

    url: str
    thumb_url: str | None = None


class DMChannelCreateIn(BaseModel):
    target_user_id: SnowflakeId


class DMChannelOut(BaseModel):
    """Wire representation of a 1:1 direct-message channel.

    ``other_user_id`` is the *other* member relative to the caller —
    computed in the route handler from ``user_a_id`` / ``user_b_id``.
    Sorting by recency is done client-side on ``last_message_id``
    (snowflake IDs are time-ordered, so no separate timestamp needed).
    """

    id: int
    other_user_id: int
    last_message_id: int | None = None
    created_at: datetime

    @field_serializer("id", "other_user_id", "last_message_id")
    def _ser_ids(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None


class MemberIn(BaseModel):
    user_id: SnowflakeId


class MemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    guild_id: int
    user_id: int
    nickname: str | None
    joined_at: datetime

    @field_serializer("guild_id", "user_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


# ---- Invites ---------------------------------------------------------------

_MAX_INVITE_TTL = 30 * 24 * 3600  # 30 days


class CreateInviteIn(BaseModel):
    expires_in_seconds: Annotated[int | None, Field(default=None, ge=60, le=_MAX_INVITE_TTL)] = None
    max_uses: Annotated[int | None, Field(default=None, ge=1, le=1000)] = None
    channel_id: SnowflakeId | None = None


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    code: str
    guild_id: int
    channel_id: int | None
    max_uses: int | None
    uses: int
    expires_at: datetime | None
    created_at: datetime

    @field_serializer("guild_id", "channel_id")
    def _ser_ids(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None


class InviteGuildOut(BaseModel):
    id: int
    name: str
    icon_url: str | None

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)


class InvitePreviewOut(BaseModel):
    guild: InviteGuildOut
    channel_id: int | None
    member_count: int

    @field_serializer("channel_id")
    def _ser_channel(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None


class InviteAcceptOut(BaseModel):
    guild: InviteGuildOut
    channel_id: int | None

    @field_serializer("channel_id")
    def _ser_channel(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None


# ---- Admin ----------------------------------------------------------------


class ChatSettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    dm_attachment_max_size_bytes: int
    dm_attachment_max_count_per_message: int


class ChatSettingsPatch(BaseModel):
    # Both optional — admin can update one field at a time. Caps are large
    # but bounded (4 TiB / 64 attachments) just to keep dumb inputs out.
    dm_attachment_max_size_bytes: Annotated[
        int | None, Field(default=None, ge=1024, le=4 * 1024**4)
    ] = None
    dm_attachment_max_count_per_message: Annotated[
        int | None, Field(default=None, ge=0, le=64)
    ] = None


class PermissionsOut(BaseModel):
    """Server-wide permission flags. Mirrored toggle pair in the admin UI's
    'Berechtigungen' section. Defaults are ``true`` so the historical
    'anyone can' behaviour holds unless the admin actively restricts."""

    model_config = ConfigDict(from_attributes=True)
    allow_guild_creation: bool
    allow_member_invites: bool


class PermissionsPatch(BaseModel):
    allow_guild_creation: bool | None = None
    allow_member_invites: bool | None = None


class AdminStatsOut(BaseModel):
    """Chat-gateway slice of the admin Übersicht-Tab. auth-svc emits its own
    counts under its ``/admin/stats``; the UI merges them.

    ``messages_24h`` counts non-deleted rows from the last 24h.
    ``storage_bytes`` is a placeholder until MinIO is wired up (None for now).
    """

    guild_count: int
    channel_count: int
    dm_channel_count: int
    messages_24h: int
    storage_bytes: int | None = None


class RoleOut(BaseModel):
    """Wire representation of a guild role. ``permissions`` is the raw
    bitfield as a string (snowflake-style, JS-Number-safe for the upper bits)."""

    model_config = ConfigDict(from_attributes=True)
    id: int
    guild_id: int
    name: str
    permissions: int
    color: int | None
    position: int
    hoist: bool
    mentionable: bool
    is_everyone: bool

    @field_serializer("id", "guild_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)

    @field_serializer("permissions")
    def _ser_perms(self, v: int) -> str:
        return str(v)


def _coerce_bitfield(value: object) -> int:
    """Accept bitfields as int or string. Mirrors ``_coerce_id`` — same
    JS-Number-precision concern."""
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value)
    raise TypeError(
        f"expected int or string bitfield, got {type(value).__name__}"
    )


Bitfield = Annotated[int, BeforeValidator(_coerce_bitfield)]


class RoleIn(BaseModel):
    """Create-role payload. ``permissions`` defaults to 0 (effectively a
    cosmetic role until edited)."""

    name: Annotated[str, Field(min_length=1, max_length=64)]
    permissions: Bitfield = 0
    color: Annotated[int | None, Field(default=None, ge=0, le=0xFFFFFF)] = None
    hoist: bool = False
    mentionable: bool = False


class RolePatchIn(BaseModel):
    name: Annotated[str | None, Field(default=None, min_length=1, max_length=64)] = None
    permissions: Bitfield | None = None
    color: Annotated[int | None, Field(default=None, ge=0, le=0xFFFFFF)] = None
    hoist: bool | None = None
    mentionable: bool | None = None


class RolePositionIn(BaseModel):
    """One entry in a bulk role-reorder request."""

    id: SnowflakeId
    position: Annotated[int, Field(ge=0, le=1000)]


class RolePositionsIn(BaseModel):
    positions: Annotated[list[RolePositionIn], Field(min_length=1, max_length=200)]


class OverwriteIn(BaseModel):
    """Channel permission overwrite payload. ``allow`` and ``deny`` are
    independent bitfields — bits in both means deny wins (resolver-side)."""

    allow: Bitfield = 0
    deny: Bitfield = 0


class OverwriteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    target_type: int
    target_id: int
    allow: int
    deny: int

    @field_serializer("target_id")
    def _ser_target(self, v: int) -> str:
        return _id_str(v)

    @field_serializer("allow", "deny")
    def _ser_bf(self, v: int) -> str:
        return str(v)


class AdminAuditLogEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    actor_id: int
    action: str
    target_id: int | None
    payload: dict
    created_at: datetime

    @field_serializer("id", "actor_id", "target_id")
    def _ids_to_str(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None
