"""dm-lesestand (serverseitiger Lesefortschritt je Teilnehmer)

Revision ID: 0090_dm_lesestand
Revises: 0089_gast_zeitfenster
Create Date: 2026-09-08 01:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0090_dm_lesestand"
down_revision: str | Sequence[str] | None = "0089_gast_zeitfenster"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Serverseitiger Lesefortschritt je DM-Teilnehmer (Übergabe P0.2): Zähler
    # müssen geräteübergreifend stimmen und einen Cache-Clear überleben — der
    # rein lokale localStorage-Stand (readState.svelte.ts) kann beides nicht.
    # ``last_read_message_id`` ist numerisch-opak: echte Snowflakes im
    # Klartext-Weg, die 19-stelligen lokalen E2EE-IDs im verschlüsselten Weg
    # (beide passen in BIGINT und vergleichen sich über die eingebettete
    # Zeit — s. web/src/lib/utils/snowflake.ts). Der Server sieht damit
    # Lesefortschritt-Metadaten, nie Nachrichtinhalte — die dokumentierte
    # Abwägung der Übergabe.
    op.create_table(
        "dm_lesestand",
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("last_read_message_id", sa.BigInteger(), nullable=False),
        sa.Column("gelesen_am", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("channel_id", "user_id", name="pk_dm_lesestand"),
        sa.ForeignKeyConstraint(
            ["channel_id"],
            ["chat.direct_message_channels.id"],
            name="fk_dm_lesestand_channel",
            ondelete="CASCADE",
        ),
        schema=SCHEMA,
    )
    # Der eine Lesepfad: „beim Verbinden die eigenen Stände + die der
    # Gegenstellen je DM holen“ (ws_ready) und „Beitritt/ein Event für die
    # Gegenstelle“ — beides fragt nach user_id.
    op.create_index(
        "ix_dm_lesestand_user",
        "dm_lesestand",
        ["user_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_dm_lesestand_user", table_name="dm_lesestand", schema=SCHEMA)
    op.drop_table("dm_lesestand", schema=SCHEMA)
