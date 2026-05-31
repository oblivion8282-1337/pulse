"""webcam capture limits on chat_settings

Revision ID: 0029_cam_limits
Revises: 0028_everyone_use_video
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0029_cam_limits"
down_revision = "0028_everyone_use_video"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.add_column(
        "chat_settings",
        sa.Column("cam_resolution_max", sa.String(16), server_default="720p", nullable=False),
        schema=SCHEMA,
    )
    op.add_column(
        "chat_settings",
        sa.Column("cam_fps_max", sa.SmallInteger(), server_default="30", nullable=False),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("chat_settings", "cam_fps_max", schema=SCHEMA)
    op.drop_column("chat_settings", "cam_resolution_max", schema=SCHEMA)
