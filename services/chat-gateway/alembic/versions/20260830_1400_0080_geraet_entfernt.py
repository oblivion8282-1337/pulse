"""Ein Gerät entfernen — der Grabstein, der die Sperrliste ersetzt

Spec §3b, Punkt 4. Mit den Zertifikaten sind auch ``cert_id`` und die beiden
Sperrlisten-Filter gefallen (Migration 0079); seither gibt es **keinen Weg,
ein einzelnes Gerät auszusperren**. Wer sein Telefon verliert, kann es nicht
aus seinem Konto werfen. Diese Spalte ist der Ersatz: der Widerruf wird
sichtbar statt kryptographisch.

**Warum ein Grabstein und kein Löschen der Zeile.** ``PUT /keys/bundle`` ist
eine der beiden Routen, die ein noch UNBEKANNTES Gerät zulassen müssen (die
Zeile entsteht ja dort). Eine gelöschte Zeile legt das entfernte Gerät beim
nächsten Start deshalb einfach neu an und liest weiter mit — ein Löschen wäre
also gar kein Widerruf, sondern nur eine Pause bis zum nächsten Start des
Geräts. Derselbe Grund, aus dem der Verfall einen Grabstein bekam
(``schluessel_verfall.py``), und ein zweiter dazu: nur eine dagebliebene
Zeile kann dem Gerät sagen, WARUM es nicht mehr darf
(``GET /keys/geraetestand`` → ``entfernt``), und nur auf ein solches
ausdrückliches Signal hin darf der Klient seinen lokalen Verlauf löschen.

**Getrennt von ``verfallen_am``, nicht mit ihm verschmolzen.** Beide sagen
„dieses Gerät ist raus", aber aus verschiedenen Gründen, und der Unterschied
ist für den Nutzer sichtbar: Verfall ist automatisch und unbeabsichtigt
(14 Tage nicht benutzt), Entfernen ist ein Entschluss des Kontoinhabers. Eine
Spalte für beides könnte die Meldung an das Gerät nicht mehr richtig
formulieren — und der Nutzer sähe in der Geräteliste nicht, was er selbst
getan hat.

Bestand: alle vorhandenen Zeilen bekommen NULL, also „nicht entfernt". Das
ist der richtige Vorgabewert — es hat bis heute niemand etwas entfernen
können.

Revision ID: 0080_geraet_entfernt
Revises: 0079_zertifikatsspuren_weg
Create Date: 2026-08-30 14:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0080_geraet_entfernt"
down_revision: str | None = "0079_zertifikatsspuren_weg"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "device_key_bundles",
        sa.Column("entfernt_am", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    # Der Inhalt geht dabei verloren, und das ist beim Zurueckrollen keine
    # Kleinigkeit: entfernte Geraete waeren danach wieder Empfaenger. Ein
    # Downgrade dieser Migration gehoert deshalb nur in eine Notlage, in der
    # ohnehin niemand verschluesselt schreibt.
    op.drop_column("device_key_bundles", "entfernt_am", schema=SCHEMA)
