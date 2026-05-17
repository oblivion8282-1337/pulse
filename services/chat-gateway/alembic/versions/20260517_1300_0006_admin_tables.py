"""chat_settings + admin_audit_log

Two tables that back the upcoming server-admin panel:

* ``chat_settings`` — singleton row (``id=1``) holding chat-gateway-owned
  server-wide toggles. Seeded by the migration so reads never have to
  handle the "no row yet" case. auth-svc keeps its own ``auth_settings``
  row separately (per PLAN.md anti-pattern: services never share tables).
* ``admin_audit_log`` — append-only history of admin actions, opaque JSON
  payload so new action kinds don't require a column change.

Revision ID: 0006_admin_tables
Revises: 0005_direct_messages
Create Date: 2026-05-17 13:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006_admin_tables"
down_revision: str | None = "0005_direct_messages"
branch_labels = None
depends_on = None

SCHEMA = "chat"


def upgrade() -> None:
    op.create_table(
        "chat_settings",
        sa.Column("id", sa.SmallInteger(), primary_key=True),
        sa.Column(
            "dm_attachment_max_size_bytes",
            sa.BigInteger(),
            server_default="26214400",
            nullable=False,
        ),
        sa.Column(
            "dm_attachment_max_count_per_message",
            sa.SmallInteger(),
            server_default="4",
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="ck_chat_settings_singleton"),
        schema=SCHEMA,
    )
    # Seed the singleton so reads always find it.
    op.execute(f"INSERT INTO {SCHEMA}.chat_settings (id) VALUES (1)")

    op.create_table(
        "admin_audit_log",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("actor_id", sa.BigInteger(), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("target_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "payload",
            postgresql.JSON(astext_type=sa.Text()),
            server_default="{}",
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
    op.drop_table("chat_settings", schema=SCHEMA)
