"""ablage_guild_laufwerke — die Freigabe-Adresse des Community-Laufwerks

Etappe E8 (Design ``docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md``
§7). Eine Zeile je Community mit verbundenem Laufwerk: der Schreib-Link, den
nur der Server kennt. Anders als beim Kanal-Pendant (Migration 0082) traegt
diese Tabelle KEIN eigenes ``ersteller_id`` — ``Guild.owner_id`` uebernimmt
diese Rolle bereits, s. Klassen-Docstring in ``models/ablage_laufwerk.py``.

Revision ID: 0084_ablage_guild_laufwerk
Revises: 0083_legacy_readonly
Create Date: 2026-09-01 13:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0084_ablage_guild_laufwerk"
down_revision: str | None = "0083_legacy_readonly"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "ablage_guild_laufwerke",
        sa.Column("guild_id", sa.BigInteger(), nullable=False),
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
        sa.PrimaryKeyConstraint("guild_id"),
        sa.ForeignKeyConstraint(
            ["guild_id"], [f"{SCHEMA}.guilds.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("ablage_guild_laufwerke", schema=SCHEMA)
