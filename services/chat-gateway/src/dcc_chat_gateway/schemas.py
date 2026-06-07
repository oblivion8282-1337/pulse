"""Pydantic schemas for REST endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    field_serializer,
    field_validator,
)


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
    # Public-address fields (Stufe 4). Both optional so a single PATCH can set
    # one without touching the other. ``handle`` is validated for *format* here
    # (3–32 lowercase-slug); per-instance uniqueness is a DB constraint enforced
    # in the route (409 on collision). ``handle=""`` (empty string) clears the
    # handle — but only when the community is not public (the route guards that
    # a public community must keep a handle). The min/max bounds below intentionally
    # allow the empty string; ``validate_handle`` rejects malformed non-empty values.
    handle: Annotated[str | None, Field(default=None, max_length=32)] = None
    is_public: bool | None = None

    @field_validator("handle")
    @classmethod
    def _validate_handle(cls, v: str | None) -> str | None:
        # ``None`` = don't touch; ``""`` = clear (handled in the route).
        # Any other value must be a well-formed, non-reserved slug.
        if v is None or v == "":
            return v
        from dcc_chat_gateway.community_handle import validate_handle

        try:
            return validate_handle(v)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc


class GuildSettingsOut(BaseModel):
    """Public-address view of a guild's settings (Stufe 4).

    Returned by ``GET /guilds/{id}/settings`` so the community-settings UI can
    render the handle field + the public toggle + a copyable address. The
    ``address_path`` is the host-relative part (``/c/<handle>``); the client
    prepends the instance host it is connected to to form the full URL — the
    backend doesn't know its own public hostname reliably (behind Caddy/nginx)."""

    id: int
    name: str
    handle: str | None
    is_public: bool
    # Host-relative public address path, e.g. ``/c/coolserver``. ``None`` until
    # a handle is set (no address exists yet).
    address_path: str | None

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)


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


