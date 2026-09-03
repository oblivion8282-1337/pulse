"""ablage_kanal_ordner + ablage_kanal_nachtrag — Kanaele als Ordner im Konto-Laufwerk

Ein Ablage-Kanal liegt nicht mehr an einer eigenen Freigabe-Adresse
(``ablage_kanal_laufwerke``), sondern als Ordner ``kanaele/<channel_id>/``
im Konto-Laufwerk seines Erstellers (Entwurf 2026-09-02, §2-3). Diese
Tabelle haelt nur noch, WER der Ersteller ist — die Adresse selbst kommt
weiterhin aus ``AblageKontoLaufwerk``, es gibt EINEN Link je Konto.

``ablage_kanal_nachtrag`` merkt sich Nutzlasten, deren Festigung im Ordner
noch aussteht — angelegt schon im Einliefer-Commit als Marker „Festigung
offen"; eine Pflege-Schleife holt sie nach (mit Wiederholungs-Abstand ueber
``versuche``/``naechster_versuch_at``).

Revision ID: 0088_ablage_kanal_ordner
Revises: 220119df9614
Create Date: 2026-09-02 22:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0088_ablage_kanal_ordner"
down_revision: str | None = "220119df9614"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "ablage_kanal_ordner",
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        sa.Column("ersteller_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
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
    op.create_table(
        "ablage_kanal_nachtrag",
        sa.Column("nutzlast_id", sa.BigInteger(), nullable=False),
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        # Wiederholungs-Buchhaltung des Sweeps (Fixwelle 2 R4): wie oft das
        # Ablegen schon scheiterte und ab wann es wieder probiert wird. Ohne
        # sie liefe eine dauerhaft unerreichbare Cloud in JEDEM Pflegetakt
        # erneut in dieselbe Zeitueberschreitung.
        sa.Column("versuche", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "naechster_versuch_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("nutzlast_id"),
        sa.ForeignKeyConstraint(
            ["nutzlast_id"], [f"{SCHEMA}.dm_nutzlasten.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )
    # Der Sweep waehlt ueber ``naechster_versuch_at <= now()`` und sortiert
    # danach — ohne diesen Index waere jeder Pflegetakt ein Full Scan.
    op.create_index(
        "ix_ablage_kanal_nachtrag_naechster_versuch_at",
        "ablage_kanal_nachtrag",
        ["naechster_versuch_at"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_ablage_kanal_nachtrag_channel_id",
        "ablage_kanal_nachtrag",
        ["channel_id"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_ablage_kanal_nachtrag_channel_id",
        table_name="ablage_kanal_nachtrag",
        schema=SCHEMA,
    )
    op.drop_index(
        "ix_ablage_kanal_nachtrag_naechster_versuch_at",
        table_name="ablage_kanal_nachtrag",
        schema=SCHEMA,
    )
    op.drop_table("ablage_kanal_nachtrag", schema=SCHEMA)
    op.drop_table("ablage_kanal_ordner", schema=SCHEMA)
