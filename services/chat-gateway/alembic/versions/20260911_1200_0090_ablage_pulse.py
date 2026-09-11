"""ablage-pulse-laufwerk (vermieteter Community-Speicher)

Revision ID: 0090_ablage_pulse
Revises: 0089_gast_zeitfenster
Create Date: 2026-09-11 12:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0090_ablage_pulse"
down_revision: str | Sequence[str] | None = "0089_gast_zeitfenster"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ablage_pulse_laufwerke",
        sa.Column("guild_id", sa.BigInteger(), nullable=False),
        sa.Column("erstellt_von", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("guild_id"),
        sa.ForeignKeyConstraint(
            ["guild_id"], [f"{SCHEMA}.guilds.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )
    op.create_table(
        "ablage_pulse_objekte",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("guild_id", sa.BigInteger(), nullable=False),
        sa.Column("hochgeladen_von", sa.BigInteger(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("groesse", sa.BigInteger(), nullable=False),
        sa.Column("zustand", sa.SmallInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["guild_id"], [f"{SCHEMA}.guilds.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint("storage_key"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_ablage_pulse_guild",
        "ablage_pulse_objekte",
        ["guild_id", "zustand"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_ablage_pulse_guild", table_name="ablage_pulse_objekte", schema=SCHEMA)
    op.drop_table("ablage_pulse_objekte", schema=SCHEMA)
    op.drop_table("ablage_pulse_laufwerke", schema=SCHEMA)
