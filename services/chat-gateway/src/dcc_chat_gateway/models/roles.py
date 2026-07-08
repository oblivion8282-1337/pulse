"""Role-based permission tables (added in migration 0009).

Resolver lives in ``dcc_shared.permission_resolver`` — the bitfield
layout in ``dcc_shared.permissions.Permissions``. Wire format sends
permission bitfields as strings (snowflake-style) so frontends are
safe to handle the upper bits.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    SmallInteger,
    String,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


class Role(Base):
    """A guild role.

    Exactly one row per guild has ``is_everyone=true`` (enforced by a
    partial unique index in the migration). The @everyone role is
    auto-created when a guild is created and seeded for all existing
    guilds by migration 0009. It cannot be deleted; its position is
    always 0; its permissions are editable but the @everyone-ness is
    immutable.

    ``permissions`` is a 64-bit signed integer storing a
    ``dcc_shared.permissions.Permissions`` bitfield. We send the value
    as a string over the wire (snowflake-style) so the frontend can
    safely handle bits past 2^53.
    """

    __tablename__ = "roles"

    id: Mapped[int] = snowflake_pk()
    guild_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("guilds.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    permissions: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    color: Mapped[int | None] = mapped_column(Integer, nullable=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    hoist: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    mentionable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    is_everyone: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_roles_guild_position", "guild_id", "position"),)


class MemberRole(Base):
    """Membership row pairing a guild_member with a role.

    The composite FK back to ``guild_members(guild_id, user_id)`` ensures
    a member cannot hold roles in a guild they're no longer in — the
    CASCADE wipes their role assignments when they leave or get kicked.
    """

    __tablename__ = "member_roles"

    guild_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    role_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("roles.id", ondelete="CASCADE"), nullable=False
    )

    __table_args__ = (
        PrimaryKeyConstraint("guild_id", "user_id", "role_id"),
        Index("ix_member_roles_user", "guild_id", "user_id"),
        # Backs the large-guild VIEW_CHANNEL path, which resolves
        # ``WHERE guild_id = :g AND role_id IN (:overwrite_roles)`` — the
        # existing indexes lead with ``(guild_id, user_id)`` and can't serve
        # a leading-``role_id`` lookup.
        Index("ix_member_roles_role", "guild_id", "role_id"),
    )


class PermissionOverwrite(Base):
    """Per-channel permission overwrite layered on top of guild perms.

    ``target_type`` is 0 (role) or 1 (user) — kept as a small int rather
    than a Postgres enum so we can ``ON CONFLICT`` cleanly from app code
    and so the values are stable across services without schema sharing.

    ``allow_bf`` and ``deny_bf`` are independent bitfields. A bit set in
    both means deny wins (Stoatchat applies allow first, deny second).
    Validation against the editor's own permissions happens in the
    route layer (anti-privilege-escalation).
    """

    __tablename__ = "permission_overwrites"

    channel_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    target_type: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    target_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    allow_bf: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    deny_bf: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )

    __table_args__ = (
        PrimaryKeyConstraint("channel_id", "target_type", "target_id"),
        CheckConstraint(
            "target_type IN (0, 1)", name="ck_permission_overwrites_target_type"
        ),
    )
