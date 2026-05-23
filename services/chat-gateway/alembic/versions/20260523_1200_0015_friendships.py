"""friendships

Mutual friendship rows between two users. PK is the *sorted* user pair
(``user_a_id < user_b_id``, enforced by CHECK) so A↔B and B↔A always
map to the same row — same trick the direct-message channels table uses
to prevent dupes. No FK to ``auth.users`` (cross-service: auth and chat
own separate schemas per the PLAN anti-pattern); user-purge is
explicit, see ``user_purge.py``.

Etappe 1 of the Voll-Discord-Freundschaftssystem; the parallel tables
``friend_requests``, ``user_blocks``, ``user_privacy`` arrive in the
next three migrations as separate files for symmetric downgrades.

Revision ID: 0015_friendships
Revises: 0014_guild_sound_overrides
Create Date: 2026-05-23 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0015_friendships"
down_revision: str | None = "0014_guild_sound_overrides"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "friendships",
        sa.Column("user_a_id", sa.BigInteger(), nullable=False),
        sa.Column("user_b_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("user_a_id", "user_b_id", name="pk_friendships"),
        sa.CheckConstraint("user_a_id < user_b_id", name="ck_friendships_sorted"),
        schema=SCHEMA,
    )
    # PK already indexes (user_a_id, user_b_id); the reverse-side index
    # speeds up "friends of user X" lookups where X is the higher id.
    op.create_index(
        "ix_friendships_user_b",
        "friendships",
        ["user_b_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_friendships_user_b", "friendships", schema=SCHEMA)
    op.drop_table("friendships", schema=SCHEMA)
