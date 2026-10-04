"""gruppen_lesestand — serverseitiger Lesefortschritt je Gruppenmitglied
(Übergabe 05.10.): der Lese-Haken an der Gruppen-Bubble zeigt blau, wenn
ALLE anderen Mitglieder bis zu dieser Nachricht gelesen haben. Dasselbe
Muster wie ``dm_lesestand`` (0094): numerisch-opake IDs, der Server sieht
Lesefortschritt-Metadaten, nie Inhalte.

Revision ID: 0099_gruppen_lesestand
Revises: 0098_archiv
Create Date: 2026-10-04 11:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0099_gruppen_lesestand"
down_revision: str | Sequence[str] | None = "0098_archiv"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "gruppen_lesestand",
        sa.Column("gruppe_id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("last_read_message_id", sa.BigInteger(), nullable=False),
        sa.Column("gelesen_am", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("gruppe_id", "user_id", name="pk_gruppen_lesestand"),
        sa.ForeignKeyConstraint(
            ["gruppe_id"],
            ["chat.private_group_channels.id"],
            name="fk_gruppen_lesestand_gruppe",
            ondelete="CASCADE",
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_gruppen_lesestand_user",
        "gruppen_lesestand",
        ["user_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_gruppen_lesestand_user", table_name="gruppen_lesestand", schema=SCHEMA)
    op.drop_table("gruppen_lesestand", schema=SCHEMA)
