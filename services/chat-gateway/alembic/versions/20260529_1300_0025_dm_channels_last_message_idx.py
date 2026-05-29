"""Add composite indexes on direct_message_channels for ordered DM list.

These cover the common query pattern of fetching a user's DM channels
ordered by last_message_id DESC (most-recently-active first).

Revision ID: 0025_dm_channels_last_message_idx
Revises: 0024_messages_created_at_idx
Create Date: 2026-05-29 13:00:00
"""

from __future__ import annotations

from alembic import op


revision = "0025_dm_channels_last_message_idx"
down_revision = "0024_messages_created_at_idx"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_dm_channels_user_a_last_message",
        "direct_message_channels",
        ["user_a_id", "last_message_id"],
        schema="chat",
    )
    op.create_index(
        "ix_dm_channels_user_b_last_message",
        "direct_message_channels",
        ["user_b_id", "last_message_id"],
        schema="chat",
    )


def downgrade() -> None:
    op.drop_index(
        "ix_dm_channels_user_b_last_message",
        table_name="direct_message_channels",
        schema="chat",
    )
    op.drop_index(
        "ix_dm_channels_user_a_last_message",
        table_name="direct_message_channels",
        schema="chat",
    )
