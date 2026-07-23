"""guilds: Attachment-Obergrenzen aus dem Bestandswert backfillen

0057 hat ``attachment_max_size_ceiling_bytes`` und ``attachment_max_count_ceiling``
als NULL dazugelegt. NULL heißt „nimm den Instanz-Standard" (25 MiB / 4). Für
Bestandsdeployments, bei denen der Betreiber im alten Modell die Werte-Spalten
``attachment_max_size_bytes`` / ``attachment_max_count_per_message`` schon
angehoben hatte (dort war dieselbe Spalte Wert UND Obergrenze), läge die neue
Obergrenze damit UNTER dem gewünschten Wert — beim nächsten Speichern eines
Limits-Formulars würde ``clamp_to_ceilings`` den Wert still auf 25 MiB / 4
herunterziehen (stille Regression, nur restriktive Richtung).

Fix: die neue Obergrenze mit dem aktuellen Wert vorbelegen, wo sie noch NULL
ist. Für Guilds am Default (25 MiB / 4) ist das ein No-Op im Verhalten
(NULL→Default == expliziter Default); für angehobene Guilds bleibt die
Betreibervorgabe erhalten.

Revision ID: 0058_backfill_attach_ceilings
Revises: 0057_community_own_limits
Create Date: 2026-07-24 10:00:00
"""
from __future__ import annotations

from alembic import op

revision: str = "0058_backfill_attach_ceilings"
down_revision: str | None = "0057_community_own_limits"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE {SCHEMA}.guilds
        SET attachment_max_size_ceiling_bytes = attachment_max_size_bytes
        WHERE attachment_max_size_ceiling_bytes IS NULL
        """
    )
    op.execute(
        f"""
        UPDATE {SCHEMA}.guilds
        SET attachment_max_count_ceiling = attachment_max_count_per_message
        WHERE attachment_max_count_ceiling IS NULL
        """
    )


def downgrade() -> None:
    # Zurück in den 0057-Zustand: „nicht gesetzt" == NULL == Instanz-Standard.
    op.execute(
        f"""
        UPDATE {SCHEMA}.guilds
        SET attachment_max_size_ceiling_bytes = NULL,
            attachment_max_count_ceiling = NULL
        """
    )
