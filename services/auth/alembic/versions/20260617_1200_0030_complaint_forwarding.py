"""complaint_forwarding — audit columns for forwarding a complaint to the operator

Adds forwarded_at / forwarded_to_email / forward_notice to complaints so the
"forward to instance operator" action keeps a proper audit trail (who it went
to, when, and the notice text) instead of overloading resolution_note.

Revision ID: 0030_complaint_forwarding
Revises: 0029_profile_color_secondary
Create Date: 2026-06-17 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0030_complaint_forwarding"
down_revision: str | None = "0029_profile_color_secondary"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "complaints",
        sa.Column("forwarded_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "complaints",
        sa.Column("forwarded_to_email", sa.Text(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "complaints",
        sa.Column("forward_notice", sa.Text(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("complaints", "forward_notice", schema=SCHEMA)
    op.drop_column("complaints", "forwarded_to_email", schema=SCHEMA)
    op.drop_column("complaints", "forwarded_at", schema=SCHEMA)
