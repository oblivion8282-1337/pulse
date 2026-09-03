"""Pydantic schemas for REST endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from dcc_shared.snowflake import INT64_MAX, INT64_MIN
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    field_serializer,
    field_validator,
    model_validator,
)


def _id_str(value: int) -> str:
    return str(value)


def _opt_id_str(v: int | None) -> str | None:
    return _id_str(v) if v is not None else None


def _coerce_id(value: object) -> int:
    """Accept snowflake IDs as int or string.

    JavaScript clients must pass IDs as strings because Number can't
    represent >2^53 without precision loss. We accept both forms so the
    Python tests stay ergonomic.

    Der Bereich wird geprueft (Bughunt 17. August): eine Kennung ausserhalb
    von BIGINT bringt nicht diese Pruefung zu Fall, sondern den Datenbank-
    treiber — der Nutzer bekaeme einen 500er statt einer Eingabefehlermeldung,
    und er kann ihn mit einer harmlos aussehenden Nachricht ausloesen. Die
    Pruefung sitzt hier, weil ``SnowflakeId`` die gemeinsame Naht ALLER
    REST-Eingaben ist; eine Grenze je Route waere genau die Sorte Kopie, die
    dann an einer Stelle fehlt.
    """
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, str):
        parsed = int(value)
    else:
        raise TypeError(f"expected int or string id, got {type(value).__name__}")
    if not (INT64_MIN <= parsed <= INT64_MAX):
        raise ValueError("id out of range")
    return parsed


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
    attachment_max_size_bytes: int
    attachment_max_count_per_message: int
    # Wirksame Grenzen dieser Community — Wert der Community, sonst Obergrenze
    # des Betreibers (``guild_limits.effective``). Die Feldnamen tragen noch
    # ``_max_``, weil genau das der Client seit jeher liest; was sich geändert
    # hat, ist nur, WORAUS der Wert entsteht.
    voice_bitrate_max_kbps: int | None = None
    stream_bitrate_max_kbps: int | None = None
    stream_fps_max: int | None = None
    stream_resolution_max: str | None = None
    # Feature permission: has the operator unlocked the Ablage here? Members
    # read it to hide the UI; the server enforces it in the dropbox router gate.
    dropbox_allowed: bool = False

    @model_validator(mode="before")
    @classmethod
    def _resolve_effective(cls, data: object) -> object:
        """Aus dem ORM-Objekt die wirksamen Werte ziehen statt der Rohspalten.

        Bewusst hier und nicht in den Routen: ``GuildOut`` wird an mehreren
        Stellen aus einem ``Guild`` gebaut, und eine Route, die es künftig
        vergisst, würde dem Client stillschweigend die Obergrenze des
        Betreibers als seinen eigenen Wert unterschieben."""
        from dcc_chat_gateway.guild_limits import effective_wire_limits

        if not hasattr(data, "voice_bitrate_max_kbps"):
            return data  # dict / bereits aufgelöst
        resolved = {
            field: getattr(data, field)
            for field in cls.model_fields
            if hasattr(data, field)
        }
        # Wirksame Qualitätsgrenzen unter ihren Wire-Namen — dieselbe Quelle wie
        # ``_guild_dict`` und der ready-Frame, damit die Feld↔Limit-Paarungen an
        # genau einer Stelle (``guild_limits``) gepflegt werden.
        resolved.update(effective_wire_limits(data))
        return resolved

    @field_serializer("id", "owner_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


class GuildLimitValue(BaseModel):
    """Ein Limit aus Sicht der Community-Leitung.

    ``value`` = der eigene Wert (None = keiner gesetzt), ``ceiling`` = die
    Obergrenze des Betreibers (None = unbegrenzt), ``effective`` = was
    tatsächlich gilt. Auflösungen sind Zeichenketten, alles andere Zahlen."""

    value: int | str | None = None
    ceiling: int | str | None = None
    effective: int | str | None = None


class GuildLimitsOut(BaseModel):
    limits: dict[str, GuildLimitValue]
    #: Schlüssel der Limits, die beim Speichern auf die Obergrenze
    #: zurückgeholt wurden — die Oberfläche sagt dem Nutzer, was angepasst wurde.
    clamped: list[str] = []


class GuildLimitsPatch(BaseModel):
    """Teilweise Aktualisierung: nur genannte Schlüssel werden angefasst,
    ausdrückliches ``null`` löscht den eigenen Wert."""

    limits: dict[str, int | str | None]


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
    #: Im Verzeichnis zeigen (Entdecken). Getrennt von ``is_public``: eine
    #: oeffentliche Adresse ist eine andere Zustimmung als ein durchsuchbares
    #: Schaufenster. Ohne ``is_public`` lehnt die Route ab.
    listed: bool | None = None
    #: Eine Kennung aus ``COMMUNITY_CATEGORIES``; ``""`` loescht sie.
    category: Annotated[str | None, Field(default=None, max_length=16)] = None
    # Per-guild attachment limits (MANAGE_GUILD). Enforced in attachments.py.
    attachment_max_size_bytes: Annotated[
        int | None, Field(default=None, ge=1024, le=1_073_741_824)
    ] = None
    attachment_max_count_per_message: Annotated[
        int | None, Field(default=None, ge=1, le=50)
    ] = None

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
    #: Im Verzeichnis sichtbar (Entdecken-Bereich). Vorgabe aus.
    listed: bool = False
    category: str | None = None

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)


class DirectoryEntryOut(BaseModel):
    """Ein Eintrag im Community-Verzeichnis (``GET /c``).

    Traegt bewusst nur, was eine Karte im Entdecken-Bildschirm zeigt. Kein
    Owner, keine Kanaele, keine Einstellungen — das Verzeichnis ist eine
    Auslage, keine Auskunftsstelle.
    """

    id: int
    handle: str
    name: str
    icon_url: str | None = None
    category: str | None = None
    member_count: int

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)


class DirectoryOut(BaseModel):
    items: list[DirectoryEntryOut]


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
    # type=2 reserved for the per-guild dropbox channel (Ablage). Same id
    # space as text + voice, lives in its own sidebar section. The dropbox
    # route in routes/dropbox.py enforces SINGLETON semantics on create
    # (one dropbox channel per guild, renames via PATCH instead).
    type: Annotated[int, Field(ge=0, le=2)] = 0
    topic: Annotated[str | None, Field(default=None, max_length=1024)] = None
    position: int = 0
    # Ablage-Kanal (Konzept §2a): serverblind, Inhalte clientverschluesselt
    # auf dem Laufwerk des Erstellers. Im Instanz-Modus "ablage_only" ist
    # ablage=True Pflicht fuer die Neuanlage.
    ablage: bool = False


class ChannelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    guild_id: int
    name: str
    type: int
    # Ablage-Kanal (Konzept §2a) — serverblind, Inhalte clientverschluesselt.
    ablage: bool = False
    # Alt-Kanal eingefroren (Entwurf §9, Etappe E9) — lesbar, nicht mehr
    # beschreibbar. Bestand + Neuanlagen: False (Migration 0083).
    legacy_readonly: bool = False
    position: int
    topic: str | None
    created_at: datetime
    # Computed, not a column: true when the @everyone overwrite denies
    # VIEW_CHANNEL (channel only visible via explicit allows). Routes stamp
    # it onto the ORM instance before returning; defaults False otherwise.
    restricted: bool = False
    # Per-channel name styling (mirrors profile_color*). NULL = no styling.
    name_color: str | None = None
    name_color_secondary: str | None = None
    name_gradient_angle: int | None = None
    # Voice-Benutzerlimit: 0 = unbegrenzt, 1..99 = max. Teilnehmer.
    user_limit: int = 0

    @field_serializer("id", "guild_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


_HEX_COLOR = r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"


class ChannelPatchIn(BaseModel):
    name: Annotated[str | None, Field(default=None, min_length=1, max_length=64)] = None
    topic: Annotated[str | None, Field(default=None, max_length=1024)] = None
    # Per-channel name styling. Hex-only (value lands in client `style="…"`):
    # default=... sentinel so model_fields_set distinguishes "not sent" from
    # "set to null" (clearing the color). Same pattern as profile_color.
    name_color: Annotated[str | None, Field(default=..., pattern=_HEX_COLOR)] = None
    name_color_secondary: Annotated[str | None, Field(default=..., pattern=_HEX_COLOR)] = None
    name_gradient_angle: Annotated[int | None, Field(default=..., ge=0, le=360)] = None
    # Voice-Benutzerlimit (0 = unbegrenzt, 1..99). Nur bei Voice-Channels
    # wirksam; die Route ignoriert es für Nicht-Voice-Channels.
    user_limit: Annotated[int | None, Field(default=None, ge=0, le=99)] = None


class ChannelPositionIn(BaseModel):
    """One entry in a bulk channel-reorder request."""

    id: SnowflakeId
    position: Annotated[int, Field(ge=0, le=1000)]


class ChannelPositionsIn(BaseModel):
    positions: Annotated[list[ChannelPositionIn], Field(min_length=1, max_length=500)]


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
    # Angepinnt-Zeitstempel (Pinned Messages); None = nicht angepinnt.
    pinned_at: datetime | None = None
    reactions: list[ReactionAggregate] = []
    attachments: list[AttachmentOut] = []
    # Parsed at write-time from ``content``. Always present (empty list
    # for messages without mentions). See ``mentions.py`` for the parser.
    mentions: list[MentionRef] = []

    @field_serializer("id", "channel_id", "author_id", "reply_to_id")
    def _ser_ids(self, v: int | None) -> str | None:
        return _opt_id_str(v)


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
    #: Ausschnitt der letzten Nachricht fuer die Chats-Liste des Handys
    #: (Mobil-Umbau 2026-08-22). Bei einer Nachricht ohne Text, aber mit
    #: Anhang steht hier ein Marker (``__image__`` / ``__file__``), den der
    #: Klient uebersetzt — der Dateiname geht bewusst NICHT mit, siehe
    #: ``dm_vorschau.py``. Null, wenn es keine (oder eine geloeschte)
    #: letzte Nachricht gibt.
    last_message_preview: str | None = None
    last_message_author_id: int | None = None
    last_message_at: datetime | None = None

    @field_serializer("id", "other_user_id", "last_message_id", "last_message_author_id")
    def _ser_ids(self, v: int | None) -> str | None:
        return _opt_id_str(v)


class DMMessageSearchHit(BaseModel):
    """Ein Treffer der DM-Nachrichten-Suche (``GET /dm-channels-search``).

    **Existiert allein wegen der Snowflake-Serialisierung.** Die Route gab
    anfangs ein rohes ``dict`` zurück; damit gingen alle vier Kennungen als
    JSON-ZAHLEN über die Leitung, obwohl der Klient sie als Zeichenkette
    deklariert. Der Vergleich „habe ich das geschrieben?" war deshalb immer
    falsch (``number === string``), und die Kanal-Kennung verlor beim
    Umweg über ``Number`` ihre unteren Stellen — der Tipp auf einen Treffer
    öffnete nichts. Jede andere Antwort dieser Datei geht über ein Modell mit
    ``field_serializer``; diese nun auch.
    """

    model_config = ConfigDict(from_attributes=True)

    message_id: int
    dm_channel_id: int
    other_user_id: int
    author_id: int
    content: str
    created_at: datetime

    @field_serializer("message_id", "dm_channel_id", "other_user_id", "author_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


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
        return _opt_id_str(v)


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
        return _opt_id_str(v)


class InviteAcceptOut(BaseModel):
    guild: InviteGuildOut
    channel_id: int | None
    # Nur bei einer Einladung auf einen fremden Host gesetzt. Die Cloud legt
    # dort keine Mitgliedschaft an (sie hat auf dem Host keine) — sie reicht
    # Ziel und Code zurueck, und der Klient geht seinen normalen Beitrittsweg,
    # bei dem der Host den Code live prueft. Ein Server-zu-Server-Aufruf waere
    # sinnlos: die Cloud kann einen fremden Code gar nicht verifizieren.
    target_host: str | None = None
    code: str | None = None

    @field_serializer("channel_id")
    def _ser_channel(self, v: int | None) -> str | None:
        return _opt_id_str(v)


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
        return _opt_id_str(v)


# ---- Community-Invite-Broker (Stufe 2 / B-lite, cloud-only) ----------------


_MAX_COMMUNITY_INVITE_TTL = _MAX_INVITE_TTL  # same 30-day ceiling


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
        return _opt_id_str(v)


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

    ``channel_creation_policy`` (Konzept §2a): "regular" oder "ablage_only" —
    der Instanz-Modus fuer die Textkanal-Erstellung.

    The numeric ``guild_sound_max_size_bytes`` lives here because it's
    a public ceiling — any uploader needs to know it. The class name
    pre-dates the field and is mildly misleading; renaming would touch
    too many callers without payoff."""

    model_config = ConfigDict(from_attributes=True)
    channel_creation_policy: str = "regular"
    allow_guild_creation: bool
    allow_member_invites: bool
    # Self-Host "Server gesperrt" not-aus toggle. When true the instance refuses
    # every new join (community-invite grant + public address alike). Surfaced so
    # the admin UI can show/set it. Cloud ignores it (no gated cert-join).
    locked: bool
    # Instanzweiter Anzeigename (Self-Host) — NULL, wenn keiner gesetzt ist.
    instance_name: str | None = None
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
    # Instanzweiter Voice-Bitrate-Deckel (kbps); Guild-Override darf höher
    # liegen ("Boost"). Client: Slider-Max + Publish-Clamp.
    voice_bitrate_max_kbps: int


