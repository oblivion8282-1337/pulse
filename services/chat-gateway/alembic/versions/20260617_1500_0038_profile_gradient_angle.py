"""profile_gradient_angle on cached_user_profiles — name-gradient direction

Adds the nullable ``profile_gradient_angle`` column to ``cached_user_profiles``.
Mirrors the auth-svc ``users.profile_gradient_angle`` column: the chat-gateway
caches it from the profile-statement claim exactly parallel to
``profile_color_secondary``, so ``/users`` and mention-search can serve the
directional name gradient.

NULL = legacy default (90° = links→rechts). Existing rows stay NULL until the
user's next profile-statement push repopulates the column.

Nullable → SQLite-safe ``add_column`` (no table rebuild).

Revision ID: 0038_profile_gradient_angle
Revises: 0037_profile_color_secondary
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0038_profile_gradient_angle"
down_revision = "0037_profile_color_secondary"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "cached_user_profiles",
        sa.Column("profile_gradient_angle", sa.Integer(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("cached_user_profiles", "profile_gradient_angle", schema=SCHEMA)
