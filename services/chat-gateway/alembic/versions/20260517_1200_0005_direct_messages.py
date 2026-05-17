"""direct message channels

Revision ID: 0005_direct_messages
Revises: 0004_replies_and_reactions
Create Date: 2026-05-17 12:00:00

Adds a separate ``direct_message_channels`` table for 1:1 DMs.
The ``messages`` table is now polymorphic: ``channel_id`` may reference
either a guild ``channels.id`` or a ``direct_message_channels.id``. To
make that possible, the existing ``messages.channel_id -> channels.id``
foreign key is dropped. Cascade-on-delete is replaced in app code
(``routes/channels.py::delete_channel``).

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0005_direct_messages"
down_revision: str | None = "0004_replies_and_reactions"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    # Drop the messages.channel_id -> channels.id FK. The constraint name
    # is Postgres-default ({table}_{column}_fkey) but we look it up
    # defensively so this works even if the name diverges.
    op.execute(
        f"""
        DO $$
        DECLARE c_name text;
        BEGIN
            SELECT conname INTO c_name
            FROM pg_constraint
            WHERE conrelid = '{SCHEMA}.messages'::regclass
              AND contype = 'f'
              AND (
                  SELECT attname FROM pg_attribute
                  WHERE attrelid = conrelid AND attnum = conkey[1]
              ) = 'channel_id';
            IF c_name IS NOT NULL THEN
                EXECUTE 'ALTER TABLE {SCHEMA}.messages DROP CONSTRAINT ' || quote_ident(c_name);
            END IF;
        END $$;
        """
    )

    op.create_table(
        "direct_message_channels",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column("user_a_id", sa.BigInteger(), nullable=False),
        sa.Column("user_b_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_message_id", sa.BigInteger(), nullable=True),
        sa.CheckConstraint("user_a_id < user_b_id", name="ck_dm_channels_sorted"),
        sa.UniqueConstraint("user_a_id", "user_b_id", name="uq_dm_channels_pair"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_dm_channels_user_a",
        "direct_message_channels",
        ["user_a_id"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_dm_channels_user_b",
        "direct_message_channels",
        ["user_b_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_dm_channels_user_b", "direct_message_channels", schema=SCHEMA)
    op.drop_index("ix_dm_channels_user_a", "direct_message_channels", schema=SCHEMA)
    op.drop_table("direct_message_channels", schema=SCHEMA)
    op.create_foreign_key(
        "messages_channel_id_fkey",
        "messages",
        "channels",
        ["channel_id"],
        ["id"],
        ondelete="CASCADE",
        source_schema=SCHEMA,
        referent_schema=SCHEMA,
    )
