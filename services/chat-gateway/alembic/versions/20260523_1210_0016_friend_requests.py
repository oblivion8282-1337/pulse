"""friend_requests

Pending friend-request rows (directional: sender → receiver). One row
per ordered pair is enough — accept turns the row into a friendship +
DELETE; decline / cancel just DELETE. If a reverse request already
exists when a new one is POSTed, the route auto-accepts (atomic in a
single TX, see ``routes/friends.py``).

Snowflake ``id`` so the row can be addressed by URL
(``POST /friend-requests/{id}/accept``) without exposing the
(sender, receiver) tuple.

Revision ID: 0016_friend_requests
Revises: 0015_friendships
Create Date: 2026-05-23 12:10:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0016_friend_requests"
down_revision: str | None = "0015_friendships"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "friend_requests",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column("sender_id", sa.BigInteger(), nullable=False),
        sa.Column("receiver_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "sender_id", "receiver_id", name="uq_friend_requests_pair"
        ),
        sa.CheckConstraint(
            "sender_id <> receiver_id", name="ck_friend_requests_no_self"
        ),
        schema=SCHEMA,
    )
    # Inbox view: receiver lists their pending requests newest-first.
    op.create_index(
        "ix_friend_requests_receiver_created",
        "friend_requests",
        ["receiver_id", sa.text("created_at DESC")],
        schema=SCHEMA,
    )
    # Outbox view: sender lists their outgoing requests newest-first.
    op.create_index(
        "ix_friend_requests_sender_created",
        "friend_requests",
        ["sender_id", sa.text("created_at DESC")],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_friend_requests_sender_created", "friend_requests", schema=SCHEMA
    )
    op.drop_index(
        "ix_friend_requests_receiver_created", "friend_requests", schema=SCHEMA
    )
    op.drop_table("friend_requests", schema=SCHEMA)
