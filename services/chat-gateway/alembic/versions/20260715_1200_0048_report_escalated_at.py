"""reports.escalated_at — Weiterleitung an den Plattform-Betreiber

Gesetzt, wenn ein Community-Moderator eine Meldung an das Betreiber-Postfach
(auth-svc Complaint) weiterleitet. Verhindert Doppel-Weiterleitung; die Meldung
bleibt offen.

Revision ID: 0048_report_escalated_at
Revises: 0047_member_invites
Create Date: 2026-07-15 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0048_report_escalated_at"
down_revision: str | None = "0047_member_invites"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column("escalated_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("reports", "escalated_at", schema=SCHEMA)
