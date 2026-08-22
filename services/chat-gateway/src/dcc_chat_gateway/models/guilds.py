"""Guild + membership + invite tables."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    SmallInteger,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


class Guild(Base):
    __tablename__ = "guilds"

    id: Mapped[int] = snowflake_pk()
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    icon_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Per-guild attachment limits. DM channels use the chat_settings row;
    # guild channels use these. Owner edits both via the admin / settings UIs.
    attachment_max_size_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="26214400"  # 25 MB
    )
    attachment_max_count_per_message: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="4"
    )
    # Public community address (Stufe 4). ``handle`` is the stable vanity slug
    # (``<host>/c/<handle>``); ``is_public`` is the gate that makes the address
    # actually resolve (preview + public join). A handle can exist while
    # ``is_public`` is false — toggling back to private keeps the handle stable
    # so the same address works on re-activation. ``handle`` is unique *per
    # instance* (the partial unique index below; NULLs are not constrained).
    is_public: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
    handle: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Verzeichnis-Listung (Entdecken-Bereich, Mobil-Umbau 2026-08-22).
    #
    # **Bewusst getrennt von ``is_public``.** Eine oeffentliche Adresse heisst
    # „wer den Link kennt, kommt rein"; eine Listung heisst „ich moechte
    # gefunden werden". Das sind zwei verschiedene Zustimmungen, und die
    # Migration setzt deshalb NUR die Vorgabe ``false`` ohne Nachziehen — keine
    # bestehende oeffentliche Community landet ungefragt im Schaufenster.
    # ``listed`` ohne ``is_public`` ist sinnlos und wird in der Route
    # abgelehnt; ein Zuruecknehmen von ``is_public`` raeumt die Listung mit.
    listed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
    # Feste Liste im Code (``COMMUNITY_CATEGORIES``) statt freier Schlagworte —
    # die Filter-Chips des Verzeichnisses zeigen genau diese.
    category: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Platform-suspension by the Cloud operator (owner). When set, the whole
    # community is frozen: members lose access (send/react/voice/stream/read)
    # until it's unsuspended — the ``GuildMember`` rows are kept (reversible,
    # unlike a ban). Only global admins/operators bypass the freeze so they can
    # still inspect + unfreeze. NULL = active. ``suspension_reason`` is optional
    # operator context, not shown to members.
    suspended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    suspension_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Per-community quality caps (Boost/Tarif foundation). NULL = inherit the
    # instance-wide default (chat_settings singleton); a set value overrides it
    # for THIS community — also higher than the default (= a paid boost). Set
    # ONLY by the Cloud operator via /owner/communities/{id}/limits, never by the
    # community's own owner. Applied as ceilings client-side (best-effort, like
    # the instance caps) at stream/voice publish time.
    voice_bitrate_max_kbps: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    stream_bitrate_max_kbps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    stream_fps_max: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    stream_resolution_max: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Total live (non-deleted) chat-attachment storage cap for this community,
    # in bytes. NULL = unlimited. Server-enforced at the upload-URL request
    # (413 when used + new file would exceed it). The Cloud operator sets it;
    # the biggest un-bypassable cost lever (attachments were previously
    # unbounded in aggregate). Dropbox has its own separate quota.
    attachment_storage_quota_bytes: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    # Per-community scale caps (Boost). NULL = unlimited. Server-enforced with a
    # count-check before the relevant insert. Members: the guild owner's own
    # membership is exempt (always gets in). Roles: the auto-seeded @everyone
    # role does not count. Set only by the Cloud operator.
    max_members: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_channels: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    max_roles: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    max_devices_per_owner: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    # Best-effort cap on concurrent live HQ streams in the community. NULL =
    # unlimited. Checked at stream-token issuance against the (poller-maintained,
    # eventually-consistent) live-stream state — catches steady-state over-limit;
    # a rapid burst can briefly exceed it (documented).
    max_concurrent_streams: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    # May this community use the Ablage (dropbox) at all? The *permission*
    # layer, set ONLY by the instance operator via /owner/communities/{id}/
    # limits. Deliberately separate from ``dropbox_configs.enabled``, which is
    # the community's own on/off switch (MANAGE_GUILD) — without this column an
    # operator ban would be reversible by the very owner it targets. Effective
    # availability = instance default (CLOUD_DROPBOX_ENABLED, Cloud only)
    # AND this flag AND the community's own ``enabled``.
    #
    # Defaults to False for existing rows too (migration 0056): the Ablage takes
    # arbitrary file types that no hash-match can inspect, so it is opt-in per
    # community — same spirit as ``allow_guild_creation``.
    dropbox_allowed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false", default=False
    )
    # Operator ceiling for this community's Ablage storage, in bytes.
    # NULL = the instance standard (``DEFAULT_DROPBOX_QUOTA_BYTES``, 1 GiB).
    #
    # The community keeps its own ``dropbox_configs.total_quota_bytes`` and may
    # pick a SMALLER value; on save it is clamped to this ceiling. Without this
    # column that setting is MANAGE_GUILD-editable and therefore unbounded.
    #
    # Distinct from ``attachment_storage_quota_bytes``, which counts chat
    # attachments only — the Ablage has always had its own pot.
    dropbox_quota_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # ---- Werte der Community (Migration 0057) -------------------------------
    # Gegenstück zu den Obergrenzen darüber: was die Community-Leitung
    # (MANAGE_GUILD) für sich selbst gewählt hat. Beim Speichern auf die
    # Obergrenze geklemmt — siehe ``guild_limits.py``, das die Paarungen an
    # einer Stelle führt. NULL = nicht gesetzt, dann gilt die Obergrenze.
    community_voice_bitrate_kbps: Mapped[int | None] = mapped_column(
        SmallInteger, nullable=True
    )
    community_stream_bitrate_kbps: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    community_stream_fps: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    community_stream_resolution: Mapped[str | None] = mapped_column(
        String(16), nullable=True
    )
    community_max_members: Mapped[int | None] = mapped_column(Integer, nullable=True)
    community_max_channels: Mapped[int | None] = mapped_column(
        SmallInteger, nullable=True
    )
    community_max_roles: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    community_max_devices_per_owner: Mapped[int | None] = mapped_column(
        SmallInteger, nullable=True
    )
    community_max_concurrent_streams: Mapped[int | None] = mapped_column(
        SmallInteger, nullable=True
    )
    community_attachment_storage_quota_bytes: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    # Umgekehrter Fall: bei diesen beiden IST die Spalte oben schon der Wert der
    # Community (sie wird an der Upload-Schranke gelesen und war immer
    # MANAGE_GUILD-editierbar), also fehlte hier die Obergrenze.
    attachment_max_size_ceiling_bytes: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    attachment_max_count_ceiling: Mapped[int | None] = mapped_column(
        SmallInteger, nullable=True
    )

    __table_args__ = (
        # Per-instance handle uniqueness. Partial (WHERE handle IS NOT NULL) so
        # the many guilds without a handle don't collide on NULL. Postgres
        # treats NULLs as distinct anyway, but the partial predicate makes the
        # intent explicit and keeps the index small.
        Index(
            "uq_guilds_handle",
            "handle",
            unique=True,
            postgresql_where=text("handle IS NOT NULL"),
            sqlite_where=text("handle IS NOT NULL"),
        ),
    )


class GuildMember(Base):
    __tablename__ = "guild_members"

    guild_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("guilds.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    nickname: Mapped[str | None] = mapped_column(String(64), nullable=True)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        PrimaryKeyConstraint("guild_id", "user_id"),
        Index("ix_guild_members_user", "user_id"),
    )


class GuildBan(Base):
    """Per-guild ban entry. Existence of a row blocks any membership
    creation for that ``(guild_id, user_id)``; an existing member gets
    their ``guild_members`` row deleted in the same transaction so the
    ban is effective immediately."""

    __tablename__ = "guild_bans"

    guild_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("guilds.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    banned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    banned_by_id: Mapped[int] = mapped_column(BigInteger, nullable=False)

    __table_args__ = (
        PrimaryKeyConstraint("guild_id", "user_id"),
        Index("ix_guild_bans_user", "user_id"),
    )


class GuildInvite(Base):
    __tablename__ = "guild_invites"

    code: Mapped[str] = mapped_column(String(16), primary_key=True)
    guild_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("guilds.id", ondelete="CASCADE"), nullable=False
    )
    channel_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("channels.id", ondelete="SET NULL"), nullable=True
    )
    creator_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    max_uses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    uses: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0", default=0)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (Index("ix_guild_invites_guild", "guild_id"),)
