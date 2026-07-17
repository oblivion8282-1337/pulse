"""chat_settings: instanzweite Voice-Bitrate

Fügt ``voice_bitrate_max_kbps`` hinzu — das instanzweite Gegenstück zum
Pro-Guild-Override ``guilds.voice_bitrate_max_kbps`` (0052). Auflösung im
Client: Guild-Override ?? dieser Instanzwert (gleiche Semantik wie die
hq_*/ns_*-Stream-Limits aus 0026/0027; ein Override darf also auch HÖHER
liegen — "Boost").

Es gibt KEINEN Nutzer-Regler (2026-07-17 entfernt: niemand stellt Qualität
freiwillig niedriger) — dieser Wert IST die gesendete Opus-Bitrate. Default
128 = das bisherige Default-Verhalten → die Migration ist ein No-op, bis ein
Admin dreht (16–512; Opus endet real bei 510). Enforcement client-seitig
(Publish-Pfad in livekit.svelte.ts), wie bei allen Qualitäts-Caps.

Revision ID: 0055_instance_voice_cap
Revises: 0054_guild_scale_caps
Create Date: 2026-07-17 19:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0055_instance_voice_cap"
down_revision: str | None = "0054_guild_scale_caps"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "chat_settings",
        sa.Column(
            "voice_bitrate_max_kbps", sa.SmallInteger(), server_default="128", nullable=False
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("chat_settings", "voice_bitrate_max_kbps", schema=SCHEMA)
