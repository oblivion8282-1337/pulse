"""chat_settings: instanzweiter Anzeigename (instance_name)

Self-Host-Admins können ihrem Server einen menschenlesbaren Namen geben, den
ALLE verbundenen Clients (statt der nackten URL) sehen. NULL = kein Name.

Revision ID: 0040_instance_name
Revises: 0039_channel_name_colors
Create Date: 2026-06-29 11:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0040_instance_name"
down_revision = "0039_channel_name_colors"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "chat_settings",
        sa.Column("instance_name", sa.Text(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("chat_settings", "instance_name", schema=SCHEMA)
