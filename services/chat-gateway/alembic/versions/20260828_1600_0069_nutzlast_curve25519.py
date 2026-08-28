"""nutzlast curve25519 — der Absender-Schluessel, den ein frischer Sitzungsaufbau braucht

Olm braucht fuer ``sitzung_eingehend`` (X3DH-Gegenstueck) den Curve25519-
Identitaetsschluessel des ABSENDERS als eigenes Argument — ein
Sitzungsaufbau-Umschlag (``PreKeyMessage``) traegt ihn NICHT mit (Standard-
Olm-Verhalten, s. ``identitaet.rs::sitzung_eingehend``). Ohne diese Spalte
haette der Empfaenger keinen Weg, den Curve25519-Schluessel eines Absenders
zu erfahren, ohne dessen Einmalschluessel-Vorrat mit einem zweckfremden
``POST /keys/claim`` zu verbrauchen.

``routes/postfach.py`` fuellt sie beim Einliefern aus dem EIGENEN Buendel
des einliefernden Geraets (``claims.device_pubkey``, bereits durch den
Geraete-Nachweis geprueft) — kein neuer Vertrauensschritt.

Nullable: Bestandszeilen (falls es welche gaebe) kennen den Wert nicht, und
der Server erzwingt ihn nicht (dieselbe Haltung wie bei ``art``: der Server
oeffnet den Umschlag nie, die Bedeutung gehoert dem Klienten).

Revision ID: 0069_curve25519
Revises: 0068_rueckfall_signatur_weg
Create Date: 2026-08-28 16:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0069_curve25519"
down_revision: str | None = "0068_rueckfall_signatur_weg"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "dm_nutzlasten",
        sa.Column("absender_curve25519", sa.Text(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("dm_nutzlasten", "absender_curve25519", schema=SCHEMA)
