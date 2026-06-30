"""Dropbox files: partial UNIQUE index on (guild_id, parent_path, name)
where deleted_at IS NULL.

Revision ID: 0043_dropbox_files_unique_name
Revises: 0042_dropbox_pending_uploads
Create Date: 2026-06-30 19:00:00

Closes finding #10 from the 2026-06-30 team re-review. Pre-flight
clash-check in ``create_folder`` / ``patch_entry`` /
``finish_upload`` is TOCTOU-anfällig — two parallel requests with
the same ``(parent_path, name)`` both pass the SELECT-then-INSERT
gap before either commits. Postgres raises ``IntegrityError`` on
the second INSERT, but the route currently maps that to ``500``
(``finish_upload``) instead of ``409`` and the in-flight MinIO
object is orphaned for the trash sweep to clean up.

The partial UNIQUE index lets the DB enforce the invariant
*atomically*. ``WHERE deleted_at IS NULL`` is the key: a trashed
row with the same name must not block re-uploads. (A user who
trashes ``a.txt`` and re-uploads ``a.txt`` in the same
window — the in-trash row is at ``parent_path/a.txt`` and the
new row would be at the same path; the partial index sees
only the live row, the trashed one is excluded.)

Indexes:
  * PK on ``id`` (unchanged).
  * ``ix_dropbox_files_storage_key`` for the orphan-sweep probe
    (unchanged).
  * **NEW** ``ix_dropbox_files_unique_name`` partial UNIQUE on
    (guild_id, parent_path, name) WHERE deleted_at IS NULL.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0043_dropbox_files_unique_name"
down_revision: str | None = "0042_dropbox_pending_uploads"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_index(
        "ix_dropbox_files_unique_name",
        "dropbox_files",
        ["guild_id", "parent_path", "name"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        sqlite_where=sa.text("deleted_at IS NULL"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_dropbox_files_unique_name",
        table_name="dropbox_files",
        schema=SCHEMA,
    )