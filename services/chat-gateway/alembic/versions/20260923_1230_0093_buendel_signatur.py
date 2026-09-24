"""Signiertes Buendel: ed25519-Identitaet + Buendel-Signatur (Bughunt 2026-09-23)

Das Schluesselverzeichnis trug bislang keine kryptographische Bindung zwischen
Geraet und seinen Schluesseln: ``curve25519`` und ``rueckfallschluessel``
standen als nackte Strings in der Zeile, und der Claim lieferte sie so weiter.
Ein kompromittierter Server konnte beides stumm austauschen und sich damit in
JEDE neue DM-Sitzung einschleusen — genau der Gegner, gegen den E2EE existiert.

Zwei neue, NULL-bare Spalten (rein additiv, Bestandszeilen bleiben unveraendert
und gelten im Klienten solange als "unsigniert"):

* ``ed25519`` — der oeffentliche Ed25519-Identitaetsschluessel des Olm-Accounts,
  der das Buendel signiert hat. Er wurde bislang NIRGENDS publiziert (die
  vodozemac-API dafuer schlummerte ungenutzt in der Kiste).
* ``bundel_signatur`` — die Ed25519-Signatur ueber die kanonische Form von
  ``(device_pubkey, curve25519, rueckfallschluessel)``. Beim Claim verifiziert
  sie der Klient (``signaturPruefen`` im wasm-Paket) und pinnt das Geraet
  (TOFU); ein Kandidat dieser Spalte passt nicht zum Signierfeld, fliegt die
  Zustellung an das Geraet hart auf die Fehlerseite.

Die alte ``signatur``-Spalte (gefallen mit Migration 0079) war eine
Durchreiche ohne Prufer — diese hier hat einen: jeden Klienten ab diesem
Einschlag, und einen Test in ``tests/test_schluessel_buendel.py``.

Anmerkung zur Nummerierung: `feat/mobile` traegt ebenfalls 009xer Revisionen
(rein additiv); bei der Zusammenfuehrung entscheidet wie schon bei
220119df9614 die Merge-Revision, und tests/test_alembic_koepfe.py wacht
darueber.

Revision ID: 0093_buendel_signatur
Revises: 0091_pubkey_eindeutig
Create Date: 2026-09-23 12:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0093_buendel_signatur"
down_revision: str | Sequence[str] | None = "0092_drop_community_invites"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "device_key_bundles",
        sa.Column("ed25519", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "device_key_bundles",
        sa.Column("bundel_signatur", sa.Text(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("device_key_bundles", "bundel_signatur", schema=SCHEMA)
    op.drop_column("device_key_bundles", "ed25519", schema=SCHEMA)