class CapabilitiesOut(PermissionsOut):
    """``/capabilities`` = the admin-editable flags above **plus** this
    instance's upload-surface policy.

    Deliberately a subclass rather than extra fields on ``PermissionsOut``:
    these three come from env (config.py), not from ``chat_settings``, so
    ``/admin/permissions`` must NOT carry them — its PATCH cannot write them
    and advertising them there would promise an admin toggle that isn't real.

    UX hint only: routes/attachments.py and the dropbox router gate enforce
    the same policy server-side regardless of what the client does with this.
    Permissive defaults keep clients talking to an older instance (which omits
    the fields) on today's behaviour."""

    dm_attachments_enabled: bool = True
    dropbox_enabled: bool = True
    # Allowed MIME prefixes for message attachments; empty = unrestricted.
    attachment_mime_prefixes: list[str] = []
    # Obergrenze eines VERSCHLUESSELTEN DM-Anhangs (Design §11.3,
    # ``ablage_anhang_max_bytes``) — dieselbe Zahl, die die Upload-Route
    # durchsetzt und die ``ablage_anhang_verteilung`` beim Weiterschieben
    # anlegt.
    #
    # **Der Verfasser liest sie NICHT hier**, sondern aus der Antwort von
    # ``GET /postfach/anhaenge/bereitschaft`` — derselben Auskunft, die den
    # Anhang-Knopf ueberhaupt freischaltet. Eine Grenze, die vor dem Knopf da
    # ist, brauchte niemand. Sie steht hier trotzdem, weil ``/capabilities``
    # der Ort ist, an dem eine Instanz ihre Einstellungen nennt, und weil
    # Oberflaechen ausserhalb des Verfassers (Einstellungsseite, Hinweise)
    # sie ohne Kanalbezug brauchen.
    ablage_anhang_max_bytes: int = 5 * 1024 * 1024


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

