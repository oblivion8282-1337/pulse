"""umzug-stuecke: inhalts-kennung fuer stale Fortsetzungen (Bughunt 2026-08-29)

Ohne diese Spalte konnte eine Fortsetzung nach einer Bearbeitung/Loeschung
WAEHREND der 48-Stunden-Frist ein veraltetes Stueck stillschweigend
uebernehmen: der Sender vertraute ``vorhandene_stuecke`` allein anhand der
Positionszahl, sobald ``gesamt_stuecke`` noch ``NULL`` war (Begruendung in
``web/src/lib/kopplung/senden.ts``). Diese Spalte traegt einen vom Klienten
aus dem Klartext abgeleiteten HMAC (Schluessel per HKDF aus dem
Kopplungscode, den der Server nie sieht) — der Sender vergleicht ihn beim
Fortsetzen gegen den lokal neu berechneten Wert und schiebt ein Stueck neu,
wenn er nicht mehr passt. Der Server selbst kann daraus nichts ueber den
Inhalt lernen (HMAC, kein Klartext-Hash).

Revision ID: 0075_umzug_kennung
Revises: 0074_geraete_kopplung
Create Date: 2026-08-29 10:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0075_umzug_kennung"
down_revision: str | None = "0074_geraete_kopplung"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "umzug_stuecke",
        sa.Column("kennung", sa.Text(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("umzug_stuecke", "kennung", schema=SCHEMA)
