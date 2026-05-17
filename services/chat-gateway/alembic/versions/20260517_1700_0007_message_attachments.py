"""message_attachments + per-guild attachment limits

Two changes that together back the message-attachments feature:

* ``message_attachments`` table — rows are created in a "pending" state
  (``message_id IS NULL``) when chat-gateway hands out a presigned upload
  URL. They get bumped to the new message id by the POST /messages call
  that references them. The reaper deletes orphans (NULL + >1 h old).

  Nullable ``mime`` / ``filename`` / ``width`` / ``height`` are deliberate:
  Phase-2 E2EE DMs will store ciphertext blobs where the server doesn't
  know any of those, and we don't want a second column rename later.
  See PLAN.md / the design discussion.

* ``guilds.attachment_max_size_bytes`` + ``attachment_max_count_per_message``
  — per-guild overrides for the upload-url limit check. Defaults match
  the DM limits (25 MB / 4 attachments) so existing guilds get sensible
  values without an admin touching them.

Revision ID: 0007_message_attachments
Revises: 0006_admin_tables
Create Date: 2026-05-17 17:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0007_message_attachments"
down_revision: str | None = "0006_admin_tables"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "guilds",
        sa.Column(
            "attachment_max_size_bytes",
            sa.BigInteger(),
            server_default="26214400",  # 25 MB
            nullable=False,
        ),
        schema=SCHEMA,
    )
    op.add_column(
        "guilds",
        sa.Column(
            "attachment_max_count_per_message",
            sa.SmallInteger(),
            server_default="4",
            nullable=False,
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "message_attachments",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        # NULL while the row is "pending" (presigned URL handed out but
        # message-create hasn't happened yet). FK is set with CASCADE so
        # a soft-deleted message keeps its attachments (the route layer
        # hard-deletes them explicitly), while a hard purge nukes them too.
        sa.Column(
            "message_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.messages.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        sa.Column("uploader_id", sa.BigInteger(), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=True),
        sa.Column("storage_key", sa.String(length=255), nullable=False, unique=True),
        sa.Column("mime", sa.String(length=128), nullable=True),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("thumb_storage_key", sa.String(length=255), nullable=True, unique=True),
        sa.Column("thumb_width", sa.Integer(), nullable=True),
        sa.Column("thumb_height", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_message_attachments_message",
        "message_attachments",
        ["message_id"],
        schema=SCHEMA,
    )
    # Partial index for the reaper — only rows still pending. Tiny when the
    # system is healthy, never wasted on real attachments.
    op.create_index(
        "ix_message_attachments_pending",
        "message_attachments",
        ["channel_id", "created_at"],
        unique=False,
        schema=SCHEMA,
        postgresql_where=sa.text("message_id IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_message_attachments_pending",
        "message_attachments",
        schema=SCHEMA,
    )
    op.drop_index(
        "ix_message_attachments_message",
        "message_attachments",
        schema=SCHEMA,
    )
    op.drop_table("message_attachments", schema=SCHEMA)
    op.drop_column("guilds", "attachment_max_count_per_message", schema=SCHEMA)
    op.drop_column("guilds", "attachment_max_size_bytes", schema=SCHEMA)