def _check_resolution(v: str | None, allowed: frozenset[str], field: str) -> str | None:
    if v is not None and v not in allowed:
        raise ValueError(f"{field} must be one of {sorted(allowed)}")
    return v


class PermissionsPatch(BaseModel):
    allow_guild_creation: bool | None = None
    allow_member_invites: bool | None = None
    # Self-Host "Server gesperrt" not-aus toggle.
    locked: bool | None = None
    # Instanzweiter Anzeigename. None = nicht ändern; Leerstring = zurücksetzen
    # (→ NULL, Clients zeigen wieder den Hostnamen). Max 60 Zeichen.
    instance_name: Annotated[str | None, Field(default=None, max_length=60)] = None
    # Bound: 4 KB floor (a 1-frame OGG is ~2 KB; below that = abuse),
    # 5 MB ceiling (anything larger isn't a "UI sound" anymore).
    guild_sound_max_size_bytes: Annotated[
        int | None, Field(default=None, ge=4096, le=5 * 1024 * 1024)
    ] = None
    # HQ-stream limits. Per-field bounds only here; the min<=max coherence
    # check happens in the route (a partial patch may set just one side, so
    # it must be validated against the stored row). Bitrate ceiling 32000
    # also respects the SmallInteger column (max 32767).
    hq_bitrate_min_kbps: Annotated[int | None, Field(default=None, ge=1000, le=100000)] = None
    hq_bitrate_max_kbps: Annotated[int | None, Field(default=None, ge=1000, le=100000)] = None
    hq_fps_min: Annotated[int | None, Field(default=None, ge=1, le=1000)] = None
    hq_fps_max: Annotated[int | None, Field(default=None, ge=1, le=1000)] = None
    hq_resolution_max: str | None = None
    # Normal-stream limits — own band; FPS ceiling 1000 (same wide band as HQ).
    ns_bitrate_min_kbps: Annotated[int | None, Field(default=None, ge=1000, le=100000)] = None
    ns_bitrate_max_kbps: Annotated[int | None, Field(default=None, ge=1000, le=100000)] = None
    ns_fps_min: Annotated[int | None, Field(default=None, ge=1, le=1000)] = None
    ns_fps_max: Annotated[int | None, Field(default=None, ge=1, le=1000)] = None
    ns_resolution_max: str | None = None
    # Webcam capture limits — FPS ceiling 60 (the camera path never exceeds it).
    cam_fps_max: Annotated[int | None, Field(default=None, ge=1, le=60)] = None
    cam_resolution_max: str | None = None
    # Instanzweiter Voice-Deckel; 512 = Slider-Maximum (Opus endet real bei 510).
    voice_bitrate_max_kbps: Annotated[int | None, Field(default=None, ge=16, le=512)] = None

    @field_validator("hq_resolution_max")
    @classmethod
    def _validate_hq_resolution(cls, v: str | None) -> str | None:
        return _check_resolution(v, ALLOWED_HQ_RESOLUTIONS, "hq_resolution_max")

    @field_validator("ns_resolution_max")
    @classmethod
    def _validate_ns_resolution(cls, v: str | None) -> str | None:
        return _check_resolution(v, ALLOWED_NS_RESOLUTIONS, "ns_resolution_max")

    @field_validator("cam_resolution_max")
    @classmethod
    def _validate_cam_resolution(cls, v: str | None) -> str | None:
        return _check_resolution(v, ALLOWED_CAM_RESOLUTIONS, "cam_resolution_max")


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
        return _opt_id_str(v)


