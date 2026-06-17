"""profile_gradient_angle — Richtung des Namens-Verlaufs

Adds the nullable ``profile_gradient_angle`` column to ``auth.users``. Carried
everywhere exactly parallel to ``profile_color_secondary`` (same nullability,
same statement/cache flow). Stores the CSS gradient angle in degrees (0–360);
together with ``profile_color`` → ``profile_color_secondary`` it drives the
directional name gradient ``linear-gradient(<angle>deg, c1, c2)``.

NULL = legacy default (90° = links→rechts), so existing rows keep the original
horizontal look without a backfill.

Nullable → SQLite-safe ``add_column`` (no table rebuild).

Revision ID: 0031_profile_gradient_angle
Revises: 0030_complaint_forwarding
Create Date: 2026-06-17 15:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0031_profile_gradient_angle"
down_revision: str | None = "0030_complaint_forwarding"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("profile_gradient_angle", sa.SmallInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("users", "profile_gradient_angle", schema=SCHEMA)
