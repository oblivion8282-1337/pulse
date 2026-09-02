"""zusammenfuehrung main pins und e2ee ablage

Revision ID: 220119df9614
Revises: 0064_message_pinned_at, 0087_anhang_laufwerk_verteilt
Create Date: 2026-09-02 10:13:52.875217+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '220119df9614'
down_revision: str | Sequence[str] | None = ('0064_message_pinned_at', '0087_anhang_laufwerk_verteilt')
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
