"""Ein Eingefroren-Flag am Alt-Kanal — die Umstellung auf "nur Ablage" braucht es

Spec: ``docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md`` §9,
Etappe E9. Entscheidung des Eigentuemers: neue Kanaele sind ueberall
verschluesselt, auch auf howispulse.com; bestehende Kanaele werden nur noch
lesbar. Das Flag ``legacy_readonly`` am Kanal ist der Schalter, mit dem die
Server-Routen den Klartext-Schreibweg fuer diesen Kanal sperren —
Nachrichten-Post (REST + WS), Klartext-Anhang-Upload — bei laufend
lesbarem Verlauf.

**Warum eine Spalte wie ``ablage`` und keine reine Config-Rechnung.**
``channel_creation_policy`` (Migration 0081-Umfeld) entscheidet nur ueber
die NEUANLAGE und ist eine Instanz-Einstellung ohne Bezug zu einzelnen
Kanaelen. Das Einfrieren bestehender Kanaele ist dagegen ein Zustand JE
KANAL — er muss unabhaengig von der aktuellen Config lesbar bleiben (auch
wenn die Instanz die Policy spaeter wieder zurückdreht, soll ein einmal
eingefrorener Alt-Kanal nicht wortlos wieder beschreibbar werden) und er
muss dem Frontend mitgeteilt werden koennen, ohne bei jeder Anzeige
Instanz-Config zu spiegeln.

**Bestand + alle Neuanlagen bekommen FALSE.** Das ist die ausdrueckliche
Vorgabe fuer diese Etappe: der Schalter wird gebaut, aber NICHT umgelegt —
eine laufende Instanz (howispulse.com eingeschlossen) friert dadurch keine
einzige Unterhaltung ein. Das tatsaechliche Umlegen ist ein bewusster,
spaeterer Handgriff des Betreibers (z. B. eine gezielte UPDATE-Anweisung auf
bestehende reguläre Textkanaele), nicht Teil dieser Migration.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0083_legacy_readonly"
down_revision: str | None = "0082_ablage_freigabe_adresse"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "channels",
        sa.Column("legacy_readonly", sa.Boolean(), nullable=False, server_default=sa.false()),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("channels", "legacy_readonly", schema=SCHEMA)
