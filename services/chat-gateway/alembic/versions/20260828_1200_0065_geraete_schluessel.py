"""geraete_schluessel — das Schluesselverzeichnis fuer Etappe B (E2E-DM)

Ein Geraet veroeffentlicht sein Schluessel-Buendel (Identitaets-, Signatur-
und Rueckfallschluessel) sowie einen Vorrat an Einmalschluesseln beim
chat-gateway. Ein Absender holt sich davon je Gegenueber-Geraet genau einen
Einmalschluessel ab, verbraucht ihn dabei. Details: ``schluessel_nachweis.py``
und ``docs/superpowers/specs/2026-08-28-e2e-dm-design.md`` §2.

Gefuehrt wird das Buendel ueber ``(user_id, device_pubkey)``, nicht ueber
``cert_id`` — die Zertifikatserneuerung stellt alle 30 Tage ein neues
Zertifikat fuer denselben Pubkey aus, ein an der cert_id haengendes Buendel
wuerde monatlich verwaisen.

Diese Revision haengt bewusst an 0063 und nicht an dem parallelen Zweig
0064_message_pinned_at, der ebenfalls von 0063 abzweigt. Historisch hiess
der Zweig 0064_drop_community_invites; die beiden Koepfe sind inzwischen
durch die Merge-Revision 220119df9614 (down_revision-Tuple) vereint —
`alembic upgrade head` bricht NICHT mehr ab, und der Waechter
tests/test_alembic_koepfe.py wacht weiter. Bitte die down_revisions dieser
Datei NICHT mehr von Hand umbiegen: das wuerde die Merge-Eltern auf einen
Strang legen und die Kette brechen. Die Nummer 0065 ist schon so vergeben,
dass die Reihenfolge stimmt.

Revision ID: 0065_geraete_schluessel
Revises: 0063_einladungen_ohne_dm
Create Date: 2026-08-28 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0065_geraete_schluessel"
down_revision: str | None = "0063_einladungen_ohne_dm"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "device_key_bundles",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("device_pubkey", sa.Text(), nullable=False),
        sa.Column("curve25519", sa.Text(), nullable=False),
        sa.Column("signatur", sa.Text(), nullable=False),
        sa.Column("rueckfallschluessel", sa.Text(), nullable=True),
        sa.Column("rueckfall_signatur", sa.Text(), nullable=True),
        sa.Column("cert_id", sa.Text(), nullable=False),
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
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "device_pubkey", name="uq_device_key_bundles_geraet"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_device_key_bundles_user", "device_key_bundles", ["user_id"], schema=SCHEMA
    )

    op.create_table(
        "device_one_time_keys",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("bundle_id", sa.BigInteger(), nullable=False),
        sa.Column("schluessel", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["bundle_id"], [f"{SCHEMA}.device_key_bundles.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint("bundle_id", "schluessel", name="uq_device_otk"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_device_otk_bundle", "device_one_time_keys", ["bundle_id"], schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_index("ix_device_otk_bundle", table_name="device_one_time_keys", schema=SCHEMA)
    op.drop_table("device_one_time_keys", schema=SCHEMA)
    op.drop_index(
        "ix_device_key_bundles_user", table_name="device_key_bundles", schema=SCHEMA
    )
    op.drop_table("device_key_bundles", schema=SCHEMA)
