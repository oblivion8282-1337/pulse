"""zustellstand + user_privacy.lesebestaetigungen — die Häkchen-Treppe
übersteht einen Neustart, und Lesebestätigungen lassen sich abschalten.

``zustellstand`` hält je (Kanal, Absender, Empfänger) die kanonische ID der
jüngsten Nachricht, die beim Empfänger angekommen ist (doppelter grauer
Haken). Bis hierher lebte der Haken nur im Arbeitsspeicher des Absenders und
nur, wenn er beim Abholen gerade online war. Numerisch-opak wie
``dm_lesestand``: der Server sieht Zustell-Metadaten, nie Inhalte.

``channel_id`` zeigt polymorph auf eine DM ODER eine private Gruppe — kein
Fremdschlüssel (dasselbe Muster wie ``anrufe.channel_id``); aufgeräumt wird
von Hand an den Löschstellen (``user_purge.py``, Gruppe auflösen, Mitglied
entfernen).

Revision ID: 0101_zustellstand
Revises: 0100_cached_user_profiles_lower
Create Date: 2026-10-10 10:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0101_zustellstand"
down_revision: str | Sequence[str] | None = "0100_cached_user_profiles_lower"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "zustellstand",
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        sa.Column("absender_user_id", sa.BigInteger(), nullable=False),
        sa.Column("empfaenger_user_id", sa.BigInteger(), nullable=False),
        sa.Column("zugestellt_bis", sa.BigInteger(), nullable=False),
        sa.Column(
            "aktualisiert_am",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "channel_id", "absender_user_id", "empfaenger_user_id", name="pk_zustellstand"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_zustellstand_absender", "zustellstand", ["absender_user_id"], schema=SCHEMA
    )
    op.create_index(
        "ix_zustellstand_empfaenger", "zustellstand", ["empfaenger_user_id"], schema=SCHEMA
    )
    op.add_column(
        "user_privacy",
        sa.Column(
            "lesebestaetigungen",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("user_privacy", "lesebestaetigungen", schema=SCHEMA)
    op.drop_index("ix_zustellstand_empfaenger", table_name="zustellstand", schema=SCHEMA)
    op.drop_index("ix_zustellstand_absender", table_name="zustellstand", schema=SCHEMA)
    op.drop_table("zustellstand", schema=SCHEMA)
