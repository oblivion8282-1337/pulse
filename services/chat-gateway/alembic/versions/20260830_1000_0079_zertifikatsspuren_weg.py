"""Zwei Zertifikats-Spuren aus dem Geraete-Buendel entfernen

Spec §3b (Entscheidung 2026-08-30): Gerätezertifikate sind ersatzlos
entfallen, ein Gerät weist sich nur noch über die Kontositzung plus seine
selbstbehauptete Kennung aus (``schluessel_nachweis.py``). Zwei Spalten von
``device_key_bundles`` hatten damit **keine Quelle mehr**:

* ``cert_id`` — der Schlüssel, unter dem die Sperrliste (Redis-Set
  ``auth:revoked:certs``) ein widerrufenes Gerät führte. Es gibt keine
  Zertifikate mehr, also auch nichts zu sperren; der Widerruf wird künftig
  sichtbar statt kryptographisch (Geräteliste mit „entfernen", Spec §3b
  Punkt 4). Die beiden Filter, die sie lasen, sind mit dieser Änderung
  entfallen (``routes/schluessel.py``, ``routes/schluessel_auskunft.py``).
* ``signatur`` — die Ed25519-Selbstunterschrift des Geräts über sein eigenes
  Bündel. Sie wurde gespeichert und an ``POST /keys/claim`` weitergereicht,
  aber von **keiner** Fassung des Klienten je geprüft; der private Schlüssel,
  mit dem sie entstand, existiert nicht mehr.

**Warum Löschen und nicht Nullable-Machen.** Eine Spalte, die niemand mehr
befüllen kann, ist eine Behauptung ohne Deckung — und ein Sperrlisten-Filter,
der nie mehr greifen kann, ist schlimmer als keiner: er sieht beim Lesen wie
ein Schutz aus. Was hier fehlt, fehlt sichtbar.

Bestand: beide Spalten werden verworfen. Kein Datenverlust, der jemandem
weh tut — ``cert_id`` zeigt auf Zertifikate, die es nicht mehr gibt, und
``signatur`` war unbenutzt. Der ``downgrade`` kann sie deshalb nur als
NULL-Spalten wiederherstellen, nicht ihren Inhalt.

Revision ID: 0079_zertifikatsspuren_weg
Revises: 0078_geraete_verfall
Create Date: 2026-08-30 10:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0079_zertifikatsspuren_weg"
down_revision: str | None = "0078_geraete_verfall"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.drop_column("device_key_bundles", "cert_id", schema=SCHEMA)
    op.drop_column("device_key_bundles", "signatur", schema=SCHEMA)


def downgrade() -> None:
    # Nur die Huelle zurueck, und ausdruecklich nullable: der Inhalt ist weg
    # und laesst sich nicht rekonstruieren. Ein ``nullable=False`` waere hier
    # eine Luege, die beim ersten Bestandsdatensatz auffliegt.
    op.add_column(
        "device_key_bundles",
        sa.Column("signatur", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "device_key_bundles",
        sa.Column("cert_id", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
