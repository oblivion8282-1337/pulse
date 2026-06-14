"""profile_color_secondary — zweite Gradient-Farbe für den Namens-Verlauf

Adds the nullable ``profile_color_secondary`` column to ``auth.users``. Carried
everywhere exactly parallel to ``profile_color`` (same nullability, same hex
validation) — together they drive a name gradient
``profile_color`` → ``profile_color_secondary``.

Nullable → SQLite-safe ``add_column`` (no table rebuild). Existing rows stay
NULL (= solid colour / theme default).

Revision ID: 0029_profile_color_secondary
Revises: 0028_account_keys
Create Date: 2026-06-14 21:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0029_profile_color_secondary"
down_revision: str | None = "0028_account_keys"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("profile_color_secondary", sa.String(length=32), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("users", "profile_color_secondary", schema=SCHEMA)
