"""instance-wide member ban columns on cached_user_profiles (F11c)

Adds ``banned_at`` + ``ban_reason`` to ``cached_user_profiles`` so a Cloud-admin
can ban a user instance-wide on their Self-Host. The cert-login handler denies a
session token when ``banned_at IS NOT NULL`` (see routes/cert_login.py).

Both columns are nullable → SQLite-safe ``add_column`` (no table rebuild needed).

Revision ID: 0030_instance_member_ban
Revises: 0029_cam_limits
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0030_instance_member_ban"
down_revision = "0029_cam_limits"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "cached_user_profiles",
        sa.Column("banned_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "cached_user_profiles",
        sa.Column("ban_reason", sa.Text(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("cached_user_profiles", "ban_reason", schema=SCHEMA)
    op.drop_column("cached_user_profiles", "banned_at", schema=SCHEMA)
