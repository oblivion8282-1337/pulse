"""Per-guild sound-override metadata.

The binary lives in MinIO under ``guild-sounds/<guild>/<sound_id>``;
this row stores upload metadata + lets us LIST efficiently without a
MinIO HEAD on every sound.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Integer,
    PrimaryKeyConstraint,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class GuildSoundOverride(Base):
    __tablename__ = "guild_sound_overrides"

    guild_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("chat.guilds.id", ondelete="CASCADE"),
        nullable=False,
    )
    sound_id: Mapped[str] = mapped_column(Text, nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    original_filename: Mapped[str] = mapped_column(Text, nullable=False)
    uploaded_by_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    __table_args__ = (
        PrimaryKeyConstraint("guild_id", "sound_id", name="pk_guild_sound_overrides"),
    )