# --- Owner (Cloud-operator) cloud-wide community oversight -------------------


class CommunityOut(BaseModel):
    """One community (guild) row in the owner's cloud-wide oversight list.

    Metadata only — never any chat content. ``owner_id`` is a numeric id; the
    Cloud username lives in auth-svc and is resolved on the frontend via the
    existing user cache (keeps this list a single chat-gateway round-trip)."""

    id: int
    name: str
    owner_id: int
    icon_url: str | None
    is_public: bool
    handle: str | None
    created_at: datetime
    member_count: int
    storage_bytes: int
    # Platform-suspension state. ``suspended`` is the frozen flag; the reason is
    # operator-only context (never shown to members).
    suspended: bool = False
    suspended_reason: str | None = None
    # Per-community quality caps (NULL = inherit the instance default). The
    # owner edits these in the expandable community panel.
    voice_bitrate_max_kbps: int | None = None
    stream_bitrate_max_kbps: int | None = None
    stream_fps_max: int | None = None
    stream_resolution_max: str | None = None
    # Storage caps. size/count always have a value (non-nullable columns); the
    # total quota is nullable (NULL = unlimited).
    # Obergrenzen (NULL = Instanz-Standard). Waren bis 0057 die Werte selbst,
    # weshalb sie damals nicht-nullable mit Zahl-Default standen.
    attachment_max_size_bytes: int | None = None
    attachment_max_count_per_message: int | None = None
    attachment_storage_quota_bytes: int | None = None
    # Scale caps (NULL = unlimited).
    max_members: int | None = None
    max_channels: int | None = None
    max_roles: int | None = None
    max_devices_per_owner: int | None = None
    max_concurrent_streams: int | None = None
    # Feature permission (not a cap): may this community use the Ablage?
    # False = the whole dropbox 404s for its members, regardless of what the
    # community's own admin has toggled.
    dropbox_allowed: bool = False
    # Operator ceiling for Ablage storage. NULL = the instance standard (1 GiB).
    # Separate pot from attachment_storage_quota_bytes (chat attachments).
    dropbox_quota_bytes: int | None = None

    @field_serializer("id", "owner_id")
    def _ser_ids(self, v: int) -> str:
        return _id_str(v)


class CommunityLimitsIn(BaseModel):
    """Owner-set per-community quality caps. Every field is a *ceiling* and
    NULL means "inherit the instance default" — the form always sends the full
    set, so NULL explicitly clears an override. ``stream_resolution_max`` uses
    the HQ resolution vocabulary ('Native' = uncapped); it is mapped down to the
    narrower screenshare/webcam ladders client-side."""

    voice_bitrate_max_kbps: Annotated[int | None, Field(default=None, ge=16, le=512)] = None
    stream_bitrate_max_kbps: Annotated[
        int | None, Field(default=None, ge=1000, le=100000)
    ] = None
    stream_fps_max: Annotated[int | None, Field(default=None, ge=1, le=1000)] = None
    stream_resolution_max: str | None = None
    # Storage. size/count: None = leave unchanged (non-nullable columns).
    # quota: None = unlimited (explicitly cleared). Bounds mirror GuildPatchIn.
    attachment_max_size_bytes: Annotated[
        int | None, Field(default=None, ge=1024, le=1024 * 1024 * 1024)
    ] = None
    attachment_max_count_per_message: Annotated[
        int | None, Field(default=None, ge=1, le=50)
    ] = None
    attachment_storage_quota_bytes: Annotated[
        int | None, Field(default=None, ge=1024 * 1024)
    ] = None
    # Scale caps. None = unlimited (always applied, like the quota).
    max_members: Annotated[int | None, Field(default=None, ge=1, le=1_000_000)] = None
    max_channels: Annotated[int | None, Field(default=None, ge=1, le=10000)] = None
    max_roles: Annotated[int | None, Field(default=None, ge=1, le=10000)] = None
    max_devices_per_owner: Annotated[int | None, Field(default=None, ge=1, le=10000)] = None
    max_concurrent_streams: Annotated[int | None, Field(default=None, ge=0, le=10000)] = None
    # Feature permission, not a cap: None = leave unchanged (non-nullable
    # column), so an older client that doesn't send the field can't silently
    # revoke the Ablage for a community it just edited the bitrate of.
    dropbox_allowed: bool | None = None
    # Ablage storage ceiling. Nullable column (NULL = instance standard), so —
    # like the quality caps — the form always sends it and NULL clears the
    # override. Floor of 1 MiB mirrors attachment_storage_quota_bytes.
    dropbox_quota_bytes: Annotated[int | None, Field(default=None, ge=1024 * 1024)] = None

    @field_validator("stream_resolution_max")
    @classmethod
    def _check_stream_resolution(cls, v: str | None) -> str | None:
        return _check_resolution(v, ALLOWED_HQ_RESOLUTIONS, "stream_resolution_max")


