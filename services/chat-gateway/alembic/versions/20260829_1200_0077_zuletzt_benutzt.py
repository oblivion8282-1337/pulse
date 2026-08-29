"""zuletzt benutzt — der Server kennt bisher nur die letzte Veroeffentlichung

Befund (Spec §3a, Entscheidung 2026-08-29): ``DeviceKeyBundle.updated_at``
ist der Zeitpunkt der letzten Buendel-VEROEFFENTLICHUNG (``PUT
/keys/bundle``), nicht der letzten BENUTZUNG. Zwei Stellen brauchen den
Unterschied:

1. Die Verdraengung bei ``schluessel_max_buendel_je_konto`` Geraeten
   (``schluessel_grenzen.py``) sortiert heute nach ``updated_at`` und trifft
   damit das FALSCHE Geraet — eines, das treu angemeldet bleibt und sich
   deshalb nicht neu veroeffentlicht, sieht genauso alt aus wie eines, das
   niemand mehr benutzt.
2. Der 14-Tage-Ablauf gekoppelter Browser (Spec §3a Punkt 2, spaeterer
   Schritt) braucht ein echtes Benutzungssignal ueberhaupt erst.

Neue Spalte ``zuletzt_benutzt``: aktualisiert von
``schluessel_nachweis.py::pruefe_geraet`` bei jedem erfolgreichen
Geraete-Nachweis (grob aufgeloest, s. Kommentar dort). Bestand: befuellt aus
``updated_at`` — der beste verfuegbare Wert, ein Altzeile hat vor dieser
Revision keine Benutzung nach der letzten Veroeffentlichung aufgezeichnet.

Revision ID: 0077_zuletzt_benutzt
Revises: 0076_absender_konto
Create Date: 2026-08-29 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0077_zuletzt_benutzt"
down_revision: str | None = "0076_absender_konto"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "device_key_bundles",
        sa.Column("zuletzt_benutzt", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.execute(
        f"UPDATE {SCHEMA}.device_key_bundles SET zuletzt_benutzt = updated_at "
        "WHERE zuletzt_benutzt IS NULL"
    )
    op.alter_column(
        "device_key_bundles",
        "zuletzt_benutzt",
        nullable=False,
        server_default=sa.text("now()"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("device_key_bundles", "zuletzt_benutzt", schema=SCHEMA)
