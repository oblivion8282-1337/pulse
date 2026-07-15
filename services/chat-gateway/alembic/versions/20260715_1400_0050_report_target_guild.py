"""reports.target_guild_id — Nutzer-Meldung an eine Community binden

Wird gesetzt, wenn ein Nutzer aus der Mitgliederliste einer bestimmten
Community gemeldet wird. Die Meldung landet dann nur in dieser Community
statt in jeder, in der der Gemeldete Mitglied ist.

Revision ID: 0050_report_target_guild
Revises: 0049_report_resolution_action
Create Date: 2026-07-15 14:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0050_report_target_guild"
down_revision: str | None = "0049_report_resolution_action"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column("target_guild_id", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("reports", "target_guild_id", schema=SCHEMA)
