"""users_lower_indexes — case-insensitive lookup indexes on username + display_name

Revision ID: 0024_users_lower_indexes
Revises: 0023_totp_last_counter
Create Date: 2026-05-29 14:00:00
"""

from __future__ import annotations

from alembic import op

revision: str = "0024_users_lower_indexes"
down_revision: str | None = "0023_totp_last_counter"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    # CONCURRENTLY avoids a full-table lock in production.  Alembic runs
    # migrations inside an implicit transaction; CREATE INDEX CONCURRENTLY
    # cannot run inside a transaction, so we close the auto-transaction first.
    op.execute("COMMIT")
    op.execute(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_users_username_lower "
        "ON auth.users (LOWER(username) text_pattern_ops)"
    )
    op.execute(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_users_display_name_lower "
        "ON auth.users (LOWER(display_name) text_pattern_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS auth.ix_users_username_lower")
    op.execute("DROP INDEX IF EXISTS auth.ix_users_display_name_lower")
