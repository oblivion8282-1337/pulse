"""ablage_zwischenlager_dateien — Chiffrat, das auf Festigung wartet

Etappe E8 (Design §7). Ein Mitglied laedt hoch, ein Geraet des Community-
Besitzers festigt es ins Laufwerk und quittiert — erst dann faellt die Zeile.
S. ``models/ablage_zwischenlager.py``.

Revision ID: 0085_ablage_zwischenlager
Revises: 0084_ablage_guild_laufwerk
Create Date: 2026-09-01 13:30:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0085_ablage_zwischenlager"
down_revision: str | None = "0084_ablage_guild_laufwerk"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "ablage_zwischenlager_dateien",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("guild_id", sa.BigInteger(), nullable=False),
        sa.Column("hochgeladen_von", sa.BigInteger(), nullable=False),
        sa.Column("groesse", sa.BigInteger(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
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
        schema=SCHEMA,
    )
    op.create_index(
        "ix_ablage_zwischenlager_guild",
        "ablage_zwischenlager_dateien",
        ["guild_id", "id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_ablage_zwischenlager_guild",
        table_name="ablage_zwischenlager_dateien",
        schema=SCHEMA,
    )
    op.drop_table("ablage_zwischenlager_dateien", schema=SCHEMA)
