"""registration_invites — invite codes for invite_only registration

Revision ID: 0022_registration_invites
Revises: 0021_complaints_target_url
Create Date: 2026-05-29 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0022_registration_invites"
down_revision: str | None = "0021_complaints_target_url"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "registration_invites",
        sa.Column("code", sa.String(length=64), primary_key=True),
        sa.Column("created_by", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column("uses", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "revoked", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("note", sa.String(length=100), nullable=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_registration_invites_created",
        "registration_invites",
        ["created_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_registration_invites_created",
        table_name="registration_invites",
        schema=SCHEMA,
    )
    op.drop_table("registration_invites", schema=SCHEMA)
