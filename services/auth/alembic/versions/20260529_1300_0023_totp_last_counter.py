"""totp_last_counter — TOTP replay-prevention column on auth.users

Revision ID: 0023_totp_last_counter
Revises: 0022_registration_invites
Create Date: 2026-05-29 13:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0023_totp_last_counter"
down_revision: str | None = "0022_registration_invites"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("totp_last_counter", sa.BigInteger(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("users", "totp_last_counter", schema=SCHEMA)
