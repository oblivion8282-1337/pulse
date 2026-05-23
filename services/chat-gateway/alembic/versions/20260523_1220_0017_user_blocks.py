"""user_blocks

Directional block: ``blocker_id`` has blocked ``blocked_id``. PK is the
ordered pair so blocking is asymmetric — A→B does not imply B→A. A
block applies in *both* directions for friend-requesting + DMing
(checked in app code, see ``routes/friends.py`` + ``routes/blocks.py``).

Block also wipes existing friendship + pending requests between the
two parties in the same TX (route-side).

Revision ID: 0017_user_blocks
Revises: 0016_friend_requests
Create Date: 2026-05-23 12:20:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0017_user_blocks"
down_revision: str | None = "0016_friend_requests"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "user_blocks",
        sa.Column("blocker_id", sa.BigInteger(), nullable=False),
        sa.Column("blocked_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "blocker_id", "blocked_id", name="pk_user_blocks"
        ),
        sa.CheckConstraint(
            "blocker_id <> blocked_id", name="ck_user_blocks_no_self"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_user_blocks_blocked",
        "user_blocks",
        ["blocked_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_user_blocks_blocked", "user_blocks", schema=SCHEMA)
    op.drop_table("user_blocks", schema=SCHEMA)
