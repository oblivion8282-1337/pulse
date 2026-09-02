"""Gekoppelte Browser verfallen — zwei Merkmale am Buendel

Spec §3a, Punkt 2 (Entscheidung 2026-08-29): ein gekoppelter Browser ist ein
vollwertiges Geraet, seine Kopplung laeuft aber nach 14 Tagen ohne Benutzung
ab. Apps (Electron/Android) verfallen nie.

**Warum ``dauerhaft`` das nicht allein tragen kann.** Es ist EIN Bit und
beantwortet EINE Frage ("ist das eine App?"), gebraucht werden aber zwei, die
sich bei einem gekoppelten Browser widersprechen: er soll ZAEHLEN (wie eine
App) und trotzdem VERFALLEN (wie ein Browser). Drei Klassen — App,
gekoppelter Browser, loser Browser-Tab — passen nicht in ein Bit.

Deshalb zwei Spalten:

* ``gekoppelt_am`` — gesetzt vom SERVER bei ``POST /kopplung/einloesen``
  (``routes/kopplung.py``), nie vom Geraet gemeldet. Anders als ``dauerhaft``
  (Selbstauskunft) ist das ein beobachtetes Ereignis: der Server hat die
  Einloesung selbst durchgefuehrt.
* ``verfallen_am`` — der Grabstein. Er muss existieren, weil der Verfall
  sonst nicht mitteilbar waere: ein blosses Loeschen der Zeile ist von "hat
  noch nie veroeffentlicht" nicht zu unterscheiden, und der Klient darf den
  Verfall NIE aus einem Fehlschlag oder einer Abwesenheit schliessen (er
  loescht daraufhin seinen lokalen Verlauf — die einzige Kopie). Gesetzt wird
  er an zwei Stellen: vom Aufraeumlauf (``schluessel_verfall.py``, ueber
  ``cleanup.py``) und, klebend, beim naechsten Geraete-Nachweis eines
  ueberfaelligen Geraets (``schluessel_nachweis.py``).

Bestand: beide Spalten bleiben NULL. Kein Backfill — ``zuletzt_benutzt``
(Migration 0077) wurde dort aus ``updated_at`` befuellt und kann bei einem
treuen Bestandsgeraet aelter aussehen, als es ist; wer daraus einen Verfall
ableitete, loeschte den Verlauf von Geraeten, die nie weg waren. Der erste
Aufraeumlauf entscheidet stattdessen auf Grundlage der ab jetzt echt
gemessenen Benutzung.

Revision ID: 0078_geraete_verfall
Revises: 0077_zuletzt_benutzt
Create Date: 2026-08-29 20:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0078_geraete_verfall"
down_revision: str | None = "0077_zuletzt_benutzt"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "device_key_bundles",
        sa.Column("gekoppelt_am", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "device_key_bundles",
        sa.Column("verfallen_am", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("device_key_bundles", "verfallen_am", schema=SCHEMA)
    op.drop_column("device_key_bundles", "gekoppelt_am", schema=SCHEMA)
