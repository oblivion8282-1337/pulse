"""Add partial indexes on reports target columns.

Speeds up the OR-subquery predicates in list_mod_queue by creating
partial indexes on target_channel_id, target_message_id, and
target_user_id (each filtered to IS NOT NULL rows only).

Revision ID: 0023_reports_target_indexes
Revises: 0022_phase3_schemas
Create Date: 2026-05-29 00:01:00
"""

from __future__ import annotations

from alembic import op

revision = "0023_reports_target_indexes"
down_revision = "0022_phase3_schemas"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_reports_target_channel",
        "reports",
        ["target_channel_id"],
        schema="chat",
        postgresql_where="target_channel_id IS NOT NULL",
    )
    op.create_index(
        "ix_reports_target_message",
        "reports",
        ["target_message_id"],
        schema="chat",
        postgresql_where="target_message_id IS NOT NULL",
    )
    op.create_index(
        "ix_reports_target_user",
        "reports",
        ["target_user_id"],
        schema="chat",
        postgresql_where="target_user_id IS NOT NULL",
    )


def downgrade() -> None:
    op.drop_index("ix_reports_target_user", table_name="reports", schema="chat")
    op.drop_index("ix_reports_target_message", table_name="reports", schema="chat")
    op.drop_index("ix_reports_target_channel", table_name="reports", schema="chat")
