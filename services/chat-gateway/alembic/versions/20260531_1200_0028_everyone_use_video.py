"""grant USE_VIDEO to existing @everyone roles

Webcam-publishing in voice (``USE_VIDEO``, bit 33) was added as a permission
but never made part of ``DEFAULT_EVERYONE_PERMISSIONS`` — so members of any
guild created before this fix could SPEAK and STREAM (screenshare) but were
denied when toggling their own webcam ("insufficient permissions to publish"
from LiveKit, because voice-signaling derives ``can_publish_sources`` from the
resolved bitfield).

This data-migration ORs the USE_VIDEO bit into every ``@everyone`` role that
lacks it, bringing existing guilds in line with the updated default. Purely
additive — admins who don't want member webcams can drop the bit again via the
role editor. New guilds get it from ``DEFAULT_EVERYONE_PERMISSIONS``.

Revision ID: 0028_everyone_use_video
Revises: 0027_normal_stream_limits
Create Date: 2026-05-31 12:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

from dcc_shared.permissions import Permissions

revision: str = "0028_everyone_use_video"
down_revision: str | None = "0027_normal_stream_limits"
branch_labels = None
depends_on = None

SCHEMA = "chat"
_USE_VIDEO = int(Permissions.USE_VIDEO)


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            f"UPDATE {SCHEMA}.roles "
            "SET permissions = permissions | :bit "
            "WHERE is_everyone = true AND (permissions & :bit) = 0"
        ),
        {"bit": _USE_VIDEO},
    )


def downgrade() -> None:
    # Clear the bit from @everyone roles again. (Can't distinguish roles that
    # had it set manually before this ran — acceptable for a reversible default
    # change.)
    op.get_bind().execute(
        sa.text(
            f"UPDATE {SCHEMA}.roles "
            "SET permissions = permissions & :mask "
            "WHERE is_everyone = true"
        ),
        {"mask": ~_USE_VIDEO},
    )
