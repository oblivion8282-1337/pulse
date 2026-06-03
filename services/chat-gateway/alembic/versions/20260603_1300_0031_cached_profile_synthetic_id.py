"""synthetic_user_id on cached_user_profiles (F19 — self-host name resolution)

Adds a numeric ``synthetic_user_id`` (+ index) to ``cached_user_profiles`` so the
new ``/users`` endpoint can map a numeric chat/voice id (``GuildMember.user_id`` /
LiveKit ``user-<id>``) back to the cached profile. On Self-Host the numeric id is
``synthesize_self_host_user_id(pairwise_sub)``; on Cloud it is the raw user id.

Nullable → SQLite-safe ``add_column`` (no table rebuild). Existing rows stay NULL
until the user's next profile-statement push repopulates the column.

Revision ID: 0031_cached_profile_synthetic_id
Revises: 0030_instance_member_ban
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0031_cached_profile_synthetic_id"
down_revision = "0030_instance_member_ban"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "cached_user_profiles",
        sa.Column("synthetic_user_id", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_chat_cached_user_profiles_synthetic_user_id",
        "cached_user_profiles",
        ["synthetic_user_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_chat_cached_user_profiles_synthetic_user_id",
        table_name="cached_user_profiles",
        schema=SCHEMA,
    )
    op.drop_column("cached_user_profiles", "synthetic_user_id", schema=SCHEMA)
