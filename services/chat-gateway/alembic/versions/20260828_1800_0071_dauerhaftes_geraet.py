"""dauerhaftes geraet — die Koexistenz-Regel bekommt eine Spalte

Die Regel (Spec §3): DMs werden nur verschluesselt, wenn beide Konten
mindestens ein DAUERHAFTES Geraet haben (Electron- oder Android-App, nicht
ein blosser Browser-Tab ohne verlaesslichen lokalen Speicher). Der Klient
sendet die Selbstauskunft bereits (``veroeffentlichen.ts::eigenesGeraetDauerhaft``)
und die Rechenregel verlangt sie bereits
(``web/src/lib/krypto/empfaengerGeraete.ts::zielgeraeteBerechnen``) — bisher
fehlte dem Backend nur die Spalte, um sie zu behalten und zurueckzugeben.

``server_default=false``: ein unbekanntes/altes Geraet gilt als NICHT
dauerhaft — fail closed, dieselbe Haltung wie beim optionalen Feld im
Klienten (``empfaengerGeraete.ts``: "Fehlt das Feld, gilt das Geraet als
NICHT dauerhaft").

Revision ID: 0071_dauerhaftes_geraet
Revises: 0070_postfach_indizes
Create Date: 2026-08-28 18:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0071_dauerhaftes_geraet"
down_revision: str | None = "0070_postfach_indizes"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "device_key_bundles",
        sa.Column(
            "dauerhaft",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("device_key_bundles", "dauerhaft", schema=SCHEMA)
