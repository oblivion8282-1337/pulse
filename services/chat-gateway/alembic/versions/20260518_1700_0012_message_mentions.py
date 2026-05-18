"""message_mentions

Per-message reverse-lookup table of who/what was @-mentioned in the
content. One row per (message, mention_type, target_id) where
``mention_type`` is 0=user, 1=role, 2=everyone. ``target_id`` is the
mentioned user or role snowflake for type 0/1, and the literal ``0``
sentinel for type 2 (Postgres PKs disallow NULLs, and a sentinel keeps
the (type, target) reverse index uniform — there can only ever be one
``everyone`` mention per message anyway).

Used for: the message wire shape (``mentions: [{type, id}]``), the
per-user "mention_added" WS event so a client with the channel closed
can still increment its mention counter, and future "where was I
mentioned" lookups by ``(target_id, mention_type)``.

Revision ID: 0012_message_mentions
Revises: 0011_guild_bans
Create Date: 2026-05-18 17:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0012_message_mentions"
down_revision: str | None = "0011_guild_bans"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "message_mentions",
        sa.Column(
            "message_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.messages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("mention_type", sa.SmallInteger(), nullable=False),
        # ``target_id`` is the mentioned snowflake (user-id for type 0,
        # role-id for type 1). Type-2 (everyone) carries the literal 0
        # sentinel — Postgres composite-PK columns can't be NULL and
        # there's only ever one @everyone mention per message anyway.
        sa.Column(
            "target_id",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "message_id", "mention_type", "target_id"
        ),
        sa.CheckConstraint(
            "mention_type IN (0, 1, 2)", name="ck_message_mentions_type"
        ),
        schema=SCHEMA,
    )
    # Reverse lookup: "where was user X / role Y mentioned?". Composite
    # column order puts the high-cardinality target_id first.
    op.create_index(
        "ix_message_mentions_target",
        "message_mentions",
        ["target_id", "mention_type"],
        schema=SCHEMA,
    )
    # ``message_id`` is the leading PK column already, so the PK index
    # serves the by-message lookup. No extra index needed.


def downgrade() -> None:
    op.drop_index(
        "ix_message_mentions_target",
        table_name="message_mentions",
        schema=SCHEMA,
    )
    op.drop_table("message_mentions", schema=SCHEMA)
