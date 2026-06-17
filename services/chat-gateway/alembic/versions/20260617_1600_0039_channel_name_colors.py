"""channel name colors — per-channel name styling

Adds nullable ``name_color`` / ``name_color_secondary`` / ``name_gradient_angle``
to ``channels``. Mirrors users.profile_color*: a channel name can be solid
(one color), a gradient (two colors), at a direction (angle, default 90°).

NULL = no styling (plain default look). Nullable → SQLite-safe add_column.

Revision ID: 0039_channel_name_colors
Revises: 0038_profile_gradient_angle
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0039_channel_name_colors"
down_revision = "0038_profile_gradient_angle"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "channels",
        sa.Column("name_color", sa.String(length=32), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "channels",
        sa.Column("name_color_secondary", sa.String(length=32), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "channels",
        sa.Column("name_gradient_angle", sa.SmallInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("channels", "name_gradient_angle", schema=SCHEMA)
    op.drop_column("channels", "name_color_secondary", schema=SCHEMA)
    op.drop_column("channels", "name_color", schema=SCHEMA)
