"""ablage_konto_laufwerke — das Cloud-Laufwerk des persoenlichen Archivs

Spec: ``docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md`` §5.
Der dritte der drei Schreib-Links, die nur Pulse kennt (Entscheidung des
Eigentuemers am 2026-08-31), neben Kanal (0082) und Community (0084).

**Warum der Server ihn braucht, obwohl es der eigene Ordner des Nutzers
ist.** Rein technisch: ein Browser kann in eine fremde Cloud nicht
schreiben, weil deren Server keine CORS-Kopfzeilen setzt — an einer echten
Nextcloud gemessen (2026-09-01: Vorabfrage und echtes ``PUT`` ohne jede
``Access-Control-Allow-Origin``-Kopfzeile, waehrend derselbe Aufruf
serverseitig 201 liefert). Ohne diese Zeile gaebe es das persoenliche
Archiv nur auf einem lokalen Sync-Ordner, nicht in einer Cloud — und damit
nicht das, wofuer es gedacht ist: den Verlauf auf einem NEUEN Geraet
zurueckzuholen.

**Eines je Konto** (``user_id`` als Primaerschluessel): ein zweites
eingetragenes Laufwerk ersetzt das erste. Mehrere gleichzeitige Archive
waeren ein anderes Feature und braeuchten eine Antwort darauf, in welches
geschrieben wird.

Kein ``ForeignKey`` auf die Nutzertabelle: die liegt im auth-Schema, und
der chat-gateway greift nie ueber Schemagrenzen. Aufgeraeumt wird beim
Kontoloeschen (``user_purge_ablage.py``).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0086_ablage_konto_laufwerk"
down_revision: str | None = "0085_ablage_zwischenlager"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "ablage_konto_laufwerke",
        sa.Column("user_id", sa.BigInteger(), primary_key=True),
        sa.Column("freigabe_adresse", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("ablage_konto_laufwerke", schema=SCHEMA)