class SuspendCommunityIn(BaseModel):
    """Optional operator note when freezing a community. Not shown to members."""

    reason: Annotated[str | None, Field(default=None, max_length=500)] = None


class CommunityListOut(BaseModel):
    communities: list[CommunityOut]
    # Cursor for the next page: the id of the last row, or None when the page
    # was not full (no more rows). Mirrors the admin users list pagination.
    next_before: str | None = None


class OwnerReportedAttachment(BaseModel):
    """Attachment metadata on a reported message. No download URL — the bytes
    are deliberately withheld (mirrors the CSAM-safety precedent in
    ``routes/reports.py``); the owner sees *that* an attachment exists and its
    shape, not its content."""

    id: int
    filename: str | None
    mime: str | None
    size: int

    @field_serializer("id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)


class OwnerReportedContentOut(BaseModel):
    """Emergency-access view of a report's target message, owner-only.

    Bypasses normal member-only visibility so the Cloud operator can act on a
    complaint. Every fetch is audit-logged server-side."""

    report_id: int
    reason_code: str
    report_body: str
    status: str
    guild_id: int | None
    channel_id: int | None
    message_id: int | None
    author_id: int | None = None
    # Message fields — None when the report doesn't target a message (e.g. a
    # user/channel report) or the message row no longer exists at all.
    content: str | None = None
    message_created_at: datetime | None = None
    edited_at: datetime | None = None
    # True when the message was soft-deleted (moderators may have already
    # removed it) — the owner still sees the content for the record.
    deleted: bool = False
    attachments: list[OwnerReportedAttachment] = Field(default_factory=list)

    @field_serializer("report_id")
    def _ser_report_id(self, v: int) -> str:
        return _id_str(v)

    @field_serializer("guild_id", "channel_id", "message_id", "author_id")
    def _ser_opt_ids(self, v: int | None) -> str | None:
        return _opt_id_str(v)


# ---------------------------------------------------------------------------
# Geraete-Schluesselverzeichnis (Etappe B, E2E-DM)
# ---------------------------------------------------------------------------


#: Die Geraetekennung im Anfrage-Rumpf (Base64url eines Ed25519-Pubkeys, in
#: der Praxis 43 Zeichen). **Selbstbehauptet** — geprueft wird nicht, dass der
#: Aufrufer dieses Geraet IST, sondern nur, dass es zu seinem Konto gehoert
#: (``schluessel_nachweis.py::pruefe_geraet``, dort auch, was das kostet).
#: Die Laengengrenzen halten bloss Unsinn aus der Tabelle, sie sind keine
#: Formatpruefung: ein zu langer Wert soll gar nicht erst in eine Abfrage
#: geraten.
GeraeteKennung = Annotated[str, Field(min_length=16, max_length=128)]


class BundleVeroeffentlichenRequest(BaseModel):
    """Rumpf von ``PUT /keys/bundle``."""

    #: Welches Geraet dieses Buendel veroeffentlicht. Beim ALLERERSTEN
    #: Veroeffentlichen gibt es dazu noch keine Zeile — die Bindung an das
    #: Konto entsteht genau hier, s. ``routes/schluessel.py``.
    device_pubkey: GeraeteKennung
    curve25519: str
    rueckfallschluessel: str | None = None
    #: Selbstauskunft des Geraets — Electron- oder Android-App (Spec §3,
    #: Koexistenz-Regel). Das Geraet kann diese Aussage nur ueber SICH SELBST
    #: treffen (die Zeile gehoert ueber ``pruefe_geraet`` ohnehin schon zum
    #: eigenen Konto, ein Dritter kann sie nicht fuer ein fremdes Geraet
    #: setzen), eine falsche Angabe schwaecht also hoechstens die eigene
    #: Kontohistorie, nie die eines anderen Kontos. Vorgabe ``False`` (Modell,
    #: nicht hier) — ein Geraet, das das Feld nicht mitschickt, gilt als
    #: nicht dauerhaft.
    dauerhaft: bool = False


class EinmalschluesselHinzufuegenRequest(BaseModel):
    """Rumpf von ``POST /keys/onetime``."""

    device_pubkey: GeraeteKennung
    schluessel: list[str] = Field(min_length=1)


class EinmalschluesselVorratOut(BaseModel):
    vorrat: int


class SchluesselAbholenRequest(BaseModel):
    """Rumpf von ``POST /keys/claim``."""

    user_ids: Annotated[list[SnowflakeId], Field(min_length=1, max_length=64)]


class GeraeteSchluesselOut(BaseModel):
    """Ein Buendel in der Antwort von ``POST /keys/claim``.

    Genau EINES der beiden Felder ``einmalschluessel``/``rueckfallschluessel``
    ist gesetzt — nie beide, nie keines (ein Buendel ohne jeden Schluessel
    wird gar nicht erst in die Liste aufgenommen).
    """

    device_pubkey: str
    curve25519: str
    einmalschluessel: str | None = None
    rueckfallschluessel: str | None = None
    #: Wie ``BundleVeroeffentlichenRequest.dauerhaft`` — durchgereicht aus
    #: ``DeviceKeyBundle.dauerhaft``, Grundlage der Koexistenz-Regel im
    #: Klienten (``web/src/lib/krypto/empfaengerGeraete.ts``).
    dauerhaft: bool = False
    #: Ob dieses Geraet per Kopplungscode gebunden wurde
    #: (``DeviceKeyBundle.gekoppelt_am is not None``, Spec §3a). Ein
    #: gekoppelter Browser zaehlt im Klienten wie eine App — ohne dieses Feld
    #: saehe der Sendeweg ihn als losen Tab und verweigerte die Nachricht,
    #: waehrend ``GET /keys/verschluesselbar`` sie zusagt. Genau diese
    #: Zwiespaeltigkeit zwischen Zusage und Sendeweg ist im Klartext-Rueckfall
    #: schon einmal teuer geworden.
    gekoppelt: bool = False


class GeraeteStandOut(BaseModel):
    """Antwort von ``GET /keys/geraetestand`` — der Stand des EIGENEN Geraets.

    Drei Werte, und der Unterschied zwischen den letzten beiden ist der Kern
    der ganzen Route (Spec §3a, Punkt 2):

    * ``gueltig`` — das Buendel steht und ist nicht verfallen.
    * ``verfallen`` — dieses Geraet ist abgelaufen. **Nur dieser Wert darf den
      Klienten seinen lokalen Verlauf loeschen lassen**, und er sagt es
      ausdruecklich, statt es aus einer Abwesenheit ableiten zu lassen.
    * ``entfernt`` — der Kontoinhaber hat dieses Geraet aus seiner
      Geraeteliste geworfen (Spec §3b Punkt 4, ``geraete_widerruf.py``).
      **Loescht ebenfalls**, und ist trotzdem ein eigener Wert statt eines
      zweiten ``verfallen``: der Klient sagt dem Nutzer, WAS geschehen ist,
      und „abgelaufen" waere an einem gerade eben entfernten Geraet schlicht
      falsch.
    * ``unbekannt`` — fuer diesen ``device_pubkey`` gibt es kein Buendel. Das
      ist der frische Browser (nichts zu loeschen), aber auch die durch die
      Geraete-Obergrenze verdraengte Zeile — zwei Faelle, die man nicht
      auseinanderhalten kann und die deshalb NICHTS ausloesen duerfen.

    **Warum kein vierter Wert fuer „entfernt UND verfallen".** Beides kann
    zugleich zutreffen; die Route antwortet dann ``entfernt``, weil das der
    Grund ist, den der Nutzer selbst gesetzt hat. Fuer die Folge — Verlauf
    loeschen — sind die beiden ohnehin gleich.
    """

    stand: Literal["gueltig", "verfallen", "entfernt", "unbekannt"]


class EigenesGeraetOut(BaseModel):
    """Eine Zeile der eigenen Geraeteliste (``GET /keys/geraete``).

    **Kein Geraetename, und das ist eine Entscheidung, keine Luecke** (Spec
    §3b Punkt 4). Ein Name waere eine Selbstauskunft des Geraets — genau des
    Geraets also, das man moeglicherweise gerade herauswerfen will. Er wuerde
    die eine Frage, fuer die es diese Liste gibt („steht hier etwas, das ich
    nicht kenne?"), nicht leichter machen, sondern schwerer: ein fremder
    Eintrag, der sich „Michaels Laptop" nennt, faellt weniger auf als einer
    ohne Namen.

    Was stattdessen unterscheidet, ist ueberpruefbar: die Art (App oder
    Browser), die Zeitpunkte — und die Kennung selbst, die das Geraet auch bei
    sich anzeigen kann. Wer wissen will, ob eine Zeile sein Laptop ist, sieht
    auf dem Laptop nach.
    """

    #: Die Geraetekennung im Klartext. Sie ist ein OEFFENTLICHER Schluessel und
    #: im Freundeskreis ohnehin ueber ``POST /keys/claim`` abholbar — hier
    #: dient sie als vergleichbares Erkennungsmerkmal und als das, worauf sich
    #: ``DELETE /keys/geraete`` bezieht.
    device_pubkey: str
    #: Selbstauskunft des Geraets (App vs. Browser), s.
    #: ``BundleVeroeffentlichenRequest.dauerhaft``. Fuer die Anzeige gedacht,
    #: nicht als Beleg.
    dauerhaft: bool
    #: Wann dieses Geraet per Kopplungscode gebunden wurde — vom Server
    #: gesetzt, also belastbar. ``None`` = nie gekoppelt.
    gekoppelt_am: datetime | None
    #: Wann die Zeile entstand, also wann dieses Geraet zum ersten Mal
    #: Schluessel veroeffentlicht hat (``DeviceKeyBundle.created_at``).
    hinzugefuegt_am: datetime
    #: Letzter Geraete-Nachweis, grob auf eine Stunde aufgeloest
    #: (``schluessel_nachweis.py``) — das „lebt noch"-Signal.
    zuletzt_benutzt: datetime
    #: Ob dieses Geraet abgelaufen ist (Spec §3a). Vom Server aus DERSELBEN
    #: SQL-Regel berechnet wie ``GET /keys/geraetestand`` — der Klient soll
    #: die Verfallsrechnung nicht ein zweites Mal nachbauen.
    verfallen: bool


class VerschluesselbarOut(BaseModel):
    """Antwort von ``GET /keys/verschluesselbar/{ziel_id}``.

    Bewusst nur ein Bit. Die Geraeteliste des Ziels gehoert NICHT hierher —
    fuer ein Schloss im Kopf des Gespraechs braucht sie niemand, und jedes
    zusaetzliche Feld waere Metadaten, die ``POST /keys/claim`` nur gegen
    Vorratsverbrauch herausgibt. Wer die LISTE braucht (und nur sie), nimmt
    ``POST /keys/geraeteliste``.
    """

    verschluesselbar: bool


class GeraetelisteRequest(BaseModel):
    """Rumpf von ``POST /keys/geraeteliste`` — dieselbe Form wie ``claim``."""

    user_ids: Annotated[list[SnowflakeId], Field(min_length=1, max_length=64)]


# ---------------------------------------------------------------------------
# Postfach — Einliefern verschluesselter Umschlaege (Etappe D, E2E-DM)
# ---------------------------------------------------------------------------


class PostfachNutzlastIn(BaseModel):
    """Ein Umschlag innerhalb von ``POST /postfach``.

    ``empfaenger`` traegt die Geraete-Pubkeys, fuer die diese Nutzlast
    verschluesselt wurde — bei einer DM meist eines, bei einer kuenftigen
    Gruppe (Megolm) mehrere, weil dieselbe Nutzlast fuer alle gilt.
    """

    art: int
    #: Base64 — dasselbe Format wie ``daten`` auf ``DmNutzlast``.
    daten: str
    #: Obergrenze wie bei ``user_ids`` weiter unten (max_length=64) — eine
    #: DM braucht heute meist eines. Ohne Obergrenze koennte ein einzelner
    #: Umschlag beliebig viele Zustellungszeilen erzwingen.
    #:
    #: **Fuer eine Megolm-Gruppe reichen 64 nicht zwangslaeufig**, und die
    #: fruehere Fassung dieses Kommentars behauptete das Gegenteil: sie hielt
    #: die Zahl gegen ``private_group_max_members`` (Vorgabe 50). Gezaehlt
    #: werden hier aber GERAETE, nicht Mitglieder — je Konto bis zu
    #: ``schluessel_max_buendel_je_konto`` (Vorgabe 20). Der Klient teilt
    #: eine grosse Gruppe deshalb in mehrere Nutzlasten mit demselben
    #: ``daten``-Wert auf (``web/src/lib/krypto/gruppe/senden.ts``); die
    #: Grenze bleibt, weil sie die Zustellungszeilen je Nutzlast deckelt,
    #: nicht die Gruppengroesse.
    empfaenger: list[str] = Field(min_length=1, max_length=64)
    #: Soll dieser Umschlag zusaetzlich im Kanal-Ordner festgehalten werden
    #: (Entwurf 2026-09-02, §2-3)? Wirkt nur in einem Ordner-Kanal; ob der
    #: Kanal einer ist, fragt die Route EINMAL je Anfrage
    #: (``_postfach_festigung.py``). Vorgabe ``False``: ein normaler
    #: DM-Umschlag hat gar keinen Ordner, dem er zugehoert.
    #:
    #: **Der Klient markiert ALLE Bloecke einer Gruppennachricht**, nicht nur
    #: den ersten (sonst haenge die Festigung daran, dass ausgerechnet dieser
    #: Block Empfaenger findet). Der Server legt trotzdem nur EINE Datei an —
    #: dedupliziert ueber ``sha256(daten)`` innerhalb der Anfrage.
    archiv: bool = False


class PostfachEinliefernRequest(BaseModel):
    """Rumpf von ``POST /postfach``."""

    channel_id: SnowflakeId
    #: Welches Geraet einliefert — es traegt seinen Curve25519-Schluessel in
    #: jede angelegte Nutzlast (``routes/postfach.py``), damit ein Empfaenger
    #: eine frische Olm-Sitzung aufbauen kann. Muss zum angemeldeten Konto
    #: gehoeren (``schluessel_nachweis.py``).
    device_pubkey: GeraeteKennung
    nutzlasten: list[PostfachNutzlastIn] = Field(min_length=1)
    #: Verschluesselte Anhaenge dieser Nachricht (Etappe E) — die Kennungen
    #: aus ``POST /postfach/anhaenge/upload-url``. Sie stehen HIER und nicht
    #: je Nutzlast, weil alle Nutzlasten einer Einlieferung dieselbe
    #: Nachricht sind, nur je Empfaengergeraet verschluesselt; der
    #: Dateischluessel steckt in jedem einzelnen Umschlag.
    #: Obergrenze wie ``dm_attachment_max_count_per_message`` (Vorgabe 4),
    #: bewusst mit Luft nach oben — die scharfe Grenze zieht die
    #: Groessenpruefung beim Hochladen.
    anhaenge: list[SnowflakeId] = Field(default_factory=list, max_length=16)


class PostfachEinliefernResponse(BaseModel):
    """Antwort von ``POST /postfach`` — ersetzt das vorherige blosse ``204``.

    Ein einzelner Empfaenger darf uebersprungen werden (unbekanntes Buendel,
    Kontingent voll), OHNE dass die Anfrage scheitert — aber wenn das fuer
    ALLE Empfaenger einer Nutzlast gilt, entsteht nirgends eine Zeile. Ein
    unbedingtes ``204`` liesse den Absender glauben, die Nachricht sei
    zugestellt, obwohl sie nirgends existiert (Bughunt 2026-08-28, FIX 1).
    """

    #: Ueber die ganze Anfrage hinweg tatsaechlich angelegte Zustellungen.
    zustellungen_angelegt: int
    #: Geraete-Pubkeys, die in mindestens einer Nutzlast als Empfaenger
    #: angefragt, aber NICHT beliefert wurden — dedupliziert ueber die ganze
    #: Anfrage. Kein Fehler fuer sich, nur eine ehrliche Auskunft.
    uebersprungene_empfaenger: list[str]
    #: Anzahl der Nutzlasten, fuer die ÜBERHAUPT KEINE Zustellung entstand
    #: (alle angefragten Empfaenger uebersprungen) — der Fall, den der
    #: Absender NICHT als Erfolg lesen darf.
    verworfene_nutzlasten: int


# ---------------------------------------------------------------------------
# Private Gruppen (Etappe G1, die Kanal-Haelfte) — ohne Krypto, ohne UI.
# ---------------------------------------------------------------------------


class PrivateGroupCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class PrivateGroupMemberOut(BaseModel):
    user_id: int
    beigetreten_am: datetime

    @field_serializer("user_id")
    def _ser_user_id(self, v: int) -> str:
        return _id_str(v)


class PrivateGroupOut(BaseModel):
    """Wire-Darstellung eines privaten Gruppenkanals samt Mitgliederliste —
    die Mitgliederzahl ist klein genug (Obergrenze
    ``private_group_max_members``), dass ein Sub-Query je Antwort keine
    Sorge ist, anders als bei einer Community mit Rollen/Overwrites."""

    id: int
    ersteller_id: int
    name: str
    created_at: datetime
    last_message_id: int | None = None
    members: list[PrivateGroupMemberOut]

    @field_serializer("id", "ersteller_id", "last_message_id")
    def _ser_ids(self, v: int | None) -> str | None:
        return _opt_id_str(v)


class PrivateGroupMemberAddIn(BaseModel):
    user_id: SnowflakeId


# ---------------------------------------------------------------------------
# Postfach — Abholen und Quittieren (Etappe D, Task 3)
# ---------------------------------------------------------------------------


class PostfachAbholenRequest(BaseModel):
    """Rumpf von ``POST /postfach/abholen`` — welches Geraet fragt.

    Ein Umschlag ist fuer genau ein Empfaengergeraet verschluesselt; ohne
    diese Angabe kennt der Server nur das KONTO und wuesste nicht, welche
    Zustellungen gemeint sind.
    """

    device_pubkey: GeraeteKennung


class PostfachZustellungOut(BaseModel):
    """Eine offene Zustellung in der Antwort von ``POST /postfach/abholen``.

    ``channel_id`` MUSS mitgegeben werden — ohne sie kann der Klient nicht
    wissen, zu welchem Gespraech eine Zustellung gehoert, und weder die
    richtige Olm-Sitzung (Schluessel ist Kanal+Geraet, s.
    ``web/src/lib/krypto/sitzungsschluessel.ts``) noch den richtigen
    lokalen Verlaufseintrag treffen.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    channel_id: int
    absender_device_pubkey: str
    #: Fuer einen frischen Sitzungsaufbau noetig (Olm braucht ihn als eigenes
    #: Argument, s. Migration 0069) — ``None``, wenn das einliefernde Geraet
    #: zum Zeitpunkt des Einlieferns kein Buendel veroeffentlicht hatte.
    absender_curve25519: str | None = None
    #: Vom Server aus ``DeviceKeyBundle.user_id`` (join ueber
    #: ``absender_device_pubkey``) hergeleitet — der Klient kann das NICHT
    #: selbst bestimmen: er kennt zu einer Zustellung nur den Kanal, und eine
    #: verschluesselte DM liefert auch an die EIGENEN anderen Geraete des
    #: Senders aus (so kommt eine vom Handy gesendete Nachricht auf dem
    #: Desktop an) — "Kanal-Gegenpart" ist in diesem Fall die FALSCHE
    #: Zuschreibung. ``None``, wenn das Sendegeraet sich zwischen Einliefern
    #: und Abholen abgemeldet und sein Buendel damit geloescht hat; der
    #: Klient faellt dann auf den bisherigen Kanal-Gegenpart zurueck
    #: (``web/src/lib/krypto/empfangen.ts``) statt abzustuerzen.
    absender_user_id: int | None = None
    #: 0 = Sitzungsaufbau, 1 = laufende Nachricht — wie ``PostfachNutzlastIn.art``.
    art: int
    #: Base64, wie ``PostfachNutzlastIn.daten``.
    daten: str
    groesse: int
    #: Wann der Umschlag beim Server einging (``DmNutzlast.created_at``,
    #: server-seitig gesetzt). ``None`` nur fuer Zustellungen, die dieses
    #: Feld noch nicht kannten (Kompatibilitaet — es gibt keine Migration,
    #: die alte Zeilen nachtraegt, ausserhalb der DB-Spalte existiert nichts
    #: davon). Fuer den Ordner-Verlauf (``ablage_kanal_ordner.py::datei_inhalt``,
    #: dasselbe Modell) ist das der einzige Anhaltspunkt fuer das ECHTE
    #: Sendedatum — ohne dieses Feld setzte der Klient dort das Lesedatum
    #: ein (Entwurf §2, Befund 2026-09-03).
    created_at: datetime | None = None

    @field_serializer("id", "channel_id")
    def _ser_id(self, v: int) -> str:
        return _id_str(v)

    @field_serializer("absender_user_id")
    def _ser_absender_user_id(self, v: int | None) -> str | None:
        return _opt_id_str(v)


class PostfachAnhangUploadIn(BaseModel):
    """Rumpf von ``POST /postfach/anhaenge/upload-url`` (Etappe E).

    **Der Gegensatz zu ``AttachmentUploadIn`` ist der Punkt dieser Etappe:**
    kein ``filename``, kein ``mime``, keine ``width``/``height``. Der Server
    speichert davon nichts, also nimmt er es auch nicht entgegen — ein Feld,
    das nur weggeworfen wird, waere eine Einladung, es spaeter doch
    abzulegen. Was der Empfaenger zum Anzeigen braucht (Name, Typ, Maße,
    Vorschaubild), reist verschluesselt in der Nachricht mit (Spec §5).
    """

    channel_id: SnowflakeId
    #: Groesse des VERSCHLUESSELTEN Klumpens, wie er hochgeladen wird.
    size: Annotated[int, Field(ge=1, le=4 * 1024**4)]
    has_thumb: bool = False
    thumb_size: int | None = None


class PostfachAnhangAbrufIn(BaseModel):
    """Rumpf von ``POST /postfach/anhaenge/{id}/abrufadresse`` (Etappe E).

    Welches Geraet fragt — das angemeldete Konto allein genuegt als
    Zeilenwahl nicht: ein Anhang ist ueber die Zustellung an ein EINZELNES
    Geraet berechtigt (``postfach_anhaenge.py::darf_anhang_abrufen``).
    """

    device_pubkey: GeraeteKennung


class PostfachQuittungRequest(BaseModel):
    """Rumpf von ``POST /postfach/quittung``."""

    device_pubkey: GeraeteKennung
    zustellung_ids: list[SnowflakeId] = Field(min_length=1)
