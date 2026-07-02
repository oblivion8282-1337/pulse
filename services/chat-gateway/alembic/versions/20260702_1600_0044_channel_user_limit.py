"""channels.user_limit — Voice-Channel-Benutzerlimit

0 = unbegrenzt (Default, Bestandsverhalten), 1..99 = max. gleichzeitige
Teilnehmer. Nur für Voice-Channels wirksam; voice-signaling setzt es beim
Token-Mint durch (MOVE_MEMBERS bypasst). Discord "User Limit".

Revision ID: 0044_channel_user_limit
Revises: 0043_dropbox_files_unique_name
Create Date: 2026-07-02 16:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0044_channel_user_limit"
down_revision: str | None = "0043_dropbox_files_unique_name"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "channels",
        sa.Column(
            "user_limit",
            sa.SmallInteger(),
            nullable=False,
            server_default="0",
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("channels", "user_limit", schema=SCHEMA)
