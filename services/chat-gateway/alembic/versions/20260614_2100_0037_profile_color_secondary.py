"""profile_color_secondary on cached_user_profiles — second gradient colour

Adds the nullable ``profile_color_secondary`` column to ``cached_user_profiles``.
Mirrors the auth-svc ``users.profile_color_secondary`` column: the chat-gateway
caches it from the profile-statement claim exactly parallel to ``profile_color``,
so ``/users`` and mention-search can serve the name-gradient endpoint colour.

Nullable → SQLite-safe ``add_column`` (no table rebuild). Existing rows stay
NULL until the user's next profile-statement push repopulates the column.

Revision ID: 0037_profile_color_secondary
Revises: 0036_invite_unique_dedupe
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0037_profile_color_secondary"
down_revision = "0036_invite_unique_dedupe"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "cached_user_profiles",
        sa.Column("profile_color_secondary", sa.Text(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("cached_user_profiles", "profile_color_secondary", schema=SCHEMA)
