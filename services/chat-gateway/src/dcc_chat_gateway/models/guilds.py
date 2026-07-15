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
