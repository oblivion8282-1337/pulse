"""Ein Ablage-Flag am Kanal — die Instanz-Einstellung „Nur Ablage" braucht es

Spec: ``docs/user-gehostete-kanaele-konzept.md`` §2a (Instanz-Einstellung).
Im Modus „Nur Ablage" angelegte Textkanäle sind **serverblind**: Inhalte
(Nachrichten, Anhänge) leben client-verschlüsselt im Laufwerk des Erstellers,
nie in ``chat.messages`` oder MinIO. Das Flag ``ablage`` am Kanal ist der
Schalter, mit dem die Server-Routen den Klartext-Weg für diesen Kanal
sperren — Nachrichten-Post, Klartext-Anhang-Upload, WS-Send.

**Warum eine Spalte und kein eigener Kanaltyp.** Ablage-Kanäle bleiben
Guild-Kanäle: Mitgliedschaft, Rechte, Position und Namen sind Metadaten, die
der Server weiterhin kennt und verwaltet. Nur der INHALT ist clientseitig.
Ein eigener Kanaltyp würde jede Liste, jedes Overwrite und jeden
Sidebar-Pfad duplizieren, ohne etwas zu schützen.

Bestand: alle vorhandenen Zeilen bekommen FALSE — reguläre Kanäle sind und
bleiben genau so, wie sie waren. Die Instanz-Einstellung
(``channel_creation_policy``) entscheidet nur über die NEUANLAGE.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0081_ablage_flag"
down_revision: str | None = "0080_geraet_entfernt"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "channels",
        sa.Column("ablage", sa.Boolean(), nullable=False, server_default=sa.false()),
        schema=SCHEMA,
    )


def downgrade() -> None:
    # Ablage-Kanäle wären danach reguläre Kanäle — ihre Inhalte liegen
    # ohnehin nicht auf dem Server, also ist der Rollback verlustfrei fuer
    # den Server, aber die Klienten verlangen danach den Krypto-Weg weiter.
    op.drop_column("channels", "ablage", schema=SCHEMA)
