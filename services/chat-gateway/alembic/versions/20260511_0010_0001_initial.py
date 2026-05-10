"""initial chat schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-05-11 00:10:00

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.execute(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}")

    op.create_table(
        "guilds",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("icon_url", sa.Text(), nullable=True),
        sa.Column("owner_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "channels",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column(
            "guild_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.guilds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("type", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("topic", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_channels_guild_position",
        "channels",
        ["guild_id", "position"],
        schema=SCHEMA,
    )

    op.create_table(
        "guild_members",
        sa.Column(
            "guild_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.guilds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("nickname", sa.String(64), nullable=True),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("guild_id", "user_id", name="pk_guild_members"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_guild_members_user",
        "guild_members",
        ["user_id"],
        schema=SCHEMA,
    )

    op.create_table(
        "messages",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column(
            "channel_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.channels.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("author_id", sa.BigInteger(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("nonce", sa.String(64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_messages_channel_id_desc",
        "messages",
        ["channel_id", "id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_messages_channel_id_desc", "messages", schema=SCHEMA)
    op.drop_table("messages", schema=SCHEMA)
    op.drop_index("ix_guild_members_user", "guild_members", schema=SCHEMA)
    op.drop_table("guild_members", schema=SCHEMA)
    op.drop_index("ix_channels_guild_position", "channels", schema=SCHEMA)
    op.drop_table("channels", schema=SCHEMA)
    op.drop_table("guilds", schema=SCHEMA)
