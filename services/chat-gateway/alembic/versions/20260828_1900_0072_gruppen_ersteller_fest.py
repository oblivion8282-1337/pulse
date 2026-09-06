"""gruppen_ersteller_fest — Obergrenze zaehlt gegen einen unveraenderlichen Ersteller

Befund 2026-08-28 (Missbrauch): ``ersteller_id`` ist die UEBERTRAGBARE
Besitzerrolle — sie wandert bei ``ersteller_erbe_uebertragen`` automatisch an
das dienstaelteste verbleibende Mitglied, sobald der bisherige Ersteller die
Gruppe verlaesst (Festlegung 1, ``routes/private_gruppen.py``). Die
Obergrenze ``private_group_max_gruppen_je_ersteller`` zaehlte bisher genau
gegen diese Spalte — ein Angreifer legt eine Gruppe mit dem Opfer an,
verlaesst sie sofort wieder, das Opfer erbt automatisch: das Kontingent des
Opfers schrumpft, ohne dass es je selbst ``POST /gruppen`` aufgerufen haette.

Neue Spalte ``erstellt_von_id``: wer die Gruppe TATSAECHLICH angelegt hat,
gesetzt einmal bei der Erstellung, danach nie mehr veraendert — auch nicht
bei der Vererbung. ``ersteller_id`` bleibt unangetastet (Rechte-Traeger).
Bestand: befuellt aus ``ersteller_id`` (bester verfuegbarer Wert — fuer
Altzeilen ist das der wahre Ersteller, weil die Etappe erst seit
Revision 0067 existiert und Vererbung eine Aktion danach voraussetzt).

Revision ID: 0072_gruppen_ersteller_fest
Revises: 0071_dauerhaftes_geraet
Create Date: 2026-08-28 19:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0072_gruppen_ersteller_fest"
down_revision: str | None = "0071_dauerhaftes_geraet"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "private_group_channels",
        sa.Column("erstellt_von_id", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )
    op.execute(
        f"UPDATE {SCHEMA}.private_group_channels SET erstellt_von_id = ersteller_id "
        "WHERE erstellt_von_id IS NULL"
    )
    op.alter_column(
        "private_group_channels",
        "erstellt_von_id",
        nullable=False,
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("private_group_channels", "erstellt_von_id", schema=SCHEMA)
