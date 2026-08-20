"""device_grants: Dauerfreigaben eines Standplatz-Geräts

Die Freigabe lag bis hierher auf dem Gerät (``pulse-stream.json``) und war nur
vor Ort änderbar. Sie zieht auf den Server, damit der Besitzer sie von jedem
seiner Rechner aus verwalten kann — und damit ROLLEN möglich werden, die ein
Client für fremde Communities nie auflösen konnte.

Der Riegel gegen den Missbrauch, gegen den die gerätelokale Fassung gebaut war
(„ein Admin schaltet fremde Rechner scharf"), ist jetzt das Schreibrecht: nur
``devices.owner_user_id`` darf lesen und schreiben, ``MANAGE_GUILD`` nicht.

CASCADE an ``devices``: ein gelöschtes Gerät darf keine Freigaben hinterlassen,
die eine später neu vergebene Kennung erbte.

Revision ID: 0060_device_grants
Revises: 0059_devices
Create Date: 2026-08-20 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0060_device_grants"
down_revision: str | None = "0059_devices"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "device_grants",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("device_id", sa.BigInteger(), nullable=False),
        sa.Column("subject_type", sa.String(length=16), nullable=False),
        sa.Column("subject_id", sa.BigInteger(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("created_by_user_id", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["device_id"], [f"{SCHEMA}.devices.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint(
            "device_id", "subject_type", "subject_id", name="uq_device_grants_subject"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_device_grants_device", "device_grants", ["device_id"], schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_index("ix_device_grants_device", table_name="device_grants", schema=SCHEMA)
    op.drop_table("device_grants", schema=SCHEMA)
