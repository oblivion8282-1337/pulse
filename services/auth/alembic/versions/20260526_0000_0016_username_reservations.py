"""username_reservations - 30-day hold after username change (Block 1.D, migration 0016).

Adds:
  * auth.users.avatar_hash   - SHA-256 hex (content-addressed avatar key)
  * auth.users.profile_color - CSS accent colour
  * auth.username_reservations - 30-day hold table

Revision ID: 0016_username_reservations
Revises: 0015_encrypted_key_backups
Create Date: 2026-05-26 00:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0016_username_reservations"
down_revision: str | None = "0015_encrypted_key_backups"
branch_labels = None
depends_on = None

SCHEMA = "auth"
_TsOrText = sa.DateTime(timezone=True).with_variant(sa.Text(), "sqlite")


def upgrade() -> None:
    op.add_column("users", sa.Column("avatar_hash", sa.String(64), nullable=True), schema=SCHEMA)
    op.add_column("users", sa.Column("profile_color", sa.String(32), nullable=True), schema=SCHEMA)
    op.create_table(
        "username_reservations",
        sa.Column("old_username", sa.Text(), primary_key=True),
        sa.Column("original_user_id", sa.BigInteger(), nullable=False),
        sa.Column("released_at", _TsOrText, nullable=False),
        sa.ForeignKeyConstraint(["original_user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_username_reservations_released_at", "username_reservations", ["released_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_username_reservations_released_at", table_name="username_reservations", schema=SCHEMA)
    op.drop_table("username_reservations", schema=SCHEMA)
    op.drop_column("users", "profile_color", schema=SCHEMA)
    op.drop_column("users", "avatar_hash", schema=SCHEMA)