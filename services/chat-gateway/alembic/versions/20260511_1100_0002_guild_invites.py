"""guild invites table

Revision ID: 0002_guild_invites
Revises: 0001_initial
Create Date: 2026-05-11 11:00:00

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0002_guild_invites"
down_revision: str | None = "0001_initial"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "guild_invites",
        sa.Column("code", sa.String(16), primary_key=True),
        sa.Column(
            "guild_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.guilds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "channel_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.channels.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("creator_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column("uses", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_guild_invites_guild",
        "guild_invites",
        ["guild_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_guild_invites_guild", "guild_invites", schema=SCHEMA)
    op.drop_table("guild_invites", schema=SCHEMA)
