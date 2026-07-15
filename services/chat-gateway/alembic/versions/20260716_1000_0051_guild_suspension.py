"""guilds.suspended_at + suspension_reason — Community durch den Betreiber stilllegen

Der Cloud-Betreiber (Owner) kann eine einzelne Community einfrieren. Ist
``suspended_at`` gesetzt, verlieren Mitglieder den Zugriff, bis sie wieder
freigegeben wird. Die Mitgliedschaften bleiben erhalten (umkehrbar, anders
als ein Bann).

Revision ID: 0051_guild_suspension
Revises: 0050_report_target_guild
Create Date: 2026-07-16 10:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0051_guild_suspension"
down_revision: str | None = "0050_report_target_guild"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "guilds",
        sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "guilds",
        sa.Column("suspension_reason", sa.Text(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("guilds", "suspension_reason", schema=SCHEMA)
    op.drop_column("guilds", "suspended_at", schema=SCHEMA)
