"""rueckfall_signatur_weg — totes Feld entfernt

``device_key_bundles.rueckfall_signatur`` wurde in 0065 mitangelegt, aber nie
gegen den ``device_pubkey`` geprueft (``schluessel_nachweis.py::pruefe_geraet``
verifiziert nur die HAUPT-Signatur — die deckt bereits den
Rueckfallschluessel, weil ``baue_nutzlast("buendel", curve25519,
rueckfallschluessel)`` ihn als drittes Stueck der Nutzlast enthaelt). Eine
zweite, ungeprueftе Unterschrift ist keine zusaetzliche Garantie, nur ein Feld,
das eine vorgibt. Details: Kommentar an ``BundleVeroeffentlichenRequest`` in
``schemas.py`` (dieser PR).

Revision ID: 0068_rueckfall_signatur_weg
Revises: 0067_private_gruppen
Create Date: 2026-08-28 15:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0068_rueckfall_signatur_weg"
down_revision: str | None = "0067_private_gruppen"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.drop_column("device_key_bundles", "rueckfall_signatur", schema=SCHEMA)


def downgrade() -> None:
    op.add_column(
        "device_key_bundles",
        sa.Column("rueckfall_signatur", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
