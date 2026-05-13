"""message replies + reactions

Revision ID: 0004_replies_and_reactions
Revises: 0003_messages_active_idx
Create Date: 2026-05-13 20:30:00

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0004_replies_and_reactions"
down_revision: str | None = "0003_messages_active_idx"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column(
            "reply_to_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.messages.id", ondelete="SET NULL"),
            nullable=True,
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "message_reactions",
        sa.Column(
            "message_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.messages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        # Stored as the literal UTF-8 emoji (e.g. "👍"). 32 bytes covers the
        # widest sequences we expect (flag + ZWJ + tone).
        sa.Column("emoji", sa.String(32), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("message_id", "user_id", "emoji"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_message_reactions_message",
        "message_reactions",
        ["message_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_message_reactions_message", "message_reactions", schema=SCHEMA)
    op.drop_table("message_reactions", schema=SCHEMA)
    op.drop_column("messages", "reply_to_id", schema=SCHEMA)
