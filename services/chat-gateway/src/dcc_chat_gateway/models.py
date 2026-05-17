"""SQLAlchemy models for the chat-gateway."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk

CHANNEL_TYPE_TEXT = 0
CHANNEL_TYPE_VOICE = 1


class Guild(Base):
    __tablename__ = "guilds"

    id: Mapped[int] = snowflake_pk()
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    icon_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Channel(Base):
    __tablename__ = "channels"

    id: Mapped[int] = snowflake_pk()
    guild_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("guilds.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    type: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=CHANNEL_TYPE_TEXT)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    topic: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_channels_guild_position", "guild_id", "position"),)


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


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = snowflake_pk()
    # No FK on channel_id: it polymorphically references either Channel.id
    # (guild channels) or DirectMessageChannel.id. Cascade-on-channel-delete
    # is handled in routes/channels.py::delete_channel.
    channel_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    author_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    nonce: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reply_to_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (Index("ix_messages_channel_id_desc", "channel_id", "id"),)


class MessageReaction(Base):
    __tablename__ = "message_reactions"

    message_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("messages.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    emoji: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        PrimaryKeyConstraint("message_id", "user_id", "emoji"),
        Index("ix_message_reactions_message", "message_id"),
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


class DirectMessageChannel(Base):
    """1:1 direct-message channel between two users.

    The (user_a_id, user_b_id) pair is stored sorted (a < b, enforced by
    CHECK + UNIQUE) so that "A↔B" and "B↔A" map to the same row — no
    duplicate channels possible.

    The ``id`` is a snowflake from the same generator as guild channels,
    so it's globally unique across both channel kinds — Message.channel_id
    can polymorphically point at either.
    """

    __tablename__ = "direct_message_channels"

    id: Mapped[int] = snowflake_pk()
    user_a_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    user_b_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Bumped on every new message; used to sort the DM list by recency.
    last_message_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    __table_args__ = (
        CheckConstraint("user_a_id < user_b_id", name="ck_dm_channels_sorted"),
        UniqueConstraint("user_a_id", "user_b_id", name="uq_dm_channels_pair"),
        Index("ix_dm_channels_user_a", "user_a_id"),
        Index("ix_dm_channels_user_b", "user_b_id"),
    )
