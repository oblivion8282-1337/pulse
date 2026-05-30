"""chat_settings: global normal-stream (LiveKit screen-share) quality limits

Mirrors migration 0026 (HQ limits) for the *normal* browser screen-share path,
as a separate set of values:

* ``ns_bitrate_min_kbps`` / ``ns_bitrate_max_kbps`` — allowed bitrate band.
* ``ns_fps_min`` / ``ns_fps_max`` — allowed FPS band.
* ``ns_resolution_max`` — resolution ceiling ('native' = no cap; ordering
  native > 1080p > 720p > 480p).

Defaults mirror the client's current screen-share bounds (1–10 Mbit/s, 1–240
fps, no resolution cap) → no-op until an admin tightens them. Enforcement is
client-side (livekit.svelte.ts publish + the screen-share settings UI).

Revision ID: 0027_normal_stream_limits
Revises: 0026_hq_stream_limits
Create Date: 2026-05-30 14:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0027_normal_stream_limits"
down_revision: str | None = "0026_hq_stream_limits"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "chat_settings",
        sa.Column("ns_bitrate_min_kbps", sa.SmallInteger(), server_default="1000", nullable=False),
        schema=SCHEMA,
    )
    op.add_column(
        "chat_settings",
        sa.Column("ns_bitrate_max_kbps", sa.SmallInteger(), server_default="10000", nullable=False),
        schema=SCHEMA,
    )
    op.add_column(
        "chat_settings",
        sa.Column("ns_fps_min", sa.SmallInteger(), server_default="1", nullable=False),
        schema=SCHEMA,
    )
    op.add_column(
        "chat_settings",
        sa.Column("ns_fps_max", sa.SmallInteger(), server_default="240", nullable=False),
        schema=SCHEMA,
    )
    op.add_column(
        "chat_settings",
        sa.Column("ns_resolution_max", sa.String(16), server_default="native", nullable=False),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("chat_settings", "ns_resolution_max", schema=SCHEMA)
    op.drop_column("chat_settings", "ns_fps_max", schema=SCHEMA)
    op.drop_column("chat_settings", "ns_fps_min", schema=SCHEMA)
    op.drop_column("chat_settings", "ns_bitrate_max_kbps", schema=SCHEMA)
    op.drop_column("chat_settings", "ns_bitrate_min_kbps", schema=SCHEMA)
