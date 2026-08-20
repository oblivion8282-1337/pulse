"""guilds: Geräte-Deckel wird ein Community-Limit

``MAX_DEVICES_PER_OWNER`` stand bisher als feste Konstante (10) in
``routes/devices.py`` — nie als Schutz vor einem Angreifer gedacht (wer
eintragen darf, darf auch übertragen, das ist die teurere Handlung), sondern
als Riegel gegen den Unfall: ein Client, der sich bei jedem Start neu
einträgt, füllte sonst die Kanalliste. Eine Postproduktion mit vielen
Schnittplätzen lief dagegen.

Wie jedes andere Limit ab 0057 bekommt es zwei Ebenen:

    Betreiber-Obergrenze   ──klemmt──▶   Wert der Community   ──▶  wirksam

Revision ID: 0061_device_limit
Revises: 0060_device_grants
Create Date: 2026-08-20 13:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0061_device_limit"
down_revision: str | None = "0060_device_grants"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "guilds",
        sa.Column("max_devices_per_owner", sa.SmallInteger(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "guilds",
        sa.Column("community_max_devices_per_owner", sa.SmallInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("guilds", "community_max_devices_per_owner", schema=SCHEMA)
    op.drop_column("guilds", "max_devices_per_owner", schema=SCHEMA)
