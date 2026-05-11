"""partial index on chat.messages for active (non-deleted) rows

Revision ID: 0003_messages_active_idx
Revises: 0002_guild_invites
Create Date: 2026-05-11 20:00:00

"""
from __future__ import annotations

from alembic import op

revision: str = "0003_messages_active_idx"
down_revision: str | None = "0002_guild_invites"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX ix_messages_channel_active "
        "ON chat.messages (channel_id, id) "
        "WHERE deleted_at IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS chat.ix_messages_channel_active")
