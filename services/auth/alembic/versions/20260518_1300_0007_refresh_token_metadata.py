"""refresh-token metadata: ip_hash + last_used_at + list index

Adds two columns to ``refresh_tokens`` used by the new ``/sessions`` routes:

* ``ip_hash`` — SHA-256 hex of the client IP at issue / last-refresh time
  (DSGVO-friendly; the raw IP is never stored).
* ``last_used_at`` — bumped to ``now()`` on the newly-rotated row in
  ``/refresh`` so the sessions UI can sort by real liveness. The old
  (revoked) row keeps its original value as an audit trail.

Also adds ``ix_refresh_tokens_user_revoked`` covering ``(user_id,
revoked_at)`` for the per-user list query (the existing
``ix_refresh_tokens_user_active`` is a partial index on the same column with
``WHERE revoked_at IS NULL`` and does not help when listing active sessions
sorted by ``last_used_at`` — Postgres can use either, but the explicit
non-partial index is friendlier to query planners and to non-Postgres dev DBs).

Revision ID: 0007_refresh_token_metadata
Revises: 0006_account_recovery
Create Date: 2026-05-18 13:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0007_refresh_token_metadata"
down_revision: str | None = "0006_account_recovery"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "refresh_tokens",
        sa.Column("ip_hash", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "refresh_tokens",
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_refresh_tokens_user_revoked",
        "refresh_tokens",
        ["user_id", "revoked_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_refresh_tokens_user_revoked", "refresh_tokens", schema=SCHEMA
    )
    op.drop_column("refresh_tokens", "last_used_at", schema=SCHEMA)
    op.drop_column("refresh_tokens", "ip_hash", schema=SCHEMA)
