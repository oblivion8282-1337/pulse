"""guilds.* per-community Qualitäts-Caps (Boost-Fundament, Etappe 3.1)

Pro-Community-Höchstwerte für Sprach-Bitrate, Stream-Bitrate, FPS und
Auflösung. NULL = erbt den serverweiten Standard; ein gesetzter Wert
überschreibt ihn für DIESE Community (auch höher = Boost). Nur der
Cloud-Betreiber setzt sie.

Revision ID: 0052_guild_quality_caps
Revises: 0051_guild_suspension
Create Date: 2026-07-16 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0052_guild_quality_caps"
down_revision: str | None = "0051_guild_suspension"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "guilds",
        sa.Column("voice_bitrate_max_kbps", sa.SmallInteger(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "guilds",
        sa.Column("stream_bitrate_max_kbps", sa.Integer(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "guilds",
        sa.Column("stream_fps_max", sa.SmallInteger(), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "guilds",
        sa.Column("stream_resolution_max", sa.String(length=16), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("guilds", "stream_resolution_max", schema=SCHEMA)
    op.drop_column("guilds", "stream_fps_max", schema=SCHEMA)
    op.drop_column("guilds", "stream_bitrate_max_kbps", schema=SCHEMA)
    op.drop_column("guilds", "voice_bitrate_max_kbps", schema=SCHEMA)
