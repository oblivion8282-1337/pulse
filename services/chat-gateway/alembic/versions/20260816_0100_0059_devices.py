"""devices: Standplatz-Geräte

Ein Rechner, der in einem Kanal steht, ohne dort Teilnehmer zu sein
(``docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md``). Der Kanal
ist dabei der Rechteanker — an ihm hängt ``REMOTE_CONTROL`` als Overwrite und
damit die Antwort auf „wer darf dieses Gerät übernehmen".

Beide Eindeutigkeiten sind Absicht:

* ``(guild_id, name)`` — zwei gleichnamige Geräte wären in der Kanalliste nicht
  auseinanderzuhalten, und genau dort entscheidet jemand, welchen fremden
  Rechner er übernimmt.
* ``(guild_id, cert_id)`` — ein Rechner trägt sich je Community einmal ein.
  ``cert_id`` ist nullable, und NULL kollidiert in Postgres nie mit NULL; die
  Regel greift also genau dort, wo der Geräteausweis bekannt ist.

Revision ID: 0059_devices
Revises: 0058_backfill_attach_ceilings
Create Date: 2026-08-16 01:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0059_devices"
down_revision: str | None = "0058_backfill_attach_ceilings"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "devices",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("guild_id", sa.BigInteger(), nullable=False),
        sa.Column("channel_id", sa.BigInteger(), nullable=False),
        sa.Column("owner_user_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("cert_id", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["guild_id"], [f"{SCHEMA}.guilds.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["channel_id"], [f"{SCHEMA}.channels.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint("guild_id", "name", name="uq_devices_guild_name"),
        sa.UniqueConstraint("guild_id", "cert_id", name="uq_devices_guild_cert"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_devices_channel", "devices", ["channel_id"], unique=False, schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_index("ix_devices_channel", table_name="devices", schema=SCHEMA)
    op.drop_table("devices", schema=SCHEMA)
