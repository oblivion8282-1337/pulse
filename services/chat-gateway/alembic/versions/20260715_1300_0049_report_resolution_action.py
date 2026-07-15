"""reports.resolution_action — Ausgang einer erledigten Meldung

Welche Maßnahme beim Erledigen ergriffen wurde (``ban`` | ``message_delete`` |
…) bzw. NULL bei reinem Erledigen/Verwerfen. Speist die Ausgangs-Anzeige im
"Erledigt"-Tab der Mod-Queue.

Revision ID: 0049_report_resolution_action
Revises: 0048_report_escalated_at
Create Date: 2026-07-15 13:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0049_report_resolution_action"
down_revision: str | None = "0048_report_escalated_at"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column("resolution_action", sa.Text(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("reports", "resolution_action", schema=SCHEMA)
