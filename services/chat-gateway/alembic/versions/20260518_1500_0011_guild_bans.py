"""guild_bans

Per-guild ban list. A row here means the listed user is forbidden from
joining the guild — checked at every membership-creation path (direct
add, invite acceptance). Banning an *existing* member also drops their
``guild_members`` row in the same transaction so they stop receiving
broadcasts.

Revision ID: 0011_guild_bans
Revises: 0010_default_guild_creation_off
Create Date: 2026-05-18 15:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0011_guild_bans"
down_revision: str | None = "0010_default_guild_creation_off"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "guild_bans",
        sa.Column(
            "guild_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.guilds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "banned_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("banned_by_id", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("guild_id", "user_id"),
        sa.Index("ix_guild_bans_user", "user_id"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_guild_bans_user", table_name="guild_bans", schema=SCHEMA)
    op.drop_table("guild_bans", schema=SCHEMA)
