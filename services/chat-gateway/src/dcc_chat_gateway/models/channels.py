"""Channel + DirectMessageChannel tables.

DM channels carry their own table because they have a different primary
key shape (composite-sorted user pair) and don't belong to a guild.
Both kinds of channel share the same snowflake id-space so
``Message.channel_id`` can polymorphically reference either.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
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
        Index("ix_dm_channels_user_a_last_message", "user_a_id", "last_message_id"),
        Index("ix_dm_channels_user_b_last_message", "user_b_id", "last_message_id"),
    )
