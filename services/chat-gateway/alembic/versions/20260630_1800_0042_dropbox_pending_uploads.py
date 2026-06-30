"""Dropbox pending uploads: ties a presigned-PUT mint to its minter.

Revision ID: 0042_dropbox_pending_uploads
Revises: 0041_dropbox_storage
Create Date: 2026-06-30 18:00:00

Adds the ``dropbox_pending_uploads`` table that fixes the cross-user
upload-attribution bug from the 2026-06-30 review:

* ``mint_upload_url`` previously returned ``{id, upload_url,
  storage_key}`` with no server-side state tying that id to the
  minter. Member A could hand the response to Member B, B could
  call ``finish-upload`` with A's id, and the resulting row's
  ``uploaded_by_id`` would be B's while A's bytes were charged to
  B's quota. The audit trail lied, and any rate-limit or storage-
  quota per minter was trivially bypassed.

* The new table binds each minted id to ``uploader_id`` (and the
  parent/name/size the client declared). ``finish-upload``
  refuses the call when the row's ``uploader_id`` doesn't match
  the JWT, when the parent/name/size don't match, or when the row
  has expired. Orphan rows are purged on the same hourly cadence
  as the trash sweep.

Indexes:
  * PK on ``id`` (also the future ``DropboxFile.id``).
  * ``ix_dropbox_pending_uploads_expires`` for the sweep query.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0042_dropbox_pending_uploads"
down_revision: str | None = "0041_dropbox_storage"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "dropbox_pending_uploads",
        sa.Column(
            "id",
            sa.BigInteger(),
            primary_key=True,
            autoincrement=False,
        ),
        sa.Column(
            "uploader_id",
            sa.BigInteger(),
            nullable=False,
        ),
        sa.Column(
            "guild_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.guilds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("parent_path", sa.Text(), nullable=False, server_default=""),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Index(
            "ix_dropbox_pending_uploads_expires",
            "expires_at",
        ),
        sa.Index(
            "ix_dropbox_pending_uploads_uploader",
            "uploader_id",
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("dropbox_pending_uploads", schema=SCHEMA)