"""Message + reaction + attachment tables."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk


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


class MessageAttachment(Base):
    """Two-phase row backing a message attachment.

    ``message_id`` is NULL between the upload-URL handout and the actual
    POST /messages. The reaper sweeps stale-NULL rows after 1h. Once
    associated with a message, the FK CASCADEs on hard message delete,
    while soft-deletes are handled in the route layer (it explicitly
    nukes the MinIO objects + sets deleted_at on the attachment row).

    ``mime`` / ``filename`` / ``width`` / ``height`` are nullable
    by-design — Phase-2 E2EE DMs will store ciphertext blobs where the
    server doesn't know any of those.
    """

    __tablename__ = "message_attachments"

    id: Mapped[int] = snowflake_pk()
    message_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("messages.id", ondelete="CASCADE"), nullable=True
    )
    channel_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    uploader_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    storage_key: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    mime: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    thumb_storage_key: Mapped[str | None] = mapped_column(
        String(255), nullable=True, unique=True
    )
    thumb_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    thumb_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_message_attachments_message", "message_id"),
        Index(
            "ix_message_attachments_pending",
            "channel_id",
            "created_at",
            postgresql_where="message_id IS NULL",
        ),
    )
