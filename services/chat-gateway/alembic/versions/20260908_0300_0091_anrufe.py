"""anrufe — Call-Entität für DM- und Gruppenanrufe (Übergabe P0 Anrufe-Epic A)

Revision ID: 0091_anrufe
Revises: 0090_dm_lesestand
Create Date: 2026-09-08 03:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0091_anrufe"
down_revision: str | Sequence[str] | None = "0090_dm_lesestand"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Ein Anruf hängt an einem DM-Kanal oder einer privaten Gruppe —
    # ``channel_id`` ist polymorph (wie Message.channel_id), deshalb ohne
    # FK. Der LiveKit-Raum heißt deterministisch ``call-{id}``; Membership
    # prüfen die Routen gegen die DM-/Gruppen-Teilnehmer.
    op.create_table(
        "anrufe",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("art", sa.SmallInteger(), nullable=False),  # 0=dm, 1=gruppe
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        sa.Column("einleiter_id", sa.BigInteger(), nullable=False),
        sa.Column("zustand", sa.SmallInteger(), nullable=False),  # 0=klingelnd, 1=laufend, 2=beendet
        sa.Column("grund", sa.SmallInteger(), nullable=True),  # 0=aufgelegt, 1=abgelehnt, 2=verpasst
        sa.Column("verbunden_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("beendet_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("erstellt_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_anrufe_channel_erstellt",
        "anrufe",
        ["channel_id", "erstellt_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_anrufe_channel_erstellt", table_name="anrufe", schema=SCHEMA)
    op.drop_table("anrufe", schema=SCHEMA)