class MentionRef(BaseModel):
    """One @-mention parsed off a message's ``content``.

    ``type`` mirrors the ``MENTION_TYPE_*`` constants in
    ``dcc_chat_gateway.models.messages`` (0=user, 1=role, 2=everyone).
    ``id`` is the mentioned snowflake as a string — ``"0"`` for the
    everyone sentinel; the frontend branches on ``type == 2`` to
    distinguish (the id is meaningless in that case)."""

    type: int
    id: SnowflakeId

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
    # Parsed at write-time from ``content``. Always present (empty list
    # for messages without mentions). See ``mentions.py`` for the parser.
    mentions: list[MentionRef] = []

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

    ``can_send`` is True iff the caller may currently post into this DM
    (friendship still exists + no block in either direction). Allows
    the FE to gate the composer without a follow-up call. Recomputed
    per response since friendship/block state is mutable. False also
    when the DM existed pre-friend-cut and now sits as a tombstone.
    """

    id: int
    other_user_id: int
    last_message_id: int | None = None
    created_at: datetime
    can_send: bool = True

    @field_serializer("id", "other_user_id", "last_message_id")
    def _ser_ids(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None


class MemberIn(BaseModel):
    user_id: SnowflakeId


class MemberNicknameIn(BaseModel):
    """Nickname patch payload. Empty string ``""`` clears the nickname
    (same convention as Discord's "reset"). ``None`` means "don't touch"
    — kept as a separate field so future patches (e.g. timeout) can be
    added without breaking the single-field shape."""

    nickname: Annotated[str | None, Field(default=None, max_length=64)] = None


class MemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    guild_id: int
    user_id: int
    nickname: str | None
    joined_at: datetime

    @field_serializer("guild_id", "user_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


class BanIn(BaseModel):
    """Ban-creation payload. ``reason`` is free-form and surfaced to
    moderators in the ban list."""

    reason: Annotated[str | None, Field(default=None, max_length=512)] = None


class BanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    guild_id: int
    user_id: int
    reason: str | None
    banned_at: datetime
    banned_by_id: int

    @field_serializer("guild_id", "user_id", "banned_by_id")
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


# ---- Public community address (Stufe 4) ------------------------------------


class PublicCommunityPreviewOut(BaseModel):
    """Anonymous-safe preview of a public community (``GET /c/{handle}``).

    Deliberately minimal: name + member count + the public flag. Only ever
    returned for an ``is_public`` community — a private one 404s so its very
    existence (and member count) does not leak via the handle namespace."""

    guild: InviteGuildOut
    member_count: int
    is_public: bool


class PublicCommunityJoinOut(BaseModel):
    """Result of ``POST /c/{handle}/join`` — same shape as an invite-accept so
    the client can navigate to a landing channel right after joining."""

    guild: InviteGuildOut
    channel_id: int | None

    @field_serializer("channel_id")
    def _ser_channel(self, v: int | None) -> str | None:
        return _id_str(v) if v is not None else None


# ---- Community-Invite-Broker (Stufe 2 / B-lite, cloud-only) ----------------


_MAX_COMMUNITY_INVITE_TTL = 30 * 24 * 3600  # 30 days


class CreateCommunityInviteIn(BaseModel):
    invitee_id: SnowflakeId
    target_host: Annotated[str, Field(min_length=1, max_length=255)]
    target_instance_id: SnowflakeId | None = None
    target_guild_id: SnowflakeId
    target_guild_name: Annotated[str, Field(min_length=1, max_length=128)]
    # Host-coined GuildInvite code — relayed verbatim, never validated by the
    # Cloud (only the host can verify it). Bounded so a caller can't stuff the
    # row with megabytes.
    code: Annotated[str, Field(min_length=1, max_length=255)]
    expires_in_seconds: Annotated[
        int | None, Field(default=None, ge=60, le=_MAX_COMMUNITY_INVITE_TTL)
    ] = None


class CommunityInviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    inviter_id: int
    invitee_id: int
    target_host: str
    target_instance_id: int | None
    target_guild_id: int
    target_guild_name: str
    code: str
    created_at: datetime
    expires_at: datetime | None

    @field_serializer("id", "inviter_id", "invitee_id", "target_guild_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)

    @field_serializer("target_instance_id")
    def _ser_instance(self, v: int | None) -> str | None:
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
    """Server-wide chat flags + limits surfaced to every client via
    ``/capabilities`` (so UI can gate the create-guild button, validate
    uploads, etc.). Admin writes happen via ``/admin/permissions``.

    The numeric ``guild_sound_max_size_bytes`` lives here because it's
    a public ceiling — any uploader needs to know it. The class name
    pre-dates the field and is mildly misleading; renaming would touch
    too many callers without payoff."""

    model_config = ConfigDict(from_attributes=True)
    allow_guild_creation: bool
    allow_member_invites: bool
    # Self-Host join gate: open | invite_only | closed. Surfaced so the admin
    # UI can show/set the current mode. Cloud ignores it (no gated cert-join).
    join_mode: str
    guild_sound_max_size_bytes: int
    # Global HQ-stream quality limits (best-effort, client-enforced).
    hq_bitrate_min_kbps: int
    hq_bitrate_max_kbps: int
    hq_fps_min: int
    hq_fps_max: int
    hq_resolution_max: str
    # Global normal-stream (browser screen-share) limits — separate set.
    ns_bitrate_min_kbps: int
    ns_bitrate_max_kbps: int
    ns_fps_min: int
    ns_fps_max: int
    ns_resolution_max: str
    # Global webcam capture limits (best-effort, client-enforced).
    cam_resolution_max: str
    cam_fps_max: int


# Allowed values for ``hq_resolution_max`` — mirrors the frontend
# RESOLUTION_VALUES enum. 'Native' = no cap (source resolution).
ALLOWED_HQ_RESOLUTIONS: frozenset[str] = frozenset(
    {"Native", "4K", "1440p", "1080p", "720p", "480p"}
)

# Allowed values for ``ns_resolution_max`` — the LiveKit screen-share set
# (lowercase 'native' = no cap). Distinct set + casing from the HQ one.
ALLOWED_NS_RESOLUTIONS: frozenset[str] = frozenset({"native", "1080p", "720p", "480p"})

# Allowed values for ``cam_resolution_max`` — explicit webcam capture stages
# (no 'native': a webcam has a hardware ceiling, the admin picks a stage).
ALLOWED_CAM_RESOLUTIONS: frozenset[str] = frozenset({"1440p", "1080p", "720p", "480p"})

# Allowed values for ``join_mode`` (Self-Host join gate). Mirrors
# ``membership.JOIN_MODES``.
ALLOWED_JOIN_MODES: frozenset[str] = frozenset({"open", "invite_only", "closed"})


class PermissionsPatch(BaseModel):
    allow_guild_creation: bool | None = None
    allow_member_invites: bool | None = None
    # Self-Host join gate: open | invite_only | closed.
    join_mode: str | None = None
    # Bound: 4 KB floor (a 1-frame OGG is ~2 KB; below that = abuse),
    # 5 MB ceiling (anything larger isn't a "UI sound" anymore).
    guild_sound_max_size_bytes: Annotated[
        int | None, Field(default=None, ge=4096, le=5 * 1024 * 1024)
    ] = None
    # HQ-stream limits. Per-field bounds only here; the min<=max coherence
    # check happens in the route (a partial patch may set just one side, so
    # it must be validated against the stored row). Bitrate ceiling 32000
    # also respects the SmallInteger column (max 32767).
    hq_bitrate_min_kbps: Annotated[int | None, Field(default=None, ge=100, le=32000)] = None
    hq_bitrate_max_kbps: Annotated[int | None, Field(default=None, ge=100, le=32000)] = None
    hq_fps_min: Annotated[int | None, Field(default=None, ge=1, le=360)] = None
    hq_fps_max: Annotated[int | None, Field(default=None, ge=1, le=360)] = None
    hq_resolution_max: str | None = None
    # Normal-stream limits — own band; FPS ceiling 240 (screen-share max).
    ns_bitrate_min_kbps: Annotated[int | None, Field(default=None, ge=100, le=32000)] = None
    ns_bitrate_max_kbps: Annotated[int | None, Field(default=None, ge=100, le=32000)] = None
    ns_fps_min: Annotated[int | None, Field(default=None, ge=1, le=240)] = None
    ns_fps_max: Annotated[int | None, Field(default=None, ge=1, le=240)] = None
    ns_resolution_max: str | None = None
    # Webcam capture limits — FPS ceiling 60 (the camera path never exceeds it).
    cam_fps_max: Annotated[int | None, Field(default=None, ge=1, le=60)] = None
    cam_resolution_max: str | None = None

    @field_validator("join_mode")
    @classmethod
    def _validate_join_mode(cls, v: str | None) -> str | None:
        if v is not None and v not in ALLOWED_JOIN_MODES:
            raise ValueError(f"join_mode must be one of {sorted(ALLOWED_JOIN_MODES)}")
        return v

    @field_validator("hq_resolution_max")
    @classmethod
    def _validate_hq_resolution(cls, v: str | None) -> str | None:
        if v is not None and v not in ALLOWED_HQ_RESOLUTIONS:
            raise ValueError(f"hq_resolution_max must be one of {sorted(ALLOWED_HQ_RESOLUTIONS)}")
        return v

    @field_validator("ns_resolution_max")
    @classmethod
    def _validate_ns_resolution(cls, v: str | None) -> str | None:
        if v is not None and v not in ALLOWED_NS_RESOLUTIONS:
            raise ValueError(f"ns_resolution_max must be one of {sorted(ALLOWED_NS_RESOLUTIONS)}")
        return v

    @field_validator("cam_resolution_max")
    @classmethod
    def _validate_cam_resolution(cls, v: str | None) -> str | None:
        if v is not None and v not in ALLOWED_CAM_RESOLUTIONS:
            raise ValueError(f"cam_resolution_max must be one of {sorted(ALLOWED_CAM_RESOLUTIONS)}")
        return v


class GuildSoundOverrideOut(BaseModel):
    """A single per-guild sound override + a fresh presigned GET URL.

    ``url`` is short-lived (``s3_presigned_ttl_seconds``, default 30 min).
    The frontend re-fetches the list on reconnect and on the
    ``guild_sound_updated`` WS event, so URL staleness in long-lived
    connections is bounded by the next event or reconnect."""

    model_config = ConfigDict(from_attributes=True)
    sound_id: str
    url: str
    content_type: str
    file_size: int
    original_filename: str
    uploaded_by_id: SnowflakeId
    uploaded_at: datetime

    @field_serializer("uploaded_by_id")
    def _ser_uploaded_by(self, v: int) -> str:
        return _id_str(v)


class AdminStatsOut(BaseModel):
    """Chat-gateway slice of the admin Übersicht-Tab. auth-svc emits its own
    counts under its ``/admin/stats``; the UI merges them.

    ``messages_24h`` counts non-deleted rows from the last 24h.
    ``storage_bytes`` is the live MinIO attachments-bucket usage (sum of
    Object sizes via paginated LIST). ``storage_total_bytes`` +
    ``storage_free_bytes`` come from MinIO's admin storageinfo endpoint —
    underlying disk total/free, so the UI can show a fill-rate. All three
    are ``None`` if MinIO is unreachable; the UI falls back to "noch nicht
    aktiv".
    """

    guild_count: int
    channel_count: int
    dm_channel_count: int
    messages_24h: int
    storage_bytes: int | None = None
    storage_total_bytes: int | None = None
    storage_free_bytes: int | None = None


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
    JS-Number-precision concern.

    Rejects negatives upfront so a hostile ``-1`` can't slip past the
    Field-bounded Annotated chain via the int branch (BeforeValidator
    runs first → Field's ``ge=0`` still re-validates after, but the
    early raise gives a clearer error and stops a negative int from
    even materialising into the field path)."""
    if isinstance(value, bool):
        # bool is an int subclass but never makes sense as a bitfield.
        raise TypeError("expected int or string bitfield, got bool")
    if isinstance(value, int):
        if value < 0:
            raise ValueError("bitfield must be non-negative")
        return value
    if isinstance(value, str):
        parsed = int(value)
        if parsed < 0:
            raise ValueError("bitfield must be non-negative")
        return parsed
    raise TypeError(
        f"expected int or string bitfield, got {type(value).__name__}"
    )


# ``BeforeValidator`` coerces str→int first; the trailing ``Field`` then
# pins the value into the safe 0..(1<<52)-1 range so neither owners nor
# admins can persist a role with a negative or out-of-budget bitfield.
Bitfield = Annotated[
    int,
    BeforeValidator(_coerce_bitfield),
    Field(ge=0, lt=1 << 52),
]


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
