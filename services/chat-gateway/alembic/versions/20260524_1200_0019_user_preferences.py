"""user_preferences

Server-side mirror of frontend settings-registry sections that opt
into cross-device sync (Plugin-System Schritt 3b). One row per
``(user_id, section_name)``; ``value`` is opaque JSON; ``version`` is
bumped on each write so the route layer can support optimistic
concurrency via ``If-Match``.

Lives in the chat-gateway DB (``chat`` schema), not auth — plugin
state is part of the chat-product domain.

Revision ID: 0019_user_preferences
Revises: 0018_user_privacy
Create Date: 2026-05-24 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0019_user_preferences"
down_revision: str | None = "0018_user_privacy"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "user_preferences",
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("section_name", sa.String(length=64), nullable=False),
        # JSONB on Postgres, JSON on SQLite — SQLAlchemy picks the
        # dialect-native type behind the generic ``JSON``.
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column(
            "version",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "user_id", "section_name", name="pk_user_preferences"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_user_preferences_user",
        "user_preferences",
        ["user_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_user_preferences_user",
        table_name="user_preferences",
        schema=SCHEMA,
    )
    op.drop_table("user_preferences", schema=SCHEMA)
