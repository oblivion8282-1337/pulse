"""postfach — Nutzlast und Zustellung fuer Etappe D (E2E-DM)

Der Server nimmt verschluesselte Umschlaege entgegen, haelt sie bis zur
Abholung, und loescht sie danach — quittiert oder verfristet. Zwei Tabellen:
``dm_nutzlasten`` (der Umschlag, evtl. von mehreren Zustellungen geteilt —
Megolm-Gruppenfall) und ``dm_zustellungen`` (eine Zeile je Empfaengergeraet,
mit Frist). Details: ``models/postfach.py``, §4 der Spec.

Revision ID: 0066_postfach
Revises: 0065_geraete_schluessel
Create Date: 2026-08-28 13:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0066_postfach"
down_revision: str | None = "0065_geraete_schluessel"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "dm_nutzlasten",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        sa.Column("absender_device_pubkey", sa.Text(), nullable=False),
        sa.Column("art", sa.SmallInteger(), nullable=False),
        sa.Column("daten", sa.Text(), nullable=False),
        sa.Column("groesse", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_dm_nutzlasten_channel", "dm_nutzlasten", ["channel_id"], schema=SCHEMA
    )

    op.create_table(
        "dm_zustellungen",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("nutzlast_id", sa.BigInteger(), nullable=False),
        sa.Column("empfaenger_device_pubkey", sa.Text(), nullable=False),
        sa.Column("empfaenger_user_id", sa.BigInteger(), nullable=False),
        sa.Column("verfaellt_am", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["nutzlast_id"], [f"{SCHEMA}.dm_nutzlasten.id"], ondelete="CASCADE"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_dm_zustellungen_empfaenger",
        "dm_zustellungen",
        ["empfaenger_device_pubkey", "id"],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_dm_zustellungen_verfaellt", "dm_zustellungen", ["verfaellt_am"], schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_index("ix_dm_zustellungen_verfaellt", table_name="dm_zustellungen", schema=SCHEMA)
    op.drop_index(
        "ix_dm_zustellungen_empfaenger", table_name="dm_zustellungen", schema=SCHEMA
    )
    op.drop_table("dm_zustellungen", schema=SCHEMA)
    op.drop_index("ix_dm_nutzlasten_channel", table_name="dm_nutzlasten", schema=SCHEMA)
    op.drop_table("dm_nutzlasten", schema=SCHEMA)
