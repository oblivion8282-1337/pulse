"""admin_audit_log (auth-side)

Append-only log of admin actions on the auth side (toggle is_admin,
disable user, change registration_mode). chat-gateway keeps its own
``admin_audit_log`` in the ``chat`` schema — the admin UI fetches both
and merges client-side (per PLAN.md anti-pattern: no shared tables).

Revision ID: 0005_admin_audit_log
Revises: 0004_auth_settings
Create Date: 2026-05-17 15:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005_admin_audit_log"
down_revision: str | None = "0004_auth_settings"
branch_labels = None
depends_on = None

SCHEMA = "auth"


def upgrade() -> None:
    op.create_table(
        "admin_audit_log",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("actor_id", sa.BigInteger(), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("target_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_admin_audit_log_created",
        "admin_audit_log",
        ["created_at"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_index("ix_admin_audit_log_created", "admin_audit_log", schema=SCHEMA)
    op.drop_table("admin_audit_log", schema=SCHEMA)
