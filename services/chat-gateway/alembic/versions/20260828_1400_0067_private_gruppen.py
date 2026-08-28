"""private_gruppen — Kanaele + Mitgliedschaft fuer Etappe G1

Dritte Kanalart neben Community-Kanal und DM: ``private_group_channels``
(Snowflake-PK aus demselben Generator, s. ``models/private_gruppen.py``) und
``private_group_members`` (CASCADE auf die Gruppe, ein Konto hoechstens
einmal Mitglied). Details + die drei Festlegungen der Etappe:
``routes/private_gruppen.py``.

Revision ID: 0067_private_gruppen
Revises: 0066_postfach
Create Date: 2026-08-28 14:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0067_private_gruppen"
down_revision: str | None = "0066_postfach"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "private_group_channels",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("ersteller_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_message_id", sa.BigInteger(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )

    op.create_table(
        "private_group_members",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("gruppe_id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "beigetreten_am",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["gruppe_id"], [f"{SCHEMA}.private_group_channels.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint(
            "gruppe_id", "user_id", name="uq_private_group_members_mitglied"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_private_group_members_gruppe",
        "private_group_members",
        ["gruppe_id"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_private_group_members_user",
        "private_group_members",
        ["user_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_private_group_members_user", table_name="private_group_members", schema=SCHEMA
    )
    op.drop_index(
        "ix_private_group_members_gruppe", table_name="private_group_members", schema=SCHEMA
    )
    op.drop_table("private_group_members", schema=SCHEMA)
    op.drop_table("private_group_channels", schema=SCHEMA)
