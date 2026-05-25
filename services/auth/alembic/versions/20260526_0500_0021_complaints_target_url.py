"""complaints_target_url — Phase 2.4 Add target_url column to complaints

Revision ID: 0021_complaints_target_url
Revises: 0020_instance_registry
Create Date: 2026-05-26 05:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0021_complaints_target_url"
down_revision: str | None = "0020_instance_registry"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "complaints",
        sa.Column("target_url", sa.Text(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("complaints", "target_url", schema=SCHEMA)
