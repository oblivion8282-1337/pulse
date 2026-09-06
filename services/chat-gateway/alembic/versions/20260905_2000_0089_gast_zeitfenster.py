"""gast-links zeitfenster (gueltig ab)

Revision ID: 0089_gast_zeitfenster
Revises: 0088_gast_links
Create Date: 2026-09-05 20:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0089_gast_zeitfenster"
down_revision: str | Sequence[str] | None = "0088_gast_links"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable: Bestandslinks sind ab sofort gültig — NULL heisst „kein
    # Start-Zeitpunkt", und genau das war vor diesem Feld der einzige Modus.
    op.add_column(
        "guest_links",
        sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("guest_links", "valid_from", schema=SCHEMA)
