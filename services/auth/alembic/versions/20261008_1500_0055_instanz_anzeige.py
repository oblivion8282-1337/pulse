"""instanz_anzeige — Anzeigename + gemeldeter Online-Zustand je Instanz.

``anzeigename``: der Name, den der Betreiber seinem Heim-Server gibt. Bis
hierher lag er nur im chat-gateway des Servers selbst (``chat_settings.
instance_name``) und erreichte ein Gerät erst nach dem ersten Verbinden — die
Server-Leiste, die aus der Cloud gebaut wird, zeigte deshalb die Relay-Adresse.

``online_gemeldet``: der zuletzt an die Mitglieder gemeldete Zustand. Die
Cloud vergleicht ihn mit dem Telefonbuch (Heartbeat/Abschied/Zeitablauf) und
schickt nur bei einem WECHSEL ein Ereignis — ohne diese Spalte könnte der
Wächter einen abgestürzten Server nicht von einem schon gemeldeten trennen.

Revision ID: 0055_instanz_anzeige
Revises: 0054_archiv_schluessel
Create Date: 2026-10-08 15:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# Revision-ID max. 32 Zeichen (``alembic_version.version_num`` ist varchar(32)).
revision: str = "0055_instanz_anzeige"
down_revision: str | None = "0054_archiv_schluessel"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "registered_instances",
        sa.Column("anzeigename", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "registered_instances",
        sa.Column(
            "online_gemeldet", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("registered_instances", "online_gemeldet", schema=SCHEMA)
    op.drop_column("registered_instances", "anzeigename", schema=SCHEMA)
