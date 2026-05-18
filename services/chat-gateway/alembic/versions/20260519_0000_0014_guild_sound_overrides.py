"""guild_sound_overrides + chat_settings.guild_sound_max_size_bytes

Per-guild overrides for the bundled UI/notification/voice sounds. One
row per (guild, sound_id); ``sound_id`` is the registry key like
``notification.message`` (validated in the application layer — not a
DB enum so adding a new sound doesn't need a migration). Binary lives
in MinIO under ``guild-sounds/<gid>/<sound_id>``; the DB row carries
metadata (size, type, uploader) for admin-UI display + housekeeping.

Also adds ``chat_settings.guild_sound_max_size_bytes`` so the Pulse
instance admin can tune the per-file cap centrally. Default 524288
(512 KB) — Kenney UI Audio defaults are ~10–30 KB, leaves plenty of
headroom for longer custom OGG/MP3.

Revision ID: 0014_guild_sound_overrides
Revises: 0013_web_push_subscriptions
Create Date: 2026-05-19 00:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0014_guild_sound_overrides"
down_revision: str | None = "0013_web_push_subscriptions"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "chat_settings",
        sa.Column(
            "guild_sound_max_size_bytes",
            sa.BigInteger(),
            nullable=False,
            server_default="524288",
        ),
        schema=SCHEMA,
    )
    op.create_table(
        "guild_sound_overrides",
        sa.Column(
            "guild_id",
            sa.BigInteger(),
            sa.ForeignKey(f"{SCHEMA}.guilds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sound_id", sa.Text(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("original_filename", sa.Text(), nullable=False),
        sa.Column("uploaded_by_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "uploaded_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("guild_id", "sound_id"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("guild_sound_overrides", schema=SCHEMA)
    op.drop_column("chat_settings", "guild_sound_max_size_bytes", schema=SCHEMA)
