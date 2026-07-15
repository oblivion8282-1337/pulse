"""guilds.* Skalierungs-Caps: Mitglieder/Kanäle/Rollen + gleichz. Streams (3.3+3.4)

Pro-Community-Obergrenzen. NULL = unbegrenzt. Serverseitig per Count-Check
erzwungen (Streams best-effort beim Token-Issue). Nur der Cloud-Betreiber
setzt sie.

Revision ID: 0054_guild_scale_caps
Revises: 0053_guild_storage_quota
Create Date: 2026-07-16 16:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0054_guild_scale_caps"
down_revision: str | None = "0053_guild_storage_quota"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column("guilds", sa.Column("max_members", sa.Integer(), nullable=True), schema=SCHEMA)
    op.add_column(
        "guilds", sa.Column("max_channels", sa.SmallInteger(), nullable=True), schema=SCHEMA
    )
    op.add_column(
        "guilds", sa.Column("max_roles", sa.SmallInteger(), nullable=True), schema=SCHEMA
    )
    op.add_column(
        "guilds",
        sa.Column("max_concurrent_streams", sa.SmallInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("guilds", "max_concurrent_streams", schema=SCHEMA)
    op.drop_column("guilds", "max_roles", schema=SCHEMA)
    op.drop_column("guilds", "max_channels", schema=SCHEMA)
    op.drop_column("guilds", "max_members", schema=SCHEMA)
