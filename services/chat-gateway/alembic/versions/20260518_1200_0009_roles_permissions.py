"""roles, member_roles, permission_overwrites + @everyone seed

Schema for guild roles, member-role assignments, and per-channel
permission overwrites. The resolver lives in ``dcc_shared.permissions``
+ ``dcc_shared.permission_resolver``; this migration is purely structural
plus a data-migration that seeds an ``@everyone`` role per existing
guild so the post-migration behaviour exactly matches the pre-migration
"every member can do everything" semantics.

Revision ID: 0009_roles_permissions
Revises: 0008_permission_flags
Create Date: 2026-05-18 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from dcc_shared.permissions import DEFAULT_EVERYONE_PERMISSIONS
from dcc_shared.snowflake import SnowflakeGenerator

revision: str = "0009_roles_permissions"
down_revision: str | None = "0008_permission_flags"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "roles",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column(
            "guild_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.guilds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column(
            "permissions", sa.BigInteger(), nullable=False, server_default="0"
        ),
        sa.Column("color", sa.Integer(), nullable=True),
        sa.Column(
            "position", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "hoist", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column(
            "mentionable",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "is_everyone",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_roles_guild_position",
        "roles",
        ["guild_id", "position"],
        schema=SCHEMA,
    )
    # Exactly one @everyone per guild. Partial index — Postgres-specific
    # but supported by SQLite 3.8+ too, so tests using aiosqlite are fine.
    op.create_index(
        "ux_roles_guild_everyone",
        "roles",
        ["guild_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("is_everyone"),
        sqlite_where=sa.text("is_everyone"),
    )

    op.create_table(
        "member_roles",
        sa.Column("guild_id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "role_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.roles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("guild_id", "user_id", "role_id"),
        sa.ForeignKeyConstraint(
            ["guild_id", "user_id"],
            [f"{SCHEMA}.guild_members.guild_id", f"{SCHEMA}.guild_members.user_id"],
            ondelete="CASCADE",
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_member_roles_user",
        "member_roles",
        ["guild_id", "user_id"],
        schema=SCHEMA,
    )

    op.create_table(
        "permission_overwrites",
        sa.Column(
            "channel_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.channels.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("target_type", sa.SmallInteger(), nullable=False),
        sa.Column("target_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "allow_bf", sa.BigInteger(), nullable=False, server_default="0"
        ),
        sa.Column(
            "deny_bf", sa.BigInteger(), nullable=False, server_default="0"
        ),
        sa.PrimaryKeyConstraint("channel_id", "target_type", "target_id"),
        sa.CheckConstraint(
            "target_type IN (0, 1)", name="ck_permission_overwrites_target_type"
        ),
        schema=SCHEMA,
    )

    # Data-migration: seed @everyone for each existing guild. New guilds
    # created after this migration ran get their @everyone via the
    # POST /guilds route. Worker-ID 2 = chat-gateway (matches the live
    # service); IDs generated here will not collide with future IDs from
    # the running service because the running service's timestamp will
    # be later.
    bind = op.get_bind()
    guild_rows = bind.execute(
        sa.text(f"SELECT id FROM {SCHEMA}.guilds")
    ).fetchall()
    if guild_rows:
        gen = SnowflakeGenerator(worker_id=2)
        bind.execute(
            sa.text(
                f"INSERT INTO {SCHEMA}.roles "
                "(id, guild_id, name, permissions, position, hoist, "
                " mentionable, is_everyone) "
                "VALUES (:id, :guild_id, :name, :permissions, 0, "
                "        false, false, true)"
            ),
            [
                {
                    "id": gen.next_id(),
                    "guild_id": row[0],
                    "name": "@everyone",
                    "permissions": DEFAULT_EVERYONE_PERMISSIONS,
                }
                for row in guild_rows
            ],
        )


def downgrade() -> None:
    op.drop_table("permission_overwrites", schema=SCHEMA)
    op.drop_index("ix_member_roles_user", table_name="member_roles", schema=SCHEMA)
    op.drop_table("member_roles", schema=SCHEMA)
    op.drop_index("ux_roles_guild_everyone", table_name="roles", schema=SCHEMA)
    op.drop_index("ix_roles_guild_position", table_name="roles", schema=SCHEMA)
    op.drop_table("roles", schema=SCHEMA)
