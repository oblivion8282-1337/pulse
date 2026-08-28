"""geraete-kopplung und verlaufsumzug (Etappe F)

Zwei Tabellen, Begruendung in ``models/kopplung.py``:

* ``kopplungen`` — die Verabredung zwischen einem eingerichteten und einem
  neuen Geraet DESSELBEN Kontos. Gespeichert wird nur der SHA-256 des Codes,
  nie der Code selbst; ``code_hash`` ist deshalb eindeutig (das einloesende
  Geraet sucht ueber ihn, es kennt die ``id`` noch nicht).
* ``umzug_stuecke`` — die verschluesselten Stuecke des Verlaufs, kaskadierend
  an der Kopplung. ``(kopplung_id, folge)`` ist eindeutig: erst das macht ein
  Wiederholen nach Abbruch gefahrlos, statt Dubletten anzulegen.

Revision ID: 0074_geraete_kopplung
Revises: 0073_verschl_anhaenge
Create Date: 2026-08-29 09:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0074_geraete_kopplung"
down_revision: str | None = "0073_verschl_anhaenge"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "kopplungen",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("alt_device_pubkey", sa.Text(), nullable=False),
        sa.Column("neu_device_pubkey", sa.Text(), nullable=True),
        sa.Column("eingeloest_am", sa.DateTime(timezone=True), nullable=True),
        sa.Column("gesamt_stuecke", sa.BigInteger(), nullable=True),
        sa.Column("verfaellt_am", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code_hash", name="uq_kopplungen_code_hash"),
        schema=SCHEMA,
    )
    op.create_index("ix_kopplungen_user", "kopplungen", ["user_id"], schema=SCHEMA)
    op.create_index(
        "ix_kopplungen_verfaellt", "kopplungen", ["verfaellt_am"], schema=SCHEMA
    )

    op.create_table(
        "umzug_stuecke",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("kopplung_id", sa.BigInteger(), nullable=False),
        sa.Column("folge", sa.BigInteger(), nullable=False),
        sa.Column("daten", sa.Text(), nullable=False),
        sa.Column("groesse", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["kopplung_id"], [f"{SCHEMA}.kopplungen.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint("kopplung_id", "folge", name="uq_umzug_stuecke_folge"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_umzug_stuecke_kopplung",
        "umzug_stuecke",
        ["kopplung_id", "folge"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_umzug_stuecke_kopplung", table_name="umzug_stuecke", schema=SCHEMA)
    op.drop_table("umzug_stuecke", schema=SCHEMA)
    op.drop_index("ix_kopplungen_verfaellt", table_name="kopplungen", schema=SCHEMA)
    op.drop_index("ix_kopplungen_user", table_name="kopplungen", schema=SCHEMA)
    op.drop_table("kopplungen", schema=SCHEMA)
