"""chat_settings: global HQ-stream quality limits

Adds five admin-tunable, instance-wide HQ-stream caps:

* ``hq_bitrate_min_kbps`` / ``hq_bitrate_max_kbps`` — allowed bitrate band.
* ``hq_fps_min`` / ``hq_fps_max`` — allowed FPS band.
* ``hq_resolution_max`` — resolution ceiling ('Native' = no cap; downscale
  ordering Native > 4K > 1440p > 1080p > 720p > 480p).

Defaults mirror the previously hard-coded client behaviour (bitrate 1000–
10000 kbps, fps 1–360, no resolution cap) so the patch is a no-op until an
admin tightens them. Enforcement is client-side only (the stream panel +
buildStartArgs) — media-svc/MediaMTX never see these params.

Revision ID: 0026_hq_stream_limits
Revises: 0025_dm_last_message_idx
Create Date: 2026-05-30 10:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0026_hq_stream_limits"
down_revision: str | None = "0025_dm_last_message_idx"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "chat_settings",
        sa.Column("hq_bitrate_min_kbps", sa.SmallInteger(), server_default="1000", nullable=False),
        schema=SCHEMA,
    )
    op.add_column(
        "chat_settings",
        sa.Column("hq_bitrate_max_kbps", sa.SmallInteger(), server_default="10000", nullable=False),
        schema=SCHEMA,
    )
    op.add_column(
        "chat_settings",
        sa.Column("hq_fps_min", sa.SmallInteger(), server_default="1", nullable=False),
        schema=SCHEMA,
    )
    op.add_column(
        "chat_settings",
        sa.Column("hq_fps_max", sa.SmallInteger(), server_default="360", nullable=False),
        schema=SCHEMA,
    )
    op.add_column(
        "chat_settings",
        sa.Column("hq_resolution_max", sa.String(16), server_default="Native", nullable=False),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("chat_settings", "hq_resolution_max", schema=SCHEMA)
    op.drop_column("chat_settings", "hq_fps_max", schema=SCHEMA)
    op.drop_column("chat_settings", "hq_fps_min", schema=SCHEMA)
    op.drop_column("chat_settings", "hq_bitrate_max_kbps", schema=SCHEMA)
    op.drop_column("chat_settings", "hq_bitrate_min_kbps", schema=SCHEMA)
