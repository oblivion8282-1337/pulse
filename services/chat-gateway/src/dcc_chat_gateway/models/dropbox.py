"""Per-guild file-storage metadata (dropbox / Ablage).

Mirror of the tables introduced in alembic migrations 0041 +
0042. Folder rows carry ``size_bytes`` / ``content_type`` /
``storage_key`` NULL; soft-delete via ``deleted_at`` so the
periodic sweep can hard-purge after the configured retention.
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


# kind values — kept here (next to the model) rather than in
# models/channels.py because they're dropbox-domain.
DROPBOX_KIND_FOLDER = 0
DROPBOX_KIND_FILE = 1


class DropboxConfig(Base):
    """One per guild that has activated the dropbox channel.

    The presence of this row doubles as "the dropbox channel exists and
    is enabled" — no separate ``is_active`` flag needed. Routes use
    ``get-or-create`` semantics: listing endpoints create the row
    transparently the first time the dropbox is opened, if and only if
    the corresponding dropbox channel has been provisioned (otherwise
    they 404 the missing-channel case first).
    """

    __tablename__ = "dropbox_configs"

    guild_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("chat.guilds.id", ondelete="CASCADE"),
        primary_key=True,
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true"
    )
    total_quota_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="5368709120"  # 5 GiB
    )
    per_file_max_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="104857600"  # 100 MiB
    )
    used_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    trash_retention_days: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="30"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class DropboxFile(Base):
    """One row per folder or file entry inside the dropbox.

    Folder rows: ``size_bytes``/``content_type``/``storage_key`` are NULL.
    Path is split across ``parent_path`` (always ends without a trailing
    slash) and ``name`` (basename). For a top-level entry ``parent_path``
    is the empty string. Uploads and overwrites share the row (kept in
    ``version``); folder rows are version 1 forever.
    """

    __tablename__ = "dropbox_files"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    guild_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("chat.guilds.id", ondelete="CASCADE"),
        nullable=False,
    )
    channel_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("chat.channels.id", ondelete="CASCADE"),
        nullable=False,
    )
    parent_path: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=""
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="0"
    )
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    content_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    storage_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    version: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="1"
    )
    uploaded_by_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    deleted_by_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    pinned: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )

    __table_args__ = (
        Index("ix_dropbox_files_guild_parent", "guild_id", "parent_path"),
        Index("ix_dropbox_files_channel", "channel_id"),
        Index("ix_dropbox_files_guild_uploaded_at", "guild_id", "uploaded_at"),
        Index("ix_dropbox_files_name_trgm", "guild_id", "name"),
        Index("ix_dropbox_files_trash_sweep", "deleted_at"),
        # Covering index for the orphan-sweep ``WHERE storage_key = ?``
        # probe — small per row, but worth having since the bucket walk
        # does one lookup per object.
        Index("ix_dropbox_files_storage_key", "storage_key"),
        # Der partielle Unique-Index aus Migration 0043 — er entscheidet in
        # Produktion die Namenskollision, auf die sich ``commit_or_conflict``
        # verlässt (IntegrityError → 409 statt 500). Er stand bis zum Bughunt
        # vom 17. August nur in der Migration: Testschemata entstehen über
        # ``create_all``, also fehlte in JEDEM Test genau der Riegel, den der
        # Code in Produktion voraussetzt.
        Index(
            "ix_dropbox_files_unique_name",
            "guild_id",
            "parent_path",
            "name",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
    )


class DropboxPendingUpload(Base):
    """Server-side state that ties a presigned-PUT mint to its minter.

    ``id`` doubles as the future ``DropboxFile.id`` once the upload
    commits — no extra Snowflake allocation, and the foreign-key
    closure is a clean drop-on-cascade when the guild goes away.

    The row is INSERTed by ``mint_upload_url`` and DELETEd by
    ``finish_upload`` (or by the orphan sweep, whichever comes first
    for an abandoned mint). ``finish_upload`` validates ``uploader_id
    == current.id`` so a leaked ``id`` cannot be used by another
    member to consume the minter's storage or pollute the audit
    trail (``uploaded_by_id`` would otherwise lie).
    """

    __tablename__ = "dropbox_pending_uploads"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    uploader_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    guild_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("chat.guilds.id", ondelete="CASCADE"),
        nullable=False,
    )
    parent_path: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=""
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_dropbox_pending_uploads_expires", "expires_at"),
        Index("ix_dropbox_pending_uploads_uploader", "uploader_id"),
    )