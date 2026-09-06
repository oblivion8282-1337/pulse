"""ablage_kanal_laufwerke — die Freigabe-Adresse eines Ablage-Kanals

Etappe E7 (Design ``docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md``
§4.1/§4.2). Eine Zeile je Ablage-Kanal mit Laufwerk: der Schreib-Link, den
nur der Server kennt, plus wer ihn zuerst gesetzt hat (``ersteller_id`` —
danach der einzige, der ihn ersetzen darf). Begruendung fuer die eigene
Tabelle statt einer Spalte an ``channels``: ``models/ablage_laufwerk.py``.

Revision ID: 0082_ablage_freigabe_adresse
Revises: 0081_ablage_flag
Create Date: 2026-09-01 09:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0082_ablage_freigabe_adresse"
down_revision: str | None = "0081_ablage_flag"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "ablage_kanal_laufwerke",
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        sa.Column("ersteller_id", sa.BigInteger(), nullable=False),
        sa.Column("freigabe_adresse", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("channel_id"),
        sa.ForeignKeyConstraint(
            ["channel_id"], [f"{SCHEMA}.channels.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("ablage_kanal_laufwerke", schema=SCHEMA)
