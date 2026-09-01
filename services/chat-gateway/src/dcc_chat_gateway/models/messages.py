"""Message + reaction + attachment tables."""

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
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base, snowflake_pk

# Mention-type sentinels — mirror the ``mention_type`` column in the
# ``message_mentions`` table. Kept here next to the model that owns them
# so the parser + serializer can refer to symbolic names instead of bare
# 0/1/2 magic numbers.
MENTION_TYPE_USER = 0
MENTION_TYPE_ROLE = 1
MENTION_TYPE_EVERYONE = 2

# ``target_id`` for an @everyone mention. The PK column is NOT NULL and
# any non-NULL sentinel is fine since there's only ever one @everyone
# per message anyway. Zero is also the sentinel used by the migration's
# server_default, so manually-inserted rows match exactly.
MENTION_EVERYONE_TARGET_ID = 0


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
    # Angepinnt („Pinned Messages“). Zeitstempel statt bool-Flag: er ordnet
    # die Pin-Liste des Kanals (Discord ordnet nach Pin-Zeit) und NULL ist
    # zugleich der „nicht angepinnt“-Zustand — eine Extra-Tabelle lohnt für
    # max. 50 Pins pro Kanal nicht. Löschen einer Nachricht löst den Pin.
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Parsed `<@uid>` / `<@&rid>` / `@everyone` markers are stored in the
    # ``message_mentions`` table — see ``MessageMention`` below + the
    # ``mentions`` module that owns the parser + persistence. We do NOT
    # declare a SQLAlchemy relationship for them: ``selectin`` would
    # collide with the route layer's ad-hoc serialization (the routes
    # set ``msg.mentions = [...dicts...]`` for Pydantic's
    # from_attributes path; a real relationship would have ORM
    # semantics on flush and confuse the issue). All reads go through
    # ``mentions.mentions_for`` instead — same pattern as reactions.

    __table_args__ = (
        Index("ix_messages_channel_id_desc", "channel_id", "id"),
        # Backs the account-purge path (``DELETE WHERE author_id = :uid``) and
        # ``GET /members/{id}``-style author lookups — otherwise a full table
        # scan on the biggest table in the schema.
        Index("ix_messages_author", "author_id"),
        # Bedient GET /channels/{id}/pins — nur angepinnte Zeilen stehen drin
        # (max. 50 pro Kanal), der Index bleibt also klein.
        Index(
            "ix_messages_pinned",
            "channel_id",
            "pinned_at",
            postgresql_where="pinned_at IS NOT NULL",
        ),
    )


class MessageMention(Base):
    """One @-mention parsed out of a message's ``content`` at write time.

    ``mention_type`` is one of the ``MENTION_TYPE_*`` constants above
    (0=user, 1=role, 2=everyone). ``target_id`` is the mentioned
    snowflake (user-id or role-id) for type 0/1, or
    ``MENTION_EVERYONE_TARGET_ID`` (0) for type 2 — Postgres composite
    primary keys disallow NULL, and a sentinel keeps the
    ``(target_id, mention_type)`` reverse index uniform.

    Rows are re-computed on edit (delete-all-then-insert via the
    relationship's delete-orphan cascade). On hard message delete the
    FK CASCADEs. The router fans out a per-user ``mention_added`` WS
    envelope so a closed-channel client can still increment its
    mention counter.
    """

    __tablename__ = "message_mentions"

    message_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("messages.id", ondelete="CASCADE"), nullable=False
    )
    mention_type: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    target_id: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        PrimaryKeyConstraint("message_id", "mention_type", "target_id"),
        CheckConstraint(
            "mention_type IN (0, 1, 2)", name="ck_message_mentions_type"
        ),
        Index(
            "ix_message_mentions_target", "target_id", "mention_type"
        ),
    )


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
        # ``user_id`` sits in the middle of the composite PK, so the PK can't
        # serve a ``WHERE user_id = :uid`` purge — this index does.
        Index("ix_message_reactions_user", "user_id"),
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
