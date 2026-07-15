"""complaints.submitter_user_id — Melder-Cloud-ID an der Beschwerde

Wird gesetzt, wenn ein eingeloggter Nutzer eine Beschwerde einreicht. Ermöglicht
eine automatische „deine Meldung wurde bearbeitet"-Rückmeldung an den Melder beim
Erledigen. NULL für anonyme / öffentliche Meldungen.

Revision ID: 0046_complaint_submitter_user
Revises: 0045_app_network_check
Create Date: 2026-07-15 15:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0046_complaint_submitter_user"
down_revision: str | None = "0045_app_network_check"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "complaints",
        sa.Column("submitter_user_id", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("complaints", "submitter_user_id", schema=SCHEMA)
