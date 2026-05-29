"""Add partial index on messages(created_at) for active rows.

Converts the admin stats messages_24h COUNT from an O(total_messages)
full table scan to an O(messages_in_last_24h) index scan.

Revision ID: 0024_messages_created_at_idx
Revises: 0023_reports_target_indexes
Create Date: 2026-05-29 12:00:00
"""

from __future__ import annotations

from alembic import op


revision = "0024_messages_created_at_idx"
down_revision = "0023_reports_target_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX ix_messages_created_at_active "
        "ON chat.messages (created_at) WHERE deleted_at IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS chat.ix_messages_created_at_active")
